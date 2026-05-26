const router = require('express').Router();
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

// GET /wallet/balance
router.get('/balance', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT balance FROM wallets WHERE user_id = $1',
      [req.user.uid]
    );

    const balance = rows.length ? parseFloat(rows[0].balance) : 0;
    res.json({ success: true, data: { balance } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
