-- TRYON APP — Schema Database (LemonSqueezy)

CREATE TABLE IF NOT EXISTS shops (
  id                    SERIAL PRIMARY KEY,
  shop_domain           VARCHAR(255) UNIQUE NOT NULL,
  shop_name             VARCHAR(255),
  email                 VARCHAR(255),
  plan                  VARCHAR(20)  DEFAULT 'none',
  status                VARCHAR(20)  DEFAULT 'pending',
  fashn_calls_used      INTEGER      DEFAULT 0,
  fashn_calls_limit     INTEGER      DEFAULT 0,
  ls_customer_id        VARCHAR(255),
  ls_subscription_id    VARCHAR(255),
  ls_subscription_status VARCHAR(50),
  next_payment_date     DATE,
  created_at            TIMESTAMP    DEFAULT NOW(),
  approved_at           TIMESTAMP,
  blocked_at            TIMESTAMP,
  notes                 TEXT
);

CREATE TABLE IF NOT EXISTS admins (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS usage_log (
  id         SERIAL PRIMARY KEY,
  shop_id    INTEGER REFERENCES shops(id),
  action     VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS plans (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(20) UNIQUE NOT NULL,
  price_eur    DECIMAL(10,2),
  fashn_limit  INTEGER,
  ls_variant_id VARCHAR(255),
  features     JSONB
);

INSERT INTO plans (name, price_eur, fashn_limit, features) VALUES
  ('basic',   30.00,  80,  '["Virtual Try-On AI","80 generazioni/mese","Supporto email"]'),
  ('pro',     85.00,  250, '["Virtual Try-On AI","250 generazioni/mese","Outfit Suggeriti","Supporto prioritario"]'),
  ('premium', 275.00, 840, '["Virtual Try-On AI","840 generazioni/mese","Outfit Suggeriti","Accesso API diretto","Supporto dedicato"]')
ON CONFLICT (name) DO NOTHING;
