require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const path      = require('path');

const app = express();
app.set('trust proxy', 1);

app.use(cors({ origin: '*' }));
app.use('/api/ls/webhook',           express.raw({ type: 'application/json' }));
app.use('/api/paddle/webhook',       express.raw({ type: 'application/json' }));
app.use('/api/shopify-payments/paid',  express.raw({ type: 'application/json' }));
app.use('/api/shopify-payments/renew', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/shop',              require('./routes/shop'));
app.use('/api/admin',             require('./routes/admin'));
app.use('/api/tryon',             require('./routes/tryon'));
app.use('/api/ls',                require('./routes/lemonsqueezy'));
app.use('/api/paddle',            require('./routes/paddle'));
app.use('/api/shopify',           require('./routes/shopify'));
app.use('/api/shopify-payments',  require('./routes/shopify-payments'));

app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
