import os from 'node:os';
import { Check, Run, Website } from './models.js';
import { config } from './config.js';

export async function enqueueRun({ type = 'manual', websiteIds = null, localRunDate = null } = {}) {
	const filter = { active: true, ...(websiteIds?.length ? { _id: { $in: websiteIds } } : {}) };
	const websites = await Website.find(filter).limit(config.maxWebsites).lean();
	if (!websites.length) return { created: false, reason: websiteIds?.length ? 'No selected websites are available to check.' : 'No active websites are available.' };
	if (type === 'daily' && await Run.exists({ status: 'running', type: 'daily' })) return { created: false, reason: 'A daily monitoring run is already in progress.' };

	const runningRuns = await Run.find({ status: 'running' }).select('_id').sort({ startedAt: -1 }).lean();
	const runIds = runningRuns.map((run) => run._id);
	// Websites picked by hand (marked, or a single "Run check now") while a run is in progress go ahead of the rest of that run.
	const prioritize = type === 'manual' && Boolean(websiteIds?.length) && runIds.length > 0;

	// A website must never have two open checks at once: two browsers would load the same site and the older result could overwrite the newer one.
	const openChecks = runIds.length
		? await Check.find({ run: { $in: runIds }, status: { $in: ['pending', 'processing'] }, website: { $in: websites.map((website) => website._id) } }).select('website status run').lean()
		: [];
	const openByWebsite = new Map(openChecks.map((check) => [String(check.website), check]));
	const queueable = [];
	const bumpable = [];
	let skipped = 0;
	for (const website of websites) {
		const open = openByWebsite.get(String(website._id));
		if (!open) queueable.push(website);
		else if (prioritize && open.status === 'pending') bumpable.push(open); // still waiting in the queue: move it to the front
		else skipped += 1; // already being checked right now (or queued in a normal run)
	}
	if (!queueable.length && !bumpable.length) return { created: false, skipped, reason: websites.length === 1 ? 'This website is already being checked.' : 'All selected websites are already being checked.' };

	// Newest priority batch gets the largest number, so a later batch always runs before an earlier one.
	let priority = 0;
	if (prioritize) {
		const top = await Check.findOne({ run: { $in: runIds }, status: 'pending' }).sort({ priority: -1 }).select('priority').lean();
		priority = Math.max(Date.now(), (top?.priority || 0) + 1);
	}
	if (bumpable.length) await Check.updateMany({ _id: { $in: bumpable.map((check) => check._id) }, status: 'pending' }, { $set: { priority, progressStage: 'Priority queued' } });
	if (!queueable.length) return { created: true, joined: true, prioritized: true, skipped, bumped: bumpable.length, queued: 0, runId: String(bumpable[0].run), total: bumpable.length };

	// A manual check made while a run is in progress joins that run, so there is one run, one progress bar and one Cancel button.
	if (type === 'manual' && runIds.length) {
		const runId = runIds[0];
		const checks = await Check.insertMany(queueable.map((website) => ({ run: runId, website: website._id, priority, progressStage: prioritize ? 'Priority queued' : 'Queued' })));
		const run = await Run.findOneAndUpdate(
			{ _id: runId, status: { $in: ['running', 'completed'] } },
			{ $set: { status: 'running' }, $unset: { finishedAt: 1 }, $inc: { total: checks.length } }
		);
		if (run) return { created: true, joined: true, prioritized: prioritize, skipped, bumped: bumpable.length, queued: checks.length, runId: runId.toString(), total: checks.length + bumpable.length };
		// The run was cancelled while the checks were being added, so they are removed and a new run is created below.
		await Check.deleteMany({ _id: { $in: checks.map((check) => check._id) } });
		const bumpedIds = new Set(bumpable.map((check) => String(check.website)));
		queueable.push(...websites.filter((website) => bumpedIds.has(String(website._id))));
	}

	const run = await Run.create({ type, total: queueable.length, localRunDate, scope: websiteIds?.length ? 'selected' : 'all' });
	await Check.insertMany(queueable.map((website) => ({ run: run._id, website: website._id })));
	return { created: true, skipped, runId: run._id.toString(), total: queueable.length };
}
export async function claimNextCheck(workerId = `${os.hostname()}-${process.pid}`) { const runningRuns = await Run.find({ status: 'running' }).select('_id').lean(); if (!runningRuns.length) return null; const check = await Check.findOneAndUpdate({ run: { $in: runningRuns.map((run) => run._id) }, status: 'pending', scheduledAt: { $lte: new Date() } }, { $set: { status: 'processing', lockedAt: new Date(), lockedBy: workerId, startedAt: new Date(), progressPercent: 0, progressStage: 'Starting' }, $inc: { attempts: 1 } }, { sort: { priority: -1, scheduledAt: 1, createdAt: 1 }, new: true }).populate('website');
	if (!check) return null;
	// A website can be paused or deleted right after its check was queued; never run a check for it.
	if (!check.website?.active) {
		await Check.deleteOne({ _id: check._id });
		await maybeFinalizeRun(check.run);
		return null;
	}
	return { check, website: check.website };
}
export async function recoverStaleChecks() {
	// A live worker refreshes lockedAt every few seconds (see touchCheck), so only a check from a stopped worker goes silent this long.
	const cutoff = new Date(Date.now() - config.lockStaleMs);
	const staleChecks = await Check.find({ status: 'processing', lockedAt: { $lt: cutoff } }).select('_id run website attempts').lean();
	for (const check of staleChecks) {
		if (check.attempts < config.maxRetries) {
			await Check.findOneAndUpdate({ _id: check._id, status: 'processing', lockedAt: { $lt: cutoff } }, { $set: { status: 'pending', progressPercent: 0, progressStage: 'Recovered; retry queued', scheduledAt: new Date(), lockedAt: null, lockedBy: null, errorSummary: 'Worker stopped before completing this check; retry queued.' } });
		} else {
			await recordFailedCheck(check, 'Worker stopped before completing this check; retry limit reached.', { stage: 'Worker stopped', onlyIfLockedBefore: cutoff });
		}
		await maybeFinalizeRun(check.run);
	}
	return staleChecks.length;
}
// Called every few seconds while a worker is busy with a check, so a slow site is never mistaken for a stopped worker.
export async function touchCheck(checkId) {
	return Check.updateOne({ _id: checkId, status: 'processing' }, { $set: { lockedAt: new Date() } });
}
export async function updateCheckProgress(checkId, { percent, stage, mobileProgressPercent }) {
	const update = {
		$max: { progressPercent: Math.max(0, Math.min(100, percent)) },
		$set: { progressStage: stage, lockedAt: new Date() }
	};
	if (Number.isFinite(mobileProgressPercent)) {
		update.$max.mobileProgressPercent = Math.max(0, Math.min(100, mobileProgressPercent));
	}
	return Check.findOneAndUpdate({ _id: checkId, status: 'processing' }, update);
}
export async function completeCheck(check, result) { const updated = await Check.findOneAndUpdate({ _id: check._id, status: 'processing' }, { $set: { status: result.overallStatus, progressPercent: 100, progressStage: 'Complete', finishedAt: new Date(), homepage: result.homepage, desktop: result.desktop, mobile: result.mobile, issues: result.issues, screenshots: result.screenshots, rawResult: result, errorSummary: result.issues.join('\n'), lockedAt: null, lockedBy: null } }); if (updated) await Website.findByIdAndUpdate(check.website, { lastCheck: check._id }); return Boolean(updated); }
const shortReason = (error) => String(error?.message || error || 'Unknown error').split('\n')[0].replace(/\s+/g, ' ').slice(0, 220);

