const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { sendOTP, verifyOTP, normalize } = require('../services/sms');
const {
  generateToken, findOrCreateUser, saveToken, savePINHash,
} = require('../services/auth');
const { requireAuth } = require('../middleware/auth');

// Rate limit: 5 OTP requests per phone per 10 minutes
const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => normalize(req.body.phone || ''),
  message: { success: false, message: 'Trop de demandes. Réessayez dans 10 minutes.' },
});

// POST /auth/send-otp
router.post('/send-otp', otpLimiter, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'Numéro requis.' });

    await sendOTP(phone);
    res.json({ success: true, message: 'Code envoyé.' });
  } catch (err) {
    console.error('[send-otp]', err.message);
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// POST /auth/resend-otp
router.post('/resend-otp', otpLimiter, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'Numéro requis.' });

    await sendOTP(phone);
    res.json({ success: true, message: 'Code renvoyé.' });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// POST /auth/verify-otp
router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, otp } = req.body;
    if (!phone || !otp) {
      return res.status(400).json({ success: false, message: 'Numéro et code requis.' });
    }

    await verifyOTP(phone, otp);

    const { user, isNew } = await findOrCreateUser(normalize(phone));
    const token = generateToken(user.id);
    await saveToken(user.id, token);

    res.json({
      success: true,
      data: {
        token,
        userId: user.id,
        name: user.name || '',
        isNewUser: isNew,
      },
    });
  } catch (err) {
    console.error('[verify-otp]', err.message);
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// POST /auth/setup-pin  (requires auth)
router.post('/setup-pin', requireAuth, async (req, res) => {
  try {
    const { pinHash } = req.body;
    if (!pinHash) return res.status(400).json({ success: false, message: 'PIN requis.' });

    await savePINHash(req.user.uid, pinHash);
    res.json({ success: true, message: 'PIN enregistré.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
