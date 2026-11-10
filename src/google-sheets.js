import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from './config.js';
import { Check, Setting, Website } from './models.js';
import { normalizeUrl } from './utils.js';

const tokenUrl = 'https://oauth2.googleapis.com/token';
const sheetsApi = 'https://sheets.googleapis.com/v4/spreadsheets';
let cachedAccessToken;

function encryptionKey() {
  return createHash('sha256').update(config.jwtSecret).digest();
}

function encryptSecret(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptSecret(value) {
  const [version, ivHex, tagHex, encryptedHex] = String(value || '').split(':');
  if (version !== 'v1' || !ivHex || !tagHex || !encryptedHex) throw new Error('Stored Google connection is invalid. Reconnect your Google account.');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedHex, 'hex')), decipher.final()]).toString('utf8');
}

async function saveSettings(values) {
  await Promise.all(Object.entries(values).map(([key, value]) => Setting.findOneAndUpdate(
    { key: `googleSheets:${key}` },
    { value: String(value) },
    { upsert: true }
  )));
}

async function readSettings() {
  const values = await Setting.find({ key: /^googleSheets:/ }).lean();
  return Object.fromEntries(values.map(({ key, value }) => [key.slice('googleSheets:'.length), value]));
}

async function accessToken(refreshToken) {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) return cachedAccessToken.value;
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.googleOAuthClientId,
      client_secret: config.googleOAuthClientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    const revoked = data.error === 'invalid_grant'
      || /expired|revoked|invalid grant/i.test(data.error_description || '');
    if (revoked) {
      await disconnectRevokedGoogleAccount();
      const error = new Error('Google authorization expired or revoked. Reconnect your Google account, then try again.');
      error.code = 'GOOGLE_AUTH_REVOKED';
      throw error;
    }
    throw new Error(`Google authorization failed: ${data.error_description || data.error || response.statusText}`);
  }
  cachedAccessToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedAccessToken.value;
}

const retryableStatuses = new Set([429, 500, 502, 503, 504]);
const maxSheetsAttempts = 4;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Google answers 429 when too many requests arrive in a minute, and sometimes 5xx. Both are temporary, so they are retried with a growing delay.
async function sheetsRequest(url, token, options = {}) {
  for (let attempt = 1; ; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(options.body ? { 'content-type': 'application/json' } : {}),
          ...options.headers
        }
      });
    } catch (error) {
      if (attempt >= maxSheetsAttempts) throw error;
      await wait(1000 * 2 ** (attempt - 1));
      continue;
    }
    const data = await response.json().catch(() => ({}));
    if (response.ok) return data;
    if (retryableStatuses.has(response.status) && attempt < maxSheetsAttempts) {
      const retryAfter = Number(response.headers?.get?.('retry-after'));
      await wait(Math.min(30_000, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** (attempt - 1) + Math.random() * 500));
      continue;
    }
    throw new Error(`Google Sheets request failed (${response.status}): ${data.error?.message || response.statusText}`);
  }
}

export function formatGoogleSheetStatus(result) {
  const failure = result.failure || result.rawResult?.failure;
  if (failure) {
    const reason = compactError(failure);
    return reason === 'Check failed' ? 'Check could not be completed' : `Check failed: ${reason}`;
  }
  const issues = [];
  for (const [label, check] of [
    ['Desktop Contact', result.desktop?.contact],
    ['Desktop News', result.desktop?.news],
    ['Mobile Contact', result.mobile?.contact],
    ['Mobile News', result.mobile?.news]
  ]) {
    if (!check || !['missing', 'error'].includes(check.status)) continue;
    issues.push(`${label}: ${check.status === 'missing' ? 'Not found' : compactError(check.error || (check.statusCode ? `HTTP ${check.statusCode}` : ''))}`);
  }

  const homepage = result.homepage || {};
  const pausedChecks = result.pausedChecks || result.rawResult?.pausedChecks || [];
  // A paused homepage check is not reported at all; a paused loading-time check only hides the timeout warning.
  if (homepage.suspended) issues.unshift('Homepage: Account suspended');
  else if (pausedChecks.includes('homepage')) { /* paused: no homepage problems are written to the sheet */ }
  else if (homepage.sslValid === false) issues.unshift(`Homepage: ${compactError(homepage.error || 'SSL certificate')}`);
  else if (homepage.blank) issues.unshift('Homepage: Blank response');
  else if (homepage.timedOut) { if (!pausedChecks.includes('loadTime')) issues.unshift('Homepage: Request timed out'); }
  else if (!homepage.statusCode) issues.unshift(`Homepage: ${compactError(homepage.error || 'Could not be reached')}`);
  else if (homepage.statusCode >= 400) issues.unshift(`Homepage: HTTP ${homepage.statusCode}`);

  return issues.length ? issues.join('; ') : 'Site OK';
}

