import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from './config.js';
import { Setting } from './models.js';
import { createGoogleAuthorizationUrl, createResultsSheet, disableGoogleSheetSync, exchangeGoogleAuthorizationCode, formatGoogleSheetStatus, syncWebsiteStatusToSheet } from './google-sheets.js';

const homepage = { statusCode: 200, sslValid: true, blank: false, timedOut: false };

test('healthy checks and slow-only warnings show Site OK', () => {
  const workingNavigation = {
    desktop: { contact: { status: 'working' }, news: { status: 'working' } },
    mobile: { contact: { status: 'working' }, news: { status: 'working' } }
  };
  assert.equal(formatGoogleSheetStatus({ homepage, ...workingNavigation }), 'Site OK');
  assert.equal(formatGoogleSheetStatus({
    homepage,
    ...workingNavigation,
    issues: ['Main website is slow (9000 ms).']
  }), 'Site OK');
});

test('contact, news and homepage failures are summarized in the sheet', () => {
  assert.equal(formatGoogleSheetStatus({
    homepage,
    desktop: { contact: { status: 'missing' }, news: { status: 'error', statusCode: 404 } },
    mobile: { contact: { status: 'working' }, news: { status: 'skipped' } }
  }), 'Desktop Contact: Not found; Desktop News: HTTP 404');
  assert.equal(formatGoogleSheetStatus({
    homepage: { statusCode: null, sslValid: true, error: 'page.goto: net::ERR_CONNECTION_REFUSED' }
  }), 'Homepage: Connection refused');
});

test('builds a Google OAuth URL with the registered redirect URI and private sheet scopes', () => {
  const previousId = config.googleOAuthClientId;
  const previousSecret = config.googleOAuthClientSecret;
  const previousRedirect = config.googleOAuthRedirectUri;
  config.googleOAuthClientId = 'client-id';
  config.googleOAuthClientSecret = 'client-secret';
  config.googleOAuthRedirectUri = 'https://api.example.com/api/google-sheets/oauth/callback';
  try {
    const authorization = new URL(createGoogleAuthorizationUrl('signed-state'));
    assert.equal(authorization.origin, 'https://accounts.google.com');
    assert.equal(authorization.searchParams.get('client_id'), 'client-id');
    assert.equal(authorization.searchParams.get('redirect_uri'), config.googleOAuthRedirectUri);
    assert.equal(authorization.searchParams.get('state'), 'signed-state');
    assert.match(authorization.searchParams.get('scope'), /spreadsheets/);
    assert.match(authorization.searchParams.get('scope'), /drive\.file/);
  } finally {
    config.googleOAuthClientId = previousId;
    config.googleOAuthClientSecret = previousSecret;
    config.googleOAuthRedirectUri = previousRedirect;
  }
});

