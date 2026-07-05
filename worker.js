const crypto = require('crypto');
const { dbRun, dbQuery, dbGet } = require('../config/database');
const { generateFailureSummary } = require('../services/aiService');
require('dotenv').config();

const workerId = `worker_${crypto.randomBytes(4).toString('hex')}`;
const concurrency = parseInt(process.env.WORKER_CONCURRENCY || '5');
const pollInterval = parseInt(process.env.WORKER_POLL_INTERVAL_MS || '2000');
const heartbeatInterval = parseInt(process.env.WORKER_HEARTBEAT_INTERVAL_MS || '5000');

let working = true;
let activeJobsCount = 0;

const sendHeartbeat = async () => {
  if (!working) return;
  try {
    await dbRun(
      `INSERT INTO workers (id, name, status, last_heartbeat)
       VALUES (?, ?, 'ACTIVE', CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET last_heartbeat=CURRENT_TIMESTAMP, status='ACTIVE'`,
      [workerId, `Worker-${workerId.slice(-4)}`]
    );
  } catch (err) {
    console.error(`[Worker ${workerId}] Heartbeat execution failure:`, err.message);
  }
};

const calculateBackoff = (strategy, baseDelay, retryCount) => {
  if (strategy === 'LINEAR') return baseDelay * (retryCount + 1);
  if (strategy === 'EXPONENTIAL') return baseDelay * Math.pow(2, retryCount);
  return baseDelay; // FIXED
};

const processJob = async (job) => {
  activeJobsCount++;
  const startTime = new Date().toISOString();

  try {
    await dbRun("UPDATE jobs SET status = 'RUNNING' WHERE id = ?", [job.id]);
    await dbRun("INSERT INTO job_logs (job_id, log_level, message) VALUES (?, 'INFO', 'Execution initialized')", [job.id]);

    const payload = JSON.parse(job.payload || '{}');
    if (payload.shouldFail) {
      throw new Error(payload.failMessage || 'Simulated internal execution exception occurred.');
    }

    await dbRun("UPDATE jobs SET status = 'COMPLETED', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [job.id]);
    await dbRun(
      "INSERT INTO job_executions (job_id, worker_id, started_at, finished_at, status) VALUES (?, ?, ?, CURRENT_TIMESTAMP, 'COMPLETED')",
      [job.id, workerId, startTime]
    );
    await dbRun("INSERT INTO job_logs (job_id, log_level, message) VALUES (?, 'INFO', 'Job processed cleanly to completion.')", [job.id]);

  } catch (err) {
    console.error(`[Worker] Execution error for job ${job.id}:`, err.message);
    await dbRun("INSERT INTO job_logs (job_id, log_level, message) VALUES (?, 'ERROR', ?)", [job.id, err.message]);

    const policy = await dbGet(`
      SELECT rp.* FROM retry_policies rp
      JOIN queues q ON q.retry_policy_id = rp.id
      WHERE q.id = ?`, [job.queue_id]);

    const maxRetries = policy ? policy.max_retries : 3;
    const strategy = policy ? policy.strategy : 'EXPONENTIAL';
    const baseDelay = policy ? policy.base_delay_seconds : 5;

    await dbRun(
      "INSERT INTO job_executions (job_id, worker_id, started_at, finished_at, status, error_message) VALUES (?, ?, ?, CURRENT_TIMESTAMP, 'FAILED', ?)",
      [job.id, workerId, startTime, err.message]
    );

    if (job.retry_count < maxRetries) {
      const nextRetryCount = job.retry_count + 1;
      const delaySec = calculateBackoff(strategy, baseDelay, job.retry_count);
      const nextRun = new Date(Date.now() + delaySec * 1000).toISOString();

      await dbRun(
        "UPDATE jobs SET status = 'QUEUED', retry_count = ?, run_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [nextRetryCount, nextRun, job.id]
      );
      await dbRun("INSERT INTO job_logs (job_id, log_level, message) VALUES (?, 'WARN', ?)", [job.id, `Scheduled retry ${nextRetryCount}/${maxRetries} in ${delaySec}s`]);
    } else {
      await dbRun("UPDATE jobs SET status = 'FAILED', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [job.id]);

      const logs = await dbQuery("SELECT log_level, message FROM job_logs WHERE job_id = ?", [job.id]);
      const summaryText = await generateFailureSummary(err.message, logs);

      await dbRun(
        `INSERT INTO dead_letter_queue (job_id, queue_id, original_payload, last_error, ai_failure_summary)
         VALUES (?, ?, ?, ?, ?)`,
        [job.id, job.queue_id, job.payload, err.message, summaryText]
      );
      console.log(`[Worker] Job ${job.id} routed to Dead Letter Queue. AI summary generated.`);
    }
  } finally {
    activeJobsCount--;
  }
};

const pollAndExecute = async () => {
  if (!working) return;

  const capacityAvailable = concurrency - activeJobsCount;
  if (capacityAvailable <= 0) return;

  try {
    await dbRun('BEGIN IMMEDIATE TRANSACTION');

    const claimableJobs = await dbQuery(`
      SELECT j.id, j.queue_id, j.payload, j.retry_count
      FROM jobs j
      JOIN queues q ON j.queue_id = q.id
      WHERE j.status = 'QUEUED'
        AND q.paused = 0
        AND (j.run_at IS NULL OR datetime(j.run_at) <= datetime('now'))
        AND (
          SELECT COUNT(active.id)
          FROM jobs active
          WHERE active.queue_id = j.queue_id
            AND active.status IN ('CLAIMED', 'RUNNING')
        ) < q.concurrency_limit
      ORDER BY q.priority DESC, datetime(j.run_at) ASC, j.id ASC
      LIMIT ?`, [capacityAvailable]);

    for (const job of claimableJobs) {
      // Atomic claim: the WHERE status='QUEUED' guard prevents a second worker
      // from claiming this row if it already flipped between our SELECT and UPDATE.
      const mutationResult = await dbRun(
        "UPDATE jobs SET status='CLAIMED', worker_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='QUEUED'",
        [workerId, job.id]
      );

      if (mutationResult.changes > 0) {
        processJob(job);
      }
    }

    await dbRun('COMMIT');
  } catch (err) {
    await dbRun('ROLLBACK').catch(() => {});
    console.error(`[Worker polling context failure]:`, err.message);
  }
};

sendHeartbeat();
const heartbeatTimer = setInterval(sendHeartbeat, heartbeatInterval);
const pollingTimer = setInterval(pollAndExecute, pollInterval);

const gracefulShutdown = () => {
  console.log(`\n[Worker ${workerId}] SIGTERM/SIGINT caught. Winding down...`);
  working = false;
  clearInterval(heartbeatTimer);
  clearInterval(pollingTimer);

  const checkInFlight = setInterval(async () => {
    if (activeJobsCount === 0) {
      clearInterval(checkInFlight);
      await dbRun("UPDATE workers SET status = 'DEAD' WHERE id = ?", [workerId]).catch(() => {});
      console.log('All in-flight jobs finished. Process terminating safely.');
      process.exit(0);
    } else {
      console.log(`Waiting on ${activeJobsCount} in-flight job(s) to finish...`);
    }
  }, 1000);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

console.log(`[Worker Initialized] ID: ${workerId}`);
