// Pure helpers for "pause only some checks of a website".
// Kept free of database / browser imports so they can be unit-tested and shared by the API, the worker and the queue.

export const PAUSABLE_CHECKS = [
  { key: 'homepage', label: 'Homepage check', description: 'Homepage opens, returns a good HTTP status, SSL is valid and the page is not blank.' },
  { key: 'loadTime', label: 'Homepage loading time', description: 'Slow homepage and homepage timeout warnings.' },
  { key: 'news', label: 'News check', description: 'News / blog menu link on desktop and mobile.' },
  { key: 'contact', label: 'Contact check', description: 'Contact menu link on desktop and mobile.' }
];
export const CHECK_KEYS = PAUSABLE_CHECKS.map(({ key }) => key);
export const MAX_REASON_LENGTH = 300;

// Works for a Mongoose document and for a lean object; old websites without `pausedChecks` simply return an empty set.
export function pausedKeySet(website) {
  const paused = new Set();
  for (const key of CHECK_KEYS) {
    if (website?.pausedChecks?.[key]?.paused === true) paused.add(key);
  }
  return paused;
}

// Which check an issue message belongs to. Messages are created in monitor.js.
export function issueCheckKey(issue) {
  const text = String(issue || '');
  if (text.startsWith('Main website is slow') || text.startsWith('Main website took longer')) return 'loadTime';
  if (text.startsWith('Main website')) return 'homepage';
  if (/^(Desktop|Mobile) News:/.test(text)) return 'news';
  if (/^(Desktop|Mobile) Contact:/.test(text)) return 'contact';
  return null;
}

// Builds the Mongo $set for PATCH /websites/:id/checks.
// `input` looks like { news: { paused: true, reason: 'Site has no news section' }, contact: { paused: false } }.
// Returns { update } or { error }. A check that is already paused keeps its saved reason unless a new one is sent.
export function buildCheckPauseUpdate(website, input, now = new Date()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Send the checks you want to pause or resume.' };
  const update = {};
  const next = pausedKeySet(website);
  let changed = 0;
  for (const [key, value] of Object.entries(input)) {
    if (!CHECK_KEYS.includes(key)) return { error: `Unknown check: ${key}.` };
    const wantPaused = value?.paused === true;
    const wasPaused = next.has(key);
    const reason = String(value?.reason || '').trim().slice(0, MAX_REASON_LENGTH);
    const label = PAUSABLE_CHECKS.find((item) => item.key === key).label;
    if (wantPaused) {
      if (!wasPaused && !reason) return { error: `A pause reason is required for: ${label}.` };
      next.add(key);
      if (!wasPaused) {
        update[`pausedChecks.${key}`] = { paused: true, reason, pausedAt: now };
        changed += 1;
      } else if (reason && reason !== website.pausedChecks[key].reason) {
        update[`pausedChecks.${key}.reason`] = reason;
        changed += 1;
      }
    } else if (wasPaused) {
      next.delete(key);
      update[`pausedChecks.${key}`] = { paused: false, reason: '', pausedAt: null };
      changed += 1;
    }
  }
  if (next.size === CHECK_KEYS.length) return { error: 'All checks cannot be paused one by one. Use "Pause monitoring" to pause the whole website instead.' };
  if (!changed) return { error: 'Nothing to change.' };
  return { update, paused: next };
}

// What must change on a website's saved latest check so it matches the current pause settings.
// Returns null when nothing has to change, otherwise a Mongo $set object.
export function planLastCheckUpdate(check, paused) {
  const set = {};
  for (const key of ['contact', 'news']) {
    for (const device of ['desktop', 'mobile']) {
      const current = check[device]?.[key];
      if (paused.has(key) && current?.status !== 'paused') set[`${device}.${key}`] = { status: 'paused' };
      else if (!paused.has(key) && current?.status === 'paused') set[`${device}.${key}`] = { status: 'pending' };
    }
  }
  const issues = check.issues || [];
  const keptIssues = issues.filter((issue) => !paused.has(issueCheckKey(issue)));
  if (keptIssues.length !== issues.length) {
    set.issues = keptIssues;
    set.errorSummary = keptIssues.join('\n');
  }
  const nextPaused = [...paused].sort();
  if (JSON.stringify(nextPaused) !== JSON.stringify([...(check.pausedChecks || [])].sort())) set.pausedChecks = nextPaused;

  let status = check.status;
  if (!check.rawResult?.failure && ['healthy', 'warning', 'critical'].includes(status)) {
    const remaining = set.issues ?? issues;
    if (status === 'critical' && paused.has('homepage')) status = remaining.length ? 'warning' : 'healthy';
    else if (status === 'warning' && remaining.length === 0) status = 'healthy';
  }
  if (status !== check.status) set.status = status;
  return Object.keys(set).length ? set : null;
}