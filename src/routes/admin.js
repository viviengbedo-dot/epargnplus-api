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

// GET /admin/users/:id — user detail
router.get('/users/:id', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT u.*, COALESCE(w.balance, 0) as balance, COALESCE(u.is_blocked, false) as is_blocked
       FROM users u LEFT JOIN wallets w ON w.user_id = u.id
       WHERE u.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Utilisateur introuvable.' });
    const u = rows[0];
    res.json({
      success: true,
      data: {
        id: u.id, phone: u.phone, name: u.name || '',
        balance: parseFloat(u.balance), kycStatus: u.kyc_status,
        kycTier: u.kyc_tier, referralCode: u.referral_code,
        isBlocked: u.is_blocked,
        createdAt: new Date(u.created_at).toLocaleDateString('fr-FR'),
      },
    });
  } catch (err) { next(err); }
});

// GET /admin/users/:id/transactions
router.get('/users/:id/transactions', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT t.*, u.phone as user_phone FROM transactions t
       JOIN users u ON u.id = t.user_id
       WHERE t.user_id = $1 ORDER BY t.created_at DESC LIMIT 50`,
      [req.params.id]
    );
    res.json({
      success: true,
      data: {
        items: rows.map((t) => ({
          id: t.id, userId: t.user_id, userPhone: t.user_phone,
          type: t.type, amount: parseFloat(t.amount),
          operator: t.operator || '', status: t.status,
          reference: t.reference,
          createdAt: new Date(t.created_at).toLocaleDateString('fr-FR'),
        })),
        total: rows.length,
      },
    });
  } catch (err) { next(err); }
});

// POST /admin/notifications/send — send to single user
router.post('/notifications/send', requireAdmin, async (req, res, next) => {
  try {
    const { userId, title, body } = req.body;
    if (!userId || !title || !body) {
      return res.status(400).json({ success: false, message: 'userId, title et body requis.' });
    }
    await query(
      `INSERT INTO notifications (user_id, title, body) VALUES ($1, $2, $3)`,
      [userId, title, body]
    );
    res.json({ success: true, data: { sent: 1 } });
  } catch (err) { next(err); }
});

// POST /admin/notifications/broadcast — send to all or active users
router.post('/notifications/broadcast', requireAdmin, async (req, res, next) => {
  try {
    const { title, body, target } = req.body;
    if (!title || !body) {
      return res.status(400).json({ success: false, message: 'title et body requis.' });
    }
    let userIds;
    if (target === 'active') {
      const { rows } = await query(
        `SELECT DISTINCT user_id FROM auth_tokens WHERE expires_at > NOW()`
      );
      userIds = rows.map((r) => r.user_id);
    } else {
      const { rows } = await query(`SELECT id FROM users`);
      userIds = rows.map((r) => r.id);
    }
    if (userIds.length === 0) {
      return res.json({ success: true, data: { count: 0 } });
    }
    const values = userIds.map((id, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(',');
    const params = userIds.flatMap((id) => [id, title, body]);
    await query(`INSERT INTO notifications (user_id, title, body) VALUES ${values}`, params);
    res.json({ success: true, data: { count: userIds.length } });
  } catch (err) { next(err); }
});

// GET /admin/export/users.csv
router.get('/export/users.csv', async (req, res, next) => {
  try {
    const token = req.query.token;
    if (!token) return res.status(401).json({ success: false, message: 'Token manquant.' });
    const jwt = require('jsonwebtoken');
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role !== 'admin') return res.status(403).json({ success: false, message: 'Accès refusé.' });

    const { rows } = await query(
      `SELECT u.phone, u.name, u.kyc_status, u.kyc_tier, u.referral_code,
              COALESCE(w.balance, 0) as balance, u.created_at
       FROM users u LEFT JOIN wallets w ON w.user_id = u.id
       ORDER BY u.created_at DESC`
    );

    const header = 'Téléphone,Nom,KYC,Tier,Parrainage,Solde (GNF),Inscrit le\n';
    const csv = header + rows.map((u) =>
      [u.phone, u.name || '', u.kyc_status, u.kyc_tier, u.referral_code,
       parseFloat(u.balance).toFixed(2),
       new Date(u.created_at).toLocaleDateString('fr-FR')].join(',')
    ).join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="epargnplus_users.csv"');
    res.send('﻿' + csv);
  } catch (err) { next(err); }
});

// GET /admin/export/transactions.csv
router.get('/export/transactions.csv', async (req, res, next) => {
  try {
    const token = req.query.token;
    if (!token) return res.status(401).json({ success: false, message: 'Token manquant.' });
    const jwt = require('jsonwebtoken');
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role !== 'admin') return res.status(403).json({ success: false, message: 'Accès refusé.' });

    const type = req.query.type || '';
    const status = req.query.status || '';
    const conditions = [];
    const params = [];
    if (type) { params.push(type); conditions.push(`t.type = $${params.length}`); }
    if (status) { params.push(status); conditions.push(`t.status = $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await query(
      `SELECT t.reference, u.phone, t.type, t.amount, t.operator, t.status, t.created_at
       FROM transactions t JOIN users u ON u.id = t.user_id
       ${where} ORDER BY t.created_at DESC`,
      params
    );

    const header = 'Référence,Téléphone,Type,Montant (GNF),Opérateur,Statut,Date\n';
    const csv = header + rows.map((t) =>
      [t.reference, t.phone, t.type, parseFloat(t.amount).toFixed(2),
       t.operator || '', t.status,
       new Date(t.created_at).toLocaleDateString('fr-FR')].join(',')
    ).join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="epargnplus_transactions.csv"');
    res.send('﻿' + csv);
  } catch (err) { next(err); }
});

