import assert from 'node:assert/strict';
import test from 'node:test';
import { Setting, TrafficRun, TrafficWebsite, Website } from './models.js';
import { cancelTrafficRun, claimNextTrafficCheck, completeTrafficCheck, deleteTrafficWebsites, enqueueDailyTrafficRun, enqueueTrafficRun, migrateLegacyTrafficWebsites } from './traffic-queue.js';

test('queues active websites with either traffic source mapped', async (t) => {
  const originals = {
    settingFindOne: Setting.findOne,
    findOne: TrafficRun.findOne,
    create: TrafficRun.create,
    find: TrafficWebsite.find,
    updateMany: TrafficWebsite.updateMany
  };
  t.after(() => {
    Setting.findOne = originals.settingFindOne;
    TrafficRun.findOne = originals.findOne;
    TrafficRun.create = originals.create;
    TrafficWebsite.find = originals.find;
    TrafficWebsite.updateMany = originals.updateMany;
  });

  let websiteFilter;
  let runInput;
  let update;
  Setting.findOne = () => ({ lean: async () => ({ value: 'complete' }) });
  TrafficRun.findOne = () => ({ sort() { return this; }, lean: async () => null });
  TrafficRun.create = async (input) => {
    runInput = input;
    return { ...input, _id: 'traffic-run', startedAt: new Date(), toObject() { return { ...this }; } };
  };
  TrafficWebsite.find = (filter) => {
    websiteFilter = filter;
    return {
      sort() { return this; },
      limit() { return this; },
      select() { return this; },
      lean: async () => [{ _id: 'site-a' }, { _id: 'site-b' }]
    };
  };
  TrafficWebsite.updateMany = async (_filter, value) => { update = value; };

  const analyticsRange = { startDate: '2024-01-01', endDate: '2024-01-14' };
  const searchConsoleRange = { startDate: '2023-12-15', endDate: '2024-01-14' };
  const result = await enqueueTrafficRun(new Date('2024-01-30T00:00:00Z'), { analyticsRange, searchConsoleRange });

  assert.equal(result.created, true);
  assert.equal(websiteFilter.active, true);
  assert.deepEqual(websiteFilter.$or, [
    { 'traffic.analyticsPropertyId': { $exists: true, $nin: ['', null] } },
    { 'traffic.searchConsoleSiteUrl': { $exists: true, $nin: ['', null] } }
  ]);
  assert.equal(runInput.total, 2);
  assert.equal(runInput.runType, 'manual');
  assert.equal(runInput.startDate, analyticsRange.startDate);
  assert.equal(runInput.endDate, analyticsRange.endDate);
  assert.equal(runInput.analyticsStartDate, analyticsRange.startDate);
  assert.equal(runInput.analyticsEndDate, analyticsRange.endDate);
  assert.equal(runInput.searchConsoleStartDate, searchConsoleRange.startDate);
  assert.equal(runInput.searchConsoleEndDate, searchConsoleRange.endDate);
  assert.equal(update.$set['traffic.status'], 'pending');
  assert.equal(update.$set['traffic.run'], 'traffic-run');
  assert.equal(update.$set['traffic.analytics'], undefined);
});

test('queues at most one automatic Traffic Check per local date', async (t) => {
  const originals = {
    settingFindOne: Setting.findOne,
    settingFindOneAndUpdate: Setting.findOneAndUpdate,
    trafficFindOne: TrafficRun.findOne,
    trafficCreate: TrafficRun.create,
    websiteFind: TrafficWebsite.find,
    websiteUpdateMany: TrafficWebsite.updateMany
  };
  t.after(() => {
    Setting.findOne = originals.settingFindOne;
    Setting.findOneAndUpdate = originals.settingFindOneAndUpdate;
    TrafficRun.findOne = originals.trafficFindOne;
    TrafficRun.create = originals.trafficCreate;
    TrafficWebsite.find = originals.websiteFind;
    TrafficWebsite.updateMany = originals.websiteUpdateMany;
  });

  let scheduledDate;
  let existingRunFilter;
  let runInput;
  let createCount = 0;
  Setting.findOne = (filter) => ({ lean: async () => filter.key === 'trafficWebsiteCollectionMigrationV1'
    ? { value: 'complete' }
    : scheduledDate ? { value: scheduledDate } : null });
  Setting.findOneAndUpdate = async (_filter, update) => { scheduledDate = update.$set.value; };
  TrafficRun.findOne = (filter) => ({
    sort() { return this; },
    lean: async () => {
      if (filter.startDate) existingRunFilter = filter;
      return null;
    }
  });
  TrafficRun.create = async (input) => {
    createCount += 1;
    runInput = input;
    return { ...input, _id: 'traffic-run', startedAt: new Date(), toObject() { return { ...this }; } };
  };
  TrafficWebsite.find = () => ({
    sort() { return this; },
    limit() { return this; },
    select() { return this; },
    lean: async () => [{ _id: 'site-a' }]
  });
  TrafficWebsite.updateMany = async () => {};

  const now = new Date('2024-03-31T20:00:00.000Z');
  const first = await enqueueDailyTrafficRun(now);
  const second = await enqueueDailyTrafficRun(now);

  assert.equal(first.created, true);
  assert.equal(first.run.startDate, '2024-04-01');
  assert.equal(scheduledDate, '2024-04-01');
  assert.equal(second.created, false);
  assert.equal(createCount, 1);
  assert.deepEqual(existingRunFilter.$or, [{ runType: 'daily' }, { runType: { $exists: false } }]);
  assert.equal(runInput.runType, 'daily');
  assert.equal(runInput.analyticsStartDate, '2024-04-01');
  assert.equal(runInput.searchConsoleStartDate, '2024-04-01');
});

