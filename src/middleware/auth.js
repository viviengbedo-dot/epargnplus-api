const { verifyToken } = require('../services/auth');
const { query } = require('../db');

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Token manquant.' });
    }

    const token = header.slice(7);
    const payload = verifyToken(token);

    // Check token exists in DB and is not expired
    const { rows } = await query(
      `SELECT at.*, u.id as uid, u.phone, u.name, u.kyc_status, u.kyc_tier, u.referral_code
       FROM auth_tokens at
       JOIN users u ON u.id = at.user_id
       WHERE at.token = $1 AND at.expires_at > NOW()`,
      [token]
    );

    if (!rows.length) {
      return res.status(401).json({ success: false, message: 'Session expirée. Reconnectez-vous.' });
    }

    req.user = rows[0];
    req.token = token;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Token invalide.' });
  }
}

module.exports = { requireAuth };
