import assert from 'node:assert/strict';
import test from 'node:test';
import { isMobileMenuControlLabel, matchesMenuLabel, normalizeMenuLabel } from './monitor.js';

test('normalizes mixed Bengali and English navigation labels', () => {
  assert.equal(normalizeMenuLabel('  Contact—Us  '), 'contact us');
  assert.equal(normalizeMenuLabel('যোগাযোগ করুন'), 'যোগাযোগ করুন');
});

test('matches English contact and news labels in phrases', () => {
  assert.equal(matchesMenuLabel('Get in touch with us', 'contact'), true);
  assert.equal(matchesMenuLabel('Latest News & Updates', 'news'), true);
  assert.equal(matchesMenuLabel('Blog', 'news'), true);
  assert.equal(matchesMenuLabel('Newsletters', 'news'), false);
});

test('matches Bengali contact and news labels', () => {
  assert.equal(matchesMenuLabel('আমাদের সাথে যোগাযোগ করুন', 'contact'), true);
  assert.equal(matchesMenuLabel('সর্বশেষ খবর', 'news'), true);
  assert.equal(matchesMenuLabel('সংবাদ ও বিজ্ঞপ্তি', 'news'), true);
  assert.equal(matchesMenuLabel('নিউজ ও আপডেট', 'news'), true);
  assert.equal(matchesMenuLabel('ব্লগ', 'news'), true);
  assert.equal(matchesMenuLabel(normalizeMenuLabel(['ব্লগ', null, null].filter(Boolean).join(' ')), 'news'), true);
  assert.equal(matchesMenuLabel('ইসলামিক পোস্ট', 'news'), false);
});

test('recognizes English and Bengali mobile menu controls', () => {
  assert.equal(isMobileMenuControlLabel('Open main navigation'), true);
  assert.equal(isMobileMenuControlLabel('Toggle navigation'), true);
  assert.equal(isMobileMenuControlLabel('Menu'), true);
  assert.equal(isMobileMenuControlLabel('Primary main-navigation grid-container site-navigation'), false);
  assert.equal(isMobileMenuControlLabel('মেনু খুলুন'), true);
  assert.equal(isMobileMenuControlLabel('Search the site'), false);
});
