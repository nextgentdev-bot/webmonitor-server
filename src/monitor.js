import { config } from './config.js';

const navigationSelectors = [
  'nav a[href]',
  '[role="navigation"] a[href]',
  'header a[href]',
  '[class*="menu" i] a[href]',
  '[id*="menu" i] a[href]',
  '[class*="nav" i] a[href]',
  '[id*="nav" i] a[href]',
  '[aria-label*="navigation" i] a[href]',
  '[role="menu"] a[href]'
];
const mobileNavigationSelectors = [
  '[class*="offcanvas" i] a[href]',
  '[id*="offcanvas" i] a[href]',
  '[class*="drawer" i] a[href]',
  '[id*="drawer" i] a[href]',
  '[class*="mobile" i] a[href]',
  '[id*="mobile" i] a[href]',
  '[class*="collapse" i] a[href]',
  '[aria-hidden="false"] nav a[href]',
  'a[href]'
];
const menuButtonSelectors = 'button, [role="button"], [aria-controls], [aria-expanded], [data-bs-toggle="collapse"], [data-toggle="collapse"], [id*="toggler" i], [class*="toggler" i], [class*="menu-toggle" i], [class*="hamburger" i], [class*="navbar-toggler" i], [class*="mobile-menu" i], [class*="nav-toggle" i]';
const dropdownControlSelectors = [
  'nav [aria-haspopup], nav [aria-expanded], nav [data-bs-toggle="dropdown"], nav [data-toggle="dropdown"], nav [class*="dropdown-toggle" i], nav li:has(> ul) > a, nav li:has(> ul) > button',
  '[role="navigation"] [aria-haspopup], [role="navigation"] [aria-expanded], [role="navigation"] [data-bs-toggle="dropdown"], [role="navigation"] [data-toggle="dropdown"], [role="navigation"] [class*="dropdown-toggle" i], [role="navigation"] li:has(> ul) > a, [role="navigation"] li:has(> ul) > button',
  'header [aria-haspopup], header [aria-expanded], header [data-bs-toggle="dropdown"], header [data-toggle="dropdown"], header [class*="dropdown-toggle" i], header li:has(> ul) > a, header li:has(> ul) > button',
  '[class*="menu" i] [aria-haspopup], [class*="menu" i] [aria-expanded], [class*="menu" i] [data-bs-toggle="dropdown"], [class*="menu" i] [data-toggle="dropdown"], [class*="menu" i] [class*="dropdown-toggle" i], [class*="menu" i] li:has(> ul) > a, [class*="menu" i] li:has(> ul) > button'
].join(', ');
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
  if (type === 'contact') return matchesAnyPhrase(normalized, [
    'contact', 'contacts', 'contact us', 'contact page', 'contact our team', 'contact team', 'get in touch', 'reach us',
    'contato', 'contate nos', 'fale conosco', 'fale com', 'entre em contato',
    'contacto', 'contactanos', 'ponte en contacto', 'contáctanos', 'contáctenos',
    'nous contacter', 'contactez nous', 'kontakt', 'kontaktieren sie uns',
    'contatto', 'contatti', 'contattaci', 'contattateci', 'contacte',
    'contacteer ons', 'neem contact op', 'skontaktuj się', 'kontakt', 'kontakta oss', 'kontakt os', 'yhteystiedot',
    'связаться с нами', 'контакты', 'зв’язатися з нами', 'звʼязатися з нами',
    'اتصل بنا', 'تواصل معنا', 'اتصل بنا', '联系我们', '聯絡我們', 'お問い合わせ',
    '문의', '문의하기', 'iletişim', 'bize ulaşın', 'hubungi kami',
    'liên hệ', 'liên hệ với chúng tôi', 'संपर्क', 'संपर्क करें', 'যোগাযোগ',
    'επικοινωνία', 'επικοινωνήστε μαζί μας', 'ติดต่อเรา', 'makipag ugnayan', 'liên lạc'
  ]);
  if (type === 'news') return isPrimaryNewsLabel(normalized)
    || /^(blog|blogs|posts|articles|blog posts|ব্লগ|ব্লগ পোস্ট|পোস্ট|প্রবন্ধ)( সমূহ)?$/.test(normalized);
  return false;
}

