const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const db      = require('../db');

const LS_API  = 'https://api.lemonsqueezy.com/v1';
const HEADERS = {
  'Authorization': `Bearer ${process.env.LS_API_KEY}`,
  'Accept':        'application/vnd.api+json',
  'Content-Type':  'application/vnd.api+json',
};

const PLAN_VARIANTS = {
  basic:   process.env.LS_VARIANT_BASIC,
  pro:     process.env.LS_VARIANT_PRO,
  premium: process.env.LS_VARIANT_PREMIUM,
};

const PLAN_LIMITS = { basic: 80, pro: 250, premium: 840 };

// ── Crea checkout LemonSqueezy ───────────────────────────
// POST /api/ls/checkout
// Body: { shop_domain, plan }
router.post('/checkout', async (req, res) => {
  const { shop_domain, plan } = req.body;
  if (!shop_domain || !plan) return res.status(400).json({ error: 'Parametri mancanti' });
  if (!PLAN_VARIANTS[plan]) return res.status(400).json({ error: 'Piano non valido' });

  try {
    const shop = await db.query('SELECT * FROM shops WHERE shop_domain = $1', [shop_domain]);
    if (!shop.rows.length) return res.status(404).json({ error: 'Negozio non trovato' });
    const s = shop.rows[0];

    // Crea checkout su LemonSqueezy
    const body = {
      data: {
        type: 'checkouts',
        attributes: {
          checkout_data: {
            email:        s.email,
            custom:       { shop_domain, plan },
          },
          product_options: {
            redirect_url: `${process.env.APP_URL}/success.html?domain=${shop_domain}`,
          },
          expires_at: null,
        },
        relationships: {
          store: {
            data: { type: 'stores', id: process.env.LS_STORE_ID }
          },
          variant: {
            data: { type: 'variants', id: PLAN_VARIANTS[plan] }
          },
        },
      },
    };

    const lsRes  = await fetch(`${LS_API}/checkouts`, {
      method:  'POST',
      headers: HEADERS,
      body:    JSON.stringify(body),
    });

    const lsData = await lsRes.json();
    if (!lsRes.ok) {
      console.error('[LS] Checkout error:', lsData);
      throw new Error(lsData.errors?.[0]?.detail || 'Errore LemonSqueezy');
    }

    const checkoutUrl = lsData.data?.attributes?.url;
    res.json({ url: checkoutUrl });

  } catch (err) {
    console.error('[LS] /checkout:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Webhook LemonSqueezy ─────────────────────────────────
// POST /api/ls/webhook
router.post('/webhook', async (req, res) => {
  const secret    = process.env.LS_WEBHOOK_SECRET;
  const signature = req.headers['x-signature'];
  const payload   = req.body; // raw buffer

  // Verifica firma
  const hmac     = crypto.createHmac('sha256', secret);
  const digest   = Buffer.from(hmac.update(payload).digest('hex'), 'utf8');
  const sigBuf   = Buffer.from(signature || '', 'utf8');

  if (!crypto.timingSafeEqual(digest, sigBuf)) {
    console.error('[LS] Firma webhook non valida');
    return res.status(401).json({ error: 'Firma non valida' });
  }

  let event;
  try {
    event = JSON.parse(payload.toString());
  } catch {
    return res.status(400).json({ error: 'Payload non valido' });
  }

  const eventName = event.meta?.event_name;
  const data      = event.data?.attributes;
  const custom    = event.meta?.custom_data || data?.first_order_item?.custom || {};

  console.log(`[LS] Webhook: ${eventName}`);

  try {
    switch (eventName) {

      // ── Abbonamento creato (primo pagamento ok) ──
      case 'subscription_created': {
        const shop_domain = custom.shop_domain || data?.customer_email;
        const plan        = custom.plan;
        const sub_id      = String(event.data?.id);
        const customer_id = String(data?.customer_id);
        const renews_at   = data?.renews_at?.split('T')[0];

        if (shop_domain && plan) {
          await db.query(`
            UPDATE shops SET
              plan = $1,
              status = 'pending',
              ls_subscription_id = $2,
              ls_customer_id = $3,
              ls_subscription_status = 'active',
              fashn_calls_limit = $4,
              fashn_calls_used = 0,
              next_payment_date = $5
            WHERE shop_domain = $6
          `, [plan, sub_id, customer_id, PLAN_LIMITS[plan], renews_at, shop_domain]);
          console.log(`[LS] Nuovo abbonamento: ${shop_domain} → ${plan}`);
        }
        break;
      }

      // ── Pagamento rinnovo riuscito ──
      case 'subscription_payment_success': {
        const sub_id    = String(event.data?.attributes?.subscription_id || '');
        const renews_at = data?.next_payment_date?.split('T')[0];

        if (sub_id) {
          await db.query(`
            UPDATE shops SET
              fashn_calls_used = 0,
              status = 'active',
              next_payment_date = $1,
              ls_subscription_status = 'active'
            WHERE ls_subscription_id = $2
          `, [renews_at, sub_id]);
          console.log(`[LS] Rinnovo OK: subscription ${sub_id}`);
        }
        break;
      }

      // ── Abbonamento aggiornato (es. upgrade piano) ──
      case 'subscription_updated': {
        const sub_id = String(event.data?.id);
        const status = data?.status;
        const renews_at = data?.renews_at?.split('T')[0];

        if (sub_id) {
          await db.query(`
            UPDATE shops SET
              ls_subscription_status = $1,
              next_payment_date = $2,
              status = CASE
                WHEN $1 = 'active' THEN 'active'
                WHEN $1 IN ('paused','past_due') THEN 'blocked'
                WHEN $1 = 'cancelled' THEN 'cancelled'
                ELSE status
              END
            WHERE ls_subscription_id = $3
          `, [status, renews_at, sub_id]);
        }
        break;
      }

      // ── Abbonamento cancellato ──
      case 'subscription_cancelled': {
        const sub_id = String(event.data?.id);
        await db.query(`
          UPDATE shops SET
            status = 'cancelled',
            plan = 'none',
            fashn_calls_limit = 0,
            ls_subscription_status = 'cancelled'
          WHERE ls_subscription_id = $1
        `, [sub_id]);
        console.log(`[LS] Cancellato: ${sub_id}`);
        break;
      }

      // ── Pagamento fallito ──
      case 'subscription_payment_failed': {
        const sub_id = String(event.data?.attributes?.subscription_id || '');
        if (sub_id) {
          await db.query(`
            UPDATE shops SET status = 'blocked', ls_subscription_status = 'past_due'
            WHERE ls_subscription_id = $1
          `, [sub_id]);
          console.log(`[LS] Pagamento fallito: ${sub_id}`);
        }
        break;
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[LS] Webhook handler error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Portale cliente (gestione abbonamento) ───────────────
// GET /api/ls/portal?domain=xxx
router.get('/portal', async (req, res) => {
  const { domain } = req.query;
  try {
    const shop = await db.query('SELECT ls_customer_id FROM shops WHERE shop_domain = $1', [domain]);
    if (!shop.rows[0]?.ls_customer_id) return res.status(404).json({ error: 'Cliente non trovato' });

    const customerId = shop.rows[0].ls_customer_id;
    const lsRes = await fetch(`${LS_API}/customers/${customerId}`, { headers: HEADERS });
    const data  = await lsRes.json();
    const portalUrl = data.data?.attributes?.urls?.customer_portal;

    if (!portalUrl) return res.status(404).json({ error: 'Portale non disponibile' });
    res.json({ url: portalUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
