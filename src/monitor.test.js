import assert from 'node:assert/strict';
import test from 'node:test';
import { findLink, getHomepageNavigationSkipReason, getOverallStatus, isIgnoredNewsCategoryPath, isMainNewsPath, isMobileMenuControlLabel, isMobileMenuOpenState, isSuspendedPage, isVerificationChallengePage, matchesMenuLabel, normalizeMenuLabel, resolveNewsCheckResult, isSameSite, isContactPagePath, resolveContactCheckResult } from './monitor.js';
import { countHealthyWebsites, defaultGoogleSheetTab, latestCheckPerWebsite, parseGoogleSheetRows, summarizeWebsiteProgress } from './utils.js';

test('normalizes mixed Bengali and English navigation labels', () => {
  assert.equal(normalizeMenuLabel('  Contact—Us  '), 'contact us');
  assert.equal(normalizeMenuLabel('যোগাযোগ করুন'), 'যোগাযোগ করুন');
});

test('matches English contact and news labels in phrases', () => {
  assert.equal(matchesMenuLabel('Contact', 'contact'), true);
  assert.equal(matchesMenuLabel('Contact Us', 'contact'), true);
  assert.equal(matchesMenuLabel('Contact Me', 'contact'), true);
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
  assert.equal(matchesMenuLabel('Contacta con nosotras', 'contact'), true);
  assert.equal(matchesMenuLabel('Contacta con nosotros', 'contact'), true);
  assert.equal(matchesMenuLabel('Nous contacter', 'contact'), true);
  assert.equal(matchesMenuLabel('اتصل بنا', 'contact'), true);
  assert.equal(matchesMenuLabel('お問い合わせ', 'contact'), true);
  assert.equal(matchesMenuLabel('Notícias', 'news'), true);
  assert.equal(matchesMenuLabel('Actualidad', 'news'), true);
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

test('detects suspended pages from provider URLs and page text, and marks them critical', () => {
  assert.equal(isSuspendedPage('https://guicloud.in/cgi-sys/suspendedpage.cgi', '', ''), true);
  assert.equal(isSuspendedPage('https://example.com/', 'Account Suspended', 'This Account has been suspended.'), true);
  assert.equal(isSuspendedPage('https://example.com/', 'Welcome', 'A normal website homepage.'), false);
  assert.equal(getOverallStatus({ statusCode: 200, suspended: true }, ['Main website account is suspended.']), 'critical');
  assert.equal(getOverallStatus({ statusCode: 200, suspended: true }, [], { homepagePaused: true }), 'critical');
});

test('recognizes browser verification pages without mistaking ordinary homepages for challenges', () => {
  assert.equal(isVerificationChallengePage('Just a moment...', 'Verify you are human by completing the action below.'), true);
  assert.equal(isVerificationChallengePage('Just a moment...', 'Security verification is in progress.'), true);
  assert.equal(isVerificationChallengePage('Welcome', 'Verify you are human by completing the action below.'), false);
  assert.equal(isVerificationChallengePage('Just a moment...', 'Welcome to our website.'), false);
});

test('skips navigation checks for homepage failures but not slow successful homepages', () => {
  assert.match(getHomepageNavigationSkipReason({ suspended: true }), /suspended/);
  assert.match(getHomepageNavigationSkipReason({ verificationRequired: true }), /verification/);
  assert.match(getHomepageNavigationSkipReason({ timedOut: true }), /timed out/);
  assert.match(getHomepageNavigationSkipReason({ sslValid: false }), /SSL/);
  assert.match(getHomepageNavigationSkipReason({ statusCode: 503 }), /unavailable/);
  assert.match(getHomepageNavigationSkipReason({ statusCode: 404 }), /unavailable/);
  assert.match(getHomepageNavigationSkipReason({ statusCode: 200, blank: true }), /unavailable/);
  assert.equal(getHomepageNavigationSkipReason({ statusCode: 200, loadTimeMs: 12000, sslValid: true, blank: false }), null);
});

test('ignores absent News navigation only when the main-domain /news page does not exist', () => {
  assert.equal(resolveNewsCheckResult({ status: 'missing' }, true).status, 'missing');
  assert.equal(resolveNewsCheckResult({ status: 'missing' }, false).status, 'skipped');
  assert.equal(resolveNewsCheckResult({ status: 'working' }, false).status, 'working');
  assert.equal(resolveNewsCheckResult({ status: 'error' }, false).status, 'error');
});

test('does not treat a redirect to the homepage as an existing News page', () => {
  assert.equal(isMainNewsPath('https://tainiomania.io/', 'https://tainiomania.io/'), false);
  assert.equal(isMainNewsPath('https://tainiomania.io/news', 'https://tainiomania.io/'), true);
});

test('finds navigation links and buttons using their resolved URL and label', async () => {
  const makePage = ({ label, href, kind }) => {
    const element = {
      getAttribute: (name) => name === 'href' ? href : null,
      closest: () => null,
      matches: () => kind === 'button'
    };
    const item = {
      isVisible: async () => true,
      innerText: async () => label,
      getAttribute: async () => null,
      evaluate: async (callback) => callback(element)
    };
    return {
      url: () => 'https://example.com/',
      locator: (selector) => ({
        count: async () => selector.startsWith('nav a[href]') ? 1 : 0,
        nth: () => item
      })
    };
  };

  assert.deepEqual(await findLink(makePage({ label: 'Noticias', href: '/noticias', kind: 'link' }), 'news'), {
    href: '/noticias',
    kind: 'link'
  });
  assert.deepEqual(await findLink(makePage({ label: 'Contacta con nosotras', href: null, kind: 'button' }), 'contact'), {
    href: null,
    kind: 'button'
  });
});

test('recognizes English and Bengali mobile menu controls', () => {
  assert.equal(isMobileMenuControlLabel('Open main navigation'), true);
  assert.equal(isMobileMenuControlLabel('Toggle navigation'), true);
  assert.equal(isMobileMenuControlLabel('Menu'), true);
  assert.equal(isMobileMenuControlLabel('Primary main-navigation grid-container site-navigation'), false);
  assert.equal(isMobileMenuControlLabel('মেনু খুলুন'), true);
  assert.equal(isMobileMenuControlLabel('Search the site'), false);
});

test('does not mistake a closed mobile menu for an open one', () => {
  assert.equal(isMobileMenuOpenState({ expanded: 'false', indicatesClose: false, controlledNavigationVisible: false }), false);
  assert.equal(isMobileMenuOpenState({ expanded: 'false', indicatesClose: false, controlledNavigationVisible: true }), false);
  assert.equal(isMobileMenuOpenState({ expanded: 'true', indicatesClose: false, controlledNavigationVisible: false }), true);
  assert.equal(isMobileMenuOpenState({ toggleChecked: false, indicatesClose: false, controlledNavigationVisible: false }), false);
  assert.equal(isMobileMenuOpenState({ toggleChecked: true, indicatesClose: false, controlledNavigationVisible: false }), true);
  assert.equal(isMobileMenuOpenState({ indicatesClose: false, controlledNavigationVisible: true }), true);
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

test('counts a re-checked website once and prefers its open check', () => {
  const checks = [
    { _id: '1', website: 'a', status: 'healthy' },
    { _id: '2', website: 'b', status: 'healthy' },
    { _id: '3', website: 'a', status: 'pending' },
    { _id: '4', website: 'b', status: 'warning' }
  ];
  const result = latestCheckPerWebsite(checks);
  assert.equal(result.length, 2);
  assert.equal(result.find((check) => check.website === 'a').status, 'pending');
  assert.equal(result.find((check) => check.website === 'b')._id, '4');
});

test('treats www and non-www as the same website for the News rules', () => {
  assert.equal(isSameSite('https://guicloud.in/news', 'https://www.guicloud.in/'), true);
  assert.equal(isSameSite('https://other.com/news', 'https://www.guicloud.in/'), false);
  // https://domain/news is a main news page (checked); /category/news is ignored (skipped), with or without www on either side.
  assert.equal(isMainNewsPath('https://guicloud.in/news', 'https://www.guicloud.in/'), true);
  assert.equal(isMainNewsPath('https://www.guicloud.in/news/', 'https://guicloud.in/'), true);
  assert.equal(isIgnoredNewsCategoryPath('https://guicloud.in/category/news/', 'https://www.guicloud.in/'), true);
  assert.equal(isIgnoredNewsCategoryPath('/category/news', 'https://guicloud.in/'), true);
  assert.equal(isIgnoredNewsCategoryPath('/news', 'https://guicloud.in/'), false);
});

test('contact is required: a missing Contact menu item is always an issue, with the reason', () => {
  assert.equal(isContactPagePath('https://guicloud.in/contact-us/'), true);
  assert.equal(isContactPagePath('https://guicloud.in/contact'), true);
  assert.equal(isContactPagePath('https://guicloud.in/'), false);
  const withPage = resolveContactCheckResult({ status: 'missing' }, true);
  assert.equal(withPage.status, 'missing');
  assert.match(withPage.error, /page exists/i);
  const noPage = resolveContactCheckResult({ status: 'missing' }, false);
  assert.equal(noPage.status, 'missing');
  assert.match(noPage.error, /not found \(\/contact or \/contact-us\)/i);
  assert.equal(resolveContactCheckResult({ status: 'missing', error: 'Mobile menu could not be opened: x' }, false).error, 'Mobile menu could not be opened: x');
  assert.deepEqual(resolveContactCheckResult({ status: 'working', url: 'x' }, false), { status: 'working', url: 'x' });
});