function matchesAnyPhrase(text, phrases) {
  return phrases.some((phrase) => text === phrase || text.startsWith(`${phrase} `) || text.endsWith(` ${phrase}`) || text.includes(` ${phrase} `));
}

export function isMainNewsPath(href, baseUrl) {
  try {
    const newsUrl = new URL(href, baseUrl);
    const siteUrl = new URL(baseUrl);
    const pathname = decodeURIComponent(newsUrl.pathname);
    return newsUrl.origin === siteUrl.origin && /^\/(?:news|not[ií]cias|actualit[eé]s|nouvelles|nachrichten|notizie|nieuws|wiadomo[sś]ci|новости|новини|أخبار|اخبار|ニュース|新闻|新聞|뉴스|haberler|berita|tin tức|समाचार|খবর|সংবাদ|nyheter|nyheder|uutiset|ειδήσεις|ข่าว|balita)\/?$/iu.test(pathname);
  } catch {
    return false;
  }
}

export function isIgnoredNewsCategoryPath(href, baseUrl) {
  try {
    const targetUrl = new URL(href, baseUrl);
    const siteUrl = new URL(baseUrl);
    return targetUrl.origin === siteUrl.origin && /(?:^|\/)category\/news\/?$/i.test(decodeURIComponent(targetUrl.pathname));
  } catch {
    return false;
  }
}

function isPrimaryNewsLabel(text) {
  return matchesAnyPhrase(text, [
    'news', 'updates', 'announcements', 'press releases',
    'noticias', 'notícias', 'actualités', 'nouvelles', 'nachrichten', 'notizie', 'nieuws',
    'wiadomości', 'новости', 'новини', 'أخبار', 'اخبار', 'ニュース', '新闻', '新聞', '뉴스',
    'haberler', 'berita', 'tin tức', 'समाचार', 'খবর', 'সংবাদ', 'নিউজ', 'প্রেস রিলিজ', 'বিজ্ঞপ্তি',
    'nyheter', 'nyheder', 'uutiset', 'ειδήσεις', 'ข่าว', 'balita'
  ]);
}

export function isMobileMenuControlLabel(text) {
  const normalized = normalizeMenuLabel(text);
  return /^(menu|main menu|menu toggle|main menu toggle|open menu|open main menu|open navigation|open main navigation|show menu|show navigation|toggle menu|toggle navigation|toggle main menu|toggle main navigation|navigation menu|navbar|hamburger|drawer)$/.test(normalized) || /^(মেনু|মেনু খুলুন|নেভিগেশন|নেভিগেশন খুলুন|হ্যামবার্গার মেনু)$/.test(normalized);
}

async function findLink(page, type, { includeHidden = false } = {}) {
  let fallback = null;
  const selectors = includeHidden ? [...navigationSelectors, ...mobileNavigationSelectors] : navigationSelectors;
  for (const selector of selectors) {
    const links = page.locator(selector);
    for (let index = 0; index < Math.min(await links.count(), 500); index += 1) {
      const link = links.nth(index);
      if ((!includeHidden || selector === 'a[href]') && !await link.isVisible().catch(() => false)) continue;
      const label = await textOf(link);
      if (!matchesMenuLabel(label, type)) continue;
      const href = await link.getAttribute('href');
      const match = { href };
      if (type === 'news' && isIgnoredNewsCategoryPath(href, page.url())) {
        fallback ||= match;
        continue;
      }
      if (type !== 'news' || isPrimaryNewsLabel(normalizeMenuLabel(label))) return match;
      fallback ||= match;
    }
  }
  return fallback;
}

