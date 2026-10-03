const express = require('express');
const router  = express.Router();
const db      = require('../db');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');

function authAdmin(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Non autorizzato' });
  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token non valido' });
  }
}

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await db.query('SELECT * FROM admins WHERE username = $1', [username]);
    if (!result.rows.length) return res.status(401).json({ error: 'Credenziali errate' });
    const valid = await bcrypt.compare(password, result.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Credenziali errate' });
    const token = jwt.sign({ id: result.rows[0].id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: 'Errore server' });
  }
});

router.get('/shops', authAdmin, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, shop_domain, shop_name, email, plan, status,
             fashn_calls_used, fashn_calls_limit, ls_subscription_status,
             next_payment_date, created_at, approved_at, notes
      FROM shops ORDER BY
        CASE status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
        created_at DESC
    `);
    res.json({ shops: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Errore server' });
  }
});

// Approva manuale (se necessario)
router.post('/shops/:id/approve', authAdmin, async (req, res) => {
  try {
    await db.query(`UPDATE shops SET status='active', approved_at=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Errore server' });
  }
});

router.post('/shops/:id/block', authAdmin, async (req, res) => {
  try {
    await db.query(`UPDATE shops SET status='blocked', blocked_at=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Errore server' });
  }
});

router.post('/shops/:id/notes', authAdmin, async (req, res) => {
  try {
    await db.query('UPDATE shops SET notes=$1 WHERE id=$2', [req.body.notes, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Errore server' });
  }
});

router.get('/stats', authAdmin, async (req, res) => {
  try {
    const s = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='active')   AS active,
        COUNT(*) FILTER (WHERE status='pending')  AS pending,
        COUNT(*) FILTER (WHERE status='blocked')  AS blocked,
        COUNT(*) FILTER (WHERE plan='basic')      AS basic,
        COUNT(*) FILTER (WHERE plan='pro')        AS pro,
        COUNT(*) FILTER (WHERE plan='premium')    AS premium,
        SUM(fashn_calls_used)                     AS total_calls,
        COALESCE(SUM(CASE plan WHEN 'basic' THEN 30 WHEN 'pro' THEN 85 WHEN 'premium' THEN 275 ELSE 0 END) FILTER (WHERE status='active'), 0) AS mrr
      FROM shops
    `);
    res.json(s.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Errore server' });
  }
});

router.post('/setup', async (req, res) => {
  const { username, password, setup_key } = req.body;
  if (setup_key !== process.env.SETUP_KEY) return res.status(403).json({ error: 'Setup key errata' });
  try {
    const count = await db.query('SELECT COUNT(*) FROM admins');
    if (parseInt(count.rows[0].count) > 0) return res.status(400).json({ error: 'Admin già creato' });
    const hash = await bcrypt.hash(password, 12);
    await db.query('INSERT INTO admins (username, password_hash) VALUES ($1, $2)', [username, hash]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Errore server' });
  }
});

module.exports = router;
