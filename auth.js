const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { dbGet, dbRun } = require('../config/database');

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_change_me_in_production';

router.post('/signup', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 })
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { email, password } = req.body;
    const existing = await dbGet('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) return res.status(400).json({ error: 'User already exists' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await dbRun('INSERT INTO users (email, password) VALUES (?, ?)', [email, hashedPassword]);

    const token = jwt.sign({ id: result.id, email }, JWT_SECRET, { expiresIn: '24h' });
    res.status(201).json({ message: 'User created successfully', token });
  } catch (err) { next(err); }
});

router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').exists()
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { email, password } = req.body;
    const user = await dbGet('SELECT * FROM users WHERE email = ?', [email]);
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token });
  } catch (err) { next(err); }
});

module.exports = router;
