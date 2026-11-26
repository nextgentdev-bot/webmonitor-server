import assert from 'node:assert/strict';
import test from 'node:test';
import { domainInfoInternals, isPublicIp } from './domain-info.js';

const { domainCandidates, eventDate, getDaysRemaining, registrarName } = domainInfoInternals;

test('tries hostname then parent domains for RDAP registration data', () => {
  assert.deepEqual(domainCandidates('shop.example.co.uk'), ['shop.example.co.uk', 'example.co.uk']);
  assert.deepEqual(domainCandidates('example.com'), ['example.com']);
  assert.deepEqual(domainCandidates('localhost'), []);
  assert.deepEqual(domainCandidates('127.0.0.1'), []);
});

test('extracts registrar and relevant RDAP lifecycle events', () => {
  const data = {
    events: [
      { eventAction: 'registration', eventDate: '2024-01-02T00:00:00Z' },
      { eventAction: 'expiration', eventDate: '2027-01-02T00:00:00Z' }
    ],
    entities: [{
      roles: ['registrar'],
      vcardArray: ['vcard', [['fn', {}, 'text', 'Example Registrar']]]
    }]
  };
  assert.equal(registrarName(data), 'Example Registrar');
  assert.equal(eventDate(data, 'registration'), '2024-01-02T00:00:00Z');
  assert.equal(eventDate(data, 'expiration'), '2027-01-02T00:00:00Z');
  assert.equal(eventDate(data, 'last changed'), null);
});

test('calculates remaining days and excludes non-public IP ranges', () => {
  assert.equal(getDaysRemaining('2027-01-02T00:00:00Z', Date.parse('2027-01-01T00:00:00Z')), 1);
  assert.equal(getDaysRemaining(null), null);
  assert.equal(isPublicIp('8.8.8.8'), true);
  assert.equal(isPublicIp('192.168.1.1'), false);
  assert.equal(isPublicIp('127.0.0.1'), false);
  assert.equal(isPublicIp('::1'), false);
  assert.equal(isPublicIp('2606:4700:4700::1111'), true);
});
