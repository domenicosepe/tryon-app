const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const db      = require('../db');

const SECRET = process.env.SHOPIFY_PAYMENTS_SECRET;

const PLAN_MAP = {
  'basic':    { plan: 'basic',   limit: 80  },
  'pro':      { plan: 'pro',     limit: 250 },
  'business': { plan: 'premium', limit: 840 },
};

function detectPlan(variantTitle, productTitle) {
  const t = (variantTitle || productTitle || '').toLowerCase().trim();
  for (const [key, val] of Object.entries(PLAN_MAP)) {
    if (t.includes(key)) return val;
  }
  return null;
}

function verifyHmac(req) {
  if (!SECRET) return true;
  const hmac   = req.headers['x-shopify-hmac-sha256'];
  const digest = crypto.createHmac('sha256', SECRET).update(req.body).digest('base64');
  return hmac === digest;
}

// ── Pagamento completato → attiva subito ─────────────────
router.post('/paid', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!verifyHmac(req)) return res.status(401).json({ error: 'Firma non valida' });

  let order;
  try { order = JSON.parse(req.body.toString()); }
  catch { return res.status(400).json({ error: 'Payload non valido' }); }

  console.log(`[ShopifyPayments] Ordine: ${order.name}`);

  try {
    const email     = order.email || order.contact_email;
    const lineItems = order.line_items || [];
    const item      = lineItems[0];

    // Legge nome variante
    const variantTitle  = item?.variant_title || item?.title || '';
    const productTitle  = item?.name || '';
    const planData      = detectPlan(variantTitle, productTitle);

    if (!planData) {
      console.log('[ShopifyPayments] Piano non rilevato:', variantTitle, productTitle);
      return res.json({ received: true });
    }

    // Cerca dominio negli attributi ordine
    const attrs      = order.note_attributes || [];
    const domainAttr = attrs.find(a => ['shop_domain','dominio','domain'].includes(a.name));
    const shopDomain = domainAttr?.value || `pending_${order.id}`;

    const renews = new Date();
    renews.setMonth(renews.getMonth() + 1);
    const renewsAt = renews.toISOString().split('T')[0];

    await db.query(`
      INSERT INTO shops (shop_domain, email, plan, status, fashn_calls_limit, fashn_calls_used, next_payment_date)
      VALUES ($1, $2, $3, 'active', $4, 0, $5)
      ON CONFLICT (shop_domain) DO UPDATE SET
        email             = $2,
        plan              = $3,
        status            = 'active',
        fashn_calls_limit = $4,
        fashn_calls_used  = 0,
        next_payment_date = $5,
        approved_at       = NOW()
    `, [shopDomain, email, planData.plan, planData.limit, renewsAt]);

    console.log(`[ShopifyPayments] ✅ Attivato: ${email} → ${planData.plan} (${shopDomain})`);
    res.json({ received: true });

  } catch (err) {
    console.error('[ShopifyPayments] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Rinnovo mensile → resetta crediti ───────────────────
router.post('/renew', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!verifyHmac(req)) return res.status(401).json({ error: 'Firma non valida' });

  let data;
  try { data = JSON.parse(req.body.toString()); }
  catch { return res.status(400).json({ error: 'Payload non valido' }); }

  const email = data.email || data.customer?.email;
  if (!email) return res.json({ received: true });

  try {
    const renews = new Date();
    renews.setMonth(renews.getMonth() + 1);
    const renewsAt = renews.toISOString().split('T')[0];

    await db.query(`
      UPDATE shops SET
        fashn_calls_used  = 0,
        status            = 'active',
        next_payment_date = $1
      WHERE email = $2
    `, [renewsAt, email]);

    console.log(`[ShopifyPayments] 🔄 Rinnovo: ${email}`);
    res.json({ received: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Associa dominio Shopify a email ─────────────────────
router.post('/associate', async (req, res) => {
  const { email, shop_domain } = req.body;
  if (!email || !shop_domain) return res.status(400).json({ error: 'Parametri mancanti' });
  try {
    await db.query(`UPDATE shops SET shop_domain = $1 WHERE email = $2`, [shop_domain, email]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
