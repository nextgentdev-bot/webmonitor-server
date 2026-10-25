import assert from 'node:assert/strict';
import test from 'node:test';
import { getOverallStatus, isIgnoredNewsCategoryPath, isMainNewsPath, isMobileMenuControlLabel, matchesMenuLabel, normalizeMenuLabel, resolveNewsCheckResult } from './monitor.js';
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

test('matches Portuguese, Spanish, French, Arabic and Japanese menu labels', () => {
  assert.equal(matchesMenuLabel('Contate-nos', 'contact'), true);
  assert.equal(matchesMenuLabel('Fale conosco', 'contact'), true);
  assert.equal(matchesMenuLabel('Contáctanos', 'contact'), true);
  assert.equal(matchesMenuLabel('Nous contacter', 'contact'), true);
  assert.equal(matchesMenuLabel('اتصل بنا', 'contact'), true);
  assert.equal(matchesMenuLabel('お問い合わせ', 'contact'), true);
  assert.equal(matchesMenuLabel('Notícias', 'news'), true);
  assert.equal(matchesMenuLabel('Actualités', 'news'), true);
  assert.equal(matchesMenuLabel('Новости', 'news'), true);
  assert.equal(matchesMenuLabel('新闻', 'news'), true);
  assert.equal(matchesMenuLabel('Επικοινωνία', 'contact'), true);
  assert.equal(matchesMenuLabel('ข่าว', 'news'), true);
});

test('counts only the same-domain root news page', () => {
  const homepage = 'https://joinpd.io/';
  assert.equal(isMainNewsPath('/news', homepage), true);
  assert.equal(isMainNewsPath('/news/', homepage), true);
  assert.equal(isMainNewsPath('https://joinpd.io/news?sort=latest', homepage), true);
  assert.equal(isMainNewsPath('/notícias', homepage), true);
  assert.equal(isMainNewsPath('/actualités/', homepage), true);
  assert.equal(isMainNewsPath('/%D8%A3%D8%AE%D8%A8%D8%A7%D8%B1', homepage), true);
  assert.equal(isMainNewsPath('/ειδήσεις', homepage), true);
  assert.equal(isMainNewsPath('/category/news/', homepage), false);
  assert.equal(isMainNewsPath('/categoria/noticias/', homepage), false);
  assert.equal(isMainNewsPath('/news/latest', homepage), false);
  assert.equal(isMainNewsPath('https://other.example/news', homepage), false);
});

test('identifies category/news links to ignore without checking them', () => {
  const homepage = 'https://baddie-hub.net/';
  assert.equal(isIgnoredNewsCategoryPath('/category/news/', homepage), true);
  assert.equal(isIgnoredNewsCategoryPath('https://baddie-hub.net/category/news', homepage), true);
  assert.equal(isIgnoredNewsCategoryPath('/category/news/article-one/', homepage), false);
  assert.equal(isIgnoredNewsCategoryPath('https://other.example/category/news/', homepage), false);
  assert.equal(isIgnoredNewsCategoryPath('/news/', homepage), false);
});

test('classifies slow and navigation-timeout homepages as warnings, not critical failures', () => {
  assert.equal(getOverallStatus({ statusCode: 200, loadTimeMs: 12000, sslValid: true }, ['Main website is slow (12000 ms).']), 'warning');
  assert.equal(getOverallStatus({ statusCode: null, timedOut: true, sslValid: true }, ['Main website exceeded the navigation timeout.']), 'warning');
  assert.equal(getOverallStatus({ statusCode: 200, sslValid: true }, []), 'healthy');
  assert.equal(getOverallStatus({ statusCode: null, timedOut: false, sslValid: true }, ['Main website could not be opened.']), 'critical');
  assert.equal(getOverallStatus({ statusCode: 503, sslValid: true }, ['Main website returned HTTP 503.']), 'critical');
});

test('ignores absent News navigation only when the main-domain /news page does not exist', () => {
  assert.equal(resolveNewsCheckResult({ status: 'missing' }, true).status, 'missing');
  assert.equal(resolveNewsCheckResult({ status: 'missing' }, false).status, 'skipped');
  assert.equal(resolveNewsCheckResult({ status: 'working' }, false).status, 'working');
  assert.equal(resolveNewsCheckResult({ status: 'error' }, false).status, 'error');
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
