import { connectedGoogleAccessToken } from './google-sheets.js';

const analyticsAdminApi = 'https://analyticsadmin.googleapis.com/v1beta';
const analyticsDataApi = 'https://analyticsdata.googleapis.com/v1beta';
const searchConsoleApi = 'https://www.googleapis.com/webmasters/v3';
const retryableStatuses = new Set([429, 500, 502, 503, 504]);
const maxAttempts = 3;
const requestTimeoutMs = 20000;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function googleRequest(url, token, options = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    let response;
    try {
      response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(options.body ? { 'content-type': 'application/json' } : {}),
          ...options.headers
        }
      });
    } catch (error) {
      if (attempt >= maxAttempts) throw new Error(`Google API request failed: ${error.message}`);
      await wait(500 * 2 ** (attempt - 1));
      continue;
    } finally {
      clearTimeout(timeout);
    }

    const data = await response.json().catch(() => ({}));
    if (response.ok) return data;
    if (retryableStatuses.has(response.status) && attempt < maxAttempts) {
      const retryAfter = Number(response.headers?.get?.('retry-after'));
      await wait(Math.min(10000, retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** (attempt - 1)));
      continue;
    }
    throw new Error(`Google API request failed (${response.status}): ${data.error?.message || response.statusText}`);
  }
}

function normalizedName(value) {
  return String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[^a-z0-9]/g, '');
}

function websiteHostname(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function searchConsoleHostname(siteUrl) {
  const value = String(siteUrl || '');
  if (value.startsWith('sc-domain:')) return value.slice('sc-domain:'.length).toLowerCase().replace(/^www\./, '');
  return websiteHostname(value);
}

export function isValidSearchConsoleSiteUrl(siteUrl) {
  const value = String(siteUrl || '').trim();
  if (!value) return true;
  if (value.startsWith('sc-domain:')) {
    const domain = value.slice('sc-domain:'.length);
    return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain);
  }
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol)
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export function matchAnalyticsProperty(website, properties) {
  const labels = new Set([normalizedName(website.name), normalizedName(websiteHostname(website.url))].filter(Boolean));
  const matches = properties.filter((property) => labels.has(normalizedName(property.displayName)));
  return matches.length === 1 ? matches[0].propertyId : '';
}

export function matchSearchConsoleSite(websiteUrl, sites) {
  const host = websiteHostname(websiteUrl);
  if (!host) return '';
  const matches = sites.map((site) => {
    const siteHost = searchConsoleHostname(site.siteUrl);
    if (!siteHost || !(host === siteHost || host.endsWith(`.${siteHost}`))) return null;
    const exact = host === siteHost;
    const prefix = site.siteUrl.startsWith('sc-domain:') ? 0 : 1;
    return { site, score: (exact ? 10000 : 0) + siteHost.length + prefix };
  }).filter(Boolean).sort((a, b) => b.score - a.score);
  if (!matches.length || (matches[1] && matches[0].score === matches[1].score)) return '';
  return matches[0].site.siteUrl;
}

async function listAnalyticsProperties(token) {
  const properties = new Map();
  let pageToken = '';
  do {
    const url = new URL(`${analyticsAdminApi}/accountSummaries`);
    url.searchParams.set('pageSize', '200');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const data = await googleRequest(url, token);
    for (const account of data.accountSummaries || []) {
      for (const property of account.propertySummaries || []) {
        const propertyId = String(property.property || '').split('/').pop();
        if (propertyId) properties.set(propertyId, {
          propertyId,
          displayName: property.displayName || propertyId,
          accountName: account.displayName || ''
        });
      }
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return [...properties.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

async function listSearchConsoleSites(token) {
  const data = await googleRequest(`${searchConsoleApi}/sites`, token);
  return (data.siteEntry || [])
    .filter((site) => site.siteUrl)
    .map((site) => ({ siteUrl: site.siteUrl, permissionLevel: site.permissionLevel || '' }))
    .sort((a, b) => a.siteUrl.localeCompare(b.siteUrl));
}

export async function discoverGoogleTrafficProperties() {
  const token = await connectedGoogleAccessToken();
  const [analyticsResult, searchConsoleResult] = await Promise.allSettled([
    listAnalyticsProperties(token),
    listSearchConsoleSites(token)
  ]);
  return {
    analytics: analyticsResult.status === 'fulfilled'
      ? { properties: analyticsResult.value, error: '' }
      : { properties: [], error: analyticsResult.reason.message },
    searchConsole: searchConsoleResult.status === 'fulfilled'
      ? { sites: searchConsoleResult.value, error: '' }
      : { sites: [], error: searchConsoleResult.reason.message }
  };
}

export function trafficDateRange(now = new Date()) {
  const dateDaysAgo = (days) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days));
    return date.toISOString().slice(0, 10);
  };
  return { startDate: dateDaysAgo(30), endDate: dateDaysAgo(3) };
}

async function analyticsReport(website, range, token) {
  const url = `${analyticsDataApi}/properties/${encodeURIComponent(website.traffic.analyticsPropertyId)}:runReport`;
  const data = await googleRequest(url, token, {
    method: 'POST',
    body: JSON.stringify({
      dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
      metrics: [
        { name: 'sessions' },
        { name: 'totalUsers' },
        { name: 'newUsers' },
        { name: 'screenPageViews' }
      ]
    })
  });
  const values = data.rows?.[0]?.metricValues || [];
  return {
    sessions: Number(values[0]?.value || 0),
    users: Number(values[1]?.value || 0),
    newUsers: Number(values[2]?.value || 0),
    pageViews: Number(values[3]?.value || 0)
  };
}

async function searchConsoleReport(website, range, token) {
  const siteUrl = website.traffic.searchConsoleSiteUrl;
  const url = `${searchConsoleApi}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const data = await googleRequest(url, token, {
    method: 'POST',
    body: JSON.stringify({
      startDate: range.startDate,
      endDate: range.endDate,
      type: 'web',
      rowLimit: 1
    })
  });
  const row = data.rows?.[0] || {};
  return {
    clicks: Number(row.clicks || 0),
    impressions: Number(row.impressions || 0),
    ctr: Number(row.ctr || 0),
    position: Number(row.position || 0)
  };
}

export async function inspectGoogleTraffic(website, range = trafficDateRange()) {
  const token = await connectedGoogleAccessToken();
  const [analyticsResult, searchConsoleResult] = await Promise.allSettled([
    website.traffic?.analyticsPropertyId
      ? analyticsReport(website, range, token)
      : Promise.reject(new Error('GA4 property is not mapped.')),
    website.traffic?.searchConsoleSiteUrl
      ? searchConsoleReport(website, range, token)
      : Promise.reject(new Error('Search Console property is not mapped.'))
  ]);
  return {
    analytics: analyticsResult.status === 'fulfilled' ? analyticsResult.value : null,
    analyticsError: analyticsResult.status === 'rejected' ? analyticsResult.reason.message : '',
    searchConsole: searchConsoleResult.status === 'fulfilled' ? searchConsoleResult.value : null,
    searchConsoleError: searchConsoleResult.status === 'rejected' ? searchConsoleResult.reason.message : ''
  };
}
