import os from 'node:os';
import { chromium } from 'playwright';
import { connectDatabase } from './db.js';
import { config } from './config.js';
import { Setting } from './models.js';
import { claimNextCheck, completeCheck, failCheck, maybeFinalizeRun, recoverStaleChecks, updateCheckProgress } from './queue.js';
import { monitorWebsite } from './monitor.js';

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
		try {
			const result = await monitorWebsite(browser, {
				website: claimed.website,
				runId: claimed.check.run,
				onProgress: (progress) => updateCheckProgress(claimed.check._id, progress).catch((error) => console.error('Unable to save check progress:', error.message))
			});
			await completeCheck(claimed.check, result);
			await maybeFinalizeRun(claimed.check.run);
			console.log(`Worker ${slot} finished ${claimed.website.url}: ${result.overallStatus}`);
		} catch (error) {
			console.error(`Worker ${slot} failed checking ${claimed.website.url}:`, error);
			try {
				await failCheck(claimed.check, error);
				await maybeFinalizeRun(claimed.check.run);
			} catch (queueError) {
				console.error(`Worker ${slot} could not save the failed check:`, queueError);
			}
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
	process.on('SIGTERM', () => { stopping = true; });
	process.on('SIGINT', () => { stopping = true; });
	try {
		const recovered = await recoverStaleChecks();
		if (recovered) console.log(`Recovered ${recovered} checks left by a stopped worker.`);
		await Promise.all(Array.from({ length: config.workerConcurrency }, (_, index) => loop(browser, index + 1)));
	} finally {
		clearInterval(heartbeat);
		clearInterval(recovery);
		await updateWorkerHeartbeat('offline');
		await browser.close();
	}
}
main().catch((error) => { console.error(error); process.exit(1); });
