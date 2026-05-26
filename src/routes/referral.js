const router = require('express').Router();
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

// GET /referral
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows: userRows } = await query(
      'SELECT referral_code FROM users WHERE id = $1',
      [req.user.uid]
    );

    const { rows: refRows } = await query(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN bonus_paid THEN 1 ELSE 0 END) as paid
       FROM referrals
       WHERE referrer_id = $1`,
      [req.user.uid]
    );

    const total = parseInt(refRows[0]?.total || 0);
    const bonusPerReferral = 5000; // 5 000 GNF per referral

    res.json({
      success: true,
      data: {
        code: userRows[0]?.referral_code || '',
        referralLink: `https://epargnplus.com/join/${userRows[0]?.referral_code || ''}`,
        referralCount: total,
        totalEarnings: total * bonusPerReferral,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