async function findMenuLink(page, type, { includeHidden = false } = {}) {
  const options = { includeHidden };
  let found = await findLink(page, type, options);
  const controls = page.locator(dropdownControlSelectors);
  for (let index = 0; index < Math.min(await controls.count(), 100); index += 1) {
    const control = controls.nth(index);
    if (!await control.isVisible().catch(() => false)) continue;
    const details = await control.evaluate((element) => ({
      tagName: element.tagName.toLowerCase(),
      href: element.getAttribute('href'),
      expanded: element.getAttribute('aria-expanded'),
      isToggle: element.hasAttribute('aria-haspopup')
        || element.hasAttribute('aria-expanded')
        || element.hasAttribute('data-bs-toggle')
        || element.hasAttribute('data-toggle')
        || element.matches('[class*="dropdown-toggle" i]')
        || Boolean(element.closest('li')?.querySelector(':scope > ul'))
    }));
    await control.hover({ timeout: 1500 }).catch(() => {});
    await page.waitForTimeout(150);
    const isOpen = await control.evaluate((element) => {
      if (element.getAttribute('aria-expanded') === 'true') return true;
      const parent = element.closest('li') || element.parentElement;
      const submenu = parent?.querySelector(':scope > ul, :scope > [role="menu"], :scope > .dropdown-menu, :scope > .sub-menu');
      return Boolean(submenu && submenu.getClientRects().length && getComputedStyle(submenu).visibility !== 'hidden');
    }).catch(() => false);
    if (details.isToggle && !isOpen
      && (details.tagName !== 'a' || !details.href || details.href === '#' || /^javascript:/i.test(details.href))) {
      await control.click({ timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(150);
    }
    const menuLink = await findLink(page, type, options);
    if (menuLink) found ||= menuLink;
  }
  return found;
}

async function findNewsLink(page, { includeHidden = false } = {}) {
  return findMenuLink(page, 'news', { includeHidden });
}

async function findContactLink(page, { includeHidden = false } = {}) {
  return findMenuLink(page, 'contact', { includeHidden });
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

async function isMobileMenuOpen(page, button) {
  if (!button) return false;
  const buttonState = await button.evaluate((element) => {
    const label = `${element.innerText || ''} ${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''}`;
    const expanded = element.getAttribute('aria-expanded') === 'true';
    const indicatesClose = /\b(close|hide)\b/i.test(label) || /বন্ধ|বন্ধ করুন/.test(label);
    const controlledNavigationVisible = (element.getAttribute('aria-controls') || '').split(/\s+/).some((id) => {
      const target = document.getElementById(id);
      return Boolean(target && target.getClientRects().length > 0);
    });
    return expanded || indicatesClose || controlledNavigationVisible;
  }).catch(() => false);
  if (buttonState) return true;
  return Boolean(await findLink(page, 'contact') || await findLink(page, 'news'));
}

async function checkMenu(page, context, type, { includeHidden = false, found: suppliedFound } = {}) {
  const found = suppliedFound || await findLink(page, type, { includeHidden });
  if (!found) return { status: 'missing', url: null, statusCode: null };
  if (type === 'news' && isIgnoredNewsCategoryPath(found.href, page.url())) {
    return { status: 'skipped', url: found.href, statusCode: null };
  }
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

async function checkMainNewsPage(context, homepageUrl) {
  try {
    const newsUrl = new URL('/news', homepageUrl).toString();
    const response = await context.request.get(newsUrl, {
      timeout: config.navigationTimeoutMs,
      failOnStatusCode: false
    });
    return { exists: response.status() >= 200 && response.status() < 400, url: response.url(), statusCode: response.status(), error: null };
  } catch (error) {
    console.warn(`Unable to verify the main-domain /news page at ${homepageUrl}:`, error.message);
    return { exists: false, url: new URL('/news', homepageUrl).toString(), statusCode: null, error: error.message };
  }
}

export function getHomepageCandidates(url) {
  const candidates = new Set();
  const trimmed = String(url || '').trim();
  if (!trimmed) return [];
  try {
    const parsed = new URL(trimmed);
    candidates.add(parsed.toString());
    const alternateProtocol = new URL(parsed.toString());
    alternateProtocol.protocol = parsed.protocol === 'http:' ? 'https:' : 'http:';
    candidates.add(alternateProtocol.toString());
    return [...candidates];
  } catch {
    return [trimmed];
  }
}

export function getOverallStatus(homepage, issues) {
  const unreachable = !homepage.statusCode && !homepage.timedOut;
  return unreachable || homepage.statusCode >= 500 || homepage.sslValid === false
    ? 'critical'
    : issues.length
      ? 'warning'
      : 'healthy';
}

export function resolveNewsCheckResult(result, mainNewsPageExists) {
  return result.status === 'missing' && !mainNewsPageExists
    ? { ...result, status: 'skipped' }
    : result;
}

export async function monitorWebsite(browser, { website, runId, onProgress = async () => {}, signal }) {
  let completedSteps = 0;
  const reportStep = async (stage, count = 1, progress = {}) => {
    completedSteps += count;
    await onProgress({ percent: Math.floor(completedSteps / 5 * 100), stage, ...progress });
  };
  const issues = [];
  const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const contexts = [desktopContext];
  const closeContexts = () => {
    for (const context of contexts) context.close().catch((error) => console.error('Unable to close cancelled browser context:', error.message));
  };
  signal?.addEventListener('abort', closeContexts, { once: true });
  if (signal?.aborted) closeContexts();
  const desktop = await desktopContext.newPage();
  desktop.setDefaultNavigationTimeout(config.navigationTimeoutMs);
  let homepage = { statusCode: null, loadTimeMs: null, sslValid: null, blank: false, timedOut: false, finalUrl: website.url, error: null };

  const homepageCandidates = getHomepageCandidates(website.url);
  let lastHomepageError = null;
  for (const candidate of homepageCandidates) {
    try {
      const started = Date.now();
      const response = await desktop.goto(candidate, { waitUntil: 'domcontentloaded' });
      const candidateStatus = response?.status() ?? null;
      const loaded = { ...homepage, statusCode: candidateStatus, loadTimeMs: Date.now() - started, sslValid: true, blank: await desktop.locator('body').innerText().then((text) => text.trim().length < 20).catch(() => false), timedOut: false, finalUrl: desktop.url(), error: null };
      homepage = loaded;
      if (response && candidateStatus < 400 && !loaded.blank) break;
      lastHomepageError = `Main website responded with HTTP ${candidateStatus ?? 'no response'}${loaded.blank ? ' and the page body is blank' : ''}.`;
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      homepage.timedOut = error.name === 'TimeoutError' || /timeout/i.test(error.message);
      lastHomepageError = `Main website could not be opened at ${candidate}: ${error.message}`;
      homepage.error = error.message;
      homepage.sslValid = !/ssl|certificate|cert_/i.test(error.message);
    }
  }
  if ((!homepage.statusCode && !homepage.timedOut) || homepage.statusCode >= 400 || homepage.blank) {
    issues.push(lastHomepageError || 'Main website could not be opened successfully.');
  }
  if (homepage.timedOut && !issues.some((issue) => issue.startsWith('Main website could not be opened'))) {
    issues.push(`Main website took longer than the ${config.navigationTimeoutMs} ms navigation timeout.`);
  }
  if (homepage.loadTimeMs > config.slowPageMs) issues.push(`Main website is slow (${homepage.loadTimeMs} ms).`);
  await reportStep('Homepage checked');

  const mainNewsPage = await checkMainNewsPage(desktopContext, homepage.finalUrl);
  const desktopChecks = (async () => {
    const contactFound = await findContactLink(desktop);
    const contact = await checkMenu(desktop, desktopContext, 'contact', { found: contactFound });
    await reportStep('Desktop Contact checked');
    const newsFound = await findNewsLink(desktop);
    const news = await checkMenu(desktop, desktopContext, 'news', { found: newsFound });
    await reportStep('Desktop News checked');
    return [contact, news];
  })();
  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  contexts.push(mobileContext);
  if (signal?.aborted) closeContexts();
  const mobile = await mobileContext.newPage();
  mobile.setDefaultNavigationTimeout(config.navigationTimeoutMs);
  const mobileChecks = (async () => {
    if (!homepage.statusCode || homepage.statusCode >= 500) {
      await reportStep('Mobile checks skipped', 2, { mobileProgressPercent: 100 });
      return { contact: { status: 'skipped' }, news: { status: 'skipped' } };
    }
    await reportStep('Mobile homepage loading', 0, { mobileProgressPercent: 10 });
    try {
      await mobile.goto(website.url, { waitUntil: 'domcontentloaded' });
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      await reportStep('Mobile checks failed to load', 2, { mobileProgressPercent: 100 });
      const result = { status: 'error', url: mobile.url() || website.url, statusCode: null, error: `Mobile homepage could not be opened: ${error.message}` };
      return { contact: result, news: result };
    }
    await reportStep('Mobile menu ready', 0, { mobileProgressPercent: 35 });
    const menuButton = await findMobileMenuButton(mobile);
    let menuOpenError = null;
    if (menuButton && !await isMobileMenuOpen(mobile, menuButton)) {
      try {
        await menuButton.click({ timeout: 3000 });
        await mobile.waitForTimeout(300);
      } catch (error) {
        menuOpenError = error.message;
      }
    }
    const contactFound = await findContactLink(mobile, { includeHidden: true });
    const contact = await checkMenu(mobile, mobileContext, 'contact', { includeHidden: true, found: contactFound });
    await reportStep('Mobile Contact checked', 1, { mobileProgressPercent: 70 });
    const newsFound = await findNewsLink(mobile, { includeHidden: true });
    const news = await checkMenu(mobile, mobileContext, 'news', { includeHidden: true, found: newsFound });
    await reportStep('Mobile News checked', 1, { mobileProgressPercent: 100 });
    const explainClosedMenu = (result) => menuOpenError && result.status === 'missing'
      ? { ...result, error: `Mobile menu could not be opened: ${menuOpenError}` }
      : result;
    return { contact: explainClosedMenu(contact), news: explainClosedMenu(news) };
  })();

  const [[desktopContact, desktopNews], mobileResult] = await Promise.all([desktopChecks, mobileChecks]);
  if (signal?.aborted) throw signal.reason || new Error('Run cancelled.');
  const desktopNewsResult = resolveNewsCheckResult(desktopNews, mainNewsPage.exists);
  const mobileNewsResult = resolveNewsCheckResult(mobileResult.news, mainNewsPage.exists);
  const desktopResult = { contact: desktopContact, news: desktopNewsResult };
  const finalMobileResult = { ...mobileResult, news: mobileNewsResult };
  for (const [label, result] of [['Desktop Contact', desktopContact], ['Desktop News', desktopNewsResult], ['Mobile Contact', mobileResult.contact], ['Mobile News', mobileNewsResult]]) {
    if (result.status !== 'working' && result.status !== 'skipped') {
      const detail = result.error || (result.status === 'missing' ? 'Not added.' : 'Link has an error.');
      issues.push(`${label}: ${detail}`);
    }
  }

  const status = getOverallStatus(homepage, issues);
  signal?.removeEventListener('abort', closeContexts);
  await Promise.all(contexts.map((context) => context.close()));
  return { overallStatus: status, homepage, desktop: desktopResult, mobile: finalMobileResult, issues, screenshots: [] };
}