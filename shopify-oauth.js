const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const db = require('../db');

const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY_NEW;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET_NEW;
const APP_URL = process.env.APP_URL || 'https://tryon-app-production-867f.up.railway.app';
const SCOPES = 'write_script_tags,read_script_tags,write_themes,read_themes,read_products';

// Step 1: avvia OAuth
router.get('/install', (req, res) => {
  const { shop } = req.query;
  if (!shop || !shop.includes('.myshopify.com')) {
    return res.status(400).send('Parametro shop mancante o non valido');
  }
  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = `${APP_URL}/api/shopify/callback`;
  const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${SCOPES}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
  res.cookie('shopify_state', state, { httpOnly: true, secure: true });
  res.redirect(installUrl);
});

// Step 2: callback OAuth
router.get('/callback', async (req, res) => {
  const { shop, code, state, hmac } = req.query;

  // Verifica HMAC
  const queryParams = Object.keys(req.query)
    .filter(k => k !== 'hmac')
    .sort()
    .map(k => `${k}=${req.query[k]}`)
    .join('&');
  const digest = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(queryParams).digest('hex');
  if (digest !== hmac) {
    return res.status(403).send('HMAC non valido');
  }

  try {
    // Scambia code per access token
    const tokenRes = await axios.post(`https://${shop}/admin/oauth/access_token`, {
      client_id: SHOPIFY_API_KEY,
      client_secret: SHOPIFY_API_SECRET,
      code
    });
    const accessToken = tokenRes.data.access_token;

    // Salva shop nel DB
    await db.query(`
      INSERT INTO shops (shop_domain, access_token, status, plan, fashn_calls_used, fashn_calls_limit)
      VALUES ($1, $2, 'pending', 'none', 0, 0)
      ON CONFLICT (shop_domain) DO UPDATE SET access_token = $2, status = CASE WHEN shops.status = 'cancelled' THEN 'pending' ELSE shops.status END
    `, [shop, accessToken]);

    // Installa Script Tag automaticamente
    await installScriptTag(shop, accessToken);

    // Redirect all'app embedded dentro il pannello Shopify
    const redirectUrl = `https://${shop}/admin/apps/${SHOPIFY_API_KEY}`;
    res.redirect(redirectUrl);
  } catch (err) {
    console.error('Callback error:', err.message);
    res.status(500).send('Errore durante installazione');
  }
});

async function installScriptTag(shop, accessToken) {
  try {
    // Rimuovi vecchi script tag dell'app
    const existing = await axios.get(`https://${shop}/admin/api/2024-01/script_tags.json`, {
      headers: { 'X-Shopify-Access-Token': accessToken }
    });
    for (const tag of existing.data.script_tags || []) {
      if (tag.src && tag.src.includes('tryon-app-production')) {
        await axios.delete(`https://${shop}/admin/api/2024-01/script_tags/${tag.id}.json`, {
          headers: { 'X-Shopify-Access-Token': accessToken }
        });
      }
    }
    // Installa nuovo script tag
    await axios.post(`https://${shop}/admin/api/2024-01/script_tags.json`, {
      script_tag: {
        event: 'onload',
        src: `${APP_URL}/tryon-widget.js`
      }
    }, {
      headers: { 'X-Shopify-Access-Token': accessToken }
    });
    console.log(`Script tag installato su ${shop}`);
  } catch (err) {
    console.error('Errore installazione script tag:', err.message);
  }
}

module.exports = router;