test('claims a bulk traffic check with independent source date ranges', async (t) => {
  const originals = {
    runFind: TrafficRun.find,
    websiteFindOneAndUpdate: TrafficWebsite.findOneAndUpdate
  };
  t.after(() => {
    TrafficRun.find = originals.runFind;
    TrafficWebsite.findOneAndUpdate = originals.websiteFindOneAndUpdate;
  });

  const analyticsRange = { startDate: '2024-01-01', endDate: '2024-01-14' };
  const searchConsoleRange = { startDate: '2023-12-15', endDate: '2024-01-14' };
  TrafficRun.find = () => ({
    select() {
      return { lean: async () => [{
        _id: 'traffic-run',
        startDate: analyticsRange.startDate,
        endDate: analyticsRange.endDate,
        analyticsStartDate: analyticsRange.startDate,
        analyticsEndDate: analyticsRange.endDate,
        searchConsoleStartDate: searchConsoleRange.startDate,
        searchConsoleEndDate: searchConsoleRange.endDate
      }] };
    }
  });
  TrafficWebsite.findOneAndUpdate = () => ({
    lean: async () => ({ _id: 'site-a', traffic: { run: 'traffic-run' } })
  });

  const claimed = await claimNextTrafficCheck('worker-1');

  assert.equal(claimed.runId, 'traffic-run');
  assert.deepEqual(claimed.range.analyticsRange, analyticsRange);
  assert.deepEqual(claimed.range.searchConsoleRange, searchConsoleRange);
});

test('saves a successful source when the other source fails', async (t) => {
  const originalWebsiteUpdate = TrafficWebsite.findOneAndUpdate;
  const originalRunUpdate = TrafficRun.findOneAndUpdate;
  const originalRunFinish = TrafficRun.updateOne;
  t.after(() => {
    TrafficWebsite.findOneAndUpdate = originalWebsiteUpdate;
    TrafficRun.findOneAndUpdate = originalRunUpdate;
    TrafficRun.updateOne = originalRunFinish;
  });

  let websiteUpdate;
  TrafficWebsite.findOneAndUpdate = async (_filter, update) => { websiteUpdate = update; return {}; };
  TrafficRun.findOneAndUpdate = async () => ({ completed: 1, total: 1 });
  TrafficRun.updateOne = async () => {};

  const range = { startDate: '2024-01-01', endDate: '2024-01-28' };
  const saved = await completeTrafficCheck(
    { _id: 'site-a' },
    'traffic-run',
    { analytics: { sessions: 12 }, analyticsError: '', searchConsole: null, searchConsoleError: 'Permission denied.' },
    range
  );

  assert.equal(saved, true);
  assert.equal(websiteUpdate.$set['traffic.status'], 'completed');
  assert.equal(websiteUpdate.$set['traffic.startDate'], range.startDate);
  assert.equal(websiteUpdate.$set['traffic.endDate'], range.endDate);
  assert.deepEqual(websiteUpdate.$set['traffic.analytics'], { sessions: 12 });
  assert.equal(websiteUpdate.$set['traffic.searchConsoleError'], 'Permission denied.');
});

