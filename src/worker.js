import os from 'node:os';
import { chromium } from 'playwright';
import { connectDatabase } from './db.js';
import { config } from './config.js';
import { Setting } from './models.js';
import { claimNextCheck, completeCheck, failCheck, maybeFinalizeRun, recoverStaleChecks, touchCheck, updateCheckProgress } from './queue.js';
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
	while (!stopping) {
		let claimed;
		try {
			claimed = await claimNextCheck(`${workerId}-${slot}`);
		} catch (error) {
			console.error(`Worker ${slot} could not claim a check:`, error);
			await sleep(3000);
			continue;
		}
		if (!claimed) {
			await sleep(1200);
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
	const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--no-sandbox'] });
	await updateWorkerHeartbeat('online');
	console.log(`Worker online (${config.workerConcurrency} slots).`);
	const heartbeat = setInterval(() => {
		updateWorkerHeartbeat('online').catch((error) => console.error('Unable to update worker heartbeat:', error));
	}, 5000);
	const recovery = setInterval(() => {
		recoverStaleChecks().catch((error) => console.error('Unable to recover stale checks:', error));
	}, 15000);
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
		await Promise.all(Array.from({ length: config.workerConcurrency }, (_, index) => loop(browser, index + 1)));
	} finally {
		clearInterval(heartbeat);
		clearInterval(recovery);
		clearInterval(sheetSync);
		await updateWorkerHeartbeat('offline');
		await browser.close();
	}
}
main().catch((error) => { console.error(error); process.exit(1); });