// PATCH /admin/transactions/:id/confirm
router.patch('/transactions/:id/confirm', requireAdmin, async (req, res, next) => {
  const client = await (require('../db').pool).connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      'SELECT * FROM transactions WHERE id = $1',
      [req.params.id]
    );

    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Transaction introuvable.' });
    }

    const tx = rows[0];

    if (tx.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Transaction déjà traitée.' });
    }

    // Mark as success
    await client.query(
      'UPDATE transactions SET status = $1 WHERE id = $2',
      ['success', tx.id]
    );

    // Deposits: credit wallet (and project if applicable)
    if (tx.type === 'deposit') {
      await client.query(
        'UPDATE wallets SET balance = balance + $1, updated_at = NOW() WHERE user_id = $2',
        [tx.amount, tx.user_id]
      );

      if (tx.project_id) {
        await client.query(
          `UPDATE projects
           SET current_amount = current_amount + $1,
               status = CASE WHEN current_amount + $1 >= goal_amount THEN 'COMPLETED' ELSE status END
           WHERE id = $2`,
          [tx.amount, tx.project_id]
        );
      }
    }
    // Withdrawals: balance already reserved at creation — nothing to do

    await client.query('COMMIT');
    res.json({ success: true, data: { id: tx.id, status: 'success' } });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// PATCH /admin/transactions/:id/reject
router.patch('/transactions/:id/reject', requireAdmin, async (req, res, next) => {
  const client = await (require('../db').pool).connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      'SELECT * FROM transactions WHERE id = $1',
      [req.params.id]
    );

    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Transaction introuvable.' });
    }

    const tx = rows[0];

    if (tx.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Transaction déjà traitée.' });
    }

    // Mark as failed
    await client.query(
      'UPDATE transactions SET status = $1 WHERE id = $2',
      ['failed', tx.id]
    );

    // Withdrawals: refund reserved balance (amount + 1% fee)
    if (tx.type === 'withdrawal') {
      const fee = Math.round(parseFloat(tx.amount) * 0.01);
      const total = parseFloat(tx.amount) + fee;
      await client.query(
        'UPDATE wallets SET balance = balance + $1, updated_at = NOW() WHERE user_id = $2',
        [total, tx.user_id]
      );
    }
    // Deposits: never credited — nothing to reverse

    await client.query('COMMIT');
    res.json({ success: true, data: { id: tx.id, status: 'failed' } });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ─── KYC Review ──────────────────────────────────────────────────────────────

