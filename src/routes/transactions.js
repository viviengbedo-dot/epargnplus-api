const router = require('express').Router();
const { query } = require('../db');
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

// POST /transactions/deposit
router.post('/deposit', requireAuth, async (req, res) => {
  try {
    const { amount, mobileOperator, phone, projectId } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Montant invalide.' });
    }
    if (!mobileOperator || !phone) {
      return res.status(400).json({ success: false, message: 'Opérateur et numéro requis.' });
    }

    // In production: initiate Mobile Money payment here, wait for webhook.
    // For now: direct credit (demo / test mode).
    const client = await (require('../db').pool).connect();
    try {
      await client.query('BEGIN');

      const reference = 'DEP-' + crypto.randomBytes(4).toString('hex').toUpperCase();

      const { rows: txRows } = await client.query(
        `INSERT INTO transactions
           (user_id, type, amount, operator, phone, project_id, status, reference, label)
         VALUES ($1, 'deposit', $2, $3, $4, $5, 'success', $6, $7)
         RETURNING id`,
        [req.user.uid, amount, mobileOperator, phone, projectId || null, reference,
         `Dépôt ${operatorLabel(mobileOperator)}`]
      );

      // Credit wallet
      await client.query(
        'UPDATE wallets SET balance = balance + $1, updated_at = NOW() WHERE user_id = $2',
        [amount, req.user.uid]
      );

      // Credit project if provided
      if (projectId) {
        await client.query(
          `UPDATE projects SET current_amount = current_amount + $1,
           status = CASE WHEN current_amount + $1 >= goal_amount THEN 'COMPLETED' ELSE status END
           WHERE id = $2 AND user_id = $3`,
          [amount, projectId, req.user.uid]
        );
      }

      await client.query('COMMIT');

      res.json({
        success: true,
        data: {
          transactionId: txRows[0].id,
          reference,
          status: 'success',
          message: 'Dépôt effectué avec succès.',
        },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[deposit]', err.message);
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// POST /transactions/withdrawal
router.post('/withdrawal', requireAuth, async (req, res) => {
  try {
    const { amount, mobileOperator, phone } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Montant invalide.' });
    }

    // Check balance
    const { rows: walletRows } = await query(
      'SELECT balance FROM wallets WHERE user_id = $1',
      [req.user.uid]
    );
    const balance = parseFloat(walletRows[0]?.balance || 0);
    const fee = amount * 0.01;
    const total = amount + fee;

    if (balance < total) {
      return res.status(400).json({
        success: false,
        message: `Solde insuffisant. Disponible: ${balance.toLocaleString('fr-FR')} GNF.`,
      });
    }

    const client = await (require('../db').pool).connect();
    try {
      await client.query('BEGIN');

      const reference = 'WTH-' + crypto.randomBytes(4).toString('hex').toUpperCase();

      const { rows: txRows } = await client.query(
        `INSERT INTO transactions
           (user_id, type, amount, operator, phone, status, reference, label)
         VALUES ($1, 'withdrawal', $2, $3, $4, 'success', $5, $6)
         RETURNING id`,
        [req.user.uid, amount, mobileOperator, phone, reference,
         `Retrait ${operatorLabel(mobileOperator)}`]
      );

      // Debit wallet (amount + fee)
      await client.query(
        'UPDATE wallets SET balance = balance - $1, updated_at = NOW() WHERE user_id = $2',
        [total, req.user.uid]
      );

      await client.query('COMMIT');

      res.json({
        success: true,
        data: {
          transactionId: txRows[0].id,
          reference,
          status: 'success',
          message: 'Retrait effectué avec succès.',
        },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[withdrawal]', err.message);
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

function operatorLabel(key) {
  const map = {
    'orange-money': 'Orange Money',
    'mtn-momo': 'MTN MoMo',
    'wave': 'Wave Guinée',
    'visa': 'Visa',
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
