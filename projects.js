const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { dbQuery, dbRun } = require('../config/database');
const authenticate = require('../middleware/auth');

router.use(authenticate);

router.post('/', [body('name').trim().notEmpty()], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const result = await dbRun('INSERT INTO projects (name, user_id) VALUES (?, ?)', [req.body.name, req.user.id]);
    res.status(201).json({ id: result.id, name: req.body.name, user_id: req.user.id });
  } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
  try {
    const projects = await dbQuery('SELECT * FROM projects WHERE user_id = ?', [req.user.id]);
    res.json(projects);
  } catch (err) { next(err); }
});

module.exports = router;