// GET /admin/kyc?page=1  — list users with pending KYC + their docs
router.get('/kyc', requireAdmin, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const offset = (page - 1) * PAGE_SIZE;

    const [rows, countRow] = await Promise.all([
      query(
        `SELECT u.id, u.phone, u.name, u.kyc_status, u.kyc_tier, u.created_at,
                json_agg(json_build_object(
                  'id', kd.id, 'type', kd.type,
                  'verified', kd.verified, 'uploadedAt', kd.uploaded_at
                ) ORDER BY kd.uploaded_at) FILTER (WHERE kd.id IS NOT NULL) as docs
         FROM users u
         LEFT JOIN kyc_documents kd ON kd.user_id = u.id
         WHERE u.kyc_status IN ('pending','verified')
         GROUP BY u.id
         ORDER BY u.created_at DESC
         LIMIT $1 OFFSET $2`,
        [PAGE_SIZE, offset]
      ),
      query(`SELECT COUNT(*) as total FROM users WHERE kyc_status IN ('pending','verified')`),
    ]);

    res.json({
      success: true,
      data: {
        items: rows.rows.map((u) => ({
          id: u.id,
          phone: u.phone,
          name: u.name || '',
          kycStatus: u.kyc_status,
          kycTier: u.kyc_tier,
          createdAt: new Date(u.created_at).toLocaleDateString('fr-FR'),
          docs: u.docs || [],
        })),
        total: parseInt(countRow.rows[0].total),
        page,
        totalPages: Math.ceil(parseInt(countRow.rows[0].total) / PAGE_SIZE),
      },
    });
  } catch (err) { next(err); }
});

// GET /admin/kyc/:userId/docs  — get docs WITH images for review
router.get('/kyc/:userId/docs', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, type, file_url, verified, uploaded_at
       FROM kyc_documents WHERE user_id = $1 ORDER BY uploaded_at`,
      [req.params.userId]
    );
    res.json({
      success: true,
      data: rows.map((d) => ({
        id: d.id,
        type: d.type,
        fileUrl: d.file_url,
        verified: d.verified,
        uploadedAt: new Date(d.uploaded_at).toLocaleDateString('fr-FR'),
      })),
    });
  } catch (err) { next(err); }
});

// PATCH /admin/kyc/:userId/approve
router.patch('/kyc/:userId/approve', requireAdmin, async (req, res, next) => {
  try {
    const { userId } = req.params;
    await query(
      `UPDATE users SET kyc_status = 'verified', kyc_tier = 2 WHERE id = $1`,
      [userId]
    );
    await query(
      `UPDATE kyc_documents SET verified = true WHERE user_id = $1`,
      [userId]
    );
    res.json({ success: true, message: 'KYC approuvé.' });
  } catch (err) { next(err); }
});

// PATCH /admin/kyc/:userId/reject
router.patch('/kyc/:userId/reject', requireAdmin, async (req, res, next) => {
  try {
    const { userId } = req.params;
    await query(
      `UPDATE users SET kyc_status = 'none', kyc_tier = 1 WHERE id = $1`,
      [userId]
    );
    await query(`DELETE FROM kyc_documents WHERE user_id = $1`, [userId]);
    res.json({ success: true, message: 'KYC rejeté, documents supprimés.' });
  } catch (err) { next(err); }
});

/* ══════════════════════════════════════════════════
   SUPPORT TICKETS — admin
   ══════════════════════════════════════════════════ */

// GET /admin/support — liste tous les tickets
router.get('/support', requireAdmin, async (req, res, next) => {
  try {
    const { status, priority, page = 1 } = req.query;
    const offset = (parseInt(page) - 1) * PAGE_SIZE;
    const conditions = [];
    const params = [];

    if (status)   { params.push(status);   conditions.push(`st.status = $${params.length}`); }
    if (priority) { params.push(priority); conditions.push(`st.priority = $${params.length}`); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const { rows } = await query(
      `SELECT st.id, st.subject, st.message, st.status, st.priority, st.category,
              st.admin_reply, st.resolved_at, st.created_at, st.updated_at,
              u.phone, u.name
       FROM support_tickets st
       JOIN users u ON u.id = st.user_id
       ${where}
       ORDER BY
         CASE st.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
         st.created_at DESC
       LIMIT ${PAGE_SIZE} OFFSET $${params.length + 1}`,
      [...params, offset]
    );

    /* Counts */
    const { rows: counts } = await query(
      `SELECT status, COUNT(*) as cnt FROM support_tickets GROUP BY status`
    );
    const stats = Object.fromEntries(counts.map((r) => [r.status, parseInt(r.cnt)]));

    res.json({ success: true, data: rows, stats });
  } catch (err) { next(err); }
});

// GET /admin/support/:id — détail + réponses
router.get('/support/:id', requireAdmin, async (req, res, next) => {
  try {
    const { rows: tRows } = await query(
      `SELECT st.*, u.phone, u.name
       FROM support_tickets st
       JOIN users u ON u.id = st.user_id
       WHERE st.id = $1`,
      [req.params.id]
    );
    if (!tRows.length) return res.status(404).json({ success: false, message: 'Ticket introuvable.' });

    const { rows: replies } = await query(
      `SELECT id, message, is_admin, created_at FROM ticket_replies
       WHERE ticket_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );

    res.json({ success: true, data: { ...tRows[0], replies } });
  } catch (err) { next(err); }
});

