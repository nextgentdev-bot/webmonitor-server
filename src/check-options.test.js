import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCheckPauseUpdate, issueCheckKey, pausedKeySet, planLastCheckUpdate } from './check-options.js';
import { getOverallStatus } from './monitor.js';

const pausedNews = { pausedChecks: { news: { paused: true, reason: 'No news page', pausedAt: new Date() } } };

test('old websites without pausedChecks have nothing paused', () => {
  assert.equal(pausedKeySet({}).size, 0);
  assert.deepEqual([...pausedKeySet(pausedNews)], ['news']);
});

test('issues are mapped to the check they belong to', () => {
  assert.equal(issueCheckKey('Main website is slow (9000 ms).'), 'loadTime');
  assert.equal(issueCheckKey('Main website took longer than the 30000 ms navigation timeout.'), 'loadTime');
  assert.equal(issueCheckKey('Main website responded with HTTP 500.'), 'homepage');
  assert.equal(issueCheckKey('Desktop News: Not added.'), 'news');
  assert.equal(issueCheckKey('Mobile Contact: HTTP 404'), 'contact');
  assert.equal(issueCheckKey('Check could not be completed: boom'), null);
});

test('pausing a check needs a reason', () => {
  assert.match(buildCheckPauseUpdate({}, { news: { paused: true, reason: '  ' } }).error, /reason is required/);
  const { update } = buildCheckPauseUpdate({}, { news: { paused: true, reason: ' Site has no news ' } });
  assert.equal(update['pausedChecks.news'].reason, 'Site has no news');
  assert.equal(update['pausedChecks.news'].paused, true);
});

test('an already paused check keeps its reason and can be resumed', () => {
  assert.match(buildCheckPauseUpdate(pausedNews, { news: { paused: true } }).error, /Nothing to change/);
  const { update } = buildCheckPauseUpdate(pausedNews, { news: { paused: false } });
  assert.deepEqual(update['pausedChecks.news'], { paused: false, reason: '', pausedAt: null });
});

test('rejects unknown checks and pausing every check one by one', () => {
  assert.match(buildCheckPauseUpdate({}, { sitemap: { paused: true, reason: 'x' } }).error, /Unknown check/);
  const all = Object.fromEntries(['homepage', 'loadTime', 'news', 'contact'].map((key) => [key, { paused: true, reason: 'x' }]));
  assert.match(buildCheckPauseUpdate({}, all).error, /whole website/);
});

test('the saved latest result is reconciled with the paused checks', () => {
  const check = { status: 'warning', issues: ['Desktop News: Not added.', 'Mobile News: Not added.'], desktop: { news: { status: 'missing' }, contact: { status: 'working' } }, mobile: { news: { status: 'missing' }, contact: { status: 'working' } }, pausedChecks: [] };
  const plan = planLastCheckUpdate(check, new Set(['news']));
  assert.deepEqual(plan.issues, []);
  assert.equal(plan.status, 'healthy');
  assert.deepEqual(plan['desktop.news'], { status: 'paused' });
  assert.deepEqual(plan.pausedChecks, ['news']);
  assert.equal(planLastCheckUpdate({ ...check, ...Object.fromEntries(Object.entries(plan)), desktop: { news: { status: 'paused' }, contact: { status: 'working' } }, mobile: { news: { status: 'paused' }, contact: { status: 'working' } } }, new Set(['news'])), null);
  const resumed = planLastCheckUpdate({ status: 'healthy', issues: [], desktop: { news: { status: 'paused' } }, mobile: { news: { status: 'paused' } }, pausedChecks: ['news'] }, new Set());
  assert.deepEqual(resumed['desktop.news'], { status: 'pending' });
  assert.deepEqual(resumed.pausedChecks, []);
});

test('a paused homepage check can never make a website critical', () => {
  const down = { statusCode: null, timedOut: false, sslValid: false };
  assert.equal(getOverallStatus(down, ['Main website could not be opened']), 'critical');
  assert.equal(getOverallStatus(down, [], { homepagePaused: true }), 'healthy');
  assert.equal(getOverallStatus(down, ['Desktop News: Not added.'], { homepagePaused: true }), 'warning');
});