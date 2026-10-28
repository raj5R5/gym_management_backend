// Isolated rehearsal tool. Production execution needs a separately approved tool
// and operational policy; changing a CLI flag cannot authorize production access.
const { readFile } = require('node:fs/promises');
const { loadConfig } = require('../config/env');
const { createLogger } = require('../config/logger');
const { createDatabase } = require('../config/database');
const { createApp } = require('../app');
const { createDeletionFulfillmentService } = require('../modules/accountDeletion/fulfillment.service');
function requireIsolated(environment) {
  let uri;
  try { uri = new URL(environment.MONGO_URI); } catch { throw new Error('ISOLATED_REHEARSAL_ONLY'); }
  if (environment.NODE_ENV !== 'test' || environment.ACCOUNT_DELETION_ISOLATED !== '1'
    || uri.protocol !== 'mongodb:' || uri.hostname !== '127.0.0.1'
    || !/^\/gym_tests_[a-f0-9]{32}$/.test(uri.pathname)
    || !['', '?replicaSet=gym_tests'].includes(uri.search)) throw new Error('ISOLATED_REHEARSAL_ONLY');
}
async function run(args = process.argv.slice(2), environment = process.env) {
  requireIsolated(environment); // Always before configuration/database connection.
  const [action, requestId, evidenceFile] = args;
  if (!['review', 'fulfill', 'complete'].includes(action) || !/^[a-f0-9]{24}$/.test(requestId ?? '')
    || (action !== 'fulfill' && !evidenceFile) || (action === 'fulfill' && evidenceFile)) throw new Error('INVALID_REHEARSAL_ARGUMENTS');
  const evidence = evidenceFile ? JSON.parse(await readFile(evidenceFile, 'utf8')) : undefined;
  const config = loadConfig({ ...environment, LOG_LEVEL: 'silent' });
  const database = createDatabase({ logger: createLogger(config) });
  try {
    await database.connect(config);
    createApp({ config, database }); // Models only: no listen, worker or email dispatch.
    const service = createDeletionFulfillmentService({ models: database.connection.models, enabled: true, reviewer: 'Raj' });
    const result = await service[action]('Raj', requestId, evidence);
    process.stdout.write(`Isolated manual-deletion rehearsal: ${result.stage}\n`);
  } finally { await database.disconnect(); }
}
if (require.main === module) run().catch(() => {
  process.stderr.write('Deletion rehearsal blocked or failed. Use only an owned synthetic test database and reviewed evidence. No credentials or records are printed.\n');
  process.exitCode = 1;
});
module.exports = { requireIsolated, run };