// A check that could not finish still leaves a proper result behind, so the website shows what went wrong instead of "Not checked".
export function buildFailureResult(reason, { timedOut = false } = {}) {
	const skipped = { contact: { status: 'skipped' }, news: { status: 'skipped' } };
	return {
		overallStatus: 'critical',
		homepage: { statusCode: null, loadTimeMs: null, sslValid: null, blank: false, timedOut, finalUrl: null, error: reason },
		desktop: skipped,
		mobile: skipped,
		issues: [`Check could not be completed: ${reason}`],
		screenshots: [],
		failure: reason
	};
}

async function recordFailedCheck(check, reason, { timedOut = false, stage = 'Failed', onlyIfLockedBefore = null } = {}) {
	const result = buildFailureResult(reason, { timedOut });
	const filter = { _id: check._id, status: 'processing', ...(onlyIfLockedBefore ? { lockedAt: { $lt: onlyIfLockedBefore } } : {}) };
	const updated = await Check.findOneAndUpdate(filter, { $set: { status: result.overallStatus, progressPercent: 100, progressStage: stage, finishedAt: new Date(), homepage: result.homepage, desktop: result.desktop, mobile: result.mobile, issues: result.issues, screenshots: [], rawResult: result, errorSummary: reason, lockedAt: null, lockedBy: null } });
	if (updated) await Website.findByIdAndUpdate(check.website, { lastCheck: check._id });
	return updated ? result : null;
}

