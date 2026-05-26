const router = require('express').Router();
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

// ─── Profile ──────────────────────────────────────────────────────────────────

// GET /user/profile
router.get('/profile', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.phone, u.name, u.kyc_status, u.kyc_tier, u.referral_code, u.created_at,
              u.birth_date, u.city, u.profession, u.monthly_income,
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
        birthDate: u.birth_date ? new Date(u.birth_date).toISOString().split('T')[0] : null,
        city: u.city || '',
        profession: u.profession || '',
        monthlyIncome: u.monthly_income ? parseFloat(u.monthly_income) : null,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /user/profile
router.patch('/profile', requireAuth, async (req, res) => {
  try {
    const { name, birthDate, city, profession, monthlyIncome } = req.body;

    const updates = [];
    const params = [];

    if (name !== undefined)         { params.push(name.trim());         updates.push(`name = $${params.length}`); }
    if (birthDate !== undefined)    { params.push(birthDate || null);   updates.push(`birth_date = $${params.length}`); }
    if (city !== undefined)         { params.push(city.trim());         updates.push(`city = $${params.length}`); }
    if (profession !== undefined)   { params.push(profession.trim());   updates.push(`profession = $${params.length}`); }
    if (monthlyIncome !== undefined){ params.push(monthlyIncome || null);updates.push(`monthly_income = $${params.length}`); }

    if (!updates.length) return res.status(400).json({ success: false, message: 'Rien à mettre à jour.' });

    params.push(req.user.uid);
    await query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${params.length}`, params);

    res.json({ success: true, message: 'Profil mis à jour.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── KYC ─────────────────────────────────────────────────────────────────────

// GET /user/kyc
router.get('/kyc', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, type, verified, uploaded_at FROM kyc_documents WHERE user_id = $1`,
      [req.user.uid]
    );
    res.json({
      success: true,
      data: rows.map((d) => ({
        id: d.id,
        type: d.type,
        verified: d.verified,
        uploadedAt: new Date(d.uploaded_at).toLocaleDateString('fr-FR'),
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /user/kyc  — submit a document (base64 data URL)
const MAX_BASE64 = 2 * 1024 * 1024; // 2 MB limit

router.post('/kyc', requireAuth, async (req, res) => {
  try {
    const { type, fileData } = req.body;
    const validTypes = ['id_card', 'selfie', 'proof_address'];

    if (!type || !validTypes.includes(type)) {
      return res.status(400).json({ success: false, message: 'Type de document invalide.' });
    }
    if (!fileData || !fileData.startsWith('data:image/')) {
      return res.status(400).json({ success: false, message: 'Image requise (data URL).' });
    }
    if (fileData.length > MAX_BASE64) {
      return res.status(413).json({ success: false, message: 'Image trop grande. Max 1.5 Mo.' });
    }

    // Upsert doc — replace if same type already uploaded
    await query(
      `INSERT INTO kyc_documents (user_id, type, file_url, verified, uploaded_at)
       VALUES ($1, $2, $3, false, NOW())
       ON CONFLICT (user_id, type) DO UPDATE
         SET file_url = EXCLUDED.file_url, verified = false, uploaded_at = NOW()`,
      [req.user.uid, type, fileData]
    );

    // Auto-set kyc_status → pending when id_card + selfie both uploaded
    const { rows } = await query(
      `SELECT type FROM kyc_documents WHERE user_id = $1`,
      [req.user.uid]
    );
    const types = rows.map((r) => r.type);
    if (types.includes('id_card') && types.includes('selfie')) {
      await query(
        `UPDATE users SET kyc_status = 'pending' WHERE id = $1 AND kyc_status = 'none'`,
        [req.user.uid]
      );
    }

    res.json({ success: true, message: 'Document soumis.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PIN ──────────────────────────────────────────────────────────────────────

// PATCH /user/change-pin  (accepts pre-hashed SHA-256 hex — same as iOS app)
router.patch('/change-pin', requireAuth, async (req, res) => {
  try {
    const { pinHash } = req.body;
    if (!pinHash || !/^[0-9a-f]{64}$/.test(pinHash)) {
      return res.status(400).json({ success: false, message: 'Hash PIN invalide (SHA-256 hex attendu).' });
    }
    await query('UPDATE users SET pin_hash = $1 WHERE id = $2', [pinHash, req.user.uid]);
    res.json({ success: true, message: 'Code PIN mis à jour.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── AI Savings Advisor ───────────────────────────────────────────────────────

function feasibility(monthlyDeposit, monthlyIncome) {
  if (!monthlyIncome || monthlyIncome <= 0) return { label: null, color: 'gray', pct: null };
  const pct = Math.round((monthlyDeposit / monthlyIncome) * 100);
  const label =
    pct < 10 ? 'Très accessible' :
    pct < 20 ? 'Accessible' :
    pct < 35 ? 'Ambitieux' :
    pct < 50 ? 'Difficile' : 'Très difficile';
  const color =
    pct < 10 ? 'green' :
    pct < 20 ? 'lime' :
    pct < 35 ? 'yellow' :
    pct < 50 ? 'orange' : 'red';
  return { label, color, pct };
}

// GET /user/ai-advice?projectId=...
router.get('/ai-advice', requireAuth, async (req, res) => {
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ success: false, message: 'projectId requis.' });

    const [pResult, uResult] = await Promise.all([
      query(
        `SELECT id, name, goal_amount, current_amount, deadline
         FROM projects WHERE id = $1 AND user_id = $2`,
        [projectId, req.user.uid]
      ),
      query(`SELECT monthly_income FROM users WHERE id = $1`, [req.user.uid]),
    ]);

    if (!pResult.rows.length) {
      return res.status(404).json({ success: false, message: 'Projet introuvable.' });
    }

    const p = pResult.rows[0];
    const monthlyIncome = uResult.rows[0]?.monthly_income
      ? parseFloat(uResult.rows[0].monthly_income) : null;

    const goalAmount    = parseFloat(p.goal_amount);
    const currentAmount = parseFloat(p.current_amount);
    const remaining     = Math.max(0, goalAmount - currentAmount);

    if (remaining === 0) {
      return res.json({ success: true, data: { completed: true, projectName: p.name } });
    }

    // With deadline
    if (p.deadline) {
      const today = new Date();
      const dl = new Date(p.deadline);
      const msLeft = dl - today;
      const daysLeft = Math.max(0, Math.floor(msLeft / 86400000));
      const weeksLeft = Math.max(1, Math.ceil(daysLeft / 7));
      const monthsLeft = Math.max(1, Math.ceil(daysLeft / 30));

      const monthlyDeposit = Math.ceil(remaining / monthsLeft);
      const weeklyDeposit  = Math.ceil(remaining / weeksLeft);
      const dailyDeposit   = Math.ceil(remaining / Math.max(1, daysLeft));
      const f = feasibility(monthlyDeposit, monthlyIncome);

      const isOnTrack = (() => {
        if (!daysLeft) return false;
        // simple heuristic: elapsed portion vs saved portion
        const totalDays = Math.ceil((dl - new Date(p.created_at || today)) / 86400000);
        if (totalDays <= 0) return true;
        const elapsedPct = 1 - daysLeft / totalDays;
        const savedPct = goalAmount > 0 ? currentAmount / goalAmount : 0;
        return savedPct >= elapsedPct - 0.05; // 5% tolerance
      })();

      return res.json({
        success: true,
        data: {
          completed: false,
          hasDeadline: true,
          projectName: p.name,
          remaining,
          goalAmount,
          currentAmount,
          daysLeft,
          monthsLeft,
          monthlyDeposit,
          weeklyDeposit,
          dailyDeposit,
          deadline: dl.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }),
          affordabilityPct: f.pct,
          feasibilityLabel: f.label,
          feasibilityColor: f.color,
          isOnTrack,
          needsIncome: !monthlyIncome,
        },
      });
    }

    // No deadline: 3 scenarios
    const scenarios = [3, 6, 12].map((months) => {
      const monthly = Math.ceil(remaining / months);
      const weekly  = Math.ceil(monthly / 4);
      const f = feasibility(monthly, monthlyIncome);
      return {
        months,
        monthlyDeposit: monthly,
        weeklyDeposit: weekly,
        affordabilityPct: f.pct,
        feasibilityLabel: f.label,
        feasibilityColor: f.color,
      };
    });

    return res.json({
      success: true,
      data: {
        completed: false,
        hasDeadline: false,
        projectName: p.name,
        remaining,
        goalAmount,
        currentAmount,
        scenarios,
        needsIncome: !monthlyIncome,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
