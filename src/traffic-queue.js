import { TrafficRun, Website } from './models.js';
import { config } from './config.js';
import { inspectGoogleTraffic, trafficDateRange } from './google-traffic.js';

export async function enqueueTrafficRun() {
  const activeRun = await TrafficRun.findOne({ status: 'running' }).sort({ startedAt: -1 }).lean();
  if (activeRun) return { created: false, reason: 'A Traffic Check is already running.', run: activeRun };

  const websites = await Website.find({
    active: true,
    $or: [
      { 'traffic.analyticsPropertyId': { $exists: true, $nin: ['', null] } },
      { 'traffic.searchConsoleSiteUrl': { $exists: true, $nin: ['', null] } }
    ]
  }).sort({ sortOrder: 1, _id: 1 }).limit(config.maxWebsites).select('_id').lean();
  if (!websites.length) {
    return { created: false, reason: 'Map at least one GA4 property or Search Console site to an active website first.' };
  }

  const range = trafficDateRange();
  const run = await TrafficRun.create({ status: 'running', total: websites.length, ...range });
  await Website.updateMany({ _id: { $in: websites.map(({ _id }) => _id) } }, {
    $set: {
      'traffic.status': 'pending',
      'traffic.run': run._id,
      'traffic.queuedAt': run.startedAt,
      'traffic.startedAt': null,
      'traffic.lockedAt': null,
      'traffic.lockedBy': ''
    }
  });
  return { created: true, run: run.toObject() };
}

export async function cancelTrafficRun(runId) {
  const run = await TrafficRun.findOneAndUpdate(
    { _id: runId, status: 'running' },
    { $set: { status: 'cancelled', finishedAt: new Date() } },
    { new: true }
  );
  if (!run) return null;

  await Website.updateMany(
    { 'traffic.run': runId, 'traffic.status': { $in: ['pending', 'processing'] } },
    { $set: {
      'traffic.status': 'cancelled',
      'traffic.startedAt': null,
      'traffic.lockedAt': null,
      'traffic.lockedBy': ''
    } }
  );
  const statusCounts = await Website.aggregate([
    { $match: { 'traffic.run': run._id } },
    { $group: { _id: '$traffic.status', count: { $sum: 1 } } }
  ]);
  const byStatus = Object.fromEntries(statusCounts.map(({ _id, count }) => [_id, count]));
  await TrafficRun.updateOne(
    { _id: run._id, status: 'cancelled' },
    { $set: { completed: (byStatus.completed || 0) + (byStatus.failed || 0), failed: byStatus.failed || 0 } }
  );
  return TrafficRun.findById(runId).lean();
}

export async function claimNextTrafficCheck(workerId) {
  const runs = await TrafficRun.find({ status: 'running' }).select('_id startDate endDate').lean();
  if (!runs.length) return null;
  const runById = new Map(runs.map((run) => [String(run._id), run]));
  const website = await Website.findOneAndUpdate(
    { 'traffic.run': { $in: runs.map(({ _id }) => _id) }, 'traffic.status': 'pending' },
    { $set: {
      'traffic.status': 'processing',
      'traffic.startedAt': new Date(),
      'traffic.lockedAt': new Date(),
      'traffic.lockedBy': workerId
    } },
    { sort: { 'traffic.queuedAt': 1, sortOrder: 1 }, new: true }
  ).lean();
  if (!website) return null;
  const run = runById.get(String(website.traffic.run));
  return run ? { website, runId: run._id, range: { startDate: run.startDate, endDate: run.endDate } } : null;
}

export async function touchTrafficCheck(websiteId, runId) {
  return Website.updateOne(
    { _id: websiteId, 'traffic.run': runId, 'traffic.status': 'processing' },
    { $set: { 'traffic.lockedAt': new Date() } }
  );
}

async function finalizeTrafficRun(runId, failed) {
  const run = await TrafficRun.findOneAndUpdate(
    { _id: runId, status: 'running' },
    { $inc: { completed: 1, ...(failed ? { failed: 1 } : {}) } },
    { new: true }
  );
  if (run && run.completed >= run.total) {
    await TrafficRun.updateOne({ _id: runId, status: 'running' }, { $set: { status: 'completed', finishedAt: new Date() } });
  }
}

export async function completeTrafficCheck(website, runId, result, range) {
  const failed = !result.analytics && !result.searchConsole;
  const updated = await Website.findOneAndUpdate(
    { _id: website._id, 'traffic.run': runId, 'traffic.status': 'processing' },
    { $set: {
      'traffic.status': failed ? 'failed' : 'completed',
      'traffic.analytics': result.analytics,
      'traffic.analyticsError': result.analyticsError,
      'traffic.searchConsole': result.searchConsole,
      'traffic.searchConsoleError': result.searchConsoleError,
      'traffic.checkedAt': new Date(),
      ...(range ? { 'traffic.startDate': range.startDate, 'traffic.endDate': range.endDate } : {}),
      'traffic.startedAt': null,
      'traffic.lockedAt': null,
      'traffic.lockedBy': ''
    } }
  );
  if (!updated) return false;
  await finalizeTrafficRun(runId, failed);
  return true;
}

export async function failTrafficCheck(website, runId, error) {
  const reason = String(error?.message || error || 'Traffic check failed.').split('\n')[0].slice(0, 300);
  const updated = await Website.findOneAndUpdate(
    { _id: website._id, 'traffic.run': runId, 'traffic.status': 'processing' },
    { $set: {
      'traffic.status': 'failed',
      'traffic.analyticsError': reason,
      'traffic.searchConsoleError': reason,
      'traffic.checkedAt': new Date(),
      'traffic.startedAt': null,
      'traffic.lockedAt': null,
      'traffic.lockedBy': ''
    } }
  );
  if (!updated) return false;
  await finalizeTrafficRun(runId, true);
  return true;
}

export async function recoverStaleTrafficChecks() {
  const cutoff = new Date(Date.now() - config.lockStaleMs);
  const result = await Website.updateMany(
    { 'traffic.status': 'processing', 'traffic.lockedAt': { $lt: cutoff } },
    { $set: {
      'traffic.status': 'pending',
      'traffic.queuedAt': new Date(),
      'traffic.startedAt': null,
      'traffic.lockedAt': null,
      'traffic.lockedBy': '',
      'traffic.analyticsError': 'Worker stopped before completing the check; retry queued.',
      'traffic.searchConsoleError': 'Worker stopped before completing the check; retry queued.'
    } }
  );
  return result.modifiedCount;
}

export async function reconcileTrafficRuns(runIds) {
  const uniqueRuns = new Map(runIds.filter(Boolean).map((runId) => [String(runId), runId]));
  for (const runId of uniqueRuns.values()) {
    const statusCounts = await Website.aggregate([
      { $match: { 'traffic.run': runId } },
      { $group: { _id: '$traffic.status', count: { $sum: 1 } } }
    ]);
    const byStatus = Object.fromEntries(statusCounts.map(({ _id, count }) => [_id, count]));
    const total = Object.values(byStatus).reduce((sum, count) => sum + count, 0);
    const completed = (byStatus.completed || 0) + (byStatus.failed || 0);
    await TrafficRun.updateOne({ _id: runId, status: 'running' }, { $set: { total, completed, failed: byStatus.failed || 0 } });
    if (completed >= total) {
      await TrafficRun.updateOne({ _id: runId, status: 'running' }, { $set: { status: 'completed', finishedAt: new Date() } });
    }
  }
}
