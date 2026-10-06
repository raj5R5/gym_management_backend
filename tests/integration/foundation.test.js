const { testAuthEnv } = require('../helpers/authConfig');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');
const express = require('express');
const request = require('supertest');
const { createApp } = require('../../src/app');
const { loadConfig } = require('../../src/config/env');
const { createLogger } = require('../../src/config/logger');
const requestId = require('../../src/middleware/requestId');
const errorHandler = require('../../src/middleware/errorHandler');

// Synthetic configuration only; these HTTP tests never open a database connection.
function testConfig(environment = {}) {
  return loadConfig({ ...testAuthEnv, MONGO_URI: 'mongodb://database.invalid/foundation-test', ...environment });
}

function makeApp(environment = {}) {
  return createApp({ config: testConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', ...environment }) });
}

function assertError(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.body.success, false);
  assert.equal(response.body.error.code, code);
  assert.equal(typeof response.body.error.message, 'string');
  assert.deepEqual(Object.keys(response.body).sort(), ['error', 'meta', 'success']);
  assert.deepEqual(Object.keys(response.body.error).sort(), ['code', 'message']);
  assert.equal(response.body.meta.requestId, response.headers['x-request-id']);
}

test('app factory creates an Express application without opening a server', () => {
  const app = makeApp();
  assert.equal(typeof app, 'function');
  assert.equal(typeof app.listen, 'function');
});

test('health endpoint reports application health and security headers', async () => {
  const response = await request(makeApp()).get('/health');
  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.data.status, 'ok');
  assert.equal(response.headers['x-powered-by'], undefined);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.body.meta.requestId, response.headers['x-request-id']);
});

test('versioned health endpoint uses the same response contract', async () => {
  const response = await request(makeApp()).get('/api/v1/health');
  assert.equal(response.status, 200);
  assert.equal(response.body.data.status, 'ok');
  assert.equal(response.body.success, true);
});

test('readiness explicitly distinguishes process readiness from database checks', async () => {
  const app = makeApp();
  const response = await request(app).get('/ready');
  assert.equal(response.status, 503);
  assert.deepEqual(response.body.data, {
    status: 'not_ready', checks: { application: 'ready', database: 'disconnected' },
  });
  app.locals.ready = false;
  const stopping = await request(app).get('/ready');
  assert.equal(stopping.status, 503);
  assert.equal(stopping.body.data.status, 'shutting_down');
});

test('unknown routes return the standard 404 error', async () => {
  assertError(await request(makeApp()).get('/unknown'), 404, 'NOT_FOUND');
});

test('safe supplied request IDs are echoed in headers and metadata', async () => {
  const response = await request(makeApp()).get('/health').set('X-Request-ID', 'client-123.test_1');
  assert.equal(response.headers['x-request-id'], 'client-123.test_1');
  assert.equal(response.body.meta.requestId, 'client-123.test_1');
});

test('missing or unsafe request IDs are replaced with unique UUIDs', async () => {
  const app = makeApp();
  const ids = [];
  for (const value of [undefined, 'contains spaces', 'x'.repeat(65), 'one,two']) {
    const pending = request(app).get('/health');
    if (value !== undefined) pending.set('X-Request-ID', value);
    const response = await pending;
    const id = response.headers['x-request-id'];
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(response.body.meta.requestId, id);
    ids.push(id);
  }
  assert.equal(new Set(ids).size, ids.length);
});

test('malformed JSON returns a safe standard error', async () => {
  const response = await request(makeApp()).post('/unknown')
    .set('Content-Type', 'application/json').send('{"password":"secret",');
  assertError(response, 400, 'INVALID_JSON');
  assert.equal(JSON.stringify(response.body).includes('secret'), false);
});

test('oversized JSON is rejected before route handling', async () => {
  const response = await request(makeApp()).post('/unknown').send({ value: 'x'.repeat(17 * 1024) });
  assertError(response, 413, 'PAYLOAD_TOO_LARGE');
});