function compactError(error) {
  const message = String(error || '');
  const code = message.match(/\b(?:net::)?(ERR_[A-Z0-9_]+)\b/i)?.[1]?.toUpperCase();
  const knownErrors = {
    ERR_CONNECTION_REFUSED: 'Connection refused',
    ERR_CONNECTION_RESET: 'Connection interrupted',
    ERR_CONNECTION_TIMED_OUT: 'Connection timed out',
    ERR_TIMED_OUT: 'Connection timed out',
    ERR_NAME_NOT_RESOLVED: 'Domain name not found',
    ERR_CERT_AUTHORITY_INVALID: 'SSL certificate not trusted',
    ERR_CERT_COMMON_NAME_INVALID: 'SSL certificate domain mismatch',
    ERR_CERT_DATE_INVALID: 'SSL certificate expired',
    ERR_SSL_PROTOCOL_ERROR: 'SSL connection failed',
    ERR_TOO_MANY_REDIRECTS: 'Too many redirects'
  };
  if (knownErrors[code]) return knownErrors[code];
  const httpStatus = message.match(/\bHTTP\s+(\d{3})\b/i)?.[1];
  if (httpStatus) return `HTTP ${httpStatus}`;
  if (/took longer than/i.test(message)) return 'Timed out';
  if (/timeout/i.test(message)) return 'Connection timed out';
  if (/ssl|certificate/i.test(message)) return 'SSL problem';
  if (/not added|missing/i.test(message)) return 'Not found';
  if (/could not be opened|unable to open/i.test(message)) return 'Could not be reached';
  return 'Check failed';
}

function googleSheetRow(website, result) {
  const summary = result ? formatGoogleSheetStatus(result) : 'Not checked';
  return [
    website.url,
    summary === 'Site OK' ? 'Site OK' : result ? 'Issue found' : 'Not checked',
    summary === 'Site OK' || !result ? '' : summary
  ];
}

function spreadsheetIdFromUrl(input) {
  let url;
  try {
    url = new URL(String(input || ''));
  } catch {
    throw new Error('Enter a valid Google Sheets URL.');
  }
  const match = url.protocol === 'https:' && url.hostname === 'docs.google.com' && url.pathname.match(/^\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) throw new Error('Enter a Google Sheets URL in the format https://docs.google.com/spreadsheets/d/...');
  return match[1];
}

