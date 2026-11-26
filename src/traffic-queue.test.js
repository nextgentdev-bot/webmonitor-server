import assert from 'node:assert/strict';
import test from 'node:test';
import { TrafficRun, Website } from './models.js';
import { cancelTrafficRun, completeTrafficCheck, enqueueTrafficRun } from './traffic-queue.js';

test('queues active websites with either traffic source mapped', async (t) => {
  const originals = {
    findOne: TrafficRun.findOne,
    create: TrafficRun.create,
    find: Website.find,
    updateMany: Website.updateMany
  };
  t.after(() => {
    TrafficRun.findOne = originals.findOne;
    TrafficRun.create = originals.create;
    Website.find = originals.find;
    Website.updateMany = originals.updateMany;
  });

  let websiteFilter;
  let runInput;
  let update;
  TrafficRun.findOne = () => ({ sort() { return this; }, lean: async () => null });
  TrafficRun.create = async (input) => {
    runInput = input;
    return { ...input, _id: 'traffic-run', startedAt: new Date(), toObject() { return { ...this }; } };
  };
  Website.find = (filter) => {
    websiteFilter = filter;
    return {
      sort() { return this; },
      limit() { return this; },
      select() { return this; },
      lean: async () => [{ _id: 'site-a' }, { _id: 'site-b' }]
    };
  };
  Website.updateMany = async (_filter, value) => { update = value; };

  const result = await enqueueTrafficRun();

  assert.equal(result.created, true);
  assert.equal(websiteFilter.active, true);
  assert.deepEqual(websiteFilter.$or, [
    { 'traffic.analyticsPropertyId': { $exists: true, $nin: ['', null] } },
    { 'traffic.searchConsoleSiteUrl': { $exists: true, $nin: ['', null] } }
  ]);
  assert.equal(runInput.total, 2);
  assert.match(runInput.startDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(runInput.endDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(update.$set['traffic.status'], 'pending');
  assert.equal(update.$set['traffic.run'], 'traffic-run');
  assert.equal(update.$set['traffic.analytics'], undefined);
});

test('saves a successful source when the other source fails', async (t) => {
  const originalWebsiteUpdate = Website.findOneAndUpdate;
  const originalRunUpdate = TrafficRun.findOneAndUpdate;
  const originalRunFinish = TrafficRun.updateOne;
  t.after(() => {
    Website.findOneAndUpdate = originalWebsiteUpdate;
    TrafficRun.findOneAndUpdate = originalRunUpdate;
    TrafficRun.updateOne = originalRunFinish;
  });

  let websiteUpdate;
  Website.findOneAndUpdate = async (_filter, update) => { websiteUpdate = update; return {}; };
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
    updateMany: Website.updateMany,
    aggregate: Website.aggregate,
    updateOne: TrafficRun.updateOne,
    findById: TrafficRun.findById
  };
  t.after(() => {
    TrafficRun.findOneAndUpdate = originals.findOneAndUpdate;
    Website.updateMany = originals.updateMany;
    Website.aggregate = originals.aggregate;
    TrafficRun.updateOne = originals.updateOne;
    TrafficRun.findById = originals.findById;
  });

  let websiteFilter;
  let progressUpdate;
  const runId = { toString: () => 'traffic-run' };
  TrafficRun.findOneAndUpdate = async () => ({ _id: runId, status: 'cancelled' });
  Website.updateMany = async (filter) => { websiteFilter = filter; };
  Website.aggregate = async (pipeline) => {
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
