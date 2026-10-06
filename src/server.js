const { loadConfig } = require('./config/env');
const { createLogger } = require('./config/logger');
const { createDatabase } = require('./config/database');
const { createApp } = require('./app');

function flushLogger(logger) {
  return new Promise((resolve, reject) => logger.flush((error) => error ? reject(error) : resolve()));
}

async function startServer({
  config = loadConfig(),
  logger = createLogger(config),
  database = createDatabase({ logger }),
} = {}) {
  let app;
  let server;
  let stopping = false;
  let shutdownPromise;

  const onSignal = (signal) => {
    shutdown(signal).catch(() => { process.exitCode = 1; });
  };
  const onSigterm = () => onSignal('SIGTERM');
  const onSigint = () => onSignal('SIGINT');
  const removeSignalHandlers = () => {
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGINT', onSigint);
  };

  function shutdown(reason) {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    if (app) app.locals.ready = false;
    shutdownPromise = (async () => {
      logger.info({ reason }, 'API server shutting down');
      const deadline = setTimeout(() => {
        logger.error('Graceful shutdown timed out');
        server?.closeAllConnections();
        logger.flush();
        process.exit(1);
      }, 10_000);
      deadline.unref();
      let failed = false;
      try {
        if (server?.listening) {
          try {
            await new Promise((resolve, reject) => {
              server.close((error) => error ? reject(error) : resolve());
            });
          } catch {
            failed = true;
            logger.error('HTTP server shutdown failed');
          }
        }
        try {
          await database.disconnect();
        } catch {
          failed = true;
          logger.error('MongoDB shutdown failed');
        }
        logger.info('API server stopped');
        // The default logger writes to stdout; flush it, but do not close shared stdout.
        await flushLogger(logger);
      } finally {
        clearTimeout(deadline);
        removeSignalHandlers();
      }
      if (failed) {
        const error = new Error('API shutdown failed.');
        error.code = 'SHUTDOWN_FAILED';
        throw error;
      }
    })();
    return shutdownPromise;
  }

  process.once('SIGTERM', onSigterm);
  process.once('SIGINT', onSigint);
  try {
    await database.connect(config);
    if (stopping) throw new Error('Startup interrupted.');
    app = createApp({ config, logger, database });
    if (config.enableBootstrapRoutes && ['development', 'test'].includes(config.nodeEnv)) {
      // Explicitly create only the bootstrap domain indexes; never drop existing indexes.
      await Promise.all([
        database.connection.models.Gym.createIndexes(),
        database.connection.models.Branch.createIndexes(),
        database.connection.models.UserAccount.createIndexes(),
        database.connection.models.GymAccess.createIndexes(),
      ]);
    }
    await new Promise((resolve, reject) => {
      server = app.listen(config.port);
      server.once('listening', resolve);
      server.once('error', reject);
    });
    logger.info({ port: config.port }, 'API server started');
    server.on('error', () => {
      logger.error('HTTP server error');
      process.exitCode = 1;
      onSignal('http_error');
    });
    return { app, server, shutdown };
  } catch (failure) {
    const databaseFailed = failure.code === 'DATABASE_CONNECTION_FAILED';
    logger.error(databaseFailed
      ? 'API startup failed: MongoDB connection unavailable'
      : 'API startup failed; HTTP service is unavailable');
    try {
      await shutdown('startup_failure');
    } catch {
      logger.error('Startup cleanup failed');
      await flushLogger(logger);
    }
    const error = new Error('Unable to start API server.');
    error.code = 'STARTUP_FAILED';
    throw error;
  }
}

if (require.main === module) {
  startServer().catch((error) => {
    const message = error.code === 'INVALID_CONFIGURATION'
      ? error.message : 'Unable to start API server.';
    process.stderr.write(`API startup failed: ${message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { startServer };