function spreadsheetUrlWithTab(spreadsheetId, worksheetId) {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${worksheetId}`;
}

function currentResultsTabTitle() {
  const dateParts = new Intl.DateTimeFormat('en', {
    timeZone: config.defaultTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const parts = Object.fromEntries(dateParts.map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function worksheetRange(sheetTitle, cells) {
  const escapedTitle = sheetTitle.replace(/'/g, "''");
  return `${encodeURIComponent(`'${escapedTitle}'`)}!${cells}`;
}

async function ensureDailyWorksheet(spreadsheetId, token) {
  const encodedId = encodeURIComponent(spreadsheetId);
  const title = currentResultsTabTitle();
  let metadata = await sheetsRequest(`${sheetsApi}/${encodedId}`, token);
  let selectedSheet = metadata.sheets?.find(({ properties }) => properties?.title === title);
  if (!selectedSheet) {
    try {
      await sheetsRequest(`${sheetsApi}/${encodedId}:batchUpdate`, token, {
        method: 'POST',
        body: JSON.stringify({
          requests: [{
            addSheet: {
              properties: {
                title,
                gridProperties: { frozenRowCount: 1, columnCount: 3 }
              }
            }
          }]
        })
      });
    } catch (error) {
      metadata = await sheetsRequest(`${sheetsApi}/${encodedId}`, token);
      selectedSheet = metadata.sheets?.find(({ properties }) => properties?.title === title);
      if (!selectedSheet) throw error;
    }
    if (!selectedSheet) {
      metadata = await sheetsRequest(`${sheetsApi}/${encodedId}`, token);
      selectedSheet = metadata.sheets?.find(({ properties }) => properties?.title === title);
    }
  }
  if (!selectedSheet?.properties?.title || selectedSheet.properties.sheetId == null) {
    throw new Error(`Could not find or create the daily results tab "${title}".`);
  }
  const worksheetTitle = selectedSheet.properties.title;
  const worksheetId = selectedSheet.properties.sheetId;
  const headerRange = worksheetRange(worksheetTitle, 'A1:C1');
  await sheetsRequest(`${sheetsApi}/${encodedId}/values/${headerRange}?valueInputOption=RAW`, token, {
    method: 'PUT',
    body: JSON.stringify({ values: [['Website URL', 'Status', 'Issue']] })
  });
  return { worksheetTitle, worksheetId };
}

async function writeResultsRows(spreadsheetId, rows, token) {
  const { worksheetTitle, worksheetId } = await ensureDailyWorksheet(spreadsheetId, token);
  const encodedId = encodeURIComponent(spreadsheetId);
  const range = (cells) => worksheetRange(worksheetTitle, cells);
  await sheetsRequest(`${sheetsApi}/${encodedId}/values/${range('A:C')}:clear`, token, { method: 'POST', body: JSON.stringify({}) });
  await sheetsRequest(`${sheetsApi}/${encodedId}/values/${range(`A1:C${rows.length}`)}?valueInputOption=RAW`, token, {
    method: 'PUT',
    body: JSON.stringify({ values: rows })
  });
  return {
    spreadsheetUrl: spreadsheetUrlWithTab(spreadsheetId, worksheetId),
    worksheetTitle,
    worksheetId
  };
}

export function googleSheetsConfigured() {
  return Boolean(config.googleOAuthClientId && config.googleOAuthClientSecret && config.googleOAuthRedirectUri);
}

export function createGoogleAuthorizationUrl(state) {
  if (!googleSheetsConfigured()) throw new Error('Google OAuth is not configured on the server.');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', config.googleOAuthClientId);
  url.searchParams.set('redirect_uri', config.googleOAuthRedirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  return url.toString();
}

export async function exchangeGoogleAuthorizationCode(code) {
  if (!googleSheetsConfigured()) throw new Error('Google OAuth is not configured on the server.');
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.googleOAuthClientId,
      client_secret: config.googleOAuthClientSecret,
      redirect_uri: config.googleOAuthRedirectUri,
      grant_type: 'authorization_code'
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(`Google authorization failed: ${data.error_description || data.error || response.statusText}`);
  }
  let refreshToken = data.refresh_token;
  if (!refreshToken) refreshToken = decryptSecret((await readSettings()).refreshToken);
  if (!refreshToken) throw new Error('Google did not provide a refresh token. Reconnect and approve offline access.');

  const userResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${data.access_token}` }
  });
  const user = await userResponse.json().catch(() => ({}));
  if (!userResponse.ok || !user.email) throw new Error('Google account email could not be verified.');

  await saveSettings({ refreshToken: encryptSecret(refreshToken), email: user.email });
  cachedAccessToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return user.email;
}

export async function googleSheetsStatus() {
  const values = await readSettings();
  let connected = Boolean(values.refreshToken && values.email);
  if (connected) {
    try {
      await accessToken(decryptSecret(values.refreshToken));
    } catch (error) {
      if (error.code !== 'GOOGLE_AUTH_REVOKED') throw error;
      return {
        configured: googleSheetsConfigured(),
        connected: false,
        email: null,
        spreadsheetUrl: null,
        pending: 0,
        lastSyncError: null,
        lastSyncAt: null
      };
    }
  }
  return {
    configured: googleSheetsConfigured(),
    connected,
    email: values.email || null,
    spreadsheetUrl: values.spreadsheetUrl || null,
    // Results that are saved in the monitor but not yet written to the sheet.
    pending: connected && values.spreadsheetId ? await pendingSheetRowCount() : 0,
    lastSyncError: values.lastSyncError || null,
    lastSyncAt: values.lastSyncAt || null
  };
}

async function disconnectRevokedGoogleAccount() {
  cachedAccessToken = undefined;
  await Setting.deleteMany({
    key: {
      $in: [
        'googleSheets:refreshToken',
        'googleSheets:email',
        'googleSheets:spreadsheetId',
        'googleSheets:spreadsheetUrl',
        'googleSheets:worksheetTitle'
      ]
    }
  });
}

async function connectedAccount() {
  const values = await readSettings();
  if (!values.refreshToken) throw new Error('Connect a Google account before creating a results sheet.');
  return { values, token: await accessToken(decryptSecret(values.refreshToken)) };
}

