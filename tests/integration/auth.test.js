const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const { Writable } = require('node:stream');
const express = require('express');
const jwt = require('jsonwebtoken');
const argon2 = require('argon2');
const mongoose = require('mongoose');
const request = require('supertest');
const { testAuthEnv } = require('../helpers/authConfig');
const { startTestMongo } = require('../helpers/mongo');
const { loadConfig } = require('../../src/config/env');
const { createDatabase } = require('../../src/config/database');
const { createLogger } = require('../../src/config/logger');
const { createApp, createBootstrapApp } = require('../../src/app');
const { startServer } = require('../../src/server');
const { initializePasswords } = require('../../src/modules/auth/password');
const { digestToken } = require('../../src/modules/auth/tokens');

let isolated, database, config, app, models;
const password = randomBytes(24).toString('base64url');
const origin = 'https://frontend.example';
const cookieName = '__Secure-gymRefresh';
function error(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.body.error.code, code);
  assert.equal(response.body.success, false);
  assert.equal(response.body.meta.requestId, response.headers['x-request-id']);
}
function noHash(value) {
  assert.equal(JSON.stringify(value).includes('passwordHash'), false);
  assert.equal(JSON.stringify(value).includes('$argon2'), false);
}

before(async () => {
  await initializePasswords();
  isolated = await startTestMongo();
  config = loadConfig({ ...testAuthEnv, NODE_ENV: 'test', LOG_LEVEL: 'silent', MONGO_URI: isolated.uri,
    ALLOWED_ORIGINS: origin, ENABLE_BOOTSTRAP_ROUTES: 'true' });
  database = createDatabase({ logger: createLogger(config) });
  await database.connect(config);
  app = createBootstrapApp({ config, database });
  models = database.connection.models;
  await Promise.all(Object.values(models).map((model) => model.createIndexes()));
});
after(async () => {
  try { if (database) await database.disconnect(); }
  finally { if (isolated) await isolated.stop(); }
});
beforeEach(async () => {
  app = createBootstrapApp({ config, database });
  await Promise.all(Object.values(models).map((model) => model.deleteMany({})));
});
async function provision(status = 'active', email = 'person@example.com') {
  const created = await request(app).post('/api/v1/user-accounts').send({ email, status });
  assert.equal(created.status, 201);
  const result = await request(app).post(`/api/v1/user-accounts/${created.body.data.id}/password`).send({ password });
  assert.equal(result.status, 200);
  return created.body.data;
}
async function login(email = 'person@example.com', client = 'mobile') {
  const pending = request(app).post('/api/v1/auth/login').send({ email, password, client });
  if (client === 'web') pending.set('Origin', origin);
  const response = await pending;
  assert.equal(response.status, 200);
  return response;
}
function refresh(raw) { return request(app).post('/api/v1/auth/refresh').send({ refreshToken: raw }); }
function me(token) { return request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`); }

 test('password provisioning stores Argon2id only, verifies correctly and never exposes hash', async () => {
  const user = await provision();
  const persisted = await models.UserAccount.findById(user.id).select('+passwordHash').lean();
  assert.match(persisted.passwordHash, /^\$argon2id\$/);
  assert.equal(await argon2.verify(persisted.passwordHash, password), true);
  assert.equal(await argon2.verify(persisted.passwordHash, 'wrong-password'), false);
  noHash((await request(app).get(`/api/v1/user-accounts/${user.id}`)).body);
  noHash((await request(app).get('/api/v1/user-accounts')).body);
  error(await request(app).post(`/api/v1/user-accounts/${user.id}/password`).send({ password }), 409, 'PASSWORD_ALREADY_SET');
  error(await request(app).post(`/api/v1/user-accounts/${user.id}/password`).send({ passwordHash: persisted.passwordHash }),
    400, 'VALIDATION_ERROR');
});

test('login normalizes email and issues minimum JWT plus hashed refresh credential', async () => {
  await provision();
  const result = await login(' Person@Example.COM ');
  const data = result.body.data;
  assert.ok(data.accessToken && data.refreshToken);
  assert.equal(data.user.status, 'active');
  assert.equal(result.headers['cache-control'], 'no-store');
  noHash(data);
  const claims = jwt.decode(data.accessToken);
  assert.deepEqual(Object.keys(claims).sort(), ['aud', 'exp', 'iat', 'iss', 'sid', 'sub']);
  assert.equal(claims.exp - claims.iat, config.accessTokenTtl);
  const record = await models.RefreshTokenRecord.findOne().select('+tokenHash').lean();
  assert.equal(record.tokenHash, digestToken(data.refreshToken));
  assert.equal(JSON.stringify(record).includes(data.refreshToken), false);
  assert.equal(record.purgeAt > record.expiresAt, true);
  assert.equal((await me(data.accessToken)).status, 200);
});

test('nonexistent account, wrong password, no password, and inactive accounts share login error', async () => {
  await provision('inactive');
  const active = await provision('active', 'active@example.com');
  assert.ok(active.id);
  await request(app).post('/api/v1/user-accounts').send({ email: 'unset@example.com', status: 'active' });
  for (const [email, value] of [['missing@example.com', password], ['active@example.com', 'wrong-password'],
    ['person@example.com', password], ['unset@example.com', password]]) {
    const response = await request(app).post('/api/v1/auth/login').send({ email, password: value, client: 'mobile' });
    error(response, 401, 'INVALID_CREDENTIALS');
    assert.equal(response.body.error.message, 'Invalid email or password.');
  }
  assert.equal(await models.AuthSession.countDocuments(), 0);
});

test('login and me return only active access to active gyms, without client role claims', async () => {
  const user = await provision();
  for (const [name, gymStatus, accessStatus, role] of [
    ['Active Gym', 'active', 'active', 'admin'], ['Other Gym', 'active', 'active', 'member'],
    ['Inactive Access', 'active', 'inactive', 'trainer'], ['Inactive Gym', 'inactive', 'active', 'member'],
  ]) {
    const gym = await request(app).post('/api/v1/gyms').send({ name, status: gymStatus });
    await request(app).post(`/api/v1/gyms/${gym.body.data.id}/access`).send({ userId: user.id, role, status: accessStatus });
  }
  const result = await login();
  assert.equal(result.body.data.gymAccess.length, 2);
  const current = await me(result.body.data.accessToken);
  assert.equal(current.body.data.gymAccess.length, 2);
  noHash(current.body);
  assert.equal(current.body.data.refreshToken, undefined);
  error(await request(app).post('/api/v1/auth/login').send({ email: user.email, password, client: 'mobile', role: 'admin' }),
    400, 'VALIDATION_ERROR');
  await models.GymAccess.updateMany({ userId: user.id }, { $set: { status: 'inactive' } });
  assert.deepEqual((await me(result.body.data.accessToken)).body.data.gymAccess, []);
});

test('valid account with no active gym access can authenticate with empty access information', async () => {
  await provision();
  assert.deepEqual((await login()).body.data.gymAccess, []);
});

test('JWT rejects expiry, signatures, issuer, audience, algorithm and malformed/missing claims', async () => {
  await provision();
  const result = await login();
  const original = jwt.decode(result.body.data.accessToken);
  const base = { sub: original.sub, sid: original.sid };
  const options = { algorithm: 'HS256', issuer: config.jwtIssuer, audience: config.jwtAudience, expiresIn: 600 };
  const variants = [
    jwt.sign(base, config.jwtAccessSecret, { ...options, expiresIn: -1 }),
    jwt.sign(base, randomBytes(64).toString('hex'), options),
    jwt.sign(base, config.jwtAccessSecret, { ...options, issuer: 'wrong' }),
    jwt.sign(base, config.jwtAccessSecret, { ...options, audience: 'wrong' }),
    jwt.sign(base, config.jwtAccessSecret, { ...options, algorithm: 'HS384' }),
    jwt.sign(base, '', { algorithm: 'none', issuer: config.jwtIssuer, audience: config.jwtAudience }),
    jwt.sign({ sub: original.sub }, config.jwtAccessSecret, options),
    jwt.sign(base, config.jwtAccessSecret, { issuer: config.jwtIssuer, audience: config.jwtAudience }),
    'malformed.token',
  ];
  for (const token of variants) error(await me(token), 401, 'INVALID_AUTHENTICATION');
  error(await request(app).get('/api/v1/auth/me'), 401, 'INVALID_AUTHENTICATION');
});

test('current account/session state overrides an otherwise valid JWT', async () => {
  const user = await provision();
  const result = await login();
  await models.UserAccount.updateOne({ _id: user.id }, { $set: { status: 'suspended' } });
  error(await me(result.body.data.accessToken), 401, 'INVALID_AUTHENTICATION');
  error(await refresh(result.body.data.refreshToken), 401, 'INVALID_AUTHENTICATION');
});

test('refresh rotates and reused credentials revoke the complete session family', async () => {
  await provision();
  const initial = (await login()).body.data;
  const rotated = await refresh(initial.refreshToken);
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.body.data.refreshToken, initial.refreshToken);
  const old = await models.RefreshTokenRecord.findOne({ tokenHash: digestToken(initial.refreshToken) }).lean();
  assert.ok(old.usedAt && old.replacedBy);
  error(await refresh(initial.refreshToken), 401, 'INVALID_AUTHENTICATION');
  error(await refresh(rotated.body.data.refreshToken), 401, 'INVALID_AUTHENTICATION');
  error(await me(initial.accessToken), 401, 'INVALID_AUTHENTICATION');
  error(await me(rotated.body.data.accessToken), 401, 'INVALID_AUTHENTICATION');
  assert.equal((await models.AuthSession.findOne()).status, 'revoked');
});

test('concurrent refresh cannot leave two usable chains', async () => {
  await provision();
  const initial = (await login()).body.data;
  const results = await Promise.all([refresh(initial.refreshToken), refresh(initial.refreshToken)]);
  assert.ok(results.some((response) => response.status === 401));
  assert.equal((await models.AuthSession.findOne()).status, 'revoked');
  for (const response of results.filter((item) => item.status === 200)) {
    error(await refresh(response.body.data.refreshToken), 401, 'INVALID_AUTHENTICATION');
  }
});

test('expired and revoked refresh credentials cannot rotate', async () => {
  await provision();
  for (const update of [{ expiresAt: new Date(0) }, { revokedAt: new Date() }]) {
    const initial = (await login()).body.data;
    await models.RefreshTokenRecord.updateOne({ tokenHash: digestToken(initial.refreshToken) }, { $set: update });
    error(await refresh(initial.refreshToken), 401, 'INVALID_AUTHENTICATION');
  }
});

test('absolute and idle session expiration reject JWTs and refresh', async () => {
  await provision();
  for (const field of ['expiresAt', 'idleExpiresAt']) {
    const initial = (await login()).body.data;
    await models.AuthSession.updateOne({ _id: jwt.decode(initial.accessToken).sid }, { $set: { [field]: new Date(0) } });
    error(await me(initial.accessToken), 401, 'INVALID_AUTHENTICATION');
    error(await refresh(initial.refreshToken), 401, 'INVALID_AUTHENTICATION');
  }
});

test('logout revokes current session immediately and leaves other device sessions active', async () => {
  await provision();
  const initial = (await login()).body.data;
  const other = (await login()).body.data;
  const result = await request(app).post('/api/v1/auth/logout').set('Authorization', `Bearer ${initial.accessToken}`).send({});
  assert.equal(result.status, 200);
  error(await refresh(initial.refreshToken), 401, 'INVALID_AUTHENTICATION');
  error(await me(initial.accessToken), 401, 'INVALID_AUTHENTICATION');
  assert.equal((await me(other.accessToken)).status, 200);
  assert.equal((await request(app).post('/api/v1/auth/logout').send({ refreshToken: initial.refreshToken })).status, 200);
});

test('web cookies are secure and HTTP-only, refresh/logout require trusted Origin', async () => {
  await provision();
  const result = await login('person@example.com', 'web');
  assert.equal(result.body.data.refreshToken, undefined);
  const cookie = result.headers['set-cookie'][0];
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/api/v1/auth']) assert.ok(cookie.includes(attribute));
  const cookiePair = cookie.split(';')[0];
  assert.ok(cookiePair.startsWith(`${cookieName}=`));
  error(await request(app).post('/api/v1/auth/refresh').set('Cookie', cookiePair).send({}), 403, 'CORS_ORIGIN_DENIED');
  const rotated = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookiePair).set('Origin', origin).send({});
  assert.equal(rotated.status, 200);
  assert.equal(rotated.body.data.refreshToken, undefined);
  const latest = rotated.headers['set-cookie'][0].split(';')[0];
  const logout = await request(app).post('/api/v1/auth/logout').set('Cookie', latest).set('Origin', origin).send({});
  assert.equal(logout.status, 200);
  assert.ok(logout.headers['set-cookie'][0].includes('Expires=Thu, 01 Jan 1970'));
  error(await request(app).post('/api/v1/auth/refresh').set('Cookie', latest).set('Origin', origin).send({}),
    401, 'INVALID_AUTHENTICATION');
});

test('minimal email/password login selects native or web transport without weakening Origin checks', async () => {
  await provision();
  const native = await request(app).post('/api/v1/auth/login').send({ email: 'person@example.com', password });
  assert.equal(native.status, 200);
  assert.ok(native.body.data.refreshToken);
  const web = await request(app).post('/api/v1/auth/login').set('Origin', origin)
    .send({ email: 'person@example.com', password });
  assert.equal(web.status, 200);
  assert.equal(web.body.data.refreshToken, undefined);
  const raw = web.headers['set-cookie'][0].split(';')[0].split('=')[1];
  const malformedCookie = `${cookieName}=${encodeURIComponent('j:' + JSON.stringify([raw]))}`;
  error(await request(app).post('/api/v1/auth/refresh').set('Origin', origin).set('Cookie', malformedCookie).send({}),
    401, 'INVALID_AUTHENTICATION');
});

test('browser callers cannot request native refresh delivery and credentials are channel-bound', async () => {
  await provision();
  error(await request(app).post('/api/v1/auth/login').set('Origin', origin)
    .send({ email: 'person@example.com', password, client: 'mobile' }), 401, 'INVALID_AUTHENTICATION');
  const web = await login('person@example.com', 'web');
  const raw = web.headers['set-cookie'][0].split(';')[0].split('=')[1];
  error(await refresh(raw), 401, 'INVALID_AUTHENTICATION');
  const mobile = (await login()).body.data;
  error(await request(app).post('/api/v1/auth/refresh').set('Origin', origin).send({ refreshToken: mobile.refreshToken }),
    401, 'INVALID_AUTHENTICATION');
});

test('provisioning is explicit, local-only, unavailable in staging/production, and requires strong length', async () => {
  const created = await request(app).post('/api/v1/user-accounts').send({ email: 'provision@example.com', status: 'active' });
  const path = `/api/v1/user-accounts/${created.body.data.id}/password`;
  error(await request(app).post(path).send({ password: 'short' }), 400, 'VALIDATION_ERROR');
  for (const [nodeEnv, enabled] of [['test', false], ['development', false], ['production', true], ['staging', true]]) {
    const disabled = createApp({ config: { ...config, nodeEnv, enableBootstrapRoutes: enabled }, database });
    error(await request(disabled).post(path).send({ password }), 404, 'NOT_FOUND');
  }
  const remote = express();
  remote.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: '203.0.113.10', configurable: true }); next();
  });
  remote.use(app);
  error(await request(remote).post(path).send({ password }), 403, 'BOOTSTRAP_FORBIDDEN');
});

test('authentication rate limits apply independently and preserve error contract', async () => {
  for (const [path, body, limit] of [
    ['/api/v1/auth/login', {}, 30], ['/api/v1/auth/refresh', {}, 60],
    [`/api/v1/user-accounts/${new mongoose.Types.ObjectId()}/password`, {}, 20],
  ]) {
    const limited = createBootstrapApp({ config, database });
    for (let i = 0; i < limit; i += 1) await request(limited).post(path).send(body);
    const response = await request(limited).post(path).send(body);
    error(response, 429, 'RATE_LIMITED');
    assert.ok(response.headers['retry-after']);
    assert.equal((await request(limited).get('/health')).status, 200);
  }
});

test('auth configuration is mandatory and error diagnostics never expose supplied secrets', () => {
  const base = { ...testAuthEnv, MONGO_URI: isolated.uri };
  for (const field of ['JWT_ACCESS_SECRET', 'JWT_ISSUER', 'JWT_AUDIENCE']) {
    assert.throws(() => loadConfig({ ...base, [field]: undefined }), /Invalid environment configuration/);
  }
  for (const input of [{ JWT_ACCESS_SECRET: 'short' }, { ACCESS_TOKEN_TTL_SECONDS: '901' },
    { REFRESH_TOKEN_TTL_SECONDS: '0' }, { SESSION_TTL_SECONDS: '-1' }]) {
    assert.throws(() => loadConfig({ ...base, ...input }), /Invalid environment configuration/);
  }
});

test('authentication logs never contain passwords, tokens or secret configuration', async () => {
  let logs = '';
  const destination = new Writable({ write(chunk, _encoding, callback) { logs += chunk.toString(); callback(); } });
  const logger = createLogger({ ...config, logLevel: 'info' }, destination);
  await provision();
  const logged = createApp({ config, database, logger });
  const result = await request(logged).post('/api/v1/auth/login').send({ email: 'person@example.com', password, client: 'mobile' });
  assert.equal(result.status, 200);
  await request(logged).get('/api/v1/auth/me').set('Authorization', `Bearer ${result.body.data.accessToken}`);
  logger.info({ jwtAccessSecret: config.jwtAccessSecret }, 'Redaction test');
  for (const secret of [password, result.body.data.accessToken, result.body.data.refreshToken, config.jwtAccessSecret]) {
    assert.equal(logs.includes(secret), false);
  }
  noHash(logs);
});

test('safe production-mode CLI startup and graceful shutdown use isolated MongoDB', { timeout: 15000 }, async () => {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  // Direct node execution intentionally does not load the real .env.
  const child = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, ...testAuthEnv, MONGO_URI: isolated.uri, PORT: String(port),
      NODE_ENV: 'production', ENABLE_BOOTSTRAP_ROUTES: 'false', LOG_LEVEL: 'info' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  const closed = once(child, 'close');
  const deadline = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    for (let attempt = 0; attempt < 100 && !output.includes('API server started'); attempt += 1) {
      assert.equal(child.exitCode, null);
      await delay(50);
    }
    assert.ok(output.includes('API server started'));
    const target = `http://127.0.0.1:${port}`;
    assert.equal((await request(target).get('/ready')).status, 200);
    error(await request(target).get('/api/v1/auth/me'), 401, 'INVALID_AUTHENTICATION');
    error(await request(target).post('/api/v1/user-accounts').send({}), 404, 'NOT_FOUND');
    child.kill('SIGTERM');
    const [code] = await closed;
    assert.equal(code, 0);
    assert.ok(output.includes('API server stopped'));
    assert.equal(output.includes(config.jwtAccessSecret), false);
    assert.equal(output.includes(isolated.uri), false);
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; }
  }
});

