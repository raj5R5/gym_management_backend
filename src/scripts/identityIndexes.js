const { loadConfig } = require('../config/env');
const { createLogger } = require('../config/logger');
const { createDatabase } = require('../config/database');
const { migrateIdentityIndexes } = require('../config/identityIndexes');

async function runIdentityIndexMigration() {
  const config = loadConfig();
  const logger = createLogger(config);
  const database = createDatabase({ logger });
  try {
    await database.connect(config);
    await migrateIdentityIndexes(database.connection);
    logger.info('Identity indexes verified');
  } catch {
    // Duplicate-key and driver messages can disclose identities or credentials.
    logger.error('Identity index migration failed. Check existing duplicates and index definitions.');
    process.exitCode = 1;
  } finally {
    await database.disconnect();
    await new Promise((resolve) => logger.flush(resolve));
  }
}
if (require.main === module) {
  runIdentityIndexMigration().catch(() => {
    process.stderr.write('Identity index migration failed.\n');
    process.exitCode = 1;
  });
}
module.exports = { runIdentityIndexMigration };
