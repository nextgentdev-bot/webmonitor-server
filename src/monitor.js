import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const navigationSelectors = [
  'nav a[href]',
  '[role="navigation"] a[href]',
  'header a[href]',
  '[class*="menu" i] a[href]',
  '[id*="menu" i] a[href]',
  '[class*="nav" i] a[href]',
  '[id*="nav" i] a[href]'
];
const menuButtonSelectors = 'button, [role="button"], [aria-controls], [aria-expanded], [data-bs-toggle="collapse"], [data-toggle="collapse"], [id*="toggler" i], [class*="toggler" i], [class*="menu-toggle" i], [class*="hamburger" i], [class*="navbar-toggler" i], [class*="mobile-menu" i], [class*="nav-toggle" i]';
const textOf = async (locator) => [
  await locator.innerText().catch(() => ''),
  await locator.getAttribute('aria-label').catch(() => ''),
  await locator.getAttribute('title').catch(() => ''),
  await locator.getAttribute('alt').catch(() => '')
].filter(Boolean).join(' ');

export function normalizeMenuLabel(text) {
  return String(text || '').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function matchesMenuLabel(text, type) {
  const normalized = normalizeMenuLabel(text);
  if (type === 'contact') return /\b(contact|contacts|get in touch|reach us)\b/.test(normalized) || /যোগাযোগ/.test(normalized);
  if (type === 'news') return isPrimaryNewsLabel(normalized) || /^(blog|blogs|posts|articles|blog posts|ব্লগ|ব্লগ পোস্ট|পোস্ট|প্রবন্ধ)( সমূহ)?$/.test(normalized);
  return false;
}

function isPrimaryNewsLabel(text) {
  return /\b(news|updates|announcements|press releases)\b/.test(text) || /(সংবাদ|খবর|নিউজ|প্রেস রিলিজ|বিজ্ঞপ্তি)/.test(text);
}

export function isMobileMenuControlLabel(text) {
  const normalized = normalizeMenuLabel(text);
  return /^(menu|main menu|menu toggle|main menu toggle|open menu|open main menu|open navigation|open main navigation|show menu|show navigation|toggle menu|toggle navigation|toggle main menu|toggle main navigation|navigation menu|navbar|hamburger|drawer)$/.test(normalized) || /^(মেনু|মেনু খুলুন|নেভিগেশন|নেভিগেশন খুলুন|হ্যামবার্গার মেনু)$/.test(normalized);
}

async function findLink(page, type) {
  let fallback = null;
  for (const selector of navigationSelectors) {
    const links = page.locator(selector);
    for (let index = 0; index < Math.min(await links.count(), 500); index += 1) {
      const link = links.nth(index);
      if (!await link.isVisible().catch(() => false)) continue;
      const label = await textOf(link);
      if (!matchesMenuLabel(label, type)) continue;
      const match = { href: await link.getAttribute('href') };
      if (type !== 'news' || isPrimaryNewsLabel(normalizeMenuLabel(label))) return match;
      fallback ||= match;
    }
  }
  return fallback;
}

async function findMobileMenuButton(page) {
  const buttons = page.locator(menuButtonSelectors);
  for (let index = 0; index < Math.min(await buttons.count(), 100); index += 1) {
    const button = buttons.nth(index);
    if (!await button.isVisible().catch(() => false)) continue;
    const description = await button.evaluate((element) => [
      element.innerText,
      element.getAttribute('aria-label'),
      element.getAttribute('title')
    ].filter(Boolean).join(' '));
    const toggleStructure = await button.evaluate((element) => [
      element.getAttribute('class'),
      element.getAttribute('id'),
      element.getAttribute('data-testid')
    ].filter(Boolean).join(' '));
    const hasToggleStructure = /(?:menu[-_]?toggle|navbar[-_]?toggler|mobile[-_]?menu|nav[-_]?toggle|hamburger|toggler)/i.test(toggleStructure);
    const controlsNavigation = await button.evaluate((element) => (element.getAttribute('aria-controls') || '').split(/\s+/).some((id) => {
      const target = document.getElementById(id);
      if (!target) return false;
      const targetDescription = `${target.id} ${target.getAttribute('class')} ${target.getAttribute('aria-label')}`;
      const hasNavigationRole = target.matches('nav, [role="navigation"], [role="menu"]') || target.querySelector('nav, [role="navigation"], [role="menu"]');
      return Boolean(hasNavigationRole || (/\b(menu|nav|navigation|navbar)\b/i.test(targetDescription) && target.querySelector('a[href]')));
    }));
    if (isMobileMenuControlLabel(description) || hasToggleStructure || controlsNavigation) return button;
  }
  return null;
}

async function checkMenu(page, context, type) {
  const found = await findLink(page, type);
  if (!found) return { status: 'missing', url: null, statusCode: null };
  if (!found.href || found.href.trim() === '#' || /^javascript:/i.test(found.href.trim())) return { status: 'error', url: null, statusCode: null, error: 'Menu item has no destination URL.' };
  const href = found.href ? new URL(found.href, page.url()).toString() : '';
  if (!href) return { status: 'error', url: null, statusCode: null, error: 'Menu item has no link URL.' };
  if (/^(mailto:|tel:|sms:)/i.test(href)) return { status: 'working', url: href, statusCode: null };
  try {
    const response = await context.request.get(href, { timeout: config.navigationTimeoutMs, failOnStatusCode: false });
    const statusCode = response.status();
    return { status: statusCode < 400 ? 'working' : 'error', url: response.url(), statusCode, error: statusCode < 400 ? null : `HTTP ${statusCode}` };
  } catch (error) {
    return { status: 'error', url: href, statusCode: null, error: error.message };
  }
}

async function screenshot(page, runId, website, mode) {
  const dir = path.join(config.screenshotDir, `run-${runId}`);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${website._id}-${website.name.replace(/[^a-z0-9_-]/gi, '-').slice(0, 60)}-${mode}.png`);
  await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
  return `/screenshots/${path.relative(config.screenshotDir, file).replaceAll(path.sep, '/')}`;
}

export async function monitorWebsite(browser, { website, runId, onProgress = async () => {} }) {
  let completedSteps = 0;
  const reportStep = async (stage, count = 1) => {
    completedSteps += count;
    await onProgress({ percent: Math.floor(completedSteps / 5 * 100), stage });
  };
  const issues = [];
  const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const desktop = await desktopContext.newPage();
  desktop.setDefaultNavigationTimeout(config.navigationTimeoutMs);
  let homepage = { statusCode: null, loadTimeMs: null, sslValid: null, blank: false, finalUrl: website.url, error: null };

  try {
    const started = Date.now();
    const response = await desktop.goto(website.url, { waitUntil: 'domcontentloaded' });
    homepage = {
      ...homepage,
      statusCode: response?.status() ?? null,
      loadTimeMs: Date.now() - started,
      sslValid: true,
      finalUrl: desktop.url(),
      blank: await desktop.locator('body').innerText().then((text) => text.trim().length < 20).catch(() => false)
    };
    if (!response || homepage.statusCode >= 400) issues.push(`Main website returned HTTP ${homepage.statusCode ?? 'no response'}.`);
    if (homepage.blank) issues.push('Main website appears blank.');
    if (homepage.loadTimeMs > config.slowPageMs) issues.push(`Main website is slow (${homepage.loadTimeMs} ms).`);
  } catch (error) {
    homepage.error = error.message;
    homepage.sslValid = !/ssl|certificate|cert_/i.test(error.message);
    issues.push(`Main website could not be opened: ${error.message}`);
  }
  await reportStep('Homepage checked');

  const desktopChecks = Promise.all([
    checkMenu(desktop, desktopContext, 'contact').then(async (result) => { await reportStep('Desktop Contact checked'); return result; }),
    checkMenu(desktop, desktopContext, 'news').then(async (result) => { await reportStep('Desktop News checked'); return result; })
  ]);

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mobile = await mobileContext.newPage();
  mobile.setDefaultNavigationTimeout(config.navigationTimeoutMs);
  const mobileChecks = (async () => {
    if (!homepage.statusCode || homepage.statusCode >= 500) {
      await reportStep('Mobile checks skipped', 2);
      return { contact: { status: 'skipped' }, news: { status: 'skipped' } };
    }
    await mobile.goto(website.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const menuButton = await findMobileMenuButton(mobile);
    if (menuButton) {
      await menuButton.click().catch(() => {});
      await mobile.waitForTimeout(150);
    }
    const [contact, news] = await Promise.all([
      checkMenu(mobile, mobileContext, 'contact').then(async (result) => { await reportStep('Mobile Contact checked'); return result; }),
      checkMenu(mobile, mobileContext, 'news').then(async (result) => { await reportStep('Mobile News checked'); return result; })
    ]);
    return { contact, news };
  })();

  const [[desktopContact, desktopNews], mobileResult] = await Promise.all([desktopChecks, mobileChecks]);
  const desktopResult = { contact: desktopContact, news: desktopNews };
  for (const [label, result] of [['Desktop Contact', desktopContact], ['Desktop News', desktopNews], ['Mobile Contact', mobileResult.contact], ['Mobile News', mobileResult.news]]) {
    if (result.status !== 'working' && result.status !== 'skipped') issues.push(`${label}: ${result.status === 'missing' ? 'Not added.' : `Added but link has an error${result.error ? ` (${result.error})` : '.'}`}`);
  }

  const status = !homepage.statusCode || homepage.statusCode >= 500 || homepage.sslValid === false ? 'critical' : issues.length ? 'warning' : 'healthy';
  let screenshots = [];
  if (config.screenshotOnIssue && status !== 'healthy') screenshots = [await screenshot(desktop, runId, website, 'desktop').catch(() => null)].filter(Boolean);
  await desktopContext.close();
  await mobileContext.close();
  return { overallStatus: status, homepage, desktop: desktopResult, mobile: mobileResult, issues, screenshots };
}