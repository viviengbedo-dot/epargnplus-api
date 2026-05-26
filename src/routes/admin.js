const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../db');
const { requireAdmin } = require('../middleware/admin');

const router = express.Router();
const PAGE_SIZE = 20;

// POST /admin/login
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email et mot de passe requis.' });
    }

    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH;

    if (!adminEmail || !adminPasswordHash) {
      return res.status(503).json({ success: false, message: 'Admin non configuré.' });
    }

    if (email !== adminEmail) {
      return res.status(401).json({ success: false, message: 'Identifiants incorrects.' });
    }

    const valid = await bcrypt.compare(password, adminPasswordHash);
    if (!valid) {
      return res.status(401).json({ success: false, message: 'Identifiants incorrects.' });
    }

    const token = jwt.sign(
      { role: 'admin', email, iat: Math.floor(Date.now() / 1000) },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({ success: true, data: { token } });
  } catch (err) {
    next(err);
  }
});

// GET /admin/stats
router.get('/stats', requireAdmin, async (req, res, next) => {
  try {
    const [users, wallets, txs, projects, newUsers, monthVol] = await Promise.all([
      query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30d') as new FROM users`),
      query(`SELECT COALESCE(SUM(balance),0) as total FROM wallets`),
      query(`SELECT COUNT(*) as total, COALESCE(SUM(amount),0) as volume FROM transactions WHERE status='success'`),
      query(`SELECT COUNT(*) as total FROM projects WHERE status='ACTIVE'`),
      query(`SELECT COUNT(*) as total FROM users WHERE created_at > NOW() - INTERVAL '30d'`),
      query(`SELECT COALESCE(SUM(amount),0) as volume FROM transactions WHERE status='success' AND created_at > NOW() - INTERVAL '30d'`),
    ]);

    const activeUsers = await query(
      `SELECT COUNT(DISTINCT user_id) as total FROM auth_tokens WHERE expires_at > NOW()`
    );

    res.json({
      success: true,
      data: {
        totalUsers: parseInt(users.rows[0].total),
        newUsersThisMonth: parseInt(newUsers.rows[0].total),
        activeUsers: parseInt(activeUsers.rows[0].total),
        totalBalance: parseFloat(wallets.rows[0].total),
        totalTransactions: parseInt(txs.rows[0].total),
        transactionsVolume: parseFloat(txs.rows[0].volume),
        activeProjects: parseInt(projects.rows[0].total),
        volumeThisMonth: parseFloat(monthVol.rows[0].volume),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/users?page=1&search=
router.get('/users', requireAdmin, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const search = (req.query.search || '').trim();
    const offset = (page - 1) * PAGE_SIZE;

    const whereClause = search ? `WHERE u.phone ILIKE $3` : '';
    const params = search
      ? [PAGE_SIZE, offset, `%${search}%`]
      : [PAGE_SIZE, offset];

    const [rows, countRow] = await Promise.all([
      query(
        `SELECT u.id, u.phone, u.name, u.kyc_status, u.kyc_tier, u.referral_code,
                u.created_at, COALESCE(w.balance,0) as balance,
                COALESCE(u.is_blocked, false) as is_blocked
         FROM users u
         LEFT JOIN wallets w ON w.user_id = u.id
         ${whereClause}
         ORDER BY u.created_at DESC
         LIMIT $1 OFFSET $2`,
        params
      ),
      query(
        `SELECT COUNT(*) as total FROM users u ${whereClause}`,
        search ? [`%${search}%`] : []
      ),
    ]);

    res.json({
      success: true,
      data: {
        items: rows.rows.map((u) => ({
          id: u.id,
          phone: u.phone,
          name: u.name || '',
          balance: parseFloat(u.balance),
          kycStatus: u.kyc_status,
          kycTier: u.kyc_tier,
          referralCode: u.referral_code,
          isBlocked: u.is_blocked,
          createdAt: new Date(u.created_at).toLocaleDateString('fr-FR'),
        })),
        total: parseInt(countRow.rows[0].total),
        page,
        totalPages: Math.ceil(parseInt(countRow.rows[0].total) / PAGE_SIZE),
      },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/users/:id
router.patch('/users/:id', requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { kycStatus, isBlocked } = req.body;

    if (kycStatus !== undefined) {
      await query(
        `UPDATE users SET kyc_status = $1 WHERE id = $2`,
        [kycStatus, id]
      );
    }
    if (isBlocked !== undefined) {
      await query(
        `UPDATE users SET is_blocked = $1 WHERE id = $2`,
        [isBlocked, id]
      );
    }

    res.json({ success: true, data: { id } });
  } catch (err) {
    next(err);
  }
});

// GET /admin/transactions?page=1&type=&status=
router.get('/transactions', requireAdmin, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const type = req.query.type || '';
    const status = req.query.status || '';
    const offset = (page - 1) * PAGE_SIZE;

    const conditions = [];
    const params = [];

    if (type) { params.push(type); conditions.push(`t.type = $${params.length}`); }
    if (status) { params.push(status); conditions.push(`t.status = $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(PAGE_SIZE, offset);

    const [rows, countRow] = await Promise.all([
      query(
        `SELECT t.*, u.phone as user_phone
         FROM transactions t
         JOIN users u ON u.id = t.user_id
         ${where}
         ORDER BY t.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      ),
      query(
        `SELECT COUNT(*) as total FROM transactions t ${where}`,
        conditions.length ? params.slice(0, -2) : []
      ),
    ]);

    res.json({
      success: true,
      data: {
        items: rows.rows.map((t) => ({
          id: t.id,
          userId: t.user_id,
          userPhone: t.user_phone,
          type: t.type,
          amount: parseFloat(t.amount),
          operator: t.operator || '',
          status: t.status,
          reference: t.reference,
          createdAt: new Date(t.created_at).toLocaleDateString('fr-FR'),
        })),
        total: parseInt(countRow.rows[0].total),
        page,
        totalPages: Math.ceil(parseInt(countRow.rows[0].total) / PAGE_SIZE),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/projects?page=1
router.get('/projects', requireAdmin, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const offset = (page - 1) * PAGE_SIZE;

    const [rows, countRow] = await Promise.all([
      query(
        `SELECT p.*, u.phone as user_phone
         FROM projects p
         JOIN users u ON u.id = p.user_id
         ORDER BY p.created_at DESC
         LIMIT $1 OFFSET $2`,
        [PAGE_SIZE, offset]
      ),
      query(`SELECT COUNT(*) as total FROM projects`),
    ]);

    res.json({
      success: true,
      data: {
        items: rows.rows.map((p) => ({
          id: p.id,
          userId: p.user_id,
          userPhone: p.user_phone,
          name: p.name,
          goalAmount: parseFloat(p.goal_amount),
          currentAmount: parseFloat(p.current_amount),
          status: p.status,
          createdAt: new Date(p.created_at).toLocaleDateString('fr-FR'),
        })),
        total: parseInt(countRow.rows[0].total),
        page,
        totalPages: Math.ceil(parseInt(countRow.rows[0].total) / PAGE_SIZE),
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
