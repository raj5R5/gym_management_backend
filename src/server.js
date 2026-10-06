function startServer() {
  const app = require('./app');
  const { config, logger } = app.locals;
  const server = app.listen(config.port, (error) => {
    // Express 5 invokes this callback on listen errors as well as success.
    if (error) return;
    logger.info({ port: config.port }, 'API server started');
  });

  let stopping = false;
  const removeSignalHandlers = () => {
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('SIGINT', shutdown);
  };

  function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    app.locals.ready = false;
    logger.info({ signal }, 'API server shutting down');
    const deadline = setTimeout(() => {
      logger.error('Graceful shutdown timed out');
      server.closeAllConnections();
      logger.flush();
      process.exit(1);
    }, 10_000);
    deadline.unref();

    server.close((error) => {
      clearTimeout(deadline);
      removeSignalHandlers();
      if (error) {
        logger.error({ err: error }, 'Server shutdown failed');
        process.exitCode = 1;
      }
      logger.info('API server stopped');
      logger.flush();
    });
  }

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  server.on('error', (error) => {
    removeSignalHandlers();
    logger.error({ err: error }, 'API server failed');
    logger.flush();
    process.exitCode = 1;
  });
  return server;
}

if (require.main === module) {
  try {
    startServer();
  } catch (error) {
    // Configuration errors contain field names only, not raw values.
    process.stderr.write(`API startup failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { startServer };
