import test from 'node:test';
import assert from 'node:assert/strict';
import { analyticsDateRangeError, analyticsTodayRange, isValidSearchConsoleSiteUrl, matchAnalyticsProperty, matchSearchConsoleSite, previousTrafficDateRange, readAnalyticsTrafficOverview, readRealtimeActiveUsers, readSearchConsoleDailyReport, trafficDateRange, trafficReportRangeErrors } from './google-traffic.js';

test('auto-matches only a single exact GA4 property name', () => {
  const properties = [
    { propertyId: '12345', displayName: 'example.com' },
    { propertyId: '67890', displayName: 'Another site' }
  ];
  assert.equal(matchAnalyticsProperty({ name: 'Example', url: 'https://www.example.com' }, properties), '12345');
  assert.equal(matchAnalyticsProperty({ name: 'example.com', url: 'https://www.example.com' }, [
    ...properties,
    { propertyId: '24680', displayName: 'example.com' }
  ]), '');
});

test('matches Search Console URL-prefix and domain properties to website hosts', () => {
  const sites = [
    { siteUrl: 'sc-domain:example.com' },
    { siteUrl: 'https://shop.example.com/' },
    { siteUrl: 'https://other.example.com/' }
  ];
  assert.equal(matchSearchConsoleSite('https://shop.example.com/products', sites), 'https://shop.example.com/');
  assert.equal(matchSearchConsoleSite('https://www.example.com/', sites), 'sc-domain:example.com');
  assert.equal(matchSearchConsoleSite('https://outside.test/', sites), '');
});

test('uses the configured local calendar date for GA4 and Search Console reports', () => {
  const afterDhakaMidnight = new Date('2024-03-31T20:00:00.000Z');
  assert.deepEqual(trafficDateRange(afterDhakaMidnight), {
    startDate: '2024-04-01',
    endDate: '2024-04-01'
  });
  assert.deepEqual(analyticsTodayRange(afterDhakaMidnight), {
    startDate: '2024-04-01',
    endDate: '2024-04-01'
  });
});

test('uses today for both GA4 and Search Console reports', () => {
  assert.deepEqual(trafficDateRange(new Date('2024-03-31T12:00:00.000Z')), {
    startDate: '2024-03-31',
    endDate: '2024-03-31'
  });
});

test('uses today for GA4 and keeps the shared today range consistent', () => {
  assert.deepEqual(analyticsTodayRange(new Date('2024-03-31T12:00:00.000Z')), {
    startDate: '2024-03-31',
    endDate: '2024-03-31'
  });
  assert.deepEqual(trafficDateRange(new Date('2024-03-31T12:00:00.000Z')), {
    startDate: '2024-03-31',
    endDate: '2024-03-31'
  });
});

test('validates custom GA4 report date ranges', () => {
  assert.equal(analyticsDateRangeError('2024-03-01', '2024-04-01', '2024-04-01'), '');
  assert.equal(analyticsDateRangeError('2024-02-31', '2024-03-01', '2024-04-01'), 'Enter valid start and end dates.');
  assert.equal(analyticsDateRangeError('2024-04-02', '2024-04-01', '2024-04-01'), 'Start date must be on or before end date.');
  assert.equal(analyticsDateRangeError('2024-04-01', '2024-04-02', '2024-04-01'), 'End date cannot be after today (2024-04-01).');
});

test('validates GA4 and Search Console report ranges independently', () => {
  assert.deepEqual(trafficReportRangeErrors({
    analyticsStartDate: '2024-03-01',
    analyticsEndDate: '2024-03-31',
    searchConsoleStartDate: '2024-04-01',
    searchConsoleEndDate: '2024-04-10'
  }, '2024-04-10'), { analytics: '', searchConsole: '' });
  assert.deepEqual(trafficReportRangeErrors({
    analyticsStartDate: '2024-03-01',
    analyticsEndDate: '2024-03-31',
    searchConsoleStartDate: '2024-04-01',
    searchConsoleEndDate: '2024-04-11'
  }, '2024-04-10'), {
    analytics: '',
    searchConsole: 'End date cannot be after today (2024-04-10).'
  });
});

