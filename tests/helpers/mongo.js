const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtemp, rm, access, readFile } = require('node:fs/promises');
const { constants } = require('node:fs');
const { tmpdir, homedir } = require('node:os');
const { join } = require('node:path');
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const { randomUUID } = require('node:crypto');

async function startTestMongo() {
  // Never read .env, MONGO_URI, or any existing database. Own process + temporary data only.
  const cached = join(homedir(), '.cache/gym-management-tests/mongodb/bin/mongod');
  let binary = process.env.MONGOD_BINARY;
  if (!binary) {
    try { await access(cached, constants.X_OK); binary = cached; }
    catch { binary = 'mongod'; }
  }
  const directory = await mkdtemp(join(tmpdir(), 'gym-domain-tests-'));
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(binary, [
    '--bind_ip', '127.0.0.1', '--port', String(port), '--dbpath', directory,
    '--logpath', join(directory, 'mongodb.log'), '--quiet',
  ], { stdio: 'ignore' });
  const closed = new Promise((resolve) => child.once('close', resolve));
  let spawnError;
  child.on('error', (error) => { spawnError = error; });
  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null && !spawnError) {
      child.kill('SIGTERM');
      const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { await closed; } finally { clearTimeout(deadline); }
    } else {
      await closed;
    }
    await rm(directory, { recursive: true, force: true });
  }
  try {
    let listening = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (spawnError || child.exitCode !== null) {
        throw new Error('Test MongoDB could not start. Install mongod or set MONGOD_BINARY; no external database is used.');
      }
      // Trust readiness from this child process's own log, not a potentially unrelated
      // listener that won the race for the reserved port.
      try {
        const log = await readFile(join(directory, 'mongodb.log'), 'utf8');
        listening = log.includes('Waiting for connections');
      } catch { listening = false; }
      if (listening) break;
      await delay(100);
    }
    if (!listening) throw new Error('Isolated test MongoDB startup timed out.');
    return { uri: `mongodb://127.0.0.1:${port}/gym_tests_${randomUUID().replaceAll('-', '')}`, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

module.exports = { startTestMongo };
