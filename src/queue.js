import os from 'node:os';
import { Check, Run, Website } from './models.js';
import { config } from './config.js';

export async function enqueueRun({ type = 'manual', websiteIds = null, localRunDate = null } = {}) { const filter = websiteIds?.length ? { _id: { $in: websiteIds } } : { active: true }; const websites = await Website.find(filter).limit(config.maxWebsites).lean(); if (!websites.length) return { created: false, reason: websiteIds?.length ? 'No selected websites were found.' : 'No active websites are available.' }; if (type === 'daily' && await Run.exists({ status: 'running', type: 'daily' })) return { created: false, reason: 'A daily monitoring run is already in progress.' }; const run = await Run.create({ type, total: websites.length, localRunDate }); await Check.insertMany(websites.map((website) => ({ run: run._id, website: website._id }))); return { created: true, runId: run._id.toString(), total: websites.length }; }
export async function claimNextCheck(workerId = `${os.hostname()}-${process.pid}`) { const runningRuns = await Run.find({ status: 'running' }).select('_id').lean(); if (!runningRuns.length) return null; const check = await Check.findOneAndUpdate({ run: { $in: runningRuns.map((run) => run._id) }, status: 'pending', scheduledAt: { $lte: new Date() } }, { $set: { status: 'processing', lockedAt: new Date(), lockedBy: workerId, startedAt: new Date(), progressPercent: 0, progressStage: 'Starting' }, $inc: { attempts: 1 } }, { sort: { scheduledAt: 1, createdAt: 1 }, new: true }).populate('website'); return check ? { check, website: check.website } : null; }
export async function recoverStaleChecks() {
	const lockTimeout = Math.max(config.checkTimeoutMs, config.navigationTimeoutMs) * 3;
	const cutoff = new Date(Date.now() - lockTimeout);
	const staleChecks = await Check.find({ status: 'processing', lockedAt: { $lt: cutoff } }).select('_id run attempts').lean();
	for (const check of staleChecks) {
		const shouldRetry = check.attempts < config.maxRetries;
		const update = shouldRetry
			? { $set: { status: 'pending', progressPercent: 0, progressStage: 'Recovered; retry queued', scheduledAt: new Date(), lockedAt: null, lockedBy: null, errorSummary: 'Worker stopped before completing this check; retry queued.' } }
			: { $set: { status: 'critical', progressPercent: 100, progressStage: 'Worker stopped', finishedAt: new Date(), lockedAt: null, lockedBy: null, errorSummary: 'Worker stopped before completing this check; retry limit reached.' } };
		await Check.findOneAndUpdate({ _id: check._id, status: 'processing', lockedAt: { $lt: cutoff } }, update);
		await maybeFinalizeRun(check.run);
	}
	return staleChecks.length;
}
export async function updateCheckProgress(checkId, { percent, stage }) { return Check.findOneAndUpdate({ _id: checkId, status: 'processing' }, { $max: { progressPercent: Math.max(0, Math.min(100, percent)) }, $set: { progressStage: stage, lockedAt: new Date() } }); }
export async function completeCheck(check, result) { const updated = await Check.findOneAndUpdate({ _id: check._id, status: 'processing' }, { $set: { status: result.overallStatus, progressPercent: 100, progressStage: 'Complete', finishedAt: new Date(), homepage: result.homepage, desktop: result.desktop, mobile: result.mobile, issues: result.issues, screenshots: result.screenshots, rawResult: result, errorSummary: result.issues.join('\n'), lockedAt: null, lockedBy: null } }); if (updated) await Website.findByIdAndUpdate(check.website, { lastCheck: check._id }); }
export async function failCheck(check, error) { const message = String(error?.stack || error?.message || error).slice(0, 8000); if (check.attempts < config.maxRetries) return Check.findOneAndUpdate({ _id: check._id, status: 'processing' }, { $set: { status: 'pending', progressPercent: 0, progressStage: 'Retry queued', scheduledAt: new Date(Date.now() + config.retryDelaySeconds * 1000), errorSummary: `Retry scheduled: ${message}`, lockedAt: null, lockedBy: null } }); return Check.findOneAndUpdate({ _id: check._id, status: 'processing' }, { $set: { status: 'critical', progressPercent: 100, progressStage: 'Failed', finishedAt: new Date(), errorSummary: message, lockedAt: null, lockedBy: null } }); }
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
	if (total === 0) {
		return Run.findOneAndUpdate(
			{ _id: runId, status: 'running' },
			{ $set: { status: 'cancelled', total: 0, completed: 0, finishedAt: new Date() } },
			{ new: true }
		);
	}
	await Run.findOneAndUpdate({ _id: runId, status: 'running' }, { $set: { total } });
	if (completed !== total) return null;
	return Run.findOneAndUpdate({ _id: runId, status: 'running' }, { $set: { status: 'completed', total, completed, healthy: counts.healthy || 0, warning: counts.warning || 0, critical: counts.critical || 0, finishedAt: new Date() } }, { new: true });
}
export async function runDetails(runId) { const run = await Run.findById(runId).lean(); if (!run) return null; const checks = await Check.find({ run: runId }).populate('website', 'name url').sort({ status: 1 }).lean(); return { run, checks }; }
