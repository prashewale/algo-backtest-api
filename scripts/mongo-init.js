// MongoDB initialization script
// Runs once when the container is first created.
// Creates indexes on the metadata collections.
// Option chain collection indexes are created dynamically by the app.

db = db.getSiblingDB('algo_backtest');

// Backtest jobs collection
db.createCollection('backtest_jobs');
db.backtest_jobs.createIndex({ jobId: 1 }, { unique: true });
db.backtest_jobs.createIndex({ status: 1, createdAt: -1 });
db.backtest_jobs.createIndex({ 'config.instrument': 1, status: 1 });

// Simulator sessions collection
db.createCollection('simulator_sessions');
db.simulator_sessions.createIndex({ sessionId: 1 }, { unique: true });
db.simulator_sessions.createIndex({ updatedAt: 1 }, { expireAfterSeconds: 86400 });

print('MongoDB initialization complete');
