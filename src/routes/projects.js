const router = require('express').Router();
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

// GET /projects
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, name, icon, current_amount, goal_amount, status, deadline, created_at
       FROM projects
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user.uid]
    );

    const projects = rows.map((p) => ({
      id: p.id,
      name: p.name,
      icon: p.icon,
      currentAmount: parseFloat(p.current_amount),
      goalAmount: parseFloat(p.goal_amount),
      status: p.status,
      deadline: p.deadline ? new Date(p.deadline).toISOString().split('T')[0] : null,
      createdAt: new Date(p.created_at).toLocaleDateString('fr-FR', {
        day: '2-digit', month: 'short', year: 'numeric',
      }),
    }));

    res.json({ success: true, data: projects });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /projects
router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, goalAmount, icon, deadline } = req.body;

    if (!name || !goalAmount || goalAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Nom et objectif requis.' });
    }

    const { rows } = await query(
      `INSERT INTO projects (user_id, name, icon, goal_amount, deadline)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, icon, current_amount, goal_amount, status, deadline, created_at`,
      [req.user.uid, name.trim(), icon || 'target', goalAmount, deadline || null]
    );

    const p = rows[0];
    res.status(201).json({
      success: true,
      data: {
        id: p.id,
        name: p.name,
        icon: p.icon,
        currentAmount: parseFloat(p.current_amount),
        goalAmount: parseFloat(p.goal_amount),
        status: p.status,
        deadline: p.deadline ? new Date(p.deadline).toISOString().split('T')[0] : null,
        createdAt: new Date(p.created_at).toLocaleDateString('fr-FR', {
          day: '2-digit', month: 'short', year: 'numeric',
        }),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /projects/:id/status
router.patch('/:id/status', requireAuth, async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['ACTIVE', 'PAUSED', 'COMPLETED'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: 'Statut invalide.' });
    }

    const { rowCount } = await query(
      'UPDATE projects SET status = $1 WHERE id = $2 AND user_id = $3',
      [status, req.params.id, req.user.uid]
    );

    if (!rowCount) return res.status(404).json({ success: false, message: 'Objectif introuvable.' });
    res.json({ success: true, message: 'Statut mis à jour.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
