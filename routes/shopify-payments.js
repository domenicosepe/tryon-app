const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const db      = require('../db');

const SECRET = process.env.SHOPIFY_PAYMENTS_SECRET;

const PLAN_LIMITS = { basic: 80, pro: 250, premium: 840 };

// Rileva piano dal titolo prodotto
function detectPlan(title) {
  const t = (title || '').toLowerCase();
  if (t.includes('premium')) return 'premium';
  if (t.includes('pro'))     return 'pro';
  if (t.includes('basic'))   return 'basic';
  return null;
}

// Verifica firma Shopify
function verifyHmac(req) {
  if (!SECRET) return true; // skip in dev
  const hmac    = req.headers['x-shopify-hmac-sha256'];
  const digest  = crypto.createHmac('sha256', SECRET).update(req.body).digest('base64');
  return hmac === digest;
}

// ── Pagamento ordine completato ──────────────────────────
// POST /api/shopify-payments/paid
router.post('/paid', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!verifyHmac(req)) return res.status(401).json({ error: 'Firma non valida' });

  let order;
  try { order = JSON.parse(req.body.toString()); }
  catch { return res.status(400).json({ error: 'Payload non valido' }); }

  console.log(`[ShopifyPayments] Ordine pagato: ${order.name}`);

  try {
    const email      = order.email || order.contact_email;
    const lineItems  = order.line_items || [];
    const note       = order.note || '';

    // Cerca dominio nelle note o negli attributi ordine
    let shop_domain = '';
    const attrs = order.note_attributes || [];
    const domainAttr = attrs.find(a => a.name === 'shop_domain' || a.name === 'dominio');
    if (domainAttr) shop_domain = domainAttr.value;

    // Rileva piano dal primo prodotto
    const item = lineItems[0];
    const plan = detectPlan(item?.title);

    if (!plan) {
      console.log('[ShopifyPayments] Piano non rilevato:', item?.title);
      return res.json({ received: true });
    }

    if (!shop_domain) {
      // Salva come pending senza dominio — verrà associato dopo
      await db.query(`
        INSERT INTO shops (shop_domain, email, plan, status, fashn_calls_limit)
        VALUES ($1, $2, $3, 'pending', $4)
        ON CONFLICT (email) DO UPDATE SET
          plan = $3, status = 'pending', fashn_calls_limit = $4
      `, [`pending_${order.id}`, email, plan, PLAN_LIMITS[plan]]);
    } else {
      await db.query(`
        INSERT INTO shops (shop_domain, email, plan, status, fashn_calls_limit)
        VALUES ($1, $2, $3, 'pending', $4)
        ON CONFLICT (shop_domain) DO UPDATE SET
          email = $2, plan = $3, status = 'pending',
          fashn_calls_limit = $4, fashn_calls_used = 0
      `, [shop_domain, email, plan, PLAN_LIMITS[plan]]);
    }

    console.log(`[ShopifyPayments] Registrato: ${email} → ${plan}`);
    res.json({ received: true });

  } catch (err) {
    console.error('[ShopifyPayments] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Rinnovo abbonamento ──────────────────────────────────
// POST /api/shopify-payments/renew
router.post('/renew', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!verifyHmac(req)) return res.status(401).json({ error: 'Firma non valida' });

  let data;
  try { data = JSON.parse(req.body.toString()); }
  catch { return res.status(400).json({ error: 'Payload non valido' }); }

  const email = data.email || data.customer?.email;
  if (!email) return res.json({ received: true });

  try {
    await db.query(`
      UPDATE shops SET fashn_calls_used = 0, status = 'active'
      WHERE email = $1
    `, [email]);
    console.log(`[ShopifyPayments] Rinnovo: ${email}`);
    res.json({ received: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Associa dominio a email ──────────────────────────────
// POST /api/shopify-payments/associate
// Body: { email, shop_domain }
router.post('/associate', async (req, res) => {
  const { email, shop_domain } = req.body;
  if (!email || !shop_domain) return res.status(400).json({ error: 'Parametri mancanti' });
  try {
    await db.query(`
      UPDATE shops SET shop_domain = $1 WHERE email = $2
    `, [shop_domain, email]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
