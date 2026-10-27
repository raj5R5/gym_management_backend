const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../../src/config/env');
const { createApp } = require('../../src/app');
const { testAuthEnv } = require('../helpers/authConfig');
const make = (extra = {}) => loadConfig({ ...testAuthEnv, NODE_ENV: 'test', LOG_LEVEL: 'silent', MONGO_URI: 'mongodb://database.invalid/config', ...extra });
test('proxy trust remains disabled until explicitly configured', () => {
  assert.deepEqual(make().trustedProxies, []);
  assert.equal(createApp({ config: make() }).get('trust proxy'), false);
});
test('only validated proxy addresses are trusted, not arbitrary forwarded hosts', () => {
  const config = make({ TRUSTED_PROXIES: '127.0.0.1/32,::1/128', API_BIND_HOST: '127.0.0.1' });
  const trust = createApp({ config }).get('trust proxy fn');
  assert.equal(trust('127.0.0.1'), true); assert.equal(trust('::1'), true);
  assert.equal(trust('203.0.113.10'), false); assert.equal(config.bindHost, '127.0.0.1');
});
test('wildcard trust, invalid CIDRs/hosts and invalid bind addresses fail closed', () => {
  for (const value of ['true', '*', '0.0.0.0/0', '127.0.0.1/33', '::1/129', 'proxy.example.com']) {
    assert.throws(() => make({ TRUSTED_PROXIES: value }), { code: 'INVALID_CONFIGURATION' });
  }
  assert.throws(() => make({ API_BIND_HOST: 'not-an-address' }), { code: 'INVALID_CONFIGURATION' });
});
