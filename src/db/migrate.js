require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { pool } = require('./index');

const schema = `
-- Users
CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       VARCHAR(20) UNIQUE NOT NULL,
  name        VARCHAR(100),
  pin_hash    VARCHAR(64),
  kyc_status  VARCHAR(20) DEFAULT 'none' CHECK (kyc_status IN ('none','pending','verified')),
  kyc_tier    SMALLINT DEFAULT 1,
  referral_code VARCHAR(10) UNIQUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Auth tokens
CREATE TABLE IF NOT EXISTS auth_tokens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  token           VARCHAR(512) UNIQUE NOT NULL,
  device_push_token TEXT,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- OTP codes (one active per phone)
CREATE TABLE IF NOT EXISTS otp_codes (
  phone       VARCHAR(20) PRIMARY KEY,
  code_hash   VARCHAR(64) NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    SMALLINT DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Wallets (one per user)
CREATE TABLE IF NOT EXISTS wallets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  balance     NUMERIC(15,2) DEFAULT 0 CHECK (balance >= 0),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Projects (savings goals)
CREATE TABLE IF NOT EXISTS projects (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID REFERENCES users(id) ON DELETE CASCADE,
  name           VARCHAR(100) NOT NULL,
  icon           VARCHAR(50) DEFAULT 'target',
  goal_amount    NUMERIC(15,2) NOT NULL CHECK (goal_amount > 0),
  current_amount NUMERIC(15,2) DEFAULT 0,
  status         VARCHAR(20) DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','COMPLETED','PAUSED')),
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Transactions
CREATE TABLE IF NOT EXISTS transactions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  type         VARCHAR(20) NOT NULL CHECK (type IN ('deposit','withdrawal','transfer','bonus')),
  amount       NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  operator     VARCHAR(30),
  phone        VARCHAR(20),
  project_id   UUID REFERENCES projects(id) ON DELETE SET NULL,
  status       VARCHAR(20) DEFAULT 'success' CHECK (status IN ('pending','success','failed')),
  reference    VARCHAR(50) UNIQUE DEFAULT 'ref-' || substr(gen_random_uuid()::text, 1, 8),
  label        VARCHAR(100),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Notifications
CREATE TABLE IF NOT EXISTS notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  title      VARCHAR(100) NOT NULL,
  body       TEXT,
  read       BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- KYC documents
CREATE TABLE IF NOT EXISTS kyc_documents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  type        VARCHAR(30) CHECK (type IN ('id_card','selfie','proof_address')),
  file_url    TEXT,
  verified    BOOLEAN DEFAULT FALSE,
  uploaded_at TIMESTAMPTZ DEFAULT NOW()
);

-- Referrals
CREATE TABLE IF NOT EXISTS referrals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id UUID REFERENCES users(id) ON DELETE CASCADE,
  referred_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  bonus_paid  BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Admin: is_blocked column (added after initial schema)
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN DEFAULT FALSE;

-- Personal info (v2)
ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_date DATE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS city VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS profession VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_income NUMERIC(12,2);

-- Project deadline (v2)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS deadline DATE;

-- KYC unique constraint (v2)
CREATE UNIQUE INDEX IF NOT EXISTS idx_kyc_user_type ON kyc_documents(user_id, type);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_token ON auth_tokens(token);

-- ── Pilot v6 : Support tickets ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS support_tickets (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject      VARCHAR(200) NOT NULL,
  message      TEXT         NOT NULL,
  status       VARCHAR(20)  NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open','in_progress','resolved','closed')),
  priority     VARCHAR(10)  NOT NULL DEFAULT 'normal'
                            CHECK (priority IN ('low','normal','high','urgent')),
  category     VARCHAR(50)  NOT NULL DEFAULT 'general',
  admin_reply  TEXT,
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ticket_replies (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id  UUID        NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_id  UUID        REFERENCES users(id) ON DELETE SET NULL,
  message    TEXT        NOT NULL,
  is_admin   BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Pilot v6 : Promo codes ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS promo_codes (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  code           VARCHAR(50)   UNIQUE NOT NULL,
  description    TEXT,
  type           VARCHAR(20)   NOT NULL CHECK (type IN ('bonus_deposit','fee_free','cashback')),
  value          NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency       VARCHAR(10)   NOT NULL DEFAULT 'GNF',
  max_uses       INTEGER       DEFAULT NULL,
  uses_count     INTEGER       NOT NULL DEFAULT 0,
  target_country VARCHAR(5)    DEFAULT NULL,
  active         BOOLEAN       NOT NULL DEFAULT TRUE,
  expires_at     TIMESTAMPTZ   DEFAULT NULL,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS promo_uses (
  id         UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_id   UUID          NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
  user_id    UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
  used_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (promo_id, user_id)
);

-- ── Pilot v6 : Broadcasts ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS broadcasts (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  title        VARCHAR(200) NOT NULL,
  message      TEXT         NOT NULL,
  target       VARCHAR(20)  NOT NULL DEFAULT 'all',
  sent_count   INTEGER      NOT NULL DEFAULT 0,
  created_by   VARCHAR(100) NOT NULL DEFAULT 'admin',
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Pilot v6 : Indexes ───────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_support_tickets_user    ON support_tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status  ON support_tickets(status);
CREATE INDEX IF NOT EXISTS idx_ticket_replies_ticket   ON ticket_replies(ticket_id);
CREATE INDEX IF NOT EXISTS idx_promo_uses_user         ON promo_uses(user_id);
CREATE INDEX IF NOT EXISTS idx_promo_uses_promo        ON promo_uses(promo_id);

-- ── Pilot v6 : Promo de lancement ───────────────────────────────────────────

INSERT INTO promo_codes (code, description, type, value, currency, max_uses)
SELECT 'PILOTE2026', 'Bonus lancement pilote iOS', 'bonus_deposit', 5000, 'GNF', 50
WHERE NOT EXISTS (SELECT 1 FROM promo_codes WHERE code = 'PILOTE2026');
`;

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(schema);
    console.log('✅ Migration complete');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
