/**
 * Support tickets — Epargn+ iOS backend
 *
 * GET  /support            — liste mes tickets (utilisateur)
 * POST /support            — créer un ticket
 * GET  /support/:id        — détail ticket + réponses
 * POST /support/:id/reply  — ajouter un message sur un ticket existant
 */

const router = require('express').Router();
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

/* ── GET / — liste des tickets de l'utilisateur ── */
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, subject, message, status, priority, category,
              admin_reply, resolved_at, created_at, updated_at
       FROM support_tickets
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.user.uid]
    );
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

/* ── POST / — créer un ticket ── */
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { subject, message, category } = req.body;
    if (!subject || !message) {
      return res.status(400).json({ success: false, message: 'subject et message requis.' });
    }
    const VALID_CATS = ['general','depot','retrait','kyc','compte','technique','autre'];
    const cat = VALID_CATS.includes(category) ? category : 'general';

    const { rows } = await query(
      `INSERT INTO support_tickets (user_id, subject, message, category)
       VALUES ($1, $2, $3, $4)
       RETURNING id, subject, status, priority, category, created_at`,
      [req.user.uid, subject.slice(0, 200), message.slice(0, 2000), cat]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
});

/* ── GET /:id — détail + fils de réponses ── */
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { rows: tRows } = await query(
      `SELECT id, subject, message, status, priority, category,
              admin_reply, resolved_at, created_at, updated_at
       FROM support_tickets
       WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.uid]
    );
    if (!tRows.length) return res.status(404).json({ success: false, message: 'Ticket introuvable.' });

    const { rows: replies } = await query(
      `SELECT id, message, is_admin, created_at
       FROM ticket_replies
       WHERE ticket_id = $1
       ORDER BY created_at ASC`,
      [req.params.id]
    );

    res.json({ success: true, data: { ...tRows[0], replies } });
  } catch (err) { next(err); }
});

/* ── POST /:id/reply — ajouter un message utilisateur ── */
router.post('/:id/reply', requireAuth, async (req, res, next) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ success: false, message: 'message requis.' });

    /* Vérifier ownership + statut */
    const { rows: tRows } = await query(
      `SELECT id, status FROM support_tickets WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.uid]
    );
    if (!tRows.length) return res.status(404).json({ success: false, message: 'Ticket introuvable.' });
    if (tRows[0].status === 'closed') {
      return res.status(400).json({ success: false, message: 'Ce ticket est clôturé.' });
    }

    await query(
      `INSERT INTO ticket_replies (ticket_id, author_id, message, is_admin) VALUES ($1, $2, $3, FALSE)`,
      [req.params.id, req.user.uid, message.slice(0, 2000)]
    );
    await query(
      `UPDATE support_tickets SET status = 'in_progress', updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
