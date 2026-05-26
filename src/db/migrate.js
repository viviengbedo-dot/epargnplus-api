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

-- Indexes
CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_token ON auth_tokens(token);
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
