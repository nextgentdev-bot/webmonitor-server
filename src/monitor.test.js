import assert from 'node:assert/strict';
import test from 'node:test';
import { isMobileMenuControlLabel, matchesMenuLabel, normalizeMenuLabel } from './monitor.js';
import { countHealthyWebsites, defaultGoogleSheetTab, parseGoogleSheetRows, summarizeWebsiteProgress } from './utils.js';

test('normalizes mixed Bengali and English navigation labels', () => {
  assert.equal(normalizeMenuLabel('  Contact—Us  '), 'contact us');
  assert.equal(normalizeMenuLabel('যোগাযোগ করুন'), 'যোগাযোগ করুন');
});

test('matches English contact and news labels in phrases', () => {
  assert.equal(matchesMenuLabel('Contact', 'contact'), true);
  assert.equal(matchesMenuLabel('Contact Us', 'contact'), true);
  assert.equal(matchesMenuLabel('CONTACT-US', 'contact'), true);
  assert.equal(matchesMenuLabel('Contact Our Team', 'contact'), true);
  assert.equal(matchesMenuLabel('Get in touch with us', 'contact'), true);
  assert.equal(matchesMenuLabel('Latest News & Updates', 'news'), true);
  assert.equal(matchesMenuLabel('Blog', 'news'), true);
  assert.equal(matchesMenuLabel('Newsletters', 'news'), false);
});

test('matches Bengali contact and news labels', () => {
  assert.equal(matchesMenuLabel('আমাদের সাথে যোগাযোগ করুন', 'contact'), true);
  assert.equal(matchesMenuLabel('সর্বশেষ খবর', 'news'), true);
  assert.equal(matchesMenuLabel('সংবাদ ও বিজ্ঞপ্তি', 'news'), true);
  assert.equal(matchesMenuLabel('নিউজ ও আপডেট', 'news'), true);
  assert.equal(matchesMenuLabel('ব্লগ', 'news'), true);
  assert.equal(matchesMenuLabel(normalizeMenuLabel(['ব্লগ', null, null].filter(Boolean).join(' ')), 'news'), true);
  assert.equal(matchesMenuLabel('ইসলামিক পোস্ট', 'news'), false);
});

test('recognizes English and Bengali mobile menu controls', () => {
  assert.equal(isMobileMenuControlLabel('Open main navigation'), true);
  assert.equal(isMobileMenuControlLabel('Toggle navigation'), true);
  assert.equal(isMobileMenuControlLabel('Menu'), true);
  assert.equal(isMobileMenuControlLabel('Primary main-navigation grid-container site-navigation'), false);
  assert.equal(isMobileMenuControlLabel('মেনু খুলুন'), true);
  assert.equal(isMobileMenuControlLabel('Search the site'), false);
});

test('imports the first website row when a Google Sheet has no header', () => {
  assert.deepEqual(parseGoogleSheetRows([
    ['First site', 'https://first.example'],
    ['Second site', 'https://second.example']
  ]), [
    { name: 'First site', url: 'https://first.example' },
    { name: 'Second site', url: 'https://second.example' }
  ]);
});

test('skips Google Sheet headers and preserves website row order', () => {
  assert.deepEqual(parseGoogleSheetRows([
    ['Website Name', 'Website URL'],
    ['First site', 'https://first.example'],
    ['Second site', 'https://second.example']
  ]), [
    { name: 'First site', url: 'https://first.example' },
    { name: 'Second site', url: 'https://second.example' }
  ]);
});

test('chooses an All site tab by default and otherwise uses the first sheet', () => {
  assert.equal(defaultGoogleSheetTab(['Sheet61', 'All site', 'Oct 09']), 'All site');
  assert.equal(defaultGoogleSheetTab(['Sheet1', 'Archive']), 'Sheet1');
  assert.equal(defaultGoogleSheetTab([]), null);
});

test('counts healthy checks across all active websites, independent of the latest run', () => {
  assert.equal(countHealthyWebsites([
    { active: true, lastCheck: { status: 'healthy' } },
    { active: true, lastCheck: { status: 'warning' } },
    { active: true, lastCheck: null },
    { active: false, lastCheck: { status: 'healthy' } }
  ]), 1);
});

test('shows zero progress and waiting websites before a worker run starts', () => {
  assert.deepEqual(summarizeWebsiteProgress([
    { websiteId: 'first', lastCheck: null },
    { websiteId: 'second', lastCheck: null }
  ], [], undefined), {
    status: 'idle',
    total: 2,
    completed: 0,
    processing: 0,
    pending: 2,
    queued: 0,
    cancelled: 0,
    percent: 0
  });
});

test('aggregates worker progress against all current websites', () => {
  assert.deepEqual(summarizeWebsiteProgress([
    { websiteId: 'first', lastCheck: null },
    { websiteId: 'second', lastCheck: null },
    { websiteId: 'third', lastCheck: { status: 'healthy' } }
  ], [
    { websiteId: 'first', status: 'processing', progressPercent: 50 },
    { websiteId: 'second', status: 'pending', progressPercent: 0 }
  ], 'running'), {
    status: 'running',
    total: 3,
    completed: 1,
    processing: 1,
    pending: 1,
    queued: 1,
    cancelled: 0,
    percent: 50
  });
});

test('counts paused websites as resolved without exposing them as active work', () => {
  assert.deepEqual(summarizeWebsiteProgress([
    { websiteId: 'active', lastCheck: null },
    { websiteId: 'paused', lastCheck: null }
  ], [
    { websiteId: 'active', status: 'healthy', progressPercent: 100 },
    { websiteId: 'paused', status: 'cancelled', progressPercent: 25 }
  ], 'completed'), {
    status: 'completed',
    total: 2,
    completed: 1,
    processing: 0,
    pending: 0,
    queued: 0,
    cancelled: 1,
    percent: 100
  });
});
