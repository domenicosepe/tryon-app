const express = require('express');
const router  = express.Router();
const db      = require('../db');

async function verifyShop(req, res, next) {
  const domain = req.headers['x-shop-domain'] || req.body.shop_domain;
  if (!domain) return res.status(400).json({ error: 'shop_domain mancante' });

  const result = await db.query('SELECT * FROM shops WHERE shop_domain = $1', [domain]);
  if (!result.rows.length) return res.status(404).json({
    error: 'Negozio non registrato',
    message: `Registrati su ${process.env.APP_URL}/install.html`,
  });

  const shop = result.rows[0];

  if (shop.status === 'pending') return res.status(403).json({
    error: 'In attesa',
    message: 'Abbonamento in attesa di conferma pagamento.',
  });
  if (shop.status === 'blocked') return res.status(403).json({
    error: 'Sospeso',
    message: 'Abbonamento sospeso. Verifica il pagamento o contatta il supporto.',
  });
  if (shop.status !== 'active') return res.status(403).json({
    error: 'Non attivo',
    message: `Attiva un piano su ${process.env.APP_URL}/install.html`,
  });
  if (shop.fashn_calls_used >= shop.fashn_calls_limit) return res.status(429).json({
    error: 'Crediti esauriti',
    message: `Hai usato tutte le ${shop.fashn_calls_limit} generazioni mensili. Si resettano al rinnovo.`,
  });

  req.shop = shop;
  next();
}

router.post('/run', verifyShop, async (req, res) => {
  try {
    const { model_image, product_image } = req.body;
    if (!model_image || !product_image) return res.status(400).json({ error: 'Immagini mancanti' });

    const fashnRes = await fetch('https://api.fashn.ai/v1/run', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.FASHN_API_KEY}`,
      },
      body: JSON.stringify({
        model_name: 'tryon-max',
        inputs: { model_image, product_image },
      }),
    });

    const data = await fashnRes.json();
    if (!fashnRes.ok) throw new Error(data.detail || data.error || `Errore Fashn ${fashnRes.status}`);

    await db.query('UPDATE shops SET fashn_calls_used = fashn_calls_used + 1 WHERE id = $1', [req.shop.id]);
    await db.query('INSERT INTO usage_log (shop_id, action) VALUES ($1, $2)', [req.shop.id, 'tryon_run']);

    res.json({ id: data.id, calls_left: req.shop.fashn_calls_limit - req.shop.fashn_calls_used - 1 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/status/:id', async (req, res) => {
  const domain = req.query.domain;
  if (!domain) return res.status(400).json({ error: 'domain mancante' });
  try {
    const r = await fetch(`https://api.fashn.ai/v1/status/${req.params.id}`, {
      headers: { 'Authorization': `Bearer ${process.env.FASHN_API_KEY}` },
    });
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
