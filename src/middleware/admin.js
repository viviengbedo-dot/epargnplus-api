const { verifyToken } = require('../services/auth');

async function requireAdmin(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Token manquant.' });
    }
    const token = header.slice(7);
    const payload = verifyToken(token);
    if (payload.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Accès refusé.' });
    }
    req.admin = payload;
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Token invalide.' });
  }
}

module.exports = { requireAdmin };
