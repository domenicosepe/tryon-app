const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const db      = require('../db');

const SHOPIFY_API_KEY    = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const APP_URL            = process.env.APP_URL;
const SCOPES             = 'write_themes,read_themes,write_script_tags,read_script_tags';

// ── STEP 1: Installa app (redirect a Shopify OAuth) ──────
// GET /api/shopify/install?shop=mio-negozio.myshopify.com
router.get('/install', (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send('Parametro shop mancante');

  const state    = crypto.randomBytes(16).toString('hex');
  const redirect = `${APP_URL}/api/shopify/callback`;

  const authUrl = `https://${shop}/admin/oauth/authorize?` +
    `client_id=${SHOPIFY_API_KEY}` +
    `&scope=${SCOPES}` +
    `&redirect_uri=${encodeURIComponent(redirect)}` +
    `&state=${state}`;

  // Salva state in cookie per verificarlo dopo
  res.cookie('shopify_state', state, { httpOnly: true, maxAge: 60000 });
  res.redirect(authUrl);
});

// ── STEP 2: Callback dopo autorizzazione Shopify ─────────
// GET /api/shopify/callback
router.get('/callback', async (req, res) => {
  const { shop, code, state, hmac } = req.query;

  // Verifica HMAC
  const params   = Object.keys(req.query)
    .filter(k => k !== 'hmac')
    .sort()
    .map(k => `${k}=${req.query[k]}`)
    .join('&');

  const digest = crypto
    .createHmac('sha256', SHOPIFY_API_SECRET)
    .update(params)
    .digest('hex');

  if (digest !== hmac) {
    return res.status(401).send('Firma non valida');
  }

  try {
    // Ottieni access token da Shopify
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:     SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        code,
      }),
    });

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) throw new Error('Token non ricevuto');

    // Salva il negozio nel DB
    await db.query(`
      INSERT INTO shops (shop_domain, status)
      VALUES ($1, 'pending')
      ON CONFLICT (shop_domain) DO UPDATE
        SET status = CASE WHEN shops.status = 'cancelled' THEN 'pending' ELSE shops.status END
    `, [shop]);

    // Installa Script Tag (carica automaticamente i JS nel tema)
    await installScriptTags(shop, accessToken);

    // Reindirizza alla pagina di scelta piano
    res.redirect(`${APP_URL}/install.html?domain=${shop}`);

  } catch (err) {
    console.error('[Shopify OAuth]', err);
    res.status(500).send('Errore durante l\'installazione: ' + err.message);
  }
});

// ── Installa Script Tags nel tema ────────────────────────
async function installScriptTags(shop, accessToken) {
  const scripts = [
    `${APP_URL}/shopify-assets/provalo-indossato.css`,
    `${APP_URL}/shopify-assets/provalo-indossato.js`,
    `${APP_URL}/shopify-assets/outfit-suggeriti.css`,
    `${APP_URL}/shopify-assets/outfit-suggeriti.js`,
  ];

  // Prima rimuovi eventuali script tag esistenti
  const existing = await fetch(`https://${shop}/admin/api/2024-01/script_tags.json`, {
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    },
  });
  const existingData = await existing.json();

  for (const tag of (existingData.script_tags || [])) {
    if (tag.src.includes(APP_URL)) {
      await fetch(`https://${shop}/admin/api/2024-01/script_tags/${tag.id}.json`, {
        method: 'DELETE',
        headers: { 'X-Shopify-Access-Token': accessToken },
      });
    }
  }

  // Installa i nuovi JS
  for (const src of scripts.filter(s => s.endsWith('.js'))) {
    await fetch(`https://${shop}/admin/api/2024-01/script_tags.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        script_tag: {
          event: 'onload',
          src,
        },
      }),
    });
  }

  console.log(`[Shopify] Script tags installati per ${shop}`);
}

// ── Link di installazione per un negozio specifico ───────
// GET /api/shopify/link?shop=mio-negozio.myshopify.com
router.get('/link', (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.json({ url: `${APP_URL}/api/shopify/install?shop=DOMINIO.myshopify.com` });
  res.json({ url: `${APP_URL}/api/shopify/install?shop=${shop}` });
});

module.exports = router;