test('safe startup serves authentication readiness and shuts down using isolated MongoDB', async () => {
  const lifecycle = await startServer({ config: { ...config, port: 0, bootstrapPort: 0 },
    database: createDatabase({ logger: createLogger(config) }) });
  try {
    assert.equal((await request(lifecycle.server).get('/ready')).status, 200);
    error(await request(lifecycle.server).get('/api/v1/auth/me'), 401, 'INVALID_AUTHENTICATION');
    assert.ok((await models.AuthSession.listIndexes()).some((index) => index.expireAfterSeconds === 0));
  } finally { await lifecycle.shutdown('test'); }
});

test('signing configuration rejects weak encodings, repeated bytes, patterns and placeholders', () => {
  for (const secret of [
    ' '.repeat(64), 'a'.repeat(64), 'ab'.repeat(32), '0123456789abcdef'.repeat(4),
    randomBytes(32).toString('hex').repeat(2),
    '<generate-a-strong-random-secret>', 'change-me'.repeat(10),
    Buffer.from('change-me-default-secret-password-placeholder-123456').toString('hex'),
    Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString('hex'),
  ]) {
    assert.throws(() => loadConfig({ ...testAuthEnv, MONGO_URI: isolated.uri, JWT_ACCESS_SECRET: secret }),
      { code: 'INVALID_CONFIGURATION' });
  }
  assert.doesNotThrow(() => loadConfig({ ...testAuthEnv, MONGO_URI: isolated.uri,
    JWT_ACCESS_SECRET: randomBytes(32).toString('hex') }));
});

