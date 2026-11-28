import os from 'node:os';
import { chromium } from 'playwright';
import { connectDatabase } from './db.js';
import { config } from './config.js';
import { Setting, TrafficWebsite } from './models.js';
import { claimNextCheck, completeCheck, failCheck, maybeFinalizeRun, recoverStaleChecks, touchCheck, updateCheckProgress } from './queue.js';
import { claimNextDomainCheck, completeDomainCheck, failDomainCheck, recoverStaleDomainChecks, touchDomainCheck } from './domain-queue.js';
import { claimNextTrafficCheck, completeTrafficCheck, enqueueDailyTrafficRun, failTrafficCheck, recoverStaleTrafficChecks, touchTrafficCheck } from './traffic-queue.js';
import { inspectDomainHosting } from './domain-info.js';
import { inspectGoogleTraffic, refreshGoogleRealtimeUsers } from './google-traffic.js';
import { monitorWebsite } from './monitor.js';
import { syncPendingSheetRows } from './google-sheets.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let stopping = false;
const workerId = `${os.hostname()}-${process.pid}`;
async function updateWorkerHeartbeat(status) {
	await Setting.findOneAndUpdate(
		{ key: `workerHeartbeat:${workerId}` },
		{ value: JSON.stringify({ status, workerId, updatedAt: new Date().toISOString() }) },
		{ upsert: true }
	);
}
async function loop(browser, slot) {
	let queueCursor = (slot - 1) % 3;
	while (!stopping) {
		let claimed;
		let claimedDomain;
		let claimedTraffic;
		try {
			const queues = ['traffic', 'domain', 'site'];
			for (let index = 0; index < queues.length; index += 1) {
				const queue = queues[(queueCursor + index) % queues.length];
				if (queue === 'traffic') claimedTraffic = await claimNextTrafficCheck(`${workerId}-${slot}`);
				if (queue === 'domain') claimedDomain = await claimNextDomainCheck(`${workerId}-${slot}`);
				if (queue === 'site') claimed = await claimNextCheck(`${workerId}-${slot}`);
				if (claimedTraffic || claimedDomain || claimed) break;
			}
			queueCursor = (queueCursor + 1) % queues.length;
		} catch (error) {
			console.error(`Worker ${slot} could not claim a check:`, error);
			await sleep(3000);
			continue;
		}
		if (!claimed && !claimedDomain && !claimedTraffic) {
			await sleep(1200);
			continue;
		}
		if (claimedTraffic) {
			const { website, runId, range } = claimedTraffic;
			console.log(`Worker ${slot} checking Google Analytics and Search Console for ${website.url}`);
			const aliveSignal = setInterval(() => touchTrafficCheck(website._id, runId).catch(() => {}), config.lockHeartbeatMs);
			try {
				const result = await inspectGoogleTraffic(website, range);
				const saved = await completeTrafficCheck(website, runId, result, range);
				if (saved) console.log(`Worker ${slot} finished Traffic Check for ${website.url}`);
			} catch (error) {
				console.error(`Worker ${slot} failed Traffic Check for ${website.url}:`, error);
				await failTrafficCheck(website, runId, error).catch((saveError) => console.error('Unable to save failed Traffic Check:', saveError));
			} finally {
				clearInterval(aliveSignal);
			}
			continue;
		}
		if (claimedDomain) {
			const { website, runId } = claimedDomain;
			console.log(`Worker ${slot} checking domain and hosting details for ${website.url}`);
			const aliveSignal = setInterval(() => touchDomainCheck(website._id, runId).catch(() => {}), config.lockHeartbeatMs);
			try {
				const result = await inspectDomainHosting(website.url);
				const saved = await completeDomainCheck(website, runId, result);
				if (saved) console.log(`Worker ${slot} finished domain and hosting lookup for ${website.url}`);
			} catch (error) {
				console.error(`Worker ${slot} failed domain and hosting lookup for ${website.url}:`, error);
				await failDomainCheck(website, runId, error).catch((saveError) => console.error('Unable to save failed domain lookup:', saveError));
			} finally {
				clearInterval(aliveSignal);
			}
			continue;
		}
		console.log(`Worker ${slot} checking ${claimed.website.url}`);
		// Every check has a time limit and keeps proving it is alive, so one stuck website can neither block this slot nor be mistaken for a dead worker.
		const limit = new AbortController();
		const timeLimit = setTimeout(() => limit.abort(new Error('Check time limit reached.')), config.checkMaxDurationMs);
		const aliveSignal = setInterval(() => touchCheck(claimed.check._id).catch(() => {}), config.lockHeartbeatMs);
		try {
			const result = await monitorWebsite(browser, {
				website: claimed.website,
				runId: claimed.check.run,
				signal: limit.signal,
				onProgress: (progress) => updateCheckProgress(claimed.check._id, progress).catch((error) => console.error('Unable to save check progress:', error.message))
			});
			const saved = await completeCheck(claimed.check, result);
			if (!saved) {
				// The check was cancelled, paused or deleted while it was running, so its result is discarded.
				console.log(`Worker ${slot} discarded the result for ${claimed.website.url} because the check was stopped.`);
			} else console.log(`Worker ${slot} finished ${claimed.website.url}: ${result.overallStatus}`);
			// The result is written to the Google Sheet by the sheet sync loop below, which also retries anything that failed.
			await maybeFinalizeRun(claimed.check.run);
		} catch (error) {
			const timedOut = limit.signal.aborted;
			console.error(`Worker ${slot} ${timedOut ? 'stopped (time limit)' : 'failed'} checking ${claimed.website.url}:`, timedOut ? 'took too long' : error);
			try {
				const outcome = await failCheck(claimed.check, error, { timedOut });
				if (outcome.retry) console.log(`Worker ${slot} queued a retry for ${claimed.website.url}.`);
				await maybeFinalizeRun(claimed.check.run);
			} catch (queueError) {
				console.error(`Worker ${slot} could not save the failed check:`, queueError);
			}
		} finally {
			clearTimeout(timeLimit);
			clearInterval(aliveSignal);
		}
	}
}
async function main() {
	await connectDatabase();
	const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-blink-features=AutomationControlled'] });
	await updateWorkerHeartbeat('online');
	console.log(`Worker online (${config.workerConcurrency} slots).`);
	const heartbeat = setInterval(() => {
		updateWorkerHeartbeat('online').catch((error) => console.error('Unable to update worker heartbeat:', error));
	}, 5000);
	const recovery = setInterval(() => {
		recoverStaleChecks().catch((error) => console.error('Unable to recover stale checks:', error));
		recoverStaleDomainChecks().catch((error) => console.error('Unable to recover stale domain lookups:', error));
		recoverStaleTrafficChecks().catch((error) => console.error('Unable to recover stale Traffic Checks:', error));
	}, 15000);
	let dailyTrafficScheduling = false;
	const scheduleDailyTraffic = async () => {
		if (dailyTrafficScheduling) return;
		dailyTrafficScheduling = true;
		try {
			const result = await enqueueDailyTrafficRun();
			if (result.created) console.log(`Queued daily Traffic Check for ${result.run.startDate}.`);
		} catch (error) {
			console.error('Unable to queue the daily Traffic Check:', error);
		} finally {
			dailyTrafficScheduling = false;
		}
	};
	scheduleDailyTraffic();
	const dailyTraffic = setInterval(scheduleDailyTraffic, 60000);
	let realtimeTrafficRefreshing = false;
	const refreshRealtimeTraffic = async () => {
		if (realtimeTrafficRefreshing) return;
		realtimeTrafficRefreshing = true;
		let websites = [];
		try {
			websites = await TrafficWebsite.find({
				active: true,
				'traffic.analyticsPropertyId': { $exists: true, $nin: ['', null] }
			}).select('_id traffic.analyticsPropertyId').lean();
			if (!websites.length) return;
			const results = await refreshGoogleRealtimeUsers(websites);
			const refreshedAt = new Date();
			await TrafficWebsite.bulkWrite(results.map(({ websiteId, activeUsers, error }) => ({
				updateOne: {
					filter: { _id: websiteId },
					update: { $set: error
						? { 'traffic.realtimeError': error }
						: {
							'traffic.realtimeActiveUsers': activeUsers,
							'traffic.realtimeUpdatedAt': refreshedAt,
							'traffic.realtimeError': ''
						}
					}
				}
			})), { ordered: false });
			const failedCount = results.filter(({ error }) => error).length;
			console.log(`Refreshed GA4 realtime users for ${results.length - failedCount} websites${failedCount ? `; ${failedCount} failed.` : '.'}`);
		} catch (error) {
			console.error('Unable to refresh GA4 realtime users:', error);
			if (websites.length) {
				try {
					await TrafficWebsite.updateMany(
						{ _id: { $in: websites.map(({ _id }) => _id) } },
						{ $set: { 'traffic.realtimeError': error.message } }
					);
				} catch (saveError) {
					console.error('Unable to save GA4 realtime refresh error:', saveError);
				}
			}
		} finally {
			realtimeTrafficRefreshing = false;
		}
	};
	refreshRealtimeTraffic();
	const realtimeTraffic = setInterval(refreshRealtimeTraffic, 10 * 60 * 1000);
	// Results go to the sheet in batches and are retried until they are written, so a busy or unreachable Google API never drops an update.
	const sheetSync = setInterval(() => {
		syncPendingSheetRows().then((result) => {
			if (result.synced) console.log(`Synced ${result.synced} results to the Google Sheet.`);
		}).catch((error) => console.error('Google Sheet sync failed, will retry:', error.message));
	}, 5000);
	process.on('SIGTERM', () => { stopping = true; });
	process.on('SIGINT', () => { stopping = true; });
	try {
		const recovered = await recoverStaleChecks();
		if (recovered) console.log(`Recovered ${recovered} checks left by a stopped worker.`);
		const recoveredDomain = await recoverStaleDomainChecks();
		if (recoveredDomain) console.log(`Recovered ${recoveredDomain} domain lookups left by a stopped worker.`);
		const recoveredTraffic = await recoverStaleTrafficChecks();
		if (recoveredTraffic) console.log(`Recovered ${recoveredTraffic} Traffic Checks left by a stopped worker.`);
		await Promise.all(Array.from({ length: config.workerConcurrency }, (_, index) => loop(browser, index + 1)));
	} finally {
		clearInterval(heartbeat);
		clearInterval(recovery);
		clearInterval(dailyTraffic);
		clearInterval(realtimeTraffic);
		clearInterval(sheetSync);
		await updateWorkerHeartbeat('offline');
		await browser.close();
	}
}
main().catch((error) => { console.error(error); process.exit(1); });