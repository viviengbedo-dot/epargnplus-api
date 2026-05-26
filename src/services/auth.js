const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { query } = require('../db');

function generateToken(userId) {
  return jwt.sign(
    { sub: userId, iat: Math.floor(Date.now() / 1000) },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '30d' }
  );
}

function verifyToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

// SHA-256 PIN hash — matches iOS KeychainService.pinHash()
function hashPIN(pin) {
  return crypto.createHash('sha256').update(pin).digest('hex');
}

async function findOrCreateUser(phone) {
  const { rows } = await query(
    'SELECT * FROM users WHERE phone = $1',
    [phone]
  );

  if (rows.length) return { user: rows[0], isNew: false };

  // New user — create user + wallet + referral code
  const referralCode = crypto.randomBytes(4).toString('hex').toUpperCase();

  const { rows: newRows } = await query(
    `INSERT INTO users (phone, referral_code)
     VALUES ($1, $2)
     RETURNING *`,
    [phone, referralCode]
  );
  const user = newRows[0];

  await query(
    'INSERT INTO wallets (user_id) VALUES ($1)',
    [user.id]
  );

  return { user, isNew: true };
}

async function saveToken(userId, token) {
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
  await query(
    `INSERT INTO auth_tokens (user_id, token, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, token, expiresAt]
  );
}

async function updatePushToken(userId, pushToken) {
  if (!pushToken) return;
  await query(
    'UPDATE auth_tokens SET device_push_token = $1 WHERE user_id = $2',
    [pushToken, userId]
  );
}

async function savePINHash(userId, pinHash) {
  await query(
    'UPDATE users SET pin_hash = $1 WHERE id = $2',
    [pinHash, userId]
  );
}

module.exports = {
  generateToken,
  verifyToken,
  hashPIN,
  findOrCreateUser,
  saveToken,
  updatePushToken,
  savePINHash,
};
