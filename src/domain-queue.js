import { DomainRun, Website } from './models.js';
import { config } from './config.js';

export async function enqueueDomainRun({ websiteIds = null } = {}) {
	const activeRun = await DomainRun.findOne({ status: 'running' }).sort({ startedAt: -1 }).lean();
	if (activeRun) return { created: false, reason: 'A Domain & Hosting check is already running.', run: activeRun };

	const filter = websiteIds?.length ? { _id: { $in: websiteIds } } : {};
	const websites = await Website.find(filter).sort({ sortOrder: 1, _id: 1 }).limit(config.maxWebsites).select('_id').lean();
	if (!websites.length) return { created: false, empty: !websiteIds?.length, reason: websiteIds?.length ? 'No selected websites are available for a domain check.' : 'Add at least one website before checking domain details.' };

	const run = await DomainRun.create({ status: 'running', total: websites.length, scope: websiteIds?.length ? 'selected' : 'all' });
	await Website.updateMany({ _id: { $in: websites.map(({ _id }) => _id) } }, {
		$set: {
			'domainHosting.status': 'pending',
			'domainHosting.run': run._id,
			'domainHosting.queuedAt': run.startedAt,
			'domainHosting.startedAt': null,
			'domainHosting.error': ''
		}
	});
	return { created: true, run: run.toObject() };
}

export async function cancelDomainRun(runId) {
	const run = await DomainRun.findOneAndUpdate(
		{ _id: runId, status: 'running' },
		{ $set: { status: 'cancelled', finishedAt: new Date() } },
		{ new: true }
	);
	if (!run) return null;

	await Website.updateMany(
		{ 'domainHosting.run': runId, 'domainHosting.status': { $in: ['pending', 'processing'] } },
		{ $set: {
			'domainHosting.status': 'cancelled',
			'domainHosting.startedAt': null,
			'domainHosting.lockedAt': null,
			'domainHosting.lockedBy': ''
		} }
	);
	const statusCounts = await Website.aggregate([
		{ $match: { 'domainHosting.run': runId } },
		{ $group: { _id: '$domainHosting.status', count: { $sum: 1 } } }
	]);
	const byStatus = Object.fromEntries(statusCounts.map(({ _id, count }) => [_id, count]));
	return DomainRun.findOneAndUpdate(
		{ _id: runId, status: 'cancelled' },
		{ $set: { completed: (byStatus.completed || 0) + (byStatus.failed || 0), failed: byStatus.failed || 0 } },
		{ new: true }
	);
}

export async function claimNextDomainCheck(workerId) {
	const runs = await DomainRun.find({ status: 'running' }).select('_id').lean();
	if (!runs.length) return null;
	const website = await Website.findOneAndUpdate(
		{ 'domainHosting.run': { $in: runs.map(({ _id }) => _id) }, 'domainHosting.status': 'pending' },
		{ $set: { 'domainHosting.status': 'processing', 'domainHosting.startedAt': new Date(), 'domainHosting.lockedAt': new Date(), 'domainHosting.lockedBy': workerId } },
		{ sort: { 'domainHosting.queuedAt': 1, sortOrder: 1 }, new: true }
	).lean();
	return website ? { website, runId: website.domainHosting.run } : null;
}

export async function touchDomainCheck(websiteId, runId) {
	return Website.updateOne(
		{ _id: websiteId, 'domainHosting.run': runId, 'domainHosting.status': 'processing' },
		{ $set: { 'domainHosting.lockedAt': new Date() } }
	);
}

async function finalizeDomainRun(runId, failed) {
	const run = await DomainRun.findOneAndUpdate(
		{ _id: runId, status: 'running' },
		{ $inc: { completed: 1, ...(failed ? { failed: 1 } : {}) } },
		{ new: true }
	);
	if (run && run.completed >= run.total) {
		await DomainRun.updateOne({ _id: runId, status: 'running' }, { $set: { status: 'completed', finishedAt: new Date() } });
	}
}

export async function completeDomainCheck(website, runId, result) {
	const updated = await Website.findOneAndUpdate(
		{ _id: website._id, 'domainHosting.run': runId, 'domainHosting.status': 'processing' },
		{ $set: {
			'domainHosting.status': 'completed',
			'domainHosting.result': result,
			'domainHosting.checkedAt': new Date(),
			'domainHosting.startedAt': null,
			'domainHosting.lockedAt': null,
			'domainHosting.lockedBy': '',
			'domainHosting.error': ''
		} }
	);
	if (!updated) return false;
	await finalizeDomainRun(runId, false);
	return true;
}

export async function failDomainCheck(website, runId, error) {
	const reason = String(error?.message || error || 'Domain lookup failed.').split('\n')[0].slice(0, 300);
	const updated = await Website.findOneAndUpdate(
		{ _id: website._id, 'domainHosting.run': runId, 'domainHosting.status': 'processing' },
		{ $set: {
			'domainHosting.status': 'failed',
			'domainHosting.checkedAt': new Date(),
			'domainHosting.startedAt': null,
			'domainHosting.lockedAt': null,
			'domainHosting.lockedBy': '',
			'domainHosting.error': reason
		} }
	);
	if (!updated) return false;
	await finalizeDomainRun(runId, true);
	return true;
}

export async function recoverStaleDomainChecks() {
	const cutoff = new Date(Date.now() - config.lockStaleMs);
	const result = await Website.updateMany(
		{ 'domainHosting.status': 'processing', 'domainHosting.lockedAt': { $lt: cutoff } },
		{ $set: {
			'domainHosting.status': 'pending',
			'domainHosting.queuedAt': new Date(),
			'domainHosting.startedAt': null,
			'domainHosting.lockedAt': null,
			'domainHosting.lockedBy': '',
			'domainHosting.error': 'Worker stopped before completing the lookup; retry queued.'
		} }
	);
	return result.modifiedCount;
}

export async function reconcileDomainRuns(runIds) {
	const uniqueRuns = new Map(runIds.filter(Boolean).map((runId) => [String(runId), runId]));
	for (const runId of uniqueRuns.values()) {
		const statusCounts = await Website.aggregate([
			{ $match: { 'domainHosting.run': runId } },
			{ $group: { _id: '$domainHosting.status', count: { $sum: 1 } } }
		]);
		const byStatus = Object.fromEntries(statusCounts.map(({ _id, count }) => [_id, count]));
		const total = Object.values(byStatus).reduce((sum, count) => sum + count, 0);
		const completed = (byStatus.completed || 0) + (byStatus.failed || 0);
		await DomainRun.updateOne({ _id: runId, status: 'running' }, { $set: { total, completed, failed: byStatus.failed || 0 } });
		if (completed >= total) {
			await DomainRun.updateOne({ _id: runId, status: 'running' }, { $set: { status: 'completed', finishedAt: new Date() } });
		}
	}
}
