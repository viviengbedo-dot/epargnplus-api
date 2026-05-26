const router = require('express').Router();
const { query, pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const crypto = require('crypto');

// GET /transactions?type=deposit|withdrawal|bonus
router.get('/', requireAuth, async (req, res) => {
  try {
    const { type } = req.query;
    const params = [req.user.uid];
    let where = 'WHERE t.user_id = $1';

    if (type) {
      params.push(type.toLowerCase());
      where += ` AND t.type = $${params.length}`;
    }

    const { rows } = await query(
      `SELECT t.id, t.type, t.amount, t.operator, t.phone,
              t.project_id, t.status, t.reference, t.label, t.created_at,
              p.name as project_name
       FROM transactions t
       LEFT JOIN projects p ON p.id = t.project_id
       ${where}
       ORDER BY t.created_at DESC
       LIMIT 100`,
      params
    );

    const transactions = rows.map((t) => ({
      id: t.id,
      type: t.type,
      amount: parseFloat(t.amount),
      operator: t.operator,
      phone: t.phone,
      projectId: t.project_id,
      projectName: t.project_name,
      status: t.status,
      reference: t.reference,
      label: t.label || labelFor(t),
      date: t.created_at,
    }));

    res.json({ success: true, data: transactions });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /transactions/deposit — creates PENDING, returns merchant number + instructions
router.post('/deposit', requireAuth, async (req, res) => {
  try {
    const { amount, mobileOperator, phone, projectId } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Montant invalide.' });
    }
    if (!mobileOperator || !phone) {
      return res.status(400).json({ success: false, message: 'Opérateur et numéro requis.' });
    }

    const reference = 'DEP-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const merchantNumber = getMerchantNumber(mobileOperator);

    await query(
      `INSERT INTO transactions
         (user_id, type, amount, operator, phone, project_id, status, reference, label)
       VALUES ($1, 'deposit', $2, $3, $4, $5, 'pending', $6, $7)`,
      [
        req.user.uid,
        amount,
        mobileOperator,
        phone,
        projectId || null,
        reference,
        `Dépôt ${operatorLabel(mobileOperator)}`,
      ]
    );

    const amountFormatted = parseFloat(amount).toLocaleString('fr-FR');

    res.json({
      success: true,
      data: {
        reference,
        status: 'pending',
        merchantNumber,
        operatorLabel: operatorLabel(mobileOperator),
        amount: parseFloat(amount),
        instructions: `Envoyez ${amountFormatted} GNF au ${merchantNumber} via ${operatorLabel(mobileOperator)}. Mettez la référence ${reference} dans le motif du paiement.`,
        message: 'Demande enregistrée. Envoyez le paiement pour confirmer.',
      },
    });
  } catch (err) {
    console.error('[deposit]', err.message);
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// POST /transactions/withdraw + /withdrawal — creates PENDING, reserves balance
async function handleWithdraw(req, res) {
  try {
    const { amount, mobileOperator, phone } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Montant invalide.' });
    }
    if (!mobileOperator || !phone) {
      return res.status(400).json({ success: false, message: 'Opérateur et numéro requis.' });
    }

    // Check balance
    const { rows: walletRows } = await query(
      'SELECT balance FROM wallets WHERE user_id = $1',
      [req.user.uid]
    );
    const balance = parseFloat(walletRows[0]?.balance || 0);
    const fee = Math.round(amount * 0.01);
    const total = amount + fee;

    if (balance < total) {
      return res.status(400).json({
        success: false,
        message: `Solde insuffisant. Disponible: ${balance.toLocaleString('fr-FR')} GNF (frais 1% inclus).`,
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const reference = 'WTH-' + crypto.randomBytes(4).toString('hex').toUpperCase();

      await client.query(
        `INSERT INTO transactions
           (user_id, type, amount, operator, phone, status, reference, label)
         VALUES ($1, 'withdrawal', $2, $3, $4, 'pending', $5, $6)`,
        [
          req.user.uid,
          amount,
          mobileOperator,
          phone,
          reference,
          `Retrait ${operatorLabel(mobileOperator)}`,
        ]
      );

      // Reserve balance (deduct immediately)
      await client.query(
        'UPDATE wallets SET balance = balance - $1, updated_at = NOW() WHERE user_id = $2',
        [total, req.user.uid]
      );

      await client.query('COMMIT');

      res.json({
        success: true,
        data: {
          reference,
          status: 'pending',
          amount: parseFloat(amount),
          fee,
          total,
          message: 'Demande de retrait enregistrée. Traitement sous 15–30 minutes.',
        },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[withdraw]', err.message);
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
}

router.post('/withdrawal', requireAuth, handleWithdraw);
router.post('/withdraw', requireAuth, handleWithdraw);

// ── Helpers ──────────────────────────────────────────────────────────────────

function getMerchantNumber(operator) {
  const map = {
    'orange-money': process.env.ORANGE_MONEY_NUMBER || '+224 621 000 000',
    'mtn-momo': process.env.MTN_MOMO_NUMBER || '+224 660 000 000',
    'wave': process.env.WAVE_NUMBER || '+224 628 000 000',
  };
  return map[operator] || map['orange-money'];
}

function operatorLabel(key) {
  const map = {
    'orange-money': 'Orange Money',
    'mtn-momo': 'MTN MoMo',
    'wave': 'Wave Guinée',
    'visa': 'Visa',
    // Legacy IDs
    'orange': 'Orange Money',
    'mtn': 'MTN MoMo',
  };
  return map[key] || key;
}

function labelFor(t) {
  if (t.type === 'deposit') return `Dépôt ${operatorLabel(t.operator)}`;
  if (t.type === 'withdrawal') return `Retrait ${operatorLabel(t.operator)}`;
  if (t.type === 'bonus') return 'Bonus de parrainage';
  return t.type;
}

module.exports = router;
