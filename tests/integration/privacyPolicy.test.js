const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const request = require('supertest');
const { createApp } = require('../../src/app');
const { loadConfig } = require('../../src/config/env');
const { testAuthEnv } = require('../helpers/authConfig');

// Uses no database connection or .env. All requests are in-process test requests.
function makeApp(database) {
  const config = loadConfig({ ...testAuthEnv, NODE_ENV: 'test', LOG_LEVEL: 'silent',
    MONGO_URI: 'mongodb://database.invalid/privacy-test' });
  return createApp({ config, database });
}
const document = readFileSync(join(__dirname, '../../src/modules/privacyPolicy/privacy-policy.html'), 'utf8');

test('public privacy GET serves the exact local document without authentication or database access', async () => {
  const database = { getStatus() { throw new Error('Privacy must not read database status'); } };
  const response = await request(makeApp(database)).get('/privacy-policy');
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /text\/html/);
  assert.equal(response.text, document);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.match(response.headers['content-security-policy'], /default-src 'self'/);
});

test('local policy remains explicitly unapproved and uses only the confirmed public identity', async () => {
  const response = await request(makeApp()).get('/privacy-policy');
  assert.match(response.text, /MuscleDesk Privacy Policy/);
  assert.match(response.text, /DRAFT — NOT APPROVED FOR PUBLICATION/);
  assert.match(response.text, /name="robots" content="noindex,nofollow"/);
  assert.match(response.text, /Raj/);
  assert.match(response.text, /pcterajbca7772@gmail\.com/);
  assert.match(response.text, /https:\/\/gym-api\.semgroup\.in\/privacy-policy/);
  assert.doesNotMatch(response.text, /<(?:script|form|input|iframe)\b/i);
});

test('public privacy HEAD succeeds without returning a body or starting a session', async () => {
  const response = await request(makeApp()).head('/privacy-policy');
  assert.equal(response.status, 200);
  assert.equal(response.text, undefined);
  assert.equal(response.headers['set-cookie'], undefined);
});

test('privacy query and nested paths cannot choose arbitrary files', async () => {
  const app = makeApp();
  const response = await request(app).get('/privacy-policy?file=../../.env');
  assert.equal(response.status, 200);
  assert.equal(response.text, document);
  assert.equal((await request(app).get('/privacy-policy/other')).status, 404);
});

test('privacy has no POST, PATCH or DELETE operation', async () => {
  const app = makeApp();
  for (const method of ['post', 'patch', 'delete']) {
    const response = await request(app)[method]('/privacy-policy').send({ status: 'published' });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'NOT_FOUND');
  }
});

test('public document does not change health/readiness or expose protected auth routes', async () => {
  const app = makeApp();
  assert.equal((await request(app).get('/privacy-policy')).status, 200);
  assert.equal((await request(app).get('/health')).status, 200);
  assert.equal((await request(app).get('/ready')).status, 503);
  assert.equal((await request(app).get('/api/v1/auth/me')).status, 404);
});