test('bootstrap configuration conflicts fail and the main API excludes local provisioning', async () => {
  for (const nodeEnv of ['production', 'staging']) {
    assert.throws(() => loadConfig({ ...testAuthEnv, MONGO_URI: isolated.uri,
      NODE_ENV: nodeEnv, ENABLE_BOOTSTRAP_ROUTES: 'true' }), { code: 'INVALID_CONFIGURATION' });
    assert.throws(() => createBootstrapApp({ config: { ...config, nodeEnv }, database }));
  }
  assert.throws(() => loadConfig({ ...testAuthEnv, MONGO_URI: isolated.uri,
    ENABLE_BOOTSTRAP_ROUTES: 'true', PORT: '3002', BOOTSTRAP_PORT: '3002' }));
  // Even loopback/proxy-originated requests cannot reach bootstrap on the main app.
  const main = createApp({ config, database });
  error(await request(main).post('/api/v1/user-accounts').send({}), 404, 'NOT_FOUND');
  error(await request(main).post('/api/v1/gyms').send({}), 404, 'NOT_FOUND');
});

test('bootstrap startup binds a separate listener to loopback and closes both listeners', async () => {
  const lifecycle = await startServer({ config: { ...config, port: 0, bootstrapPort: 0 },
    database: createDatabase({ logger: createLogger(config) }) });
  try {
    assert.equal(lifecycle.bootstrapServer.address().address, '127.0.0.1');
    assert.notEqual(lifecycle.bootstrapServer.address().port, lifecycle.server.address().port);
    error(await request(lifecycle.server).get('/api/v1/user-accounts'), 404, 'NOT_FOUND');
    assert.equal((await request(lifecycle.bootstrapServer).get('/api/v1/user-accounts')).status, 200);
  } finally { await lifecycle.shutdown('test'); }
  assert.equal(lifecycle.server.listening, false);
  assert.equal(lifecycle.bootstrapServer.listening, false);
});

