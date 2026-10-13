const express = require('express');
const router = express.Router();
const axios = require('axios');
const db = require('../db');

const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY_NEW;
const APP_URL = process.env.APP_URL || 'https://tryon-app-production-867f.up.railway.app';

const PLANS = {
  basic: {
    name: 'TryStyleAI Basic',
    price: 30.00,
    trialDays: 7,
    calls: 80,
    interval: 'EVERY_30_DAYS'
  },
  pro: {
    name: 'TryStyleAI Pro',
    price: 85.00,
    trialDays: 7,
    calls: 250,
    interval: 'EVERY_30_DAYS'
  },
  premium: {
    name: 'TryStyleAI Business',
    price: 275.00,
    trialDays: 7,
    calls: 840,
    interval: 'EVERY_30_DAYS'
  }
};

// Middleware verifica sessione shop
async function requireShop(req, res, next) {
  const shop = req.query.shop || req.body?.shop;
  if (!shop) return res.status(400).json({ error: 'Shop mancante' });
  const result = await db.query('SELECT * FROM shops WHERE shop_domain = $1', [shop]);
  if (!result.rows.length) return res.status(404).json({ error: 'Shop non trovato' });
  req.shopData = result.rows[0];
  next();
}

// Crea abbonamento Shopify Billing
router.get('/subscribe', requireShop, async (req, res) => {
  const { plan } = req.query;
  const planConfig = PLANS[plan];
  if (!planConfig) return res.status(400).json({ error: 'Piano non valido' });

  const shop = req.shopData.shop_domain;
  const accessToken = req.shopData.access_token;
  const returnUrl = `${APP_URL}/api/billing/confirm?shop=${shop}&plan=${plan}`;

  try {
    const mutation = `
      mutation {
        appSubscriptionCreate(
          name: "${planConfig.name}"
          returnUrl: "${returnUrl}"
          trialDays: ${planConfig.trialDays}
          test: false
          lineItems: [{
            plan: {
              appRecurringPricingDetails: {
                price: { amount: ${planConfig.price}, currencyCode: EUR }
                interval: ${planConfig.interval}
              }
            }
          }]
        ) {
          appSubscription { id status }
          confirmationUrl
          userErrors { field message }
        }
      }
    `;

    const response = await axios.post(
      `https://${shop}/admin/api/2024-01/graphql.json`,
      { query: mutation },
      { headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' } }
    );

    const data = response.data.data?.appSubscriptionCreate;
    if (data?.userErrors?.length) {
      return res.status(400).json({ error: data.userErrors[0].message });
    }

    // Salva subscription ID pending
    const subId = data.appSubscription.id;
    await db.query('UPDATE shops SET ls_subscription_id = $1 WHERE shop_domain = $2', [subId, shop]);

    // Redirect al checkout Shopify
    res.redirect(data.confirmationUrl);
  } catch (err) {
    console.error('Billing error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Errore creazione abbonamento' });
  }
});

// Conferma abbonamento dopo approvazione merchant
router.get('/confirm', requireShop, async (req, res) => {
  const { plan, charge_id } = req.query;
  const shop = req.shopData.shop_domain;
  const planConfig = PLANS[plan];

  if (!planConfig) return res.redirect(`https://${shop}/admin/apps/${SHOPIFY_API_KEY}`);

  try {
    // Verifica stato abbonamento tramite API
    const accessToken = req.shopData.access_token;
    const subId = req.shopData.ls_subscription_id;

    const query = `
      {
        node(id: "${subId}") {
          ... on AppSubscription {
            id
            status
            currentPeriodEnd
          }
        }
      }
    `;

    const response = await axios.post(
      `https://${shop}/admin/api/2024-01/graphql.json`,
      { query },
      { headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' } }
    );

    const subData = response.data.data?.node;
    if (subData?.status === 'ACTIVE') {
      const nextPayment = subData.currentPeriodEnd ? new Date(subData.currentPeriodEnd) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await db.query(`
        UPDATE shops SET
          plan = $1,
          status = 'active',
          fashn_calls_limit = $2,
          fashn_calls_used = 0,
          next_payment_date = $3
        WHERE shop_domain = $4
      `, [plan, planConfig.calls, nextPayment, shop]);
    }

    // Redirect all'app embedded
    res.redirect(`https://${shop}/admin/apps/${SHOPIFY_API_KEY}`);
  } catch (err) {
    console.error('Confirm error:', err.message);
    res.redirect(`https://${shop}/admin/apps/${SHOPIFY_API_KEY}`);
  }
});

// Webhook: aggiornamento abbonamento da Shopify
router.post('/webhook/subscription-update', express.raw({ type: 'application/json' }), async (req, res) => {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const body = req.body;
  const secret = process.env.SHOPIFY_BILLING_WEBHOOK_SECRET || process.env.SHOPIFY_API_SECRET_NEW;

  const hash = require('crypto').createHmac('sha256', secret).update(body).digest('base64');
  if (hash !== hmac) return res.status(401).send('HMAC non valido');

  const data = JSON.parse(body);
  const shop = req.get('X-Shopify-Shop-Domain');

  if (data.status === 'CANCELLED' || data.status === 'DECLINED') {
    await db.query("UPDATE shops SET status = 'cancelled', plan = 'none' WHERE shop_domain = $1", [shop]);
  }

  res.sendStatus(200);
});

// API: info piano corrente
router.get('/current', requireShop, async (req, res) => {
  const shop = req.shopData;
  const planConfig = PLANS[shop.plan] || null;
  res.json({
    shop: shop.shop_domain,
    plan: shop.plan,
    planName: planConfig?.name || 'Nessun piano',
    status: shop.status,
    callsUsed: shop.fashn_calls_used,
    callsLimit: shop.fashn_calls_limit,
    nextPayment: shop.next_payment_date,
    plans: Object.entries(PLANS).map(([key, p]) => ({
      key,
      name: p.name,
      price: p.price,
      calls: p.calls,
      trialDays: p.trialDays
    }))
  });
});

// API: cancella abbonamento
router.post('/cancel', requireShop, async (req, res) => {
  const shop = req.shopData;
  const accessToken = shop.access_token;
  const subId = shop.ls_subscription_id;

  if (!subId) return res.status(400).json({ error: 'Nessun abbonamento attivo' });

  try {
    const mutation = `
      mutation {
        appSubscriptionCancel(id: "${subId}") {
          appSubscription { id status }
          userErrors { field message }
        }
      }
    `;
    await axios.post(
      `https://${shop.shop_domain}/admin/api/2024-01/graphql.json`,
      { query: mutation },
      { headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' } }
    );
    await db.query("UPDATE shops SET status = 'cancelled', plan = 'none' WHERE shop_domain = $1", [shop.shop_domain]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Errore cancellazione' });
  }
});

module.exports = router;
module.exports.PLANS = PLANS;
