const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const db      = require('../db');

const PADDLE_API  = 'https://api.paddle.com';
const PADDLE_KEY  = process.env.PADDLE_API_KEY;

const PRICE_IDS = {
  basic:   process.env.PADDLE_PRICE_BASIC,
  pro:     process.env.PADDLE_PRICE_PRO,
  premium: process.env.PADDLE_PRICE_PREMIUM,
};

const PLAN_LIMITS = { basic: 80, pro: 250, premium: 840 };

const headers = () => ({
  'Authorization': `Bearer ${PADDLE_KEY}`,
  'Content-Type':  'application/json',
});

// ── Crea checkout Paddle ─────────────────────────────────
// POST /api/paddle/checkout
// Body: { shop_domain, plan, email }
router.post('/checkout', async (req, res) => {
  const { shop_domain, plan, email } = req.body;
  if (!shop_domain || !plan || !email) return res.status(400).json({ error: 'Parametri mancanti' });
  if (!PRICE_IDS[plan]) return res.status(400).json({ error: 'Piano non valido' });

  try {
    const body = {
      items: [{ price_id: PRICE_IDS[plan], quantity: 1 }],
      customer: { email },
      custom_data: { shop_domain, plan },
      success_url: `${process.env.APP_URL}/success.html?domain=${shop_domain}`,
    };

    const paddleRes = await fetch(`${PADDLE_API}/transactions`, {
      method:  'POST',
      headers: headers(),
      body:    JSON.stringify(body),
    });

    const data = await paddleRes.json();
    if (!paddleRes.ok) throw new Error(data.error?.detail || 'Errore Paddle');

    const checkoutUrl = data.data?.checkout?.url || data.data?.url;
    res.json({ url: checkoutUrl });

  } catch (err) {
    console.error('[Paddle] checkout:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Webhook Paddle ───────────────────────────────────────
// POST /api/paddle/webhook
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['paddle-signature'];
  const secret    = process.env.PADDLE_WEBHOOK_SECRET;

  // Verifica firma
  if (secret && signature) {
    try {
      const parts    = signature.split(';').reduce((acc, p) => { const [k,v] = p.split('='); acc[k]=v; return acc; }, {});
      const ts       = parts.ts;
      const h1       = parts.h1;
      const signed   = `${ts}:${req.body.toString()}`;
      const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
      if (expected !== h1) return res.status(401).json({ error: 'Firma non valida' });
    } catch (e) {
      return res.status(401).json({ error: 'Errore verifica firma' });
    }
  }

  let event;
  try { event = JSON.parse(req.body.toString()); }
  catch { return res.status(400).json({ error: 'Payload non valido' }); }

  const type = event.event_type;
  const data = event.data;

  console.log(`[Paddle] Webhook: ${type}`);

  try {
    switch (type) {

      case 'subscription.created': {
        const custom     = data.custom_data || {};
        const shop_domain = custom.shop_domain;
        const plan        = custom.plan;
        const sub_id      = data.id;
        const email       = data.customer?.email;
        const renews_at   = data.next_billed_at?.split('T')[0];

        if (shop_domain && plan) {
          await db.query(`
            INSERT INTO shops (shop_domain, email, plan, status, fashn_calls_limit, ls_subscription_id, next_payment_date)
            VALUES ($1, $2, $3, 'pending', $4, $5, $6)
            ON CONFLICT (shop_domain) DO UPDATE SET
              plan = $3, status = 'pending',
              fashn_calls_limit = $4,
              fashn_calls_used = 0,
              ls_subscription_id = $5,
              next_payment_date = $6
          `, [shop_domain, email, plan, PLAN_LIMITS[plan], sub_id, renews_at]);
          console.log(`[Paddle] Nuovo abbonamento: ${shop_domain} → ${plan}`);
        }
        break;
      }

      case 'subscription.activated': {
        const custom      = data.custom_data || {};
        const shop_domain = custom.shop_domain;
        const sub_id      = data.id;
        if (shop_domain) {
          await db.query(`UPDATE shops SET status='active', approved_at=NOW() WHERE ls_subscription_id=$1 OR shop_domain=$2`,
            [sub_id, shop_domain]);
          console.log(`[Paddle] Attivato: ${shop_domain}`);
        }
        break;
      }

      case 'transaction.completed': {
        // Rinnovo mensile — resetta crediti
        const sub_id    = data.subscription_id;
        const renews_at = data.billing_period?.ends_at?.split('T')[0];
        if (sub_id) {
          await db.query(`
            UPDATE shops SET fashn_calls_used=0, status='active', next_payment_date=$1
            WHERE ls_subscription_id=$2
          `, [renews_at, sub_id]);
          console.log(`[Paddle] Rinnovo OK: ${sub_id}`);
        }
        break;
      }

      case 'subscription.canceled': {
        const sub_id = data.id;
        await db.query(`
          UPDATE shops SET status='cancelled', plan='none', fashn_calls_limit=0
          WHERE ls_subscription_id=$1
        `, [sub_id]);
        console.log(`[Paddle] Cancellato: ${sub_id}`);
        break;
      }

      case 'subscription.past_due': {
        const sub_id = data.id;
        await db.query(`UPDATE shops SET status='blocked' WHERE ls_subscription_id=$1`, [sub_id]);
        console.log(`[Paddle] Scaduto: ${sub_id}`);
        break;
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[Paddle] Handler error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Portale cliente Paddle ───────────────────────────────
// GET /api/paddle/portal?domain=xxx
router.get('/portal', async (req, res) => {
  const { domain } = req.query;
  try {
    const shop = await db.query('SELECT ls_subscription_id FROM shops WHERE shop_domain=$1', [domain]);
    if (!shop.rows[0]?.ls_subscription_id) return res.status(404).json({ error: 'Abbonamento non trovato' });

    const sub_id  = shop.rows[0].ls_subscription_id;
    const paddleRes = await fetch(`${PADDLE_API}/subscriptions/${sub_id}/update-payment-method-transaction`, {
      method:  'POST',
      headers: headers(),
      body:    '{}',
    });
    const data = await paddleRes.json();
    const url  = data.data?.checkout?.url;
    if (!url) return res.status(404).json({ error: 'Portale non disponibile' });
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