test('password policy rejects blank/common/predictable values and preserves a passphrase', async () => {
  const created = await request(app).post('/api/v1/user-accounts').send({ email: 'policy@example.com', status: 'active' });
  const path = `/api/v1/user-accounts/${created.body.data.id}/password`;
  for (const value of [' '.repeat(20), 'a'.repeat(20), 'password123456789', 'P@ssw0rd123456789', 'qwerty1234567890',
    'correct horse battery staple', 'too short', 'x'.repeat(129)]) {
    error(await request(app).post(path).send({ password: value }), 400, 'VALIDATION_ERROR');
  }
  const passphrase = '  violet rivers orbit distant moons!  ';
  assert.equal((await request(app).post(path).send({ password: passphrase })).status, 200);
  const saved = await models.UserAccount.findById(created.body.data.id).select('+passwordHash');
  assert.equal(await argon2.verify(saved.passwordHash, passphrase), true);
  assert.equal(await argon2.verify(saved.passwordHash, passphrase.trim()), false);
});

test('Argon2 parameters and independent salts remain enforced', async () => {
  const { hashPassword } = require('../../src/modules/auth/password');
  const [first, second] = await Promise.all([hashPassword(password), hashPassword(password)]);
  for (const hash of [first, second]) {
    assert.match(hash, /^\$argon2id\$v=19\$/);
    assert.deepEqual(Object.fromEntries(hash.split('$')[3].split(',').map((item) => item.split('='))),
      { m: '65536', t: '3', p: '1' });
  }
  assert.notEqual(first.split('$')[4], second.split('$')[4]);
  assert.equal(await argon2.verify(first, password), true);
});

