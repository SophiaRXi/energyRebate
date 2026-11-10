const path = require('path');

/**
 * Local-first DB config.
 * Future hosted swap: set DATABASE_URL (Postgres/Turso) and teach backend/db.js
 * to open that client instead of better-sqlite3 while keeping the same helpers.
 */
module.exports = {
  databasePath: process.env.DATABASE_PATH
    || path.join(__dirname, '../data/rebates.db'),
  databaseUrl: process.env.DATABASE_URL || null
};