test('unexpected errors never expose internal details, including in production', async () => {
  const app = express();
  app.set('env', 'production');
  app.use(requestId);
  app.use((_req, _res, next) => next(new Error('private database credentials')));
  app.use(errorHandler);
  const response = await request(app).get('/');
  assertError(response, 500, 'INTERNAL_SERVER_ERROR');
  assert.equal(JSON.stringify(response.body).includes('private'), false);
  assert.equal(response.body.error.stack, undefined);
});

test('CORS allows only configured origins and handles preflight', async () => {
  const app = makeApp({ ALLOWED_ORIGINS: 'https://frontend.example' });
  const allowed = await request(app).get('/health').set('Origin', 'https://frontend.example');
  assert.equal(allowed.headers['access-control-allow-origin'], 'https://frontend.example');
  assert.equal(allowed.headers['access-control-allow-credentials'], 'true');
  const preflight = await request(app).options('/api/v1/health')
    .set('Origin', 'https://frontend.example').set('Access-Control-Request-Method', 'GET');
  assert.equal(preflight.status, 204);
  const denied = await request(app).get('/health').set('Origin', 'https://untrusted.example');
  assertError(denied, 403, 'CORS_ORIGIN_DENIED');
  assert.equal(denied.headers['access-control-allow-origin'], undefined);
  const noOrigin = await request(app).get('/health');
  assert.equal(noOrigin.status, 200);
  assert.equal(noOrigin.headers['access-control-allow-origin'], undefined);
  assertError(await request(makeApp()).get('/health').set('Origin', 'https://frontend.example'),
    403, 'CORS_ORIGIN_DENIED');
});

test('general rate limiting returns the standard 429 error without blocking probes', async () => {
  const app = makeApp();
  for (let i = 0; i < 100; i += 1) {
    assert.equal((await request(app).get('/api/v1/health')).status, 200);
  }
  const limited = await request(app).get('/api/v1/health');
  assertError(limited, 429, 'RATE_LIMITED');
  assert.ok(limited.headers['retry-after']);
  assert.ok(limited.headers.ratelimit);
  assert.equal((await request(app).get('/health')).status, 200);
  assert.equal((await request(app).get('/ready')).status, 503);
});

test('environment validation rejects invalid configuration without leaking values', () => {
  assert.equal(testConfig({}).port, 3000);
  assert.deepEqual(testConfig({}).allowedOrigins, []);
  for (const env of [
    { PORT: '0' }, { PORT: '65536' }, { PORT: '1.5' }, { PORT: '' },
    { NODE_ENV: 'unknown' }, { LOG_LEVEL: 'invalid' },
    { ALLOWED_ORIGINS: '*' }, { ALLOWED_ORIGINS: 'https://example.com/path' },
  ]) {
    assert.throws(() => testConfig(env), /Invalid environment configuration/);
  }
  const config = testConfig({ PORT: '4321', NODE_ENV: 'staging', ALLOWED_ORIGINS: ' https://a.example,https://a.example ' });
  assert.equal(config.port, 4321);
  assert.deepEqual(config.allowedOrigins, ['https://a.example']);
});

test('structured logs correlate requests and omit sensitive request data', async () => {
  let output = '';
  const destination = new Writable({
    write(chunk, _encoding, callback) { output += chunk.toString(); callback(); },
  });
  const config = testConfig({ NODE_ENV: 'test', LOG_LEVEL: 'info' });
  const logger = createLogger(config, destination);
  const app = createApp({ config, logger });
  await request(app).post('/unknown?token=query-secret')
    .set('X-Request-ID', 'log-request-123')
    .set('Authorization', 'Bearer header-secret')
    .set('Cookie', 'session=cookie-secret')
    .send({ password: 'body-secret', refreshToken: 'refresh-secret' });
  logger.info({ password: 'direct-secret', account: { accessToken: 'nested-secret' } }, 'Redaction check');
  assert.ok(output.includes('log-request-123'));
  assert.ok(output.includes('[REDACTED]'));
  for (const secret of ['query-secret', 'header-secret', 'cookie-secret', 'body-secret',
    'refresh-secret', 'direct-secret', 'nested-secret']) {
    assert.equal(output.includes(secret), false);
  }
  for (const line of output.trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line));
});