test('concurrent initial provisioning accepts exactly one password', async () => {
  const created = await request(app).post('/api/v1/user-accounts').send({ email: 'race@example.com', status: 'active' });
  const values = [randomBytes(24).toString('base64url'), randomBytes(24).toString('base64url')];
  const responses = await Promise.all(values.map((value) => request(app)
    .post(`/api/v1/user-accounts/${created.body.data.id}/password`).send({ password: value })));
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const saved = await models.UserAccount.findById(created.body.data.id).select('+passwordHash');
  const winner = responses.findIndex((response) => response.status === 200);
  assert.equal(await argon2.verify(saved.passwordHash, values[winner]), true);
  assert.equal(await argon2.verify(saved.passwordHash, values[1 - winner]), false);
});

function expiredAccess(data) {
  const claims = jwt.decode(data.accessToken);
  return jwt.sign({ sid: claims.sid }, config.jwtAccessSecret, { algorithm: 'HS256',
    subject: claims.sub, issuer: config.jwtIssuer, audience: config.jwtAudience, expiresIn: -1 });
}

test('expired access plus valid refresh logs out and prevents further refresh', async () => {
  await provision();
  const data = (await login()).body.data;
  const expired = expiredAccess(data);
  error(await me(expired), 401, 'INVALID_AUTHENTICATION');
  assert.equal((await request(app).post('/api/v1/auth/logout')
    .set('Authorization', `Bearer ${expired}`).send({ refreshToken: data.refreshToken })).status, 200);
  error(await refresh(data.refreshToken), 401, 'INVALID_AUTHENTICATION');
});

