const router = require('express').Router();
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

// GET /user/profile
router.get('/profile', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.phone, u.name, u.kyc_status, u.kyc_tier, u.referral_code, u.created_at,
              w.balance
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       WHERE u.id = $1`,
      [req.user.uid]
    );

    if (!rows.length) return res.status(404).json({ success: false, message: 'Utilisateur introuvable.' });

    const u = rows[0];
    res.json({
      success: true,
      data: {
        id: u.id,
        phone: u.phone,
        name: u.name || '',
        balance: parseFloat(u.balance || 0),
        kycStatus: u.kyc_status,
        kycTier: u.kyc_tier,
        referralCode: u.referral_code,
        memberSince: new Date(u.created_at).toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' }),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /user/profile  (update name)
router.patch('/profile', requireAuth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Nom requis.' });

    await query('UPDATE users SET name = $1 WHERE id = $2', [name.trim(), req.user.uid]);
    res.json({ success: true, message: 'Profil mis à jour.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