test('creates a results sheet and updates completed check rows', async () => {
  const previousConfig = {
    clientId: config.googleOAuthClientId,
    clientSecret: config.googleOAuthClientSecret,
    redirectUri: config.googleOAuthRedirectUri
  };
  const previousFetch = globalThis.fetch;
  const previousFind = Setting.find;
  const previousFindOneAndUpdate = Setting.findOneAndUpdate;
  const previousDeleteMany = Setting.deleteMany;
  const storedSettings = new Map();
  const sheetWrites = [];
  const sheetClears = [];
  let spreadsheetCreates = 0;
  let dateTabTitle = '';
  let dateTabSheetId = 9;
  let hasDateTab = false;
  const dateTabAddRequests = [];
  config.googleOAuthClientId = 'client-id';
  config.googleOAuthClientSecret = 'client-secret';
  config.googleOAuthRedirectUri = 'https://api.example.com/api/google-sheets/oauth/callback';
  Setting.findOneAndUpdate = async (filter, update) => storedSettings.set(filter.key, update.value);
  Setting.find = () => ({ lean: async () => [...storedSettings].map(([key, value]) => ({ key, value })) });
  Setting.deleteMany = async ({ key }) => {
    for (const settingKey of key.$in) storedSettings.delete(settingKey);
  };
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') {
      return {
        ok: true,
        status: 200,
        json: async () => String(options.body).includes('authorization_code')
          ? { access_token: 'google-access-token', refresh_token: 'google-refresh-token', expires_in: 3600 }
          : { access_token: 'google-refreshed-token', expires_in: 3600 }
      };
    }
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
      return { ok: true, status: 200, json: async () => ({ email: 'owner@example.com' }) };
    }
    if (url === 'https://sheets.googleapis.com/v4/spreadsheets' && options.method === 'POST') {
      spreadsheetCreates += 1;
      dateTabTitle = JSON.parse(options.body).sheets[0].properties.title;
      hasDateTab = true;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          spreadsheetId: 'created-sheet',
          spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/created-sheet/edit',
          sheets: [{ properties: { sheetId: 0, title: dateTabTitle } }]
        })
      };
    }
    if (url === 'https://sheets.googleapis.com/v4/spreadsheets/created-sheet') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          spreadsheetId: 'created-sheet',
          spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/created-sheet/edit',
          sheets: [{ properties: { sheetId: 0, title: dateTabTitle } }]
        })
      };
    }
    if (url === 'https://sheets.googleapis.com/v4/spreadsheets/existing-sheet') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          spreadsheetId: 'existing-sheet',
          spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/existing-sheet/edit',
          sheets: [
            { properties: { sheetId: 5, title: 'Personal notes' } },
            ...(hasDateTab ? [{ properties: { sheetId: dateTabSheetId, title: dateTabTitle } }] : [])
          ]
        })
      };
    }
    if (url === 'https://sheets.googleapis.com/v4/spreadsheets/existing-sheet:batchUpdate') {
      const request = JSON.parse(options.body).requests[0];
      if (request.addSheet) {
        dateTabAddRequests.push(request.addSheet.properties.title);
        dateTabTitle = request.addSheet.properties.title;
        hasDateTab = true;
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (url.includes('/values/') && url.endsWith(':clear')) {
      sheetClears.push(url);
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (url.includes(':batchUpdate')) return { ok: true, status: 200, json: async () => ({}) };
    if (url.includes('/values/')) {
      sheetWrites.push({ url, method: options.method, body: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => ({}) };
    }
    throw new Error(`Unexpected Google API request: ${url}`);
  };

  try {
    await exchangeGoogleAuthorizationCode('authorization-code');
    await assert.rejects(createResultsSheet([]), /Add at least one website before creating a results sheet/);
    assert.equal(spreadsheetCreates, 0);

    const created = await createResultsSheet([{
      name: 'Example',
      url: 'https://example.com',
      sortOrder: 0,
      lastCheck: {
        homepage,
        desktop: { contact: { status: 'working' }, news: { status: 'working' } },
        mobile: { contact: { status: 'working' }, news: { status: 'working' } }
      }
    }]);
    assert.equal(created.created, true);
    assert.equal(created.spreadsheetUrl, `https://docs.google.com/spreadsheets/d/created-sheet/edit#gid=0`);
    assert.match(dateTabTitle, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(sheetWrites[1].body.values, [
      ['Website URL', 'Status', 'Issue'],
      ['https://example.com', 'Site OK', '']
    ]);

    await syncWebsiteStatusToSheet({ name: 'Example', url: 'https://example.com', sortOrder: 0 }, {
      homepage,
      desktop: { contact: { status: 'missing' } },
      mobile: {}
    });
    assert.match(sheetWrites[3].url, new RegExp(`'${dateTabTitle}'!A2:C2`));
    assert.deepEqual(sheetWrites[3].body.values, [['https://example.com', 'Issue found', 'Desktop Contact: Not found']]);

    const updated = await createResultsSheet([{
      name: 'Example',
      url: 'https://example.com',
      sortOrder: 0,
      lastCheck: { homepage, desktop: { contact: { status: 'missing' } }, mobile: {} }
    }]);
    assert.equal(updated.created, false);
    assert.equal(updated.spreadsheetUrl, created.spreadsheetUrl);
    assert.equal(spreadsheetCreates, 1);
    assert.equal(sheetClears.length, 2);
    assert.deepEqual(sheetWrites[5].body.values, [
      ['Website URL', 'Status', 'Issue'],
      ['https://example.com', 'Issue found', 'Desktop Contact: Not found']
    ]);

    hasDateTab = false;
    const selectedExisting = await createResultsSheet([{
      name: 'Example',
      url: 'https://example.com',
      sortOrder: 0,
      lastCheck: { homepage, desktop: { contact: { status: 'working' } }, mobile: {} }
    }], {
      mode: 'existing',
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/existing-sheet/edit#gid=5'
    });
    assert.equal(selectedExisting.created, false);
    assert.equal(selectedExisting.spreadsheetUrl, `https://docs.google.com/spreadsheets/d/existing-sheet/edit#gid=${dateTabSheetId}`);
    assert.deepEqual(dateTabAddRequests, [dateTabTitle]);
    assert.deepEqual(sheetWrites[7].body.values, [
      ['Website URL', 'Status', 'Issue'],
      ['https://example.com', 'Site OK', '']
    ]);

    await syncWebsiteStatusToSheet({ name: 'Example', url: 'https://example.com', sortOrder: 0 }, {
      homepage,
      desktop: { contact: { status: 'missing' } },
      mobile: {}
    });
    assert.match(sheetWrites[9].url, new RegExp(`spreadsheets/existing-sheet/values/'${dateTabTitle}'!A2:C2`));
    assert.deepEqual(sheetWrites[9].body.values, [['https://example.com', 'Issue found', 'Desktop Contact: Not found']]);

    await disableGoogleSheetSync();
    const recreatedSync = await createResultsSheet([{
      name: 'Example',
      url: 'https://example.com',
      sortOrder: 0,
      lastCheck: { homepage, desktop: { contact: { status: 'working' } }, mobile: {} }
    }]);
    assert.equal(recreatedSync.created, false);
    assert.equal(recreatedSync.spreadsheetUrl, selectedExisting.spreadsheetUrl);
    assert.equal(spreadsheetCreates, 1);
  } finally {
    config.googleOAuthClientId = previousConfig.clientId;
    config.googleOAuthClientSecret = previousConfig.clientSecret;
    config.googleOAuthRedirectUri = previousConfig.redirectUri;
    globalThis.fetch = previousFetch;
    Setting.find = previousFind;
    Setting.findOneAndUpdate = previousFindOneAndUpdate;
    Setting.deleteMany = previousDeleteMany;
  }
});
