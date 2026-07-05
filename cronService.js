const cron = require('node-cron');
const { dbQuery, dbRun } = require('../config/database');

const scheduledCronJobs = new Map();

const syncCronJobs = async () => {
  try {
    const activeCronJobs = await dbQuery("SELECT * FROM jobs WHERE type = 'SCHEDULED' AND status = 'SCHEDULED'");

    for (const [jobId, task] of scheduledCronJobs.entries()) {
      if (!activeCronJobs.some(j => j.id === jobId)) {
        task.stop();
        scheduledCronJobs.delete(jobId);
      }
    }

    for (const job of activeCronJobs) {
      if (!scheduledCronJobs.has(job.id) && cron.validate(job.cron_expression)) {
        const task = cron.schedule(job.cron_expression, async () => {
          console.log(`[Cron Engine] Triggering instantiation for Cron Job ID: ${job.id}`);
          await dbRun(
            "INSERT INTO jobs (queue_id, type, status, payload, run_at) VALUES (?, 'IMMEDIATE', 'QUEUED', ?, CURRENT_TIMESTAMP)",
            [job.queue_id, job.payload]
          );
        });
        scheduledCronJobs.set(job.id, task);
      }
    }
  } catch (err) {
    console.error('[Cron Engine] Error syncing cron definitions:', err);
  }
};

const startCronEngine = () => {
  syncCronJobs();
  setInterval(syncCronJobs, 30000);
};

module.exports = { startCronEngine, syncCronJobs };
