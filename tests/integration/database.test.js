const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const request = require('supertest');
const { loadConfig } = require('../../src/config/env');
const { createLogger } = require('../../src/config/logger');
const { createDatabase } = require('../../src/config/database');
const { createApp } = require('../../src/app');
const { startServer } = require('../../src/server');

// Test-only placeholder, never used to contact an external database.
const testUri = 'mongodb://database.invalid/foundation-test';
function config(overrides = {}) {
  return loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', MONGO_URI: testUri, ...overrides });
}

function captureLogger() {
  let output = '';
  const destination = new Writable({
    write(chunk, _encoding, callback) { output += chunk.toString(); callback(); },
  });
  return {
    logger: createLogger(config({ LOG_LEVEL: 'info' }), destination),
    output: () => output,
  };
}

class TestConnection extends EventEmitter {
  readyState = 0;
  async openUri(uri, options) {
    this.uri = uri;
    this.options = options;
    this.readyState = 1;
    this.emit('connected');
    return this;
  }
  async close() {
    this.readyState = 0;
    this.emit('disconnected');
  }
}

test('MONGO_URI is mandatory and invalid values are not exposed', () => {
  for (const value of [undefined, '', ' ', '<your-mongodb-connection-string>', 'https://example.com']) {
    assert.throws(() => config({ MONGO_URI: value }), (error) => {
      assert.equal(error.code, 'INVALID_CONFIGURATION');
      assert.match(error.message, /MONGO_URI/);
      if (value && value.trim()) assert.equal(error.message.includes(value), false);
      return true;
    });
  }
  assert.equal(config().mongoUri, testUri);
  assert.equal(config({ MONGO_URI: 'mongodb+srv://database.invalid/test' }).mongoUri,
    'mongodb+srv://database.invalid/test');
});

test('database abstraction uses supplied URI, disables automatic schema work, and closes', async () => {
  const connection = new TestConnection();
  const database = createDatabase({ logger: createLogger(config()), connection });
  assert.equal(database.getStatus(), 'disconnected');
  assert.equal(await database.connect(config()), connection);
  assert.equal(connection.uri, testUri);
  assert.equal(connection.options.bufferCommands, false);
  assert.equal(connection.options.autoIndex, false);
  assert.equal(connection.options.autoCreate, false);
  assert.equal(database.getStatus(), 'connected');
  await database.disconnect();
  assert.equal(database.getStatus(), 'disconnected');
});

test('readiness follows connection state while liveness remains healthy', async () => {
  const connection = new TestConnection();
  const logger = createLogger(config());
  const database = createDatabase({ logger, connection });
  const app = createApp({ config: config(), logger, database });
  for (const [state, label, status] of [
    [0, 'disconnected', 503], [2, 'connecting', 503], [1, 'connected', 200],
    [3, 'disconnecting', 503], [0, 'disconnected', 503], [1, 'connected', 200],
  ]) {
    connection.readyState = state;
    const response = await request(app).get('/ready');
    assert.equal(response.status, status);
    assert.equal(response.body.success, status === 200);
    assert.equal(response.body.data.checks.database, label);
    assert.equal(response.body.meta.requestId, response.headers['x-request-id']);
    assert.equal((await request(app).get('/health')).status, 200);
    assert.equal((await request(app).get('/api/v1/health')).status, 200);
  }
  app.locals.ready = false;
  assert.equal((await request(app).get('/ready')).status, 503);
});

test('database errors and structured URI fields do not disclose connection details', async () => {
  const captured = captureLogger();
  const connection = new TestConnection();
  connection.openUri = async () => {
    const error = new Error(`private-credential ${testUri}`);
    connection.emit('error', error);
    throw error;
  };
  connection.close = async () => { throw new Error(`private-credential ${testUri}`); };
  const database = createDatabase({ logger: captured.logger, connection });
  await assert.rejects(database.connect(config()), { code: 'DATABASE_CONNECTION_FAILED' });
  await assert.rejects(database.disconnect(), { code: 'DATABASE_DISCONNECT_FAILED' });
  captured.logger.info({ mongoUri: testUri, config: { MONGO_URI: testUri } }, 'Redaction check');
  assert.equal(captured.output().includes(testUri), false);
  assert.equal(captured.output().includes('private-credential'), false);
  assert.ok(captured.output().includes('[REDACTED]'));
});

