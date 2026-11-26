import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainRun, Website } from './models.js';
import { cancelDomainRun, enqueueDomainRun } from './domain-queue.js';

test('enqueues only marked websites for a selected domain run', async (t) => {
  const originals = {
    findOne: DomainRun.findOne,
    create: DomainRun.create,
    find: Website.find,
    updateMany: Website.updateMany
  };
  t.after(() => {
    DomainRun.findOne = originals.findOne;
    DomainRun.create = originals.create;
    Website.find = originals.find;
    Website.updateMany = originals.updateMany;
  });

  const selectedIds = ['site-a', 'site-b'];
  let websiteFilter;
  let createdRun;
  let updatedWebsites;
  DomainRun.findOne = () => ({ sort() { return this; }, lean: async () => null });
  DomainRun.create = async (data) => {
    createdRun = data;
    return { ...data, _id: 'domain-run', startedAt: new Date(), toObject() { return { ...this }; } };
  };
  Website.find = (filter) => {
    websiteFilter = filter;
    return {
      sort() { return this; },
      limit() { return this; },
      select() { return this; },
      lean: async () => selectedIds.map((_id) => ({ _id }))
    };
  };
  Website.updateMany = async (filter) => {
    updatedWebsites = filter;
  };

  const result = await enqueueDomainRun({ websiteIds: selectedIds });

  assert.equal(result.created, true);
  assert.deepEqual(websiteFilter, { _id: { $in: selectedIds } });
  assert.equal(createdRun.scope, 'selected');
  assert.equal(createdRun.total, selectedIds.length);
  assert.deepEqual(updatedWebsites, { _id: { $in: selectedIds } });
});

test('cancels pending and processing lookups and retains completed progress', async (t) => {
  const originals = {
    findOneAndUpdate: DomainRun.findOneAndUpdate,
    updateMany: Website.updateMany,
    aggregate: Website.aggregate
  };
  t.after(() => {
    DomainRun.findOneAndUpdate = originals.findOneAndUpdate;
    Website.updateMany = originals.updateMany;
    Website.aggregate = originals.aggregate;
  });

  const updatedRuns = [];
  let cancelledWebsites;
  DomainRun.findOneAndUpdate = async (filter, update) => {
    updatedRuns.push({ filter, update });
    if (updatedRuns.length === 1) return { _id: 'domain-run', status: 'cancelled' };
    return { _id: 'domain-run', status: 'cancelled', completed: 3, failed: 1 };
  };
  Website.updateMany = async (filter, update) => {
    cancelledWebsites = { filter, update };
  };
  Website.aggregate = async () => [
    { _id: 'completed', count: 2 },
    { _id: 'failed', count: 1 },
    { _id: 'cancelled', count: 7 }
  ];

  const run = await cancelDomainRun('domain-run');

  assert.equal(run.status, 'cancelled');
  assert.equal(run.completed, 3);
  assert.equal(run.failed, 1);
  assert.deepEqual(cancelledWebsites.filter, {
    'domainHosting.run': 'domain-run',
    'domainHosting.status': { $in: ['pending', 'processing'] }
  });
  assert.equal(cancelledWebsites.update.$set['domainHosting.status'], 'cancelled');
  assert.deepEqual(updatedRuns[0].filter, { _id: 'domain-run', status: 'running' });
  assert.equal(updatedRuns[0].update.$set.status, 'cancelled');
});

test('does not update websites when a domain run is no longer running', async (t) => {
  const originalFindOneAndUpdate = DomainRun.findOneAndUpdate;
  const originalUpdateMany = Website.updateMany;
  t.after(() => {
    DomainRun.findOneAndUpdate = originalFindOneAndUpdate;
    Website.updateMany = originalUpdateMany;
  });

  let websitesUpdated = false;
  DomainRun.findOneAndUpdate = async () => null;
  Website.updateMany = async () => { websitesUpdated = true; };

  assert.equal(await cancelDomainRun('domain-run'), null);
  assert.equal(websitesUpdated, false);
});