test('conflicting bearer and cookie revoke both verified sessions before clearing the cookie', async () => {
  await provision();
  const first = (await login('person@example.com', 'web')).body.data;
  const second = await login('person@example.com', 'web');
  const cookie = second.headers['set-cookie'][0].split(';')[0];
  const result = await request(app).post('/api/v1/auth/logout').set('Origin', origin)
    .set('Authorization', `Bearer ${first.accessToken}`).set('Cookie', cookie).send({});
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data, { loggedOut: true });
  error(await me(first.accessToken), 401, 'INVALID_AUTHENTICATION');
  error(await me(second.body.data.accessToken), 401, 'INVALID_AUTHENTICATION');
  error(await request(app).post('/api/v1/auth/refresh').set('Origin', origin).set('Cookie', cookie).send({}),
    401, 'INVALID_AUTHENTICATION');
});

test('matching bearer and refresh logout is idempotent for an already-revoked session', async () => {
  await provision();
  const data = (await login()).body.data;
  for (let i = 0; i < 2; i += 1) {
    assert.equal((await request(app).post('/api/v1/auth/logout').set('Authorization', `Bearer ${data.accessToken}`)
      .send({ refreshToken: data.refreshToken })).status, 200);
  }
  error(await refresh(data.refreshToken), 401, 'INVALID_AUTHENTICATION');
  error(await me(data.accessToken), 401, 'INVALID_AUTHENTICATION');
});

test('invalid logout credentials do not clear cookies or revoke a valid accompanying session', async () => {
  await provision();
  const web = await login('person@example.com', 'web');
  const cookie = web.headers['set-cookie'][0].split(';')[0];
  const badBearer = await request(app).post('/api/v1/auth/logout').set('Origin', origin)
    .set('Cookie', cookie).set('Authorization', 'Bearer malformed').send({});
  error(badBearer, 401, 'INVALID_AUTHENTICATION');
  assert.equal(badBearer.headers['set-cookie'], undefined);
  assert.equal((await me(web.body.data.accessToken)).status, 200);
  const mobile = (await login()).body.data;
  const invalid = await request(app).post('/api/v1/auth/logout').set('Authorization', `Bearer ${mobile.accessToken}`)
    .send({ refreshToken: randomBytes(32).toString('base64url') });
  error(invalid, 401, 'INVALID_AUTHENTICATION');
  assert.equal((await me(mobile.accessToken)).status, 200);
  error(await request(app).post('/api/v1/auth/logout').send({}), 401, 'INVALID_AUTHENTICATION');
  error(await request(app).post('/api/v1/auth/logout').set('Origin', origin)
    .set('Cookie', `${cookieName}=`).send({}), 401, 'INVALID_AUTHENTICATION');
});

