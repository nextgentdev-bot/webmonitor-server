import { Setting, TrafficRun, TrafficWebsite, Website } from './models.js';
import { config } from './config.js';
import { inspectGoogleTraffic, trafficDateRange } from './google-traffic.js';

export async function migrateLegacyTrafficWebsites() {
  const migrationKey = 'trafficWebsiteCollectionMigrationV1';
  const migration = await Setting.findOne({ key: migrationKey }).lean();
  if (migration?.value === 'complete') return 0;

  const legacyWebsites = await Website.find({
    $or: [
      { 'traffic.analyticsPropertyId': { $exists: true, $nin: ['', null] } },
      { 'traffic.searchConsoleSiteUrl': { $exists: true, $nin: ['', null] } },
      { 'traffic.status': { $in: ['pending', 'processing', 'completed', 'failed'] } },
      { 'traffic.run': { $exists: true, $ne: null } },
      { 'traffic.analytics': { $ne: null } },
      { 'traffic.searchConsole': { $ne: null } },
      { 'traffic.customReport': { $ne: null } },
      { 'traffic.reportRanges.analyticsStartDate': { $exists: true, $nin: ['', null] } },
      { 'traffic.reportRanges.searchConsoleStartDate': { $exists: true, $nin: ['', null] } },
      { 'traffic.realtimeActiveUsers': { $exists: true, $ne: null } }
    ]
  }).select('_id name url active sortOrder traffic').lean();
  const urls = legacyWebsites.map(({ url }) => url);
  const existing = urls.length
    ? await TrafficWebsite.find({ url: { $in: urls } }).select('_id url').lean()
    : [];
  const existingIds = new Set(existing.map(({ _id }) => String(_id)));
  const existingUrls = new Set(existing.map(({ url }) => url));
  const operations = legacyWebsites
    .filter((website) => !existingIds.has(String(website._id)) && !existingUrls.has(website.url))
    .map((website) => ({
      updateOne: {
        filter: { _id: website._id },
        update: { $setOnInsert: {
          _id: website._id,
          name: website.name,
          url: website.url,
          active: website.active,
          sortOrder: website.sortOrder,
          traffic: website.traffic
        } },
        upsert: true
      }
    }));
  if (operations.length) await TrafficWebsite.bulkWrite(operations, { ordered: false });
  await Setting.findOneAndUpdate(
    { key: migrationKey },
    { $set: { value: 'complete' } },
    { upsert: true }
  );
  return operations.length;
}

