const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const db      = require('../db');

const SHOPIFY_API_KEY    = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const APP_URL            = process.env.APP_URL;
const SCOPES             = 'write_themes,read_themes,write_script_tags,read_script_tags';

// Stato temporaneo in memoria (funziona per singolo server)
const stateStore = new Map();

// STEP 1: Redirect a Shopify OAuth
router.get('/install', (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send('Parametro shop mancante');

  const state    = crypto.randomBytes(16).toString('hex');
  const redirect = `${APP_URL}/api/shopify/callback`;

  // Salva state in memoria con scadenza 5 minuti
  stateStore.set(state, { shop, ts: Date.now() });
  setTimeout(() => stateStore.delete(state), 300000);

  const authUrl = `https://${shop}/admin/oauth/authorize?` +
    `client_id=${SHOPIFY_API_KEY}` +
    `&scope=${SCOPES}` +
    `&redirect_uri=${encodeURIComponent(redirect)}` +
    `&state=${state}`;

  res.redirect(authUrl);
});

// STEP 2: Callback dopo autorizzazione
router.get('/callback', async (req, res) => {
  const { shop, code, state, hmac } = req.query;

  // Verifica HMAC
  const params = Object.keys(req.query)
    .filter(k => k !== 'hmac')
    .sort()
    .map(k => `${k}=${req.query[k]}`)
    .join('&');

  const digest = crypto
    .createHmac('sha256', SHOPIFY_API_SECRET)
    .update(params)
    .digest('hex');

  if (digest !== hmac) {
    return res.status(401).send('Firma HMAC non valida');
  }

  try {
    // Ottieni access token
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
    if (!accessToken) throw new Error('Access token non ricevuto da Shopify');

    // Salva shop nel DB
    await db.query(`
      INSERT INTO shops (shop_domain, status)
      VALUES ($1, 'pending')
      ON CONFLICT (shop_domain) DO UPDATE
        SET status = CASE WHEN shops.status = 'cancelled' THEN 'pending' ELSE shops.status END
    `, [shop]);

    // Installa Script Tags
    await installScriptTags(shop, accessToken);

    console.log(`[Shopify] ✅ Installato: ${shop}`);

    // Redirect alla pagina piani
    res.redirect(`${APP_URL}/install.html?domain=${shop}`);

  } catch (err) {
    console.error('[Shopify callback] ERRORE COMPLETO:', JSON.stringify(err), err.message, err.stack);
    res.status(500).send(`Errore installazione: ${err.message}`);
  }
});

// Installa Script Tags automaticamente nel tema
async function installScriptTags(shop, accessToken) {
  const headers = {
    'X-Shopify-Access-Token': accessToken,
    'Content-Type': 'application/json',
  };
  const base = `https://${shop}/admin/api/2024-01`;

  // Rimuovi tag esistenti del nostro app
  const existing = await fetch(`${base}/script_tags.json`, { headers });
  const existingData = await existing.json();
  for (const tag of (existingData.script_tags || [])) {
    if (tag.src && tag.src.includes('tryon-app')) {
      await fetch(`${base}/script_tags/${tag.id}.json`, { method: 'DELETE', headers });
    }
  }

  // Installa CSS come script tag (workaround)
  const jsFiles = [
    `${APP_URL}/shopify-assets/provalo-indossato.js`,
    `${APP_URL}/shopify-assets/outfit-suggeriti.js`,
  ];

  for (const src of jsFiles) {
    await fetch(`${base}/script_tags.json`, {
      method:  'POST',
      headers,
      body: JSON.stringify({ script_tag: { event: 'onload', src } }),
    });
  }
}

module.exports = router;
