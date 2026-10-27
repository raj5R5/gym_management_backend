const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');
const express = require('express');
const mongoose = require('mongoose');
const pinoHttp = require('pino-http');
const request = require('supertest');
const { createApp } = require('../../src/app');
const { createLogger } = require('../../src/config/logger');
const { createRequestLogger, routeTemplatePrefix } = require('../../src/middleware/requestLogger');
const requestId = require('../../src/middleware/requestId');
const notFound = require('../../src/middleware/notFound');
const errorHandler = require('../../src/middleware/errorHandler');

function capture() {
  let output = '';
  const logger = createLogger({ nodeEnv: 'test', logLevel: 'info' }, new Writable({
    write(chunk, _encoding, callback) { output += chunk.toString(); callback(); },
  }));
  return { logger, lines: () => output.trim().split('\n').filter(Boolean).map(JSON.parse) };
}

const secrets = {
  gymId: '111111111111111111111111', memberId: '222222222222222222222222',
  query: 'private-query-value', authorization: 'private-bearer-value', cookie: 'private-cookie-value',
  password: 'private-password-value', name: 'Private Member Name', phone: '+919876543210',
  payment: 'private-payment-reference', uri: 'mongodb://private-user:private-pass@private-host/db',
};
const memberPath = `/api/v1/gyms/${secrets.gymId}/members/${secrets.memberId}`;
const memberTemplate = '/api/v1/gyms/:gymId/members/:memberId';

function assertSafe(lines) {
  const output = JSON.stringify(lines);
  for (const value of Object.values(secrets)) assert.equal(output.includes(value), false, value);
}

function fixture({ status = 200, elapsedMs, preRouteError = false } = {}) {
  const captured = capture();
  const app = express();
  app.use(requestId, createRequestLogger(captured.logger), express.json());
  const router = express.Router({ mergeParams: true });
  // Simulate elapsed work without sleeps or changing the production threshold/clock.
  // pino-http exposes this symbol specifically for adjusting the request start time.
  const respond = (_req, res, next) => {
    if (elapsedMs !== undefined) res[pinoHttp.startTime] = Date.now() - elapsedMs;
    if (status >= 400) {
      const error = new Error(secrets.uri);
      if (status === 403) error.code = 'FORBIDDEN';
      return next(error);
    }
    return res.status(status).json({ name: secrets.name, phone: secrets.phone, payment: secrets.payment });
  };
  if (preRouteError) router.use((_req, _res, next) => next(new Error(secrets.uri)));
  router.get('/:memberId', respond);
  router.post('/:memberId', respond);
  app.use('/api/v1/gyms/:gymId/members', routeTemplatePrefix('/api/v1/gyms/:gymId/members'), router);
  app.use(notFound, errorHandler);
  return { app, ...captured };
}

function sensitiveRequest(app, method, path = memberPath) {
  return request(app)[method](`${path}?token=${secrets.query}`)
    .set('X-Request-ID', 'latency-test-123')
    .set('Authorization', `Bearer ${secrets.authorization}`)
    .set('Cookie', `session=${secrets.cookie}`);
}

function completion(lines, { method, status, route, level = 30 }) {
  const completed = lines.filter((line) => ['request completed', 'request errored'].includes(line.msg));
  assert.equal(completed.length, 1);
  const entry = completed[0];
  assert.equal(entry.req.method, method);
  assert.equal(entry.res.statusCode, status);
  assert.equal(entry.route, route);
  assert.equal(entry.level, level);
  assert.equal(entry.req.id, 'latency-test-123');
  assert.equal(entry.requestId, 'latency-test-123');
  assert.equal(typeof entry.responseTime, 'number');
  assert.ok(entry.responseTime >= 0);
  assertSafe(lines);
  return entry;
}

test('completion logs successful requests with full templates and no sensitive inputs or outputs', async () => {
  const { app, lines } = fixture();
  const response = await sensitiveRequest(app, 'post').send({ password: secrets.password,
    name: secrets.name, phone: secrets.phone, payment: secrets.payment });
  assert.equal(response.status, 200);
  assert.equal(response.headers['x-request-id'], 'latency-test-123');
  completion(lines(), { method: 'POST', status: 200, route: memberTemplate });
});

test('completion logs handled failures and unexpected errors after Express unwinds the router', async () => {
  for (const status of [403, 500]) {
    const { app, lines } = fixture({ status });
    assert.equal((await sensitiveRequest(app, 'get')).status, status);
    completion(lines(), { method: 'GET', status, route: memberTemplate, level: status === 500 ? 50 : 30 });
  }
});

test('unmatched routes and failures before route selection use a fixed safe label', async () => {
  for (const options of [{}, { preRouteError: true }]) {
    const { app, lines } = fixture(options);
    const status = options.preRouteError ? 500 : 404;
    assert.equal((await sensitiveRequest(app, 'get', `${memberPath}/${secrets.query}`)).status, status);
    completion(lines(), { method: 'GET', status, route: 'unmatched', level: status === 500 ? 50 : 30 });
  }
});

test('JSON parse failures cannot expose raw URLs, bodies, or parser error messages', async () => {
  const { app, lines } = fixture();
  const response = await sensitiveRequest(app, 'post').set('Content-Type', 'application/json')
    .send(`{"password":"${secrets.password}",`);
  assert.equal(response.status, 400);
  completion(lines(), { method: 'POST', status: 400, route: 'unmatched' });
});

test('requests at or above 1000 ms warn once; slow server failures retain error severity', async () => {
  for (const [status, elapsedMs, level] of [[200, 1000, 40], [200, 5700, 40], [403, 2000, 40], [500, 5700, 50]]) {
    const { app, lines } = fixture({ status, elapsedMs });
    assert.equal((await sensitiveRequest(app, 'get')).status, status);
    const entry = completion(lines(), { method: 'GET', status, route: memberTemplate, level });
    assert.ok(entry.responseTime >= elapsedMs);
  }
});

test('application wiring logs health, Dashboard denials, and unknown paths without a database connection', async () => {
  const { logger, lines } = capture();
  const connection = mongoose.createConnection();
  const app = createApp({ config: { nodeEnv: 'test', allowedOrigins: [] }, logger, database: { connection } });
  for (const [path, status, route] of [
    ['/health', 200, '/health'],
    [`/api/v1/gyms/${secrets.gymId}/dashboard`, 401, '/api/v1/gyms/:gymId/dashboard'],
    [`/${secrets.memberId}`, 404, 'unmatched'],
  ]) {
    const before = lines().length;
    assert.equal((await sensitiveRequest(app, 'get', path).unset('Authorization')).status, status);
    completion(lines().slice(before), { method: 'GET', status, route });
  }
  await connection.close();
});