export async function createResultsSheet(websites, { mode = 'reuse', spreadsheetUrl: requestedSpreadsheetUrl = '' } = {}) {
  if (!websites.length) throw new Error('Add at least one website before creating a results sheet.');
  const { values, token } = await connectedAccount();
  if (!['reuse', 'new', 'existing'].includes(mode)) throw new Error('Choose whether to create a new sheet or use an existing sheet.');
  if (mode === 'existing' && !requestedSpreadsheetUrl) throw new Error('Paste the Google Sheets URL you want to use.');
  const existingSpreadsheetId = mode === 'existing'
    ? spreadsheetIdFromUrl(requestedSpreadsheetUrl)
    : mode === 'reuse' ? values.spreadsheetId || values.lastSpreadsheetId : null;
  const orderedWebsites = [...websites].sort((first, second) => first.sortOrder - second.sortOrder);
  const lastRow = orderedWebsites.reduce((max, website) => Math.max(max, Number.isInteger(website.sortOrder) && website.sortOrder >= 0 ? website.sortOrder + 2 : max), 1);
  const rows = Array.from({ length: lastRow }, () => ['', '', '']);
  rows[0] = ['Website URL', 'Status', 'Issue'];
  for (const website of orderedWebsites) {
    const rowIndex = Number.isInteger(website.sortOrder) && website.sortOrder >= 0 ? website.sortOrder + 1 : rows.length;
    rows[rowIndex] = googleSheetRow(website, website.lastCheck);
  }

  if (existingSpreadsheetId) {
    const selectedSheet = await writeResultsRows(existingSpreadsheetId, rows, token);
    const spreadsheetUrl = selectedSheet.spreadsheetUrl;
    await saveSettings({
      spreadsheetId: existingSpreadsheetId,
      spreadsheetUrl,
      worksheetTitle: selectedSheet.worksheetTitle,
      lastSpreadsheetId: existingSpreadsheetId,
      lastSpreadsheetUrl: spreadsheetUrl
    });
    return { spreadsheetUrl, created: false };
  }

  const spreadsheet = await sheetsRequest(sheetsApi, token, {
    method: 'POST',
    body: JSON.stringify({
      properties: { title: 'Website Monitor Results' },
      sheets: [{
        properties: {
          title: currentResultsTabTitle(),
          gridProperties: { frozenRowCount: 1, rowCount: Math.max(config.maxWebsites + 1, 1000), columnCount: 3 }
        }
      }]
    })
  });
  const selectedSheet = await writeResultsRows(spreadsheet.spreadsheetId, rows, token);
  const spreadsheetUrl = selectedSheet.spreadsheetUrl;
  await saveSettings({
    spreadsheetId: spreadsheet.spreadsheetId,
    spreadsheetUrl,
    worksheetTitle: selectedSheet.worksheetTitle,
    lastSpreadsheetId: spreadsheet.spreadsheetId,
    lastSpreadsheetUrl: spreadsheetUrl
  });
  await sheetsRequest(`${sheetsApi}/${encodeURIComponent(spreadsheet.spreadsheetId)}:batchUpdate`, token, {
    method: 'POST',
    body: JSON.stringify({
      requests: [{
        repeatCell: {
          range: { sheetId: spreadsheet.sheets.find(({ properties }) => properties.title === selectedSheet.worksheetTitle)?.properties.sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { backgroundColor: { red: 0.09, green: 0.16, blue: 0.14 }, textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true } } },
          fields: 'userEnteredFormat(backgroundColor,textFormat)'
        }
      }]
    })
  });
  return { spreadsheetUrl, created: true };
}

export async function syncWebsiteStatusToSheet(website, result) {
  const values = await readSettings();
  if (!values.spreadsheetId || !values.refreshToken) return false;
  const token = await accessToken(decryptSecret(values.refreshToken));
  const { worksheetTitle, worksheetId } = await ensureDailyWorksheet(values.spreadsheetId, token);
  if (values.worksheetTitle !== worksheetTitle) {
    const spreadsheetUrl = spreadsheetUrlWithTab(values.spreadsheetId, worksheetId);
    await saveSettings({ worksheetTitle, spreadsheetUrl, lastSpreadsheetUrl: spreadsheetUrl });
  }

  let rowNumber = Number.isInteger(website.sortOrder) && website.sortOrder >= 0 ? website.sortOrder + 2 : null;
  if (rowNumber === null) {
    const range = worksheetRange(worksheetTitle, 'A:A');
    const data = await sheetsRequest(`${sheetsApi}/${encodeURIComponent(values.spreadsheetId)}/values/${range}`, token);
    const url = normalizeUrl(website.url);
    rowNumber = (data.values || []).findIndex((row, index) => index > 0 && safeNormalizeUrl(row[0]) === url) + 1;
    if (rowNumber < 2) throw new Error(`Website row was not found in the results sheet: ${website.url}`);
  }
  const range = worksheetRange(worksheetTitle, `A${rowNumber}:C${rowNumber}`);
  await sheetsRequest(`${sheetsApi}/${encodeURIComponent(values.spreadsheetId)}/values/${range}?valueInputOption=RAW`, token, {
    method: 'PUT',
    body: JSON.stringify({ values: [googleSheetRow(website, result)] })
  });
  return true;
}