// Returns { retry: true } when another attempt was queued, or { retry: false, result } with the recorded failure result.
export async function failCheck(check, error, { timedOut = false } = {}) {
	const reason = timedOut ? `The check took longer than ${Math.round(config.checkMaxDurationMs / 1000)} seconds and was stopped.` : shortReason(error);
	if (check.attempts < config.maxRetries) {
		await Check.findOneAndUpdate({ _id: check._id, status: 'processing' }, { $set: { status: 'pending', progressPercent: 0, progressStage: 'Retry queued', scheduledAt: new Date(Date.now() + config.retryDelaySeconds * 1000), errorSummary: `Retry scheduled: ${reason}`, lockedAt: null, lockedBy: null } });
		return { retry: true };
	}
	const result = await recordFailedCheck(check, reason, { timedOut });
	return { retry: false, result };
}
export async function cancelRun(runId) { const now = new Date(); const run = await Run.findOneAndUpdate({ _id: runId, status: 'running' }, { $set: { status: 'cancelled', finishedAt: now } }, { new: true }); if (!run) return null; await Check.updateMany({ run: runId, status: { $in: ['pending', 'processing'] } }, { $set: { status: 'cancelled', progressStage: 'Cancelled', finishedAt: now, lockedAt: null, lockedBy: null } }); return run; }
export async function maybeFinalizeRun(runId) {
	const run = await Run.findById(runId).select('status').lean();
	if (!run || run.status !== 'running') return null;
	const statusCounts = await Check.aggregate([
		{ $match: { run: runId } },
		{ $group: { _id: '$status', count: { $sum: 1 } } }
	]);
	const counts = Object.fromEntries(statusCounts.map(({ _id, count }) => [_id, count]));
	const completed = ['healthy', 'warning', 'critical'].reduce((sum, status) => sum + (counts[status] || 0), 0);
	const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
	const terminal = completed + (counts.cancelled || 0);
	if (total === 0) {
		return Run.findOneAndUpdate(
			{ _id: runId, status: 'running' },
			{ $set: { status: 'cancelled', total: 0, completed: 0, finishedAt: new Date() } },
			{ new: true }
		);
	}
	await Run.findOneAndUpdate({ _id: runId, status: 'running' }, { $set: { total } });
	if (terminal !== total) return null;
	return Run.findOneAndUpdate({ _id: runId, status: 'running' }, { $set: { status: completed ? 'completed' : 'cancelled', total, completed, healthy: counts.healthy || 0, warning: counts.warning || 0, critical: counts.critical || 0, finishedAt: new Date() } }, { new: true });
}
export async function runDetails(runId) { const run = await Run.findById(runId).lean(); if (!run) return null; const checks = await Check.find({ run: runId }).populate('website', 'name url').sort({ status: 1 }).lean(); return { run, checks }; }