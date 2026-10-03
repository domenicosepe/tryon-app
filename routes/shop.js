const express = require('express');
const router  = express.Router();
const db      = require('../db');

// Registra negozio
router.post('/register', async (req, res) => {
  const { shop_domain, shop_name, email, plan } = req.body;
  if (!shop_domain || !plan || !email) return res.status(400).json({ error: 'Parametri mancanti' });

  const LIMITS = { basic: 80, pro: 250, premium: 840 };
  if (!LIMITS[plan]) return res.status(400).json({ error: 'Piano non valido' });

  try {
    const result = await db.query(`
      INSERT INTO shops (shop_domain, shop_name, email, plan, status, fashn_calls_limit)
      VALUES ($1, $2, $3, $4, 'pending', $5)
      ON CONFLICT (shop_domain) DO UPDATE
        SET shop_name = EXCLUDED.shop_name,
            email     = EXCLUDED.email,
            plan      = EXCLUDED.plan,
            fashn_calls_limit = EXCLUDED.fashn_calls_limit
      RETURNING *
    `, [shop_domain, shop_name, email, plan, LIMITS[plan]]);

    res.json({ success: true, shop: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Errore server' });
  }
});

// Stato abbonamento
router.get('/status', async (req, res) => {
  const { domain } = req.query;
  if (!domain) return res.status(400).json({ error: 'domain richiesto' });

  try {
    const result = await db.query('SELECT * FROM shops WHERE shop_domain = $1', [domain]);
    if (!result.rows.length) return res.status(404).json({ error: 'Negozio non trovato' });
    const s = result.rows[0];
    res.json({
      shop_domain:  s.shop_domain,
      plan:         s.plan,
      status:       s.status,
      calls_used:   s.fashn_calls_used,
      calls_limit:  s.fashn_calls_limit,
      calls_left:   Math.max(0, s.fashn_calls_limit - s.fashn_calls_used),
      next_payment: s.next_payment_date,
    });
  } catch (err) {
    res.status(500).json({ error: 'Errore server' });
  }
});

// Piani
router.get('/plans', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM plans ORDER BY price_eur ASC');
    res.json({ plans: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Errore server' });
  }
});

module.exports = router;