// A website is waiting for the sheet while its latest check differs from the check already written there.
const pendingSheetFilter = { lastCheck: { $ne: null }, sortOrder: { $type: 'number' }, $expr: { $ne: ['$lastCheck', '$sheetSyncedCheck'] } };
let sheetSyncRunning = false;
let sheetSyncPausedUntil = 0;

export function pendingSheetRowCount() {
  return Website.countDocuments(pendingSheetFilter);
}

function rawWorksheetRange(sheetTitle, cells) {
  return `'${sheetTitle.replace(/'/g, "''")}'!${cells}`;
}

// Writes every waiting result to the sheet in one request per batch. Nothing is lost when Google is slow or unreachable:
// the websites simply stay "waiting" and the next run of this function sends them again.
export async function syncPendingSheetRows({ force = false, batchSize = 100, maxBatches = 1 } = {}) {
  if (sheetSyncRunning) return { synced: 0, busy: true };
  if (!force && Date.now() < sheetSyncPausedUntil) return { synced: 0, waiting: true };
  sheetSyncRunning = true;
  let synced = 0;
  try {
    const values = await readSettings();
    if (!values.spreadsheetId || !values.refreshToken) return { synced: 0 };
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const websites = await Website.find(pendingSheetFilter).sort({ sortOrder: 1, _id: 1 }).limit(batchSize).select('url sortOrder lastCheck').lean();
      if (!websites.length) break;
      const checks = await Check.find({ _id: { $in: websites.map((website) => website.lastCheck) } }).lean();
      const checkById = new Map(checks.map((check) => [String(check._id), check]));
      const writable = websites.filter((website) => checkById.has(String(website.lastCheck)));
      if (writable.length) {
        const token = await accessToken(decryptSecret(values.refreshToken));
        const { worksheetTitle, worksheetId } = await ensureDailyWorksheet(values.spreadsheetId, token);
        if (values.worksheetTitle !== worksheetTitle) {
          const spreadsheetUrl = spreadsheetUrlWithTab(values.spreadsheetId, worksheetId);
          await saveSettings({ worksheetTitle, spreadsheetUrl, lastSpreadsheetUrl: spreadsheetUrl });
          values.worksheetTitle = worksheetTitle;
        }
        await sheetsRequest(`${sheetsApi}/${encodeURIComponent(values.spreadsheetId)}/values:batchUpdate`, token, {
          method: 'POST',
          body: JSON.stringify({
            valueInputOption: 'RAW',
            data: writable.map((website) => ({
              range: rawWorksheetRange(worksheetTitle, `A${website.sortOrder + 2}:C${website.sortOrder + 2}`),
              values: [googleSheetRow(website, checkById.get(String(website.lastCheck)))]
            }))
          })
        });
      }
      // Websites whose check no longer exists have nothing to write, so they are marked as done too. Only the exact check that was sent is marked, so a newer result is never skipped.
      await Website.bulkWrite(websites.map((website) => ({
        updateOne: { filter: { _id: website._id, lastCheck: website.lastCheck }, update: { $set: { sheetSyncedCheck: website.lastCheck } } }
      })));
      synced += writable.length;
      if (websites.length < batchSize) break;
    }
    await saveSettings({ lastSyncAt: new Date().toISOString(), lastSyncError: '' });
    return { synced };
  } catch (error) {
    sheetSyncPausedUntil = Date.now() + 30_000;
    await saveSettings({ lastSyncError: error.message }).catch(() => {});
    throw error;
  } finally {
    sheetSyncRunning = false;
  }
}

export async function disableGoogleSheetSync() {
  const values = await readSettings();
  if (values.spreadsheetId && values.spreadsheetUrl) {
    await saveSettings({ lastSpreadsheetId: values.spreadsheetId, lastSpreadsheetUrl: values.spreadsheetUrl });
  }
  await Setting.deleteMany({ key: { $in: ['googleSheets:spreadsheetId', 'googleSheets:spreadsheetUrl'] } });
}

function safeNormalizeUrl(value) {
  try {
    return normalizeUrl(value);
  } catch {
    return '';
  }
}