test('a signed JWT with mismatched account and session is rejected', async () => {
  await provision();
  const data = (await login()).body.data;
  const other = await provision('active', 'other@example.com');
  const wrong = jwt.sign({ sid: jwt.decode(data.accessToken).sid }, config.jwtAccessSecret, { algorithm: 'HS256',
    subject: other.id, issuer: config.jwtIssuer, audience: config.jwtAudience, expiresIn: 600 });
  error(await me(wrong), 401, 'INVALID_AUTHENTICATION');
  error(await request(app).post('/api/v1/auth/logout').set('Authorization', `Bearer ${wrong}`).send({}),
    401, 'INVALID_AUTHENTICATION');
  assert.equal((await me(data.accessToken)).status, 200);
});

test('refresh never extends the absolute session deadline', async () => {
  await provision();
  const data = (await login()).body.data;
  const expiresAt = new Date(Date.now() + 5000);
  const sid = jwt.decode(data.accessToken).sid;
  await models.AuthSession.updateOne({ _id: sid }, { $set: { expiresAt, idleExpiresAt: expiresAt } });
  const result = await refresh(data.refreshToken);
  assert.equal(result.status, 200);
  const session = await models.AuthSession.findById(sid);
  const record = await models.RefreshTokenRecord.findOne({ tokenHash: digestToken(result.body.data.refreshToken) });
  assert.equal(session.expiresAt.getTime(), expiresAt.getTime());
  assert.equal(session.idleExpiresAt.getTime(), expiresAt.getTime());
  assert.equal(record.expiresAt.getTime(), expiresAt.getTime());
  assert.equal(record.purgeAt.getTime(), expiresAt.getTime());
});

test('logout winning the refresh session update cannot be undone by refresh', async (t) => {
  await provision();
  const data = (await login()).body.data;
  const entered = Promise.withResolvers();
  const proceed = Promise.withResolvers();
  const original = models.AuthSession.updateOne.bind(models.AuthSession);
  t.mock.method(models.AuthSession, 'updateOne', async (query, update) => {
    if (query.currentTokenHash) { entered.resolve(); await proceed.promise; }
    return original(query, update);
  });
  const pending = refresh(data.refreshToken).then((response) => response);
  try {
    await entered.promise;
    assert.equal((await request(app).post('/api/v1/auth/logout').send({ refreshToken: data.refreshToken })).status, 200);
  } finally { proceed.resolve(); }
  error(await pending, 401, 'INVALID_AUTHENTICATION');
  assert.equal((await models.AuthSession.findOne()).status, 'revoked');
  error(await refresh(data.refreshToken), 401, 'INVALID_AUTHENTICATION');
  error(await me(data.accessToken), 401, 'INVALID_AUTHENTICATION');
});

test('failure after the refresh session switch revokes the chain and exposes no internal error', async (t) => {
  await provision();
  const data = (await login()).body.data;
  t.mock.method(models.RefreshTokenRecord, 'updateOne', async () => { throw new Error('private database credential'); });
  const result = await refresh(data.refreshToken);
  error(result, 500, 'INTERNAL_SERVER_ERROR');
  assert.equal(JSON.stringify(result.body).includes('private'), false);
  assert.equal((await models.AuthSession.findOne()).status, 'revoked');
  error(await me(data.accessToken), 401, 'INVALID_AUTHENTICATION');
});

test('identity migration preserves unrelated indexes and production startup fails on missing uniqueness', async () => {
  const { migrateIdentityIndexes, verifyIdentityIndexes } = require('../../src/config/identityIndexes');
  await models.UserAccount.collection.createIndex({ status: 1 }, { name: 'retained_custom_index' });
  await models.UserAccount.collection.dropIndex('account_email_unique');
  try {
    await assert.rejects(verifyIdentityIndexes(database.connection), { code: 'IDENTITY_INDEX_MISSING' });
    const output = [];
    const logger = createLogger({ ...config, logLevel: 'info' }, new Writable({
      write(chunk, _encoding, callback) { output.push(chunk.toString()); callback(); },
    }));
    const independent = createDatabase({ logger });
    await assert.rejects(startServer({ config: { ...config, nodeEnv: 'production', enableBootstrapRoutes: false, port: 0 },
      database: independent, logger }), { code: 'STARTUP_FAILED' });
    assert.equal(independent.getStatus(), 'disconnected');
    assert.equal(output.join('').includes('API server started'), false);
    assert.match(output.join(''), /account_email_unique/);
    await migrateIdentityIndexes(database.connection);
    await verifyIdentityIndexes(database.connection);
    assert.ok((await models.UserAccount.listIndexes()).some((index) => index.name === 'retained_custom_index'));
    await models.GymAccess.collection.dropIndex('access_user_gym_unique');
    await assert.rejects(verifyIdentityIndexes(database.connection), { code: 'IDENTITY_INDEX_MISSING' });
  } finally { await migrateIdentityIndexes(database.connection); }
});

