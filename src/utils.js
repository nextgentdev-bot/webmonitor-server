export function normalizeUrl(input) {
  let value = String(input || '').trim();
  if (!value) throw new Error('Website URL is required.');
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS URLs are supported.');
  url.hostname = url.hostname.toLowerCase(); url.hash = ''; if (url.pathname === '/') url.pathname = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}
export function parseGoogleSheetRows(grid) {
  const normalizeHeader = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const urlHeaders = new Set(['websiteurl', 'siteurl', 'url', 'link', 'websitelink']);
  const nameHeaders = new Set(['websitename', 'sitename', 'name', 'title']);
  const firstRowIndex = grid.findIndex((row) => row.some((value) => String(value || '').trim()));
  if (firstRowIndex === -1) return [];
  const firstRow = grid[firstRowIndex];
  const headers = firstRow.map(normalizeHeader);
  const hasHeader = headers.some((header) => urlHeaders.has(header) || nameHeaders.has(header));
  const dataStart = hasHeader ? firstRowIndex + 1 : firstRowIndex;
  const urlColumn = hasHeader ? headers.findIndex((header) => urlHeaders.has(header)) : -1;
  const nameColumn = hasHeader ? headers.findIndex((header) => nameHeaders.has(header)) : -1;
  return grid.slice(dataStart).flatMap((row) => {
    const values = row.map((value) => String(value || '').trim()).filter(Boolean);
    if (!values.length) return [];
    const candidates = urlColumn >= 0 && row[urlColumn] ? [row[urlColumn], ...row] : row;
    const url = candidates.find((value) => {
      try { normalizeUrl(value); return true; } catch { return false; }
    }) || '';
    if (!url) return [{ name: nameColumn >= 0 ? row[nameColumn] || '' : '', url: '' }];
    const name = (nameColumn >= 0 ? row[nameColumn] : '') || values.find((value) => value !== String(url).trim()) || '';
    return [{ name, url }];
  });
}
export function defaultGoogleSheetTab(sheetNames) {
  return sheetNames.find((name) => /^all\s+sites?$/i.test(name.trim())) || sheetNames[0] || null;
}
export function countHealthyWebsites(websiteChecks) {
  return websiteChecks.filter(({ active, lastCheck }) => active && lastCheck?.status === 'healthy').length;
}
export function summarizeWebsiteProgress(websiteChecks, runChecks, runStatus, runTotal = null) {
  const checksByWebsite = new Map(runChecks.map((check) => [check.websiteId, check]));
  const scopedRun = Number.isFinite(runTotal) && runTotal > 0 && runChecks.length > 0;
  const statuses = scopedRun
    ? runChecks
    : websiteChecks.map(({ websiteId, lastCheck }) => checksByWebsite.get(websiteId) || lastCheck);
  const completed = statuses.filter((check) => ['healthy', 'warning', 'critical'].includes(check?.status)).length;
  const processing = statuses.filter((check) => check?.status === 'processing').length;
  const cancelled = statuses.filter((check) => check?.status === 'cancelled').length;
  // Checks are deleted together with their website, so the run's stored total can be stale; the surviving checks are the true scope.
  const total = scopedRun ? runChecks.length : statuses.length;
  const progressUnits = statuses.reduce((sum, check) => {
    if (['healthy', 'warning', 'critical'].includes(check?.status)) return sum + 100;
    if (check?.status === 'cancelled') return sum + 100;
    if (check?.status === 'processing') return sum + (check.progressPercent || 0);
    return sum;
  }, 0);
  const terminal = completed + cancelled;
  return {
    status: runStatus === 'cancelled' ? 'cancelled' : runStatus === 'running' && terminal < total ? 'running' : total > 0 && terminal === total ? 'completed' : 'idle',
    total,
    completed,
    processing,
    pending: Math.max(0, total - completed - processing - cancelled),
    queued: runStatus === 'running' ? runChecks.filter((check) => check.status === 'pending').length : 0,
    cancelled,
    percent: total ? Math.floor(progressUnits / total) : 0
  };
}
export function nameFromUrl(value) { return new URL(normalizeUrl(value)).hostname.replace(/^www\./, '').split('.')[0].replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }
export function parseBulkText(text) { return String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => { const parts = line.split('|').map((part) => part.trim()); return parts.length > 1 ? { name: parts[0], url: parts[1] } : { name: '', url: parts[0] }; }); }
export function escapeCsv(value) { const text = String(value ?? ''); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
export function toCsv(rows) { const headers = ['Website', 'URL', 'Status', 'Homepage HTTP', 'Load Time (ms)', 'Desktop Contact', 'Desktop News', 'Mobile Contact', 'Mobile News', 'Issues']; const fields = ['name', 'url', 'status', 'homepageStatusCode', 'loadTimeMs', 'desktopContactStatus', 'desktopNewsStatus', 'mobileContactStatus', 'mobileNewsStatus', 'errorSummary']; return `${headers.join(',')}\n${rows.map((row) => fields.map((field) => escapeCsv(row[field])).join(',')).join('\n')}\n`; }