export async function enqueueTrafficRun(now = new Date(), customRanges = null) {
  await migrateLegacyTrafficWebsites();
  const activeRun = await TrafficRun.findOne({ status: 'running' }).sort({ startedAt: -1 }).lean();
  if (activeRun) return { created: false, reason: 'A Traffic Check is already running.', run: activeRun };

  const websites = await TrafficWebsite.find({
    active: true,
    $or: [
      { 'traffic.analyticsPropertyId': { $exists: true, $nin: ['', null] } },
      { 'traffic.searchConsoleSiteUrl': { $exists: true, $nin: ['', null] } }
    ]
  }).sort({ sortOrder: 1, _id: 1 }).limit(config.maxWebsites).select('_id').lean();
  if (!websites.length) {
    return { created: false, reason: 'Map at least one GA4 property or Search Console site to an active website first.' };
  }

  const defaultRange = trafficDateRange(now);
  const analyticsRange = customRanges?.analyticsRange || defaultRange;
  const searchConsoleRange = customRanges?.searchConsoleRange || defaultRange;
  const run = await TrafficRun.create({
    status: 'running',
    runType: customRanges ? 'manual' : 'daily',
    total: websites.length,
    startDate: analyticsRange.startDate,
    endDate: analyticsRange.endDate,
    analyticsStartDate: analyticsRange.startDate,
    analyticsEndDate: analyticsRange.endDate,
    searchConsoleStartDate: searchConsoleRange.startDate,
    searchConsoleEndDate: searchConsoleRange.endDate
  });
  await TrafficWebsite.updateMany({ _id: { $in: websites.map(({ _id }) => _id) } }, {
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

export async function enqueueDailyTrafficRun(now = new Date()) {
  await migrateLegacyTrafficWebsites();
  const date = trafficDateRange(now).startDate;
  const scheduleKey = 'trafficDailyRunDate';
  const scheduled = await Setting.findOne({ key: scheduleKey }).lean();
  if (scheduled?.value === date) return { created: false, reason: "Today's automatic Traffic Check is already scheduled." };

  const existingRun = await TrafficRun.findOne({
    $or: [{ runType: 'daily' }, { runType: { $exists: false } }],
    startDate: date,
    endDate: date,
    status: { $in: ['running', 'completed'] }
  }).lean();
  if (existingRun) {
    await Setting.findOneAndUpdate({ key: scheduleKey }, { $set: { value: date } }, { upsert: true });
    return { created: false, reason: 'A Traffic Check for today already exists.', run: existingRun };
  }

  const result = await enqueueTrafficRun(now);
  if (result.created || result.run?.runType === 'daily' || (!result.run?.runType && result.run?.startDate === date)) {
    await Setting.findOneAndUpdate({ key: scheduleKey }, { $set: { value: date } }, { upsert: true });
  }
  return result;
}

export async function cancelTrafficRun(runId) {
  const run = await TrafficRun.findOneAndUpdate(
    { _id: runId, status: 'running' },
    { $set: { status: 'cancelled', finishedAt: new Date() } },
    { new: true }
  );
  if (!run) return null;

  await TrafficWebsite.updateMany(
    { 'traffic.run': runId, 'traffic.status': { $in: ['pending', 'processing'] } },
    { $set: {
      'traffic.status': 'cancelled',
      'traffic.startedAt': null,
      'traffic.lockedAt': null,
      'traffic.lockedBy': ''
    } }
  );
  const statusCounts = await TrafficWebsite.aggregate([
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
  const runs = await TrafficRun.find({ status: 'running' }).select('_id startDate endDate analyticsStartDate analyticsEndDate searchConsoleStartDate searchConsoleEndDate').lean();
  if (!runs.length) return null;
  const runById = new Map(runs.map((run) => [String(run._id), run]));
  const website = await TrafficWebsite.findOneAndUpdate(
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
  if (!run) return null;
  const analyticsRange = {
    startDate: run.analyticsStartDate || run.startDate,
    endDate: run.analyticsEndDate || run.endDate
  };
  const searchConsoleRange = {
    startDate: run.searchConsoleStartDate || run.startDate,
    endDate: run.searchConsoleEndDate || run.endDate
  };
  return {
    website,
    runId: run._id,
    range: { startDate: run.startDate, endDate: run.endDate, analyticsRange, searchConsoleRange }
  };
}

export async function touchTrafficCheck(websiteId, runId) {
  return TrafficWebsite.updateOne(
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
  const analyticsRange = range?.analyticsRange || range;
  const searchConsoleRange = range?.searchConsoleRange || range;
  const updated = await TrafficWebsite.findOneAndUpdate(
    { _id: website._id, 'traffic.run': runId, 'traffic.status': 'processing' },
    { $set: {
      'traffic.status': failed ? 'failed' : 'completed',
      'traffic.analytics': result.analytics,
      'traffic.analyticsError': result.analyticsError,
      'traffic.analyticsStartDate': result.analyticsStartDate || '',
      'traffic.analyticsEndDate': result.analyticsEndDate || '',
      'traffic.searchConsole': result.searchConsole,
      'traffic.searchConsoleError': result.searchConsoleError,
      'traffic.searchConsoleStartDate': result.searchConsoleStartDate || searchConsoleRange?.startDate || '',
      'traffic.searchConsoleEndDate': result.searchConsoleEndDate || searchConsoleRange?.endDate || '',
      'traffic.checkedAt': new Date(),
      ...(range ? {
        'traffic.startDate': analyticsRange?.startDate || range.startDate,
        'traffic.endDate': analyticsRange?.endDate || range.endDate
      } : {}),
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
  const updated = await TrafficWebsite.findOneAndUpdate(
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
  const result = await TrafficWebsite.updateMany(
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
    const statusCounts = await TrafficWebsite.aggregate([
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
