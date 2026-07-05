const sqlite3 = require('sqlite3').verbose();
const path = require('path');
require('dotenv').config();

const dbPath = path.resolve(__dirname, '../../', process.env.DATABASE_URL || 'queueforge.db');
const db = new sqlite3.Database(dbPath);

const dbQuery = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

const dbRun = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
};

const dbGet = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const initDB = async () => {
  await dbRun('PRAGMA foreign_keys = ON;');

  const ensureColumn = async (tableName, columnName, definition) => {
    const columns = await dbQuery(`PRAGMA table_info(${tableName})`);
    if (!columns.some(column => column.name === columnName)) {
      await dbRun(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
  };

  await dbRun(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS retry_policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      strategy TEXT CHECK(strategy IN ('FIXED', 'LINEAR', 'EXPONENTIAL')) NOT NULL,
      max_retries INTEGER NOT NULL,
      base_delay_seconds INTEGER NOT NULL
    )
  `);

  // FIX: FK action clause must be "ON DELETE SET NULL", not bare "SET NULL"
  await dbRun(`
    CREATE TABLE IF NOT EXISTS queues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      project_id INTEGER NOT NULL,
      retry_policy_id INTEGER,
      priority INTEGER DEFAULT 0,
      concurrency_limit INTEGER DEFAULT 5,
      paused INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(retry_policy_id) REFERENCES retry_policies(id) ON DELETE SET NULL
    )
  `);

  await ensureColumn('queues', 'priority', 'INTEGER DEFAULT 0');
  await ensureColumn('queues', 'concurrency_limit', 'INTEGER DEFAULT 5');
  await ensureColumn('queues', 'paused', 'INTEGER DEFAULT 0');

  await dbRun(`
    CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT CHECK(status IN ('ACTIVE', 'DEAD')) DEFAULT 'ACTIVE',
      last_heartbeat DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // FIX: same FK action clause bug fixed here for worker_id
  await dbRun(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_id INTEGER NOT NULL,
      worker_id TEXT,
      type TEXT CHECK(type IN ('IMMEDIATE', 'DELAYED', 'SCHEDULED', 'BATCH')) NOT NULL,
      status TEXT CHECK(status IN ('QUEUED', 'SCHEDULED', 'CLAIMED', 'RUNNING', 'COMPLETED', 'FAILED')) DEFAULT 'QUEUED',
      payload TEXT,
      cron_expression TEXT,
      run_at DATETIME,
      retry_count INTEGER DEFAULT 0,
      batch_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(queue_id) REFERENCES queues(id) ON DELETE CASCADE,
      FOREIGN KEY(worker_id) REFERENCES workers(id) ON DELETE SET NULL
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS job_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      worker_id TEXT NOT NULL,
      started_at DATETIME NOT NULL,
      finished_at DATETIME,
      status TEXT NOT NULL,
      error_message TEXT,
      FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS job_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      log_level TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS dead_letter_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER UNIQUE NOT NULL,
      queue_id INTEGER NOT NULL,
      failed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      original_payload TEXT,
      last_error TEXT,
      ai_failure_summary TEXT
    )
  `);

  // Helpful indexes for the poll/claim query and dashboard filters
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_jobs_status_runat ON jobs(status, run_at)`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs(queue_id)`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_queues_project ON queues(project_id)`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_job_logs_job ON job_logs(job_id)`);

  const policy = await dbGet('SELECT id FROM retry_policies LIMIT 1');
  if (!policy) {
    await dbRun("INSERT INTO retry_policies (name, strategy, max_retries, base_delay_seconds) VALUES ('Default Policy', 'EXPONENTIAL', 3, 2)");
  }
};

module.exports = { db, dbQuery, dbRun, dbGet, initDB };
