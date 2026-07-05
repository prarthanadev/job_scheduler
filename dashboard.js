const express = require('express');
const router = express.Router();
const { dbQuery } = require('../config/database');
const authenticate = require('../middleware/auth');

router.use(authenticate);

router.get('/stats', async (req, res, next) => {
  try {
    const userId = req.user.id;

    const queueHealth = await dbQuery(`
      SELECT
        q.id as queue_id,
        q.name as queue_name,
        q.priority,
        q.concurrency_limit,
        q.paused,
        j.status,
        COUNT(j.id) as count
      FROM queues q
      JOIN projects p ON q.project_id = p.id
      LEFT JOIN jobs j ON j.queue_id = q.id
      WHERE p.user_id = ?
      GROUP BY q.id, j.status
    `, [userId]);

    const activeWorkers = await dbQuery(`
      SELECT id, name, status, last_heartbeat
      FROM workers
      WHERE status = 'ACTIVE' AND datetime(last_heartbeat) > datetime('now', '-30 seconds')
    `);

    const throughput = await dbQuery(`
      SELECT je.status, COUNT(je.id) as count
      FROM job_executions je
      JOIN jobs j ON je.job_id = j.id
      JOIN queues q ON j.queue_id = q.id
      JOIN projects p ON q.project_id = p.id
      WHERE p.user_id = ? AND je.started_at >= datetime('now', '-1 hour')
      GROUP BY je.status
    `, [userId]);

    const deadLetterQueue = await dbQuery(`
      SELECT dlq.*, q.name as queue_name
      FROM dead_letter_queue dlq
      JOIN queues q ON dlq.queue_id = q.id
      JOIN projects p ON q.project_id = p.id
      WHERE p.user_id = ?
      ORDER BY dlq.failed_at DESC
      LIMIT 20
    `, [userId]);

    res.json({
      queueHealth,
      activeWorkers,
      hourlyThroughput: throughput,
      deadLetterQueue
    });
  } catch (err) { next(err); }
});

module.exports = router;