// POST /admin/support/:id/reply — répondre à un ticket
router.post('/support/:id/reply', requireAdmin, async (req, res, next) => {
  try {
    const { message, newStatus, newPriority } = req.body;
    if (!message && !newStatus && !newPriority) {
      return res.status(400).json({ success: false, message: 'message, newStatus ou newPriority requis.' });
    }

    const VALID_STATUS   = ['open','in_progress','resolved','closed'];
    const VALID_PRIORITY = ['low','normal','high','urgent'];

    if (newStatus && !VALID_STATUS.includes(newStatus)) {
      return res.status(400).json({ success: false, message: 'status invalide.' });
    }

    /* Récupérer le ticket pour notifier l'utilisateur */
    const { rows: tRows } = await query(
      `SELECT id, user_id, subject FROM support_tickets WHERE id = $1`,
      [req.params.id]
    );
    if (!tRows.length) return res.status(404).json({ success: false, message: 'Ticket introuvable.' });
    const ticket = tRows[0];

    /* Insérer la réponse */
    if (message) {
      await query(
        `INSERT INTO ticket_replies (ticket_id, author_id, message, is_admin) VALUES ($1, NULL, $2, TRUE)`,
        [req.params.id, message.slice(0, 2000)]
      );
    }

    /* Mettre à jour le ticket */
    const updates = ['updated_at = NOW()'];
    const params  = [req.params.id];
    if (message)      { params.push(message.slice(0, 2000)); updates.push(`admin_reply = $${params.length}`); }
    if (newStatus)    { params.push(newStatus);  updates.push(`status = $${params.length}`); }
    if (newPriority && VALID_PRIORITY.includes(newPriority)) {
      params.push(newPriority); updates.push(`priority = $${params.length}`);
    }
    if (newStatus === 'resolved') updates.push('resolved_at = NOW()');

    await query(`UPDATE support_tickets SET ${updates.join(', ')} WHERE id = $1`, params);

    /* Notifier l'utilisateur */
    if (message) {
      await query(
        `INSERT INTO notifications (user_id, title, body) VALUES ($1, $2, $3)`,
        [ticket.user_id,
         '💬 Réponse à votre demande',
         `Votre demande "${ticket.subject}" a reçu une réponse de l'équipe Epargn+.`]
      );
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

// PATCH /admin/support/:id/status — changer statut/priorité uniquement
router.patch('/support/:id/status', requireAdmin, async (req, res, next) => {
  try {
    const { status, priority } = req.body;
    const VALID_STATUS   = ['open','in_progress','resolved','closed'];
    const VALID_PRIORITY = ['low','normal','high','urgent'];

    if (status && !VALID_STATUS.includes(status)) {
      return res.status(400).json({ success: false, message: 'status invalide.' });
    }

    const updates = ['updated_at = NOW()'];
    const params  = [req.params.id];
    if (status)   { params.push(status);   updates.push(`status = $${params.length}`); }
    if (priority && VALID_PRIORITY.includes(priority)) {
      params.push(priority); updates.push(`priority = $${params.length}`);
    }
    if (status === 'resolved') updates.push('resolved_at = NOW()');

    await query(`UPDATE support_tickets SET ${updates.join(', ')} WHERE id = $1`, params);
    res.json({ success: true });
  } catch (err) { next(err); }
});

/* ══════════════════════════════════════════════════
   PROMO CODES — admin
   ══════════════════════════════════════════════════ */

// GET /admin/promos — liste tous les codes
router.get('/promos', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, code, description, type, value, currency, max_uses, uses_count,
              target_country, active, expires_at, created_at
       FROM promo_codes
       ORDER BY created_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// POST /admin/promos — créer un code promo
router.post('/promos', requireAdmin, async (req, res, next) => {
  try {
    const { code, description, type, value, currency, max_uses, target_country, expires_at } = req.body;
    if (!code || !type || value === undefined) {
      return res.status(400).json({ success: false, message: 'code, type et value requis.' });
    }
    const VALID_TYPES = ['bonus_deposit','fee_free','cashback'];
    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({ success: false, message: 'type invalide.' });
    }

    const { rows } = await query(
      `INSERT INTO promo_codes (code, description, type, value, currency, max_uses, target_country, expires_at)
       VALUES (UPPER($1), $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        code.trim(), description || '', type, parseFloat(value),
        currency || 'GNF',
        max_uses ? parseInt(max_uses) : null,
        target_country || null,
        expires_at || null,
      ]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: 'Ce code promo existe déjà.' });
    }
    next(err);
  }
});

// PATCH /admin/promos/:id — activer/désactiver
router.patch('/promos/:id', requireAdmin, async (req, res, next) => {
  try {
    const { active } = req.body;
    if (active === undefined) {
      return res.status(400).json({ success: false, message: 'active requis.' });
    }
    await query(`UPDATE promo_codes SET active = $1 WHERE id = $2`, [Boolean(active), req.params.id]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// DELETE /admin/promos/:id — supprimer
router.delete('/promos/:id', requireAdmin, async (req, res, next) => {
  try {
    await query(`DELETE FROM promo_uses WHERE promo_id = $1`, [req.params.id]);
    await query(`DELETE FROM promo_codes WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /admin/promos/:id/uses — qui a utilisé ce code
router.get('/promos/:id/uses', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT pu.id, pu.amount, pu.used_at, u.phone, u.name
       FROM promo_uses pu
       JOIN users u ON u.id = pu.user_id
       WHERE pu.promo_id = $1
       ORDER BY pu.used_at DESC`,
      [req.params.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

/* ══════════════════════════════════════════════════
   BROADCAST — version améliorée avec enregistrement
   ══════════════════════════════════════════════════ */

// POST /admin/broadcast — envoyer + enregistrer
router.post('/broadcast', requireAdmin, async (req, res, next) => {
  try {
    const { title, body: msgBody, target } = req.body;
    if (!title || !msgBody) {
      return res.status(400).json({ success: false, message: 'title et body requis.' });
    }

    /* Sélectionner les utilisateurs selon la cible */
    /* iOS n'a pas de colonne country — 'active' = tokens valides, sinon tous */
    let userIds = [];
    if (target === 'active') {
      const { rows } = await query(
        `SELECT DISTINCT user_id FROM auth_tokens WHERE expires_at > NOW()`
      );
      userIds = rows.map((r) => r.user_id);
    } else {
      const { rows } = await query(`SELECT id FROM users WHERE is_blocked = FALSE`);
      userIds = rows.map((r) => r.id);
    }

    if (!userIds.length) {
      return res.json({ success: true, data: { count: 0 } });
    }

    /* Insérer les notifications en batch */
    const values = userIds.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(',');
    const params = userIds.flatMap((id) => [id, title, msgBody]);
    await query(`INSERT INTO notifications (user_id, title, body) VALUES ${values}`, params);

    /* Enregistrer le broadcast */
    try {
      await query(
        `INSERT INTO broadcasts (title, message, target, sent_count, created_by) VALUES ($1, $2, $3, $4, 'admin')`,
        [title, msgBody, target || 'all', userIds.length]
      );
    } catch (e) { /* table optionnelle */ }

    res.json({ success: true, data: { count: userIds.length } });
  } catch (err) { next(err); }
});

// GET /admin/broadcast/history — historique des broadcasts
router.get('/broadcast/history', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, title, message, target, sent_count, created_at
       FROM broadcasts
       ORDER BY created_at DESC
       LIMIT 50`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    /* Table optionnelle — retourner tableau vide si absente */
    res.json({ success: true, data: [] });
  }
});

/* ══════════════════════════════════════════════════
   PILOT CHECKLIST — endpoint de santé globale
   ══════════════════════════════════════════════════ */

// GET /admin/health — santé de la plateforme pour la checklist pilote
router.get('/health', requireAdmin, async (req, res, next) => {
  try {
    const [users, txns, promos, tickets, wallets] = await Promise.all([
      query(`SELECT COUNT(*) as total,
                    COUNT(*) FILTER (WHERE kyc_status = 'verified') as kyc_verified
             FROM users`),
      query(`SELECT COUNT(*) FILTER (WHERE status = 'success') as completed,
                    COUNT(*) FILTER (WHERE status = 'pending') as pending
             FROM transactions`),
      query(`SELECT COUNT(*) FILTER (WHERE active) as active FROM promo_codes`).catch(() => ({ rows: [{ active: 0 }] })),
      query(`SELECT COUNT(*) FILTER (WHERE status = 'open') as open,
                    COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress
             FROM support_tickets`).catch(() => ({ rows: [{ open: 0, in_progress: 0 }] })),
      query(`SELECT SUM(balance) as total FROM wallets`),
    ]);

    const checks = {
      hasUsers:          parseInt(users.rows[0].total) >= 1,
      hasKycVerified:    parseInt(users.rows[0].kyc_verified) >= 1,
      hasCompletedTxn:   parseInt(txns.rows[0].completed) >= 1,
      hasActivePromo:    parseInt(promos.rows[0].active) >= 1,
      adminEmailSet:     !!process.env.ADMIN_EMAIL,
      jwtSecretSet:      !!process.env.JWT_SECRET,
      dbConnected:       true,
    };

    const passed = Object.values(checks).filter(Boolean).length;
    const total  = Object.keys(checks).length;

    res.json({
      success: true,
      data: {
        checks,
        passed,
        total,
        ready: passed === total,
        stats: {
          users:       parseInt(users.rows[0].total),
          kycVerified: parseInt(users.rows[0].kyc_verified),
          completedTxn:parseInt(txns.rows[0].completed),
          pendingTxn:  parseInt(txns.rows[0].pending),
          totalSavings:parseFloat(wallets.rows[0].total || 0),
          activePromos:parseInt(promos.rows[0].active),
          openTickets: parseInt(tickets.rows[0].open || 0),
        },
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;