test('startup waits for database and shutdown closes HTTP before database', async () => {
  const captured = captureLogger();
  const gate = Promise.withResolvers();
  let state = 'connecting';
  let closes = 0;
  const database = {
    async connect() { await gate.promise; state = 'connected'; },
    getStatus: () => state,
    async disconnect() {
      assert.equal(lifecycle.server.listening, false);
      state = 'disconnected';
      closes += 1;
    },
  };
  const signalCount = process.listenerCount('SIGTERM');
  // Port zero is injected only for testing so the OS chooses a free HTTP port.
  const pending = startServer({ config: { ...config(), port: 0 }, logger: captured.logger, database });
  assert.equal(captured.output().includes('API server started'), false);
  gate.resolve();
  const lifecycle = await pending;
  try {
    const response = await request(lifecycle.server).get('/ready');
    assert.equal(response.status, 200);
    assert.equal(response.body.data.checks.database, 'connected');
  } finally {
    await Promise.all([lifecycle.shutdown('test'), lifecycle.shutdown('test')]);
  }
  assert.equal(closes, 1);
  assert.equal(process.listenerCount('SIGTERM'), signalCount);
  assert.ok(captured.output().includes('API server stopped'));
});

test('failed database startup never starts HTTP, cleans up, and sanitizes errors', async () => {
  const captured = captureLogger();
  let closes = 0;
  const signalCount = process.listenerCount('SIGTERM');
  await assert.rejects(startServer({
    config: { ...config(), port: 0 },
    logger: captured.logger,
    database: {
      async connect() { throw new Error(`private-credential ${testUri}`); },
      async disconnect() { closes += 1; },
    },
  }), { code: 'STARTUP_FAILED', message: 'Unable to start API server.' });
  assert.equal(closes, 1);
  assert.equal(captured.output().includes('API server started'), false);
  assert.equal(captured.output().includes('private-credential'), false);
  assert.equal(captured.output().includes(testUri), false);
  assert.equal(process.listenerCount('SIGTERM'), signalCount);
});

test('HTTP listen failure closes the already-connected database', async () => {
  const occupied = net.createServer();
  occupied.listen(0, '::');
  await once(occupied, 'listening');
  let closes = 0;
  try {
    await assert.rejects(startServer({
      config: { ...config(), port: occupied.address().port },
      logger: createLogger(config()),
      database: {
        async connect() {},
        getStatus: () => 'connected',
        async disconnect() { closes += 1; },
      },
    }), { code: 'STARTUP_FAILED' });
    assert.equal(closes, 1);
  } finally {
    await new Promise((resolve) => occupied.close(resolve));
  }
});

test('real Mongoose failure against a controlled loopback non-MongoDB endpoint is safe', { timeout: 5000 }, async () => {
  // This is a dummy TCP listener, not MongoDB. No credentials or external network are used.
  const dummy = net.createServer((socket) => socket.destroy());
  dummy.listen(0, '127.0.0.1');
  await once(dummy, 'listening');
  const captured = captureLogger();
  const database = createDatabase({ logger: captured.logger });
  const localConfig = config({ MONGO_URI: `mongodb://127.0.0.1:${dummy.address().port}/failure_test` });
  try {
    await assert.rejects(database.connect(localConfig, {
      serverSelectionTimeoutMS: 100, connectTimeoutMS: 100,
    }), { code: 'DATABASE_CONNECTION_FAILED' });
    assert.equal(database.getStatus(), 'disconnected');
    assert.equal(captured.output().includes(localConfig.mongoUri), false);
  } finally {
    await database.disconnect();
    await new Promise((resolve) => dummy.close(resolve));
  }
});

test('CLI rejects missing database configuration without contacting MongoDB', { timeout: 5000 }, async () => {
  const environment = { ...process.env };
  delete environment.MONGO_URI;
  const child = spawn(process.execPath, ['src/server.js'], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 1);
  assert.match(output, /Invalid environment configuration: MONGO_URI/);
  assert.equal(output.includes('API server started'), false);
});

test('app import does not require MONGO_URI or establish a connection', { timeout: 5000 }, async () => {
  const environment = { ...process.env };
  delete environment.MONGO_URI;
  const child = spawn(process.execPath, ['-e',
    'require("./src/app"); const mongoose = require("mongoose"); if (mongoose.connection.readyState !== 0) process.exit(1);',
  ], { env: environment, stdio: 'ignore' });
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
});
