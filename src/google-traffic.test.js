import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidSearchConsoleSiteUrl, matchAnalyticsProperty, matchSearchConsoleSite, trafficDateRange } from './google-traffic.js';

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

test('uses 28 complete UTC days ending three days ago for reports', () => {
  assert.deepEqual(trafficDateRange(new Date('2024-03-31T12:00:00.000Z')), {
    startDate: '2024-03-01',
    endDate: '2024-03-28'
  });
});

test('validates Search Console URL-prefix and domain properties', () => {
  assert.equal(isValidSearchConsoleSiteUrl('sc-domain:example.com'), true);
  assert.equal(isValidSearchConsoleSiteUrl('https://www.example.com/path/'), true);
  assert.equal(isValidSearchConsoleSiteUrl('sc-domain:example..com'), false);
  assert.equal(isValidSearchConsoleSiteUrl('https://user@example.com/'), false);
  assert.equal(isValidSearchConsoleSiteUrl('javascript:alert(1)'), false);
});
