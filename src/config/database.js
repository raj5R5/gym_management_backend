const mongoose = require('mongoose');

const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];

function createDatabase({ logger, connection = mongoose.createConnection() }) {
  // Log lifecycle events only; driver errors may contain credentials or entire URIs.
  connection.on('connected', () => logger.info('MongoDB connected'));
  connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  connection.on('error', () => logger.error('MongoDB connection error'));

  async function connect(config, options = {}) {
    try {
      await connection.openUri(config.mongoUri, {
        serverSelectionTimeoutMS: 10_000,
        connectTimeoutMS: 10_000,
        maxPoolSize: 10,
        bufferCommands: false,
        autoCreate: false,
        autoIndex: false,
        ...options,
      });
      return connection;
    } catch {
      // Deliberately omit raw driver errors, messages, causes, and connection details.
      const error = new Error('Unable to establish MongoDB connection.');
      error.code = 'DATABASE_CONNECTION_FAILED';
      throw error;
    }
  }

  async function disconnect() {
    try {
      await connection.close();
    } catch {
      const error = new Error('Unable to close MongoDB connection.');
      error.code = 'DATABASE_DISCONNECT_FAILED';
      throw error;
    }
  }

  return {
    connect,
    disconnect,
    getStatus: () => states[connection.readyState] ?? 'disconnected',
    // Future model registration can use this explicit connection; no models exist yet.
    connection,
  };
}

module.exports = { createDatabase };