test('cancels queued traffic checks and records completed results', async (t) => {
  const originals = {
    findOneAndUpdate: TrafficRun.findOneAndUpdate,
    updateMany: TrafficWebsite.updateMany,
    aggregate: TrafficWebsite.aggregate,
    updateOne: TrafficRun.updateOne,
    findById: TrafficRun.findById
  };
  t.after(() => {
    TrafficRun.findOneAndUpdate = originals.findOneAndUpdate;
    TrafficWebsite.updateMany = originals.updateMany;
    TrafficWebsite.aggregate = originals.aggregate;
    TrafficRun.updateOne = originals.updateOne;
    TrafficRun.findById = originals.findById;
  });

  let websiteFilter;
  let progressUpdate;
  const runId = { toString: () => 'traffic-run' };
  TrafficRun.findOneAndUpdate = async () => ({ _id: runId, status: 'cancelled' });
  TrafficWebsite.updateMany = async (filter) => { websiteFilter = filter; };
  TrafficWebsite.aggregate = async (pipeline) => {
    assert.equal(pipeline[0].$match['traffic.run'], runId);
    return [{ _id: 'completed', count: 2 }, { _id: 'cancelled', count: 3 }];
  };
  TrafficRun.updateOne = async (filter, update) => { progressUpdate = { filter, update }; };
  TrafficRun.findById = () => ({ lean: async () => ({ _id: 'traffic-run', status: 'cancelled', completed: 2, failed: 0 }) });

  const cancelled = await cancelTrafficRun('traffic-run');

  assert.deepEqual(websiteFilter, {
    'traffic.run': 'traffic-run',
    'traffic.status': { $in: ['pending', 'processing'] }
  });
  assert.equal(progressUpdate.filter._id, runId);
  assert.equal(progressUpdate.update.$set.completed, 2);
  assert.equal(cancelled.status, 'cancelled');
});

test('migrates configured legacy traffic websites to the dedicated collection once', async (t) => {
  const originals = {
    settingFindOne: Setting.findOne,
    settingFindOneAndUpdate: Setting.findOneAndUpdate,
    websiteFind: Website.find,
    trafficFind: TrafficWebsite.find,
    trafficBulkWrite: TrafficWebsite.bulkWrite
  };
  t.after(() => {
    Setting.findOne = originals.settingFindOne;
    Setting.findOneAndUpdate = originals.settingFindOneAndUpdate;
    Website.find = originals.websiteFind;
    TrafficWebsite.find = originals.trafficFind;
    TrafficWebsite.bulkWrite = originals.trafficBulkWrite;
  });

  let migrationComplete = false;
  let copied;
  Setting.findOne = () => ({ lean: async () => migrationComplete ? { value: 'complete' } : null });
  Setting.findOneAndUpdate = async (_filter, update) => { migrationComplete = update.$set.value === 'complete'; };
  Website.find = () => ({
    select() {
      return { lean: async () => [{
        _id: 'legacy-id',
        name: 'Legacy traffic site',
        url: 'https://legacy.example',
        active: true,
        sortOrder: 3,
        traffic: { analyticsPropertyId: '123' }
      }] };
    }
  });
  TrafficWebsite.find = () => ({ select() { return { lean: async () => [] }; } });
  TrafficWebsite.bulkWrite = async (operations) => { copied = operations; };

  assert.equal(await migrateLegacyTrafficWebsites(), 1);
  assert.equal(await migrateLegacyTrafficWebsites(), 0);
  assert.equal(copied[0].updateOne.filter._id, 'legacy-id');
  assert.equal(copied[0].updateOne.update.$setOnInsert.traffic.analyticsPropertyId, '123');
});

test('bulk deletes only selected traffic websites and reconciles their runs', async (t) => {
  const originals = {
    distinct: TrafficWebsite.distinct,
    deleteMany: TrafficWebsite.deleteMany,
    aggregate: TrafficWebsite.aggregate,
    updateOne: TrafficRun.updateOne
  };
  t.after(() => {
    TrafficWebsite.distinct = originals.distinct;
    TrafficWebsite.deleteMany = originals.deleteMany;
    TrafficWebsite.aggregate = originals.aggregate;
    TrafficRun.updateOne = originals.updateOne;
  });

  const runIds = [];
  let deleteFilter;
  TrafficWebsite.distinct = async (field, filter) => {
    assert.equal(field, 'traffic.run');
    assert.deepEqual(filter, { _id: { $in: ['site-a', 'site-b'] } });
    return ['run-a', 'run-b'];
  };
  TrafficWebsite.deleteMany = async (filter) => {
    deleteFilter = filter;
    return { deletedCount: 2 };
  };
  TrafficWebsite.aggregate = async (pipeline) => {
    runIds.push(pipeline[0].$match['traffic.run']);
    return [];
  };
  TrafficRun.updateOne = async () => {};

  const deleted = await deleteTrafficWebsites(['site-a', 'site-b']);

  assert.equal(deleted, 2);
  assert.deepEqual(deleteFilter, { _id: { $in: ['site-a', 'site-b'] } });
  assert.deepEqual(runIds.sort(), ['run-a', 'run-b']);
});
