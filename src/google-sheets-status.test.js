import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from './config.js';
import { Setting } from './models.js';
import { googleSheetsStatus } from './google-sheets.js';

test('reports an unusable saved token as disconnected so OAuth can be restarted', async (t) => {
  const previous = {
    clientId: config.googleOAuthClientId,
    clientSecret: config.googleOAuthClientSecret,
    find: Setting.find
  };
  t.after(() => {
    config.googleOAuthClientId = previous.clientId;
    config.googleOAuthClientSecret = previous.clientSecret;
    Setting.find = previous.find;
  });

  config.googleOAuthClientId = 'client-id';
  config.googleOAuthClientSecret = 'client-secret';
  Setting.find = () => ({
    lean: async () => [
      { key: 'googleSheets:refreshToken', value: 'not-an-encrypted-token' },
      { key: 'googleSheets:email', value: 'admin@example.com' }
    ]
  });

  const status = await googleSheetsStatus();

  assert.equal(status.configured, true);
  assert.equal(status.connected, false);
  assert.equal(status.email, null);
  assert.match(status.connectionError, /invalid|authorization|authenticate|decrypt|unsupported/i);
});
