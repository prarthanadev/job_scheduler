const express = require('express');
const router = express.Router();
const { body, validationResult, query } = require('express-validator');
const { dbQuery, dbRun, dbGet } = require('../config/database');
const authenticate = require('../middleware/auth');
const { syncCronJobs } = require('../services/cronService');

router.use(authenticate);

router.post('/', [
  body('queue_id').isInt(),
  body('type').isIn(['IMMEDIATE', 'DELAYED', 'SCHEDULED', 'BATCH']),
  body('payload').optional().isString(),
  body('cron_expression').optional().isString(),
  body('delay_seconds').optional().isInt(),
  body('batch_id').optional().isString()
], async (req, res, next) => {
    const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { queue_id, type, payload, cron_expression, delay_seconds, batch_id } = req.body;
    const queue = await dbGet(`
      SELECT q.id FROM queues q
      JOIN projects p ON q.project_id = p.id
      WHERE q.id = ? AND p.user_id = ?`, [queue_id, req.user.id]);

    if (!queue) return res.status(404).json({ error: 'Queue not found' });

    let status = 'QUEUED';
    let runAt = new Date();

    if (type === 'DELAYED' && delay_seconds) {
      runAt = new Date(Date.now() + delay_seconds * 1000);
    } else if (type === 'SCHEDULED') {
      status = 'SCHEDULED';
      runAt = null;
    }

    const result = await dbRun(
      `INSERT INTO jobs (queue_id, type, status, payload, cron_expression, run_at, batch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [queue_id, type, status, payload || '{}', cron_expression || null, runAt ? runAt.toISOString() : null, batch_id || null]
    );

    if (type === 'SCHEDULED') await syncCronJobs();

    res.status(201).json({ id: result.id, type, status, run_at: runAt });
  } catch (err) { next(err); }
});

router.get('/', [
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  query('status').optional().isString(),
  query('queue_id').optional().isInt()
], async (req, res, next) => {
  try {
    const page = req.query.page || 1;
    const limit = req.query.limit || 10;
    const offset = (page - 1) * limit;

    let queryStr = `
      SELECT j.* FROM jobs j
      JOIN queues q ON j.queue_id = q.id
      JOIN projects p ON q.project_id = p.id
      WHERE p.user_id = ?
    `;
    const params = [req.user.id];

    if (req.query.status) {
      queryStr += ' AND j.status = ?';
      params.push(req.query.status);
    }
    if (req.query.queue_id) {
      queryStr += ' AND j.queue_id = ?';
      params.push(req.query.queue_id);
    }

    queryStr += ' ORDER BY j.id DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const jobs = await dbQuery(queryStr, params);
    const [{ total }] = await dbQuery(
      queryStr
        .replace('SELECT j.*', 'SELECT COUNT(j.id) as total')
        .replace(' ORDER BY j.id DESC LIMIT ? OFFSET ?', ''),
      params.slice(0, -2)
    );

    res.json({ page, limit, total, data: jobs });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const job = await dbGet(`
      SELECT j.*, q.name as queue_name, dlq.last_error, dlq.ai_failure_summary, dlq.failed_at
      FROM jobs j
      JOIN queues q ON j.queue_id = q.id
      JOIN projects p ON q.project_id = p.id
      LEFT JOIN dead_letter_queue dlq ON dlq.job_id = j.id
      WHERE j.id = ? AND p.user_id = ?`, [req.params.id, req.user.id]);

    if (!job) return res.status(404).json({ error: 'Job not found' });

    const executions = await dbQuery(
      'SELECT * FROM job_executions WHERE job_id = ? ORDER BY id DESC',
      [job.id]
    );
    const logs = await dbQuery(
      'SELECT * FROM job_logs WHERE job_id = ? ORDER BY id DESC',
      [job.id]
    );

    res.json({ ...job, executions, logs });
  } catch (err) { next(err); }
});

router.post('/:id/retry', async (req, res, next) => {
  try {
    const job = await dbGet(`
      SELECT j.* FROM jobs j
      JOIN queues q ON j.queue_id = q.id
      JOIN projects p ON q.project_id = p.id
      WHERE j.id = ? AND p.user_id = ?`, [req.params.id, req.user.id]);

    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'FAILED') return res.status(400).json({ error: 'Only FAILED jobs can be manually retried' });

    await dbRun("UPDATE jobs SET status = 'QUEUED', retry_count = 0, run_at = CURRENT_TIMESTAMP WHERE id = ?", [job.id]);
    await dbRun("DELETE FROM dead_letter_queue WHERE job_id = ?", [job.id]);

    res.json({ message: 'Job successfully scheduled for retry execution', job_id: job.id });
  } catch (err) { next(err); }
});

module.exports = router;