test('security events are correlated and contain no credentials across failure, reuse and logout', async () => {
  let output = '';
  const logger = createLogger({ ...config, logLevel: 'info' }, new Writable({
    write(chunk, _encoding, callback) { output += chunk.toString(); callback(); },
  }));
  await provision();
  const logged = createApp({ config, database, logger });
  await request(logged).post('/api/v1/auth/login').set('X-Request-ID', 'failed-login')
    .send({ email: 'person@example.com', password: 'wrong', client: 'mobile' });
  const first = await request(logged).post('/api/v1/auth/login').set('X-Request-ID', 'successful-login')
    .send({ email: 'person@example.com', password, client: 'mobile' });
  const rotated = await request(logged).post('/api/v1/auth/refresh').send({ refreshToken: first.body.data.refreshToken });
  await request(logged).post('/api/v1/auth/refresh').set('X-Request-ID', 'replay')
    .send({ refreshToken: first.body.data.refreshToken });
  await request(logged).post('/api/v1/auth/logout').set('X-Request-ID', 'logout')
    .send({ refreshToken: rotated.body.data.refreshToken });
  const events = output.trim().split('\n').map((line) => JSON.parse(line)).filter((item) => item.event);
  for (const [event, outcome, requestId] of [
    ['auth.login', 'failure', 'failed-login'], ['auth.login', 'success', 'successful-login'],
    ['auth.refresh_reuse', 'detected', 'replay'], ['auth.session_revoked', 'success', 'replay'],
    ['auth.logout', 'success', 'logout'],
  ]) assert.ok(events.some((item) => item.event === event && item.outcome === outcome && item.requestId === requestId));
  for (const secret of [password, first.body.data.accessToken, first.body.data.refreshToken,
    rotated.body.data.accessToken, rotated.body.data.refreshToken, config.jwtAccessSecret, isolated.uri]) {
    assert.equal(output.includes(secret), false);
  }
  noHash(output);
});

test('conflicting native bearer and refresh credentials revoke both sessions', async () => {
  await provision();
  const first = (await login()).body.data;
  const second = (await login()).body.data;
  assert.equal((await request(app).post('/api/v1/auth/logout').set('Authorization', `Bearer ${first.accessToken}`)
    .send({ refreshToken: second.refreshToken })).status, 200);
  for (const data of [first, second]) {
    error(await refresh(data.refreshToken), 401, 'INVALID_AUTHENTICATION');
    error(await me(data.accessToken), 401, 'INVALID_AUTHENTICATION');
  }
});

test('a partial identity uniqueness index is not accepted as the global constraint', async () => {
  const { migrateIdentityIndexes, verifyIdentityIndexes } = require('../../src/config/identityIndexes');
  await models.UserAccount.collection.dropIndex('account_email_unique');
  try {
    await models.UserAccount.collection.createIndex({ normalizedEmail: 1 }, {
      name: 'partial_email_only', unique: true, partialFilterExpression: { status: 'active' },
    });
    await assert.rejects(verifyIdentityIndexes(database.connection), { code: 'IDENTITY_INDEX_MISSING' });
  } finally {
    await models.UserAccount.collection.dropIndex('partial_email_only');
    await migrateIdentityIndexes(database.connection);
  }
});

test('the explicit index migration CLI works on a fresh isolated database', { timeout: 10000 }, async () => {
  const uri = `${isolated.uri}_index_migration`;
  const child = spawn(process.execPath, ['src/scripts/identityIndexes.js'], {
    env: { ...process.env, ...testAuthEnv, MONGO_URI: uri, NODE_ENV: 'production',
      ENABLE_BOOTSTRAP_ROUTES: 'false', LOG_LEVEL: 'info' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  assert.match(output, /Identity indexes verified/);
  assert.equal(output.includes(uri), false);
  assert.equal(output.includes(testAuthEnv.JWT_ACCESS_SECRET), false);
  const localConfig = { ...config, mongoUri: uri, enableBootstrapRoutes: false };
  const independent = createDatabase({ logger: createLogger(config) });
  try {
    await independent.connect(localConfig);
    const { verifyIdentityIndexes } = require('../../src/config/identityIndexes');
    await verifyIdentityIndexes(independent.connection);
  } finally { await independent.disconnect(); }
});
