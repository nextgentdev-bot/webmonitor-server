import { connectedGoogleAccessToken } from './google-sheets.js';
import { config } from './config.js';

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

function localDate(now, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function trafficDateRange(now = new Date(), timeZone = config.defaultTimezone) {
  const date = localDate(now, timeZone);
  return { startDate: date, endDate: date };
}

export function latestTrafficUpdate(result, now = new Date()) {
  const today = trafficDateRange(now).endDate;
  const date = new Date(`${today}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  const yesterday = date.toISOString().slice(0, 10);
  const update = {};
  if (result?.analytics && result.analyticsStartDate === today && result.analyticsEndDate === today) {
    update['traffic.latest.analytics'] = result.analytics;
    update['traffic.latest.analyticsDate'] = today;
    update['traffic.latest.analyticsUpdatedAt'] = now;
  }
  if (result?.searchConsole && result.searchConsoleStartDate === yesterday && result.searchConsoleEndDate === yesterday) {
    update['traffic.latest.searchConsole'] = result.searchConsole;
    update['traffic.latest.searchConsoleDate'] = yesterday;
    update['traffic.latest.searchConsoleUpdatedAt'] = now;
  }
  return update;
}

export function analyticsTodayRange(now = new Date(), timeZone = config.defaultTimezone) {
  const date = localDate(now, timeZone);
  return { startDate: date, endDate: date };
}

export function analyticsDateRangeError(startDate, endDate, today = trafficDateRange().endDate) {
  const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
  if (!isDate(startDate) || !isDate(endDate)) return 'Enter valid start and end dates.';
  if (startDate > endDate) return 'Start date must be on or before end date.';
  if (endDate > today) return `End date cannot be after today (${today}).`;
  return '';
}

export function trafficReportRangeErrors(ranges, today = trafficDateRange().endDate) {
  return {
    analytics: analyticsDateRangeError(
      String(ranges.analyticsStartDate || ''),
      String(ranges.analyticsEndDate || ''),
      today
    ),
    searchConsole: analyticsDateRangeError(
      String(ranges.searchConsoleStartDate || ''),
      String(ranges.searchConsoleEndDate || ''),
      today
    )
  };
}

export function previousTrafficDateRange(range) {
  const startDate = new Date(`${range.startDate}T00:00:00.000Z`);
  const endDate = new Date(`${range.endDate}T00:00:00.000Z`);
  const start = startDate.getTime();
  const end = endDate.getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const lastDayOfStartMonth = new Date(Date.UTC(
    startDate.getUTCFullYear(),
    startDate.getUTCMonth() + 1,
    0
  )).getUTCDate();
  if (startDate.getUTCDate() === 1 && endDate.getUTCDate() === lastDayOfStartMonth) {
    const previousStart = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() - 1, 1));
    const previousEnd = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 0));
    return {
      startDate: previousStart.toISOString().slice(0, 10),
      endDate: previousEnd.toISOString().slice(0, 10)
    };
  }
  const duration = Math.floor((end - start) / dayMs) + 1;
  const previousEnd = new Date(start - dayMs);
  const previousStart = new Date(start - duration * dayMs);
  return {
    startDate: previousStart.toISOString().slice(0, 10),
    endDate: previousEnd.toISOString().slice(0, 10)
  };
}

async function analyticsMetricReport(propertyId, range, token) {
  const url = `${analyticsDataApi}/properties/${encodeURIComponent(propertyId)}:runReport`;
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

export async function readAnalyticsTrafficOverview(propertyId, range, token) {
  const url = `${analyticsDataApi}/properties/${encodeURIComponent(propertyId)}:runReport`;
  const dateRanges = [{ startDate: range.startDate, endDate: range.endDate }];
  const [monthlyData, channelsData, countriesData] = await Promise.all([
    googleRequest(url, token, {
      method: 'POST',
      body: JSON.stringify({
        dateRanges,
        dimensions: [{ name: 'yearMonth' }],
        metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'screenPageViews' }],
        orderBys: [{ dimension: { dimensionName: 'yearMonth' } }],
        limit: '1200'
      })
    }),
    googleRequest(url, token, {
      method: 'POST',
      body: JSON.stringify({
        dateRanges,
        dimensions: [{ name: 'sessionDefaultChannelGroup' }],
        metrics: [{ name: 'sessions' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: '5'
      })
    }),
    googleRequest(url, token, {
      method: 'POST',
      body: JSON.stringify({
        dateRanges,
        dimensions: [{ name: 'country' }],
        metrics: [{ name: 'sessions' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: '5'
      })
    })
  ]);
  const rowsForDimension = (data) => (data.rows || []).map((row) => ({
    name: row.dimensionValues?.[0]?.value || '',
    sessions: Number(row.metricValues?.[0]?.value || 0)
  }));
  return {
    monthly: (monthlyData.rows || []).map((row) => {
      const value = row.dimensionValues?.[0]?.value || '';
      return {
        month: value.length === 6 ? `${value.slice(0, 4)}-${value.slice(4)}` : value,
        sessions: Number(row.metricValues?.[0]?.value || 0),
        users: Number(row.metricValues?.[1]?.value || 0),
        pageViews: Number(row.metricValues?.[2]?.value || 0)
      };
    }),
    channels: rowsForDimension(channelsData),
    countries: rowsForDimension(countriesData)
  };
}

async function analyticsReport(website, range, token) {
  const report = await analyticsMetricReport(website.traffic.analyticsPropertyId, range, token);
  let activeUsers = null;
  try {
    activeUsers = await readRealtimeActiveUsers(website.traffic.analyticsPropertyId, token);
  } catch {
    activeUsers = null;
  }
  return {
    ...report,
    activeUsers
  };
}

export async function inspectGoogleAnalyticsReports(websites, range) {
  const token = await connectedGoogleAccessToken();
  const propertyIds = [...new Set(websites.map(({ traffic }) => traffic?.analyticsPropertyId).filter(Boolean))];
  const propertyResults = new Map();
  for (let index = 0; index < propertyIds.length; index += 5) {
    const batch = propertyIds.slice(index, index + 5);
    const results = await Promise.all(batch.map(async (propertyId) => {
      try {
        return { propertyId, analytics: await analyticsMetricReport(propertyId, range, token), error: '' };
      } catch (error) {
        return { propertyId, analytics: null, error: error.message };
      }
    }));
    for (const result of results) propertyResults.set(result.propertyId, result);
  }
  return websites.map((website) => ({
    websiteId: String(website._id),
    ...propertyResults.get(website.traffic?.analyticsPropertyId)
  }));
}

export async function readRealtimeActiveUsers(propertyId, token) {
  const url = `${analyticsDataApi}/properties/${encodeURIComponent(propertyId)}:runRealtimeReport`;
  const data = await googleRequest(url, token, {
    method: 'POST',
    body: JSON.stringify({ metrics: [{ name: 'activeUsers' }] })
  });
  const values = data.rows?.[0]?.metricValues || [];
  return Number(values[0]?.value || 0);
}

export async function refreshGoogleRealtimeUsers(websites) {
  const propertyIds = [...new Set(websites.map(({ traffic }) => traffic?.analyticsPropertyId).filter(Boolean))];
  if (!propertyIds.length) return [];

  const token = await connectedGoogleAccessToken();
  const propertyResults = new Map();
  for (let index = 0; index < propertyIds.length; index += 5) {
    const batch = propertyIds.slice(index, index + 5);
    const results = await Promise.all(batch.map(async (propertyId) => {
      try {
        return { propertyId, activeUsers: await readRealtimeActiveUsers(propertyId, token), error: '' };
      } catch (error) {
        return { propertyId, activeUsers: null, error: error.message };
      }
    }));
    for (const result of results) propertyResults.set(result.propertyId, result);
  }

  return websites.map((website) => ({
    websiteId: String(website._id),
    ...propertyResults.get(website.traffic?.analyticsPropertyId)
  }));
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

export async function readSearchConsoleDailyReport(siteUrl, range, token) {
  const url = `${searchConsoleApi}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const data = await googleRequest(url, token, {
    method: 'POST',
    body: JSON.stringify({
      startDate: range.startDate,
      endDate: range.endDate,
      type: 'web',
      dimensions: ['date'],
      rowLimit: 25000
    })
  });
  return (data.rows || []).map((row) => ({
    date: row.keys?.[0] || '',
    clicks: Number(row.clicks || 0),
    impressions: Number(row.impressions || 0)
  })).filter((row) => row.date);
}

export async function inspectGoogleTraffic(website, ranges = trafficDateRange(), { includeAnalyticsOverview = false } = {}) {
  const token = await connectedGoogleAccessToken();
  const analyticsRange = ranges.analyticsRange || ranges;
  const searchConsoleRange = ranges.searchConsoleRange || ranges;
  const [analyticsResult, searchConsoleResult] = await Promise.allSettled([
    website.traffic?.analyticsPropertyId
      ? analyticsReport(website, analyticsRange, token)
      : Promise.reject(new Error('GA4 property is not mapped.')),
    website.traffic?.searchConsoleSiteUrl
      ? searchConsoleReport(website, searchConsoleRange, token)
      : Promise.reject(new Error('Search Console property is not mapped.'))
  ]);
  let analyticsOverview = null;
  let analyticsOverviewError = '';
  let analyticsComparison = null;
  let analyticsComparisonError = '';
  let searchConsoleDaily = null;
  let searchConsoleOverviewError = '';
  if (includeAnalyticsOverview) {
    const hasAnalyticsProperty = Boolean(website.traffic?.analyticsPropertyId);
    const hasSearchConsoleProperty = Boolean(website.traffic?.searchConsoleSiteUrl);
    const comparisonRange = hasAnalyticsProperty ? previousTrafficDateRange(analyticsRange) : null;
    const [overviewResult, comparisonResult, searchConsoleDailyResult] = await Promise.allSettled([
      hasAnalyticsProperty
        ? readAnalyticsTrafficOverview(website.traffic.analyticsPropertyId, analyticsRange, token)
        : Promise.resolve(null),
      hasAnalyticsProperty
        ? analyticsMetricReport(website.traffic.analyticsPropertyId, comparisonRange, token)
        : Promise.resolve(null),
      hasSearchConsoleProperty
        ? readSearchConsoleDailyReport(website.traffic.searchConsoleSiteUrl, searchConsoleRange, token)
        : Promise.resolve(null)
    ]);
    if (hasAnalyticsProperty) {
      if (overviewResult.status === 'fulfilled') analyticsOverview = overviewResult.value;
      else analyticsOverviewError = overviewResult.reason.message;
      if (comparisonResult.status === 'fulfilled') analyticsComparison = comparisonResult.value;
      else analyticsComparisonError = comparisonResult.reason.message;
    }
    if (hasSearchConsoleProperty) {
      if (searchConsoleDailyResult.status === 'fulfilled') searchConsoleDaily = searchConsoleDailyResult.value;
      else searchConsoleOverviewError = searchConsoleDailyResult.reason.message;
    }
  }
  return {
    analytics: analyticsResult.status === 'fulfilled' ? analyticsResult.value : null,
    analyticsError: analyticsResult.status === 'rejected' ? analyticsResult.reason.message : '',
    analyticsOverview,
    analyticsOverviewError,
    searchConsoleDaily,
    searchConsoleOverviewError,
    analyticsComparison,
    analyticsComparisonError,
    analyticsComparisonStartDate: includeAnalyticsOverview && website.traffic?.analyticsPropertyId
      ? previousTrafficDateRange(analyticsRange).startDate
      : '',
    analyticsComparisonEndDate: includeAnalyticsOverview && website.traffic?.analyticsPropertyId
      ? previousTrafficDateRange(analyticsRange).endDate
      : '',
    analyticsStartDate: analyticsRange.startDate,
    analyticsEndDate: analyticsRange.endDate,
    searchConsole: searchConsoleResult.status === 'fulfilled' ? searchConsoleResult.value : null,
    searchConsoleError: searchConsoleResult.status === 'rejected' ? searchConsoleResult.reason.message : '',
    searchConsoleStartDate: searchConsoleRange.startDate,
    searchConsoleEndDate: searchConsoleRange.endDate
  };
}