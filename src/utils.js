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
export function nameFromUrl(value) { return new URL(normalizeUrl(value)).hostname.replace(/^www\./, '').split('.')[0].replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }
export function parseBulkText(text) { return String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => { const parts = line.split('|').map((part) => part.trim()); return parts.length > 1 ? { name: parts[0], url: parts[1] } : { name: '', url: parts[0] }; }); }
export function escapeCsv(value) { const text = String(value ?? ''); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
export function toCsv(rows) { const headers = ['Website', 'URL', 'Status', 'Homepage HTTP', 'Load Time (ms)', 'Desktop Contact', 'Desktop News', 'Mobile Contact', 'Mobile News', 'Issues']; const fields = ['name', 'url', 'status', 'homepageStatusCode', 'loadTimeMs', 'desktopContactStatus', 'desktopNewsStatus', 'mobileContactStatus', 'mobileNewsStatus', 'errorSummary']; return `${headers.join(',')}\n${rows.map((row) => fields.map((field) => escapeCsv(row[field])).join(',')).join('\n')}\n`; }
