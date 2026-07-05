const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { dbQuery, dbRun, dbGet } = require('../config/database');
const authenticate = require('../middleware/auth');

router.use(authenticate);

router.post('/', [
  body('name').trim().notEmpty(),
  body('project_id').isInt(),
  body('strategy').optional().isIn(['FIXED', 'LINEAR', 'EXPONENTIAL']),
  body('max_retries').optional().isInt({ min: 0 }),
  body('base_delay_seconds').optional().isInt({ min: 1 }),
  body('priority').optional().isInt({ min: 0 }),
  body('concurrency_limit').optional().isInt({ min: 1 })
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const {
      name,
      project_id,
      strategy,
      max_retries,
      base_delay_seconds,
      priority = 0,
      concurrency_limit = 5
    } = req.body;

    const project = await dbGet('SELECT id FROM projects WHERE id = ? AND user_id = ?', [project_id, req.user.id]);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    let policyId = null;
    if (strategy) {
      const policyRes = await dbRun(
        'INSERT INTO retry_policies (name, strategy, max_retries, base_delay_seconds) VALUES (?, ?, ?, ?)',
        [`Policy_${name}`, strategy, max_retries || 3, base_delay_seconds || 5]
      );
      policyId = policyRes.id;
    } else {
      const defaultPolicy = await dbGet("SELECT id FROM retry_policies WHERE name = 'Default Policy'");
      policyId = defaultPolicy ? defaultPolicy.id : null;
    }

    const queueRes = await dbRun(
      'INSERT INTO queues (name, project_id, retry_policy_id, priority, concurrency_limit) VALUES (?, ?, ?, ?, ?)',
      [name, project_id, policyId, priority, concurrency_limit]
    );

    res.status(201).json({
      id: queueRes.id,
      name,
      project_id,
      retry_policy_id: policyId,
      priority,
      concurrency_limit,
      paused: 0
    });
  } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
  try {
    const queues = await dbQuery(`
      SELECT q.*, rp.strategy, rp.max_retries, rp.base_delay_seconds
      FROM queues q
      JOIN projects p ON q.project_id = p.id
      LEFT JOIN retry_policies rp ON q.retry_policy_id = rp.id
      WHERE p.user_id = ?`, [req.user.id]);
    res.json(queues);
  } catch (err) { next(err); }
});

router.patch('/:id', [
  body('name').optional().trim().notEmpty(),
  body('priority').optional().isInt({ min: 0 }),
  body('concurrency_limit').optional().isInt({ min: 1 }),
  body('paused').optional().isBoolean().toBoolean()
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const queue = await dbGet(`
      SELECT q.* FROM queues q
      JOIN projects p ON q.project_id = p.id
      WHERE q.id = ? AND p.user_id = ?`, [req.params.id, req.user.id]);

    if (!queue) return res.status(404).json({ error: 'Queue not found' });

    const nextQueue = {
      name: req.body.name ?? queue.name,
      priority: req.body.priority ?? queue.priority,
      concurrency_limit: req.body.concurrency_limit ?? queue.concurrency_limit,
      paused: req.body.paused === undefined ? queue.paused : (req.body.paused ? 1 : 0)
    };

    await dbRun(
      'UPDATE queues SET name = ?, priority = ?, concurrency_limit = ?, paused = ? WHERE id = ?',
      [nextQueue.name, nextQueue.priority, nextQueue.concurrency_limit, nextQueue.paused, queue.id]
    );

    res.json({ id: queue.id, ...nextQueue });
  } catch (err) { next(err); }
});

router.post('/:id/pause', async (req, res, next) => {
  try {
    const result = await dbRun(`
      UPDATE queues
      SET paused = 1
      WHERE id = ? AND project_id IN (SELECT id FROM projects WHERE user_id = ?)`,
      [req.params.id, req.user.id]
    );

    if (result.changes === 0) return res.status(404).json({ error: 'Queue not found' });
    res.json({ id: Number(req.params.id), paused: true });
  } catch (err) { next(err); }
});

router.post('/:id/resume', async (req, res, next) => {
  try {
    const result = await dbRun(`
      UPDATE queues
      SET paused = 0
      WHERE id = ? AND project_id IN (SELECT id FROM projects WHERE user_id = ?)`,
      [req.params.id, req.user.id]
    );

    if (result.changes === 0) return res.status(404).json({ error: 'Queue not found' });
    res.json({ id: Number(req.params.id), paused: false });
  } catch (err) { next(err); }
});

module.exports = router;