test('uses the previous calendar month when the selected range is a full month', () => {
  assert.deepEqual(previousTrafficDateRange({
    startDate: '2026-10-01',
    endDate: '2026-10-31'
  }), {
    startDate: '2026-09-01',
    endDate: '2026-09-30'
  });
});

test('reads GA4 realtime active users for the selected property', async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl;
  let requestBody;
  globalThis.fetch = async (url, options) => {
    requestUrl = url;
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ rows: [{ metricValues: [{ value: '3' }] }] })
    };
  };
  try {
    assert.equal(await readRealtimeActiveUsers('property/123', 'access-token'), 3);
    assert.equal(requestUrl, 'https://analyticsdata.googleapis.com/v1beta/properties/property%2F123:runRealtimeReport');
    assert.deepEqual(requestBody, { metrics: [{ name: 'activeUsers' }] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('reads monthly GA4 traffic, channels, and countries for the requested range', async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requestBodies.push(body);
    const dimension = body.dimensions[0].name;
    const rows = dimension === 'yearMonth'
      ? [{ dimensionValues: [{ value: '202610' }], metricValues: [{ value: '39' }, { value: '33' }, { value: '42' }] }]
      : [{ dimensionValues: [{ value: dimension === 'country' ? 'Bangladesh' : 'Organic Search' }], metricValues: [{ value: '36' }] }];
    return { ok: true, json: async () => ({ rows }) };
  };
  try {
    const overview = await readAnalyticsTrafficOverview('12345', {
      startDate: '2026-10-01',
      endDate: '2026-10-31'
    }, 'access-token');
    assert.deepEqual(overview, {
      monthly: [{ month: '2026-10', sessions: 39, users: 33, pageViews: 42 }],
      channels: [{ name: 'Organic Search', sessions: 36 }],
      countries: [{ name: 'Bangladesh', sessions: 36 }]
    });
    assert.equal(requestBodies.length, 3);
    assert.equal(requestBodies[0].dimensions[0].name, 'yearMonth');
    assert.ok(requestBodies.every((body) => body.dateRanges[0].startDate === '2026-10-01' && body.dateRanges[0].endDate === '2026-10-31'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('reads Search Console clicks and impressions by date for charting', async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl;
  let requestBody;
  globalThis.fetch = async (url, options) => {
    requestUrl = url;
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        rows: [
          { keys: ['2026-11-22'], clicks: 140, impressions: 17396 },
          { keys: ['2026-11-23'], clicks: 152, impressions: 18120 }
        ]
      })
    };
  };
  try {
    const rows = await readSearchConsoleDailyReport('https://example.com/', {
      startDate: '2026-11-22',
      endDate: '2026-11-28'
    }, 'access-token');
    assert.equal(requestUrl, 'https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com%2F/searchAnalytics/query');
    assert.deepEqual(requestBody, {
      startDate: '2026-11-22',
      endDate: '2026-11-28',
      type: 'web',
      dimensions: ['date'],
      rowLimit: 25000
    });
    assert.deepEqual(rows, [
      { date: '2026-11-22', clicks: 140, impressions: 17396 },
      { date: '2026-11-23', clicks: 152, impressions: 18120 }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('validates Search Console URL-prefix and domain properties', () => {
  assert.equal(isValidSearchConsoleSiteUrl('sc-domain:example.com'), true);
  assert.equal(isValidSearchConsoleSiteUrl('https://www.example.com/path/'), true);
  assert.equal(isValidSearchConsoleSiteUrl('sc-domain:example..com'), false);
  assert.equal(isValidSearchConsoleSiteUrl('https://user@example.com/'), false);
  assert.equal(isValidSearchConsoleSiteUrl('javascript:alert(1)'), false);
});
