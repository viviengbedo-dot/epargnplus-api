const AfricasTalking = require('africastalking');
const crypto = require('crypto');
const { query } = require('../db');

// Lazy-init AfricasTalking (skips in demo mode)
let _at;
function getAT() {
  if (!_at) {
    _at = AfricasTalking({
      apiKey: process.env.AT_API_KEY,
      username: process.env.AT_USERNAME, // 'sandbox' in dev, your username in prod
    });
  }
  return _at;
}

function normalize(phone) {
  return phone.replace(/\D/g, '');
}

function hashCode(code) {
  return crypto.createHash('sha256').update(code + process.env.JWT_SECRET).digest('hex');
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Returns true if this is the demo phone — no SMS sent
function isDemo(phone) {
  return normalize(phone) === normalize(process.env.DEMO_PHONE || '224620000000');
}

async function sendOTP(phone) {
  const normalizedPhone = normalize(phone);

  if (isDemo(phone)) {
    // Store demo OTP in DB so verifyOTP works normally
    const code = process.env.DEMO_OTP || '123456';
    const expires = new Date(Date.now() + 10 * 60 * 1000);
    await query(
      `INSERT INTO otp_codes (phone, code_hash, expires_at, attempts)
       VALUES ($1, $2, $3, 0)
       ON CONFLICT (phone) DO UPDATE SET code_hash=$2, expires_at=$3, attempts=0`,
      [normalizedPhone, hashCode(code), expires]
    );
    console.log(`[SMS] Demo phone — OTP not sent (code: ${code})`);
    return { demo: true };
  }

  const code = generateCode();
  const expires = new Date(Date.now() + Number(process.env.OTP_TTL_MINUTES || 10) * 60 * 1000);

  // Upsert OTP (rate-limit: replace existing so old code expires)
  await query(
    `INSERT INTO otp_codes (phone, code_hash, expires_at, attempts)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT (phone) DO UPDATE SET code_hash=$2, expires_at=$3, attempts=0`,
    [normalizedPhone, hashCode(code), expires]
  );

  // Send via AfricasTalking
  const sms = getAT().SMS;
  await sms.send({
    to: [`+${normalizedPhone}`],
    message: `Votre code Epargn+ : ${code}. Valable ${process.env.OTP_TTL_MINUTES || 10} minutes. Ne le partagez jamais.`,
    from: process.env.AT_SENDER_ID || 'EpargnPlus',
  });

  console.log(`[SMS] OTP sent to +${normalizedPhone}`);
  return { sent: true };
}

async function verifyOTP(phone, code) {
  const normalizedPhone = normalize(phone);

  const { rows } = await query(
    'SELECT * FROM otp_codes WHERE phone = $1',
    [normalizedPhone]
  );

  if (!rows.length) {
    throw Object.assign(new Error('Code introuvable. Demandez un nouveau code.'), { status: 400 });
  }

  const row = rows[0];

  if (new Date(row.expires_at) < new Date()) {
    await query('DELETE FROM otp_codes WHERE phone = $1', [normalizedPhone]);
    throw Object.assign(new Error('Code expiré. Demandez un nouveau code.'), { status: 400 });
  }

  const maxAttempts = Number(process.env.OTP_MAX_ATTEMPTS || 5);
  if (row.attempts >= maxAttempts) {
    throw Object.assign(new Error('Trop de tentatives. Demandez un nouveau code.'), { status: 429 });
  }

  if (row.code_hash !== hashCode(code)) {
    await query(
      'UPDATE otp_codes SET attempts = attempts + 1 WHERE phone = $1',
      [normalizedPhone]
    );
    const remaining = maxAttempts - row.attempts - 1;
    throw Object.assign(
      new Error(`Code invalide. ${remaining} tentative(s) restante(s).`),
      { status: 400 }
    );
  }

  // Correct — delete OTP
  await query('DELETE FROM otp_codes WHERE phone = $1', [normalizedPhone]);
  return true;
}

module.exports = { sendOTP, verifyOTP, isDemo, normalize };
