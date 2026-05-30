/**
 * Promo codes — Epargn+ iOS backend
 *
 * POST /promos/apply — appliquer un code promo
 * GET  /promos/used  — codes déjà utilisés par l'utilisateur
 */

const router = require('express').Router();
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

/* ── POST /apply — appliquer un code promo ── */
router.post('/apply', requireAuth, async (req, res, next) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, message: 'code requis.' });

    /* Récupérer le promo */
    const { rows: promoRows } = await query(
      `SELECT id, code, type, value, currency, max_uses, uses_count,
              target_country, active, expires_at
       FROM promo_codes
       WHERE UPPER(code) = UPPER($1)`,
      [code.trim()]
    );
    if (!promoRows.length) {
      return res.status(404).json({ success: false, message: 'Code promo invalide ou inexistant.' });
    }
    const promo = promoRows[0];

    if (!promo.active) {
      return res.status(400).json({ success: false, message: 'Ce code promo est désactivé.' });
    }
    if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
      return res.status(400).json({ success: false, message: 'Ce code promo a expiré.' });
    }
    if (promo.max_uses !== null && promo.uses_count >= promo.max_uses) {
      return res.status(400).json({ success: false, message: 'Ce code a atteint sa limite d\'utilisation.' });
    }

    /* Vérifier pays cible si défini */
    /* Note: la table users iOS n'a pas de champ country — skip cette vérification
       ou ajouter la colonne si nécessaire */

    /* Vérifier utilisation déjà faite */
    const { rows: usedRows } = await query(
      `SELECT id FROM promo_uses WHERE promo_id = $1 AND user_id = $2`,
      [promo.id, req.user.uid]
    );
    if (usedRows.length) {
      return res.status(400).json({ success: false, message: 'Vous avez déjà utilisé ce code promo.' });
    }

    let bonusAmount = 0;

    /* Appliquer le bonus selon le type */
    if (promo.type === 'bonus_deposit') {
      bonusAmount = parseFloat(promo.value) || 0;
      if (bonusAmount > 0) {
        /* Créditer le wallet */
        await query(
          `UPDATE wallets SET balance = balance + $1, updated_at = NOW() WHERE user_id = $2`,
          [bonusAmount, req.user.uid]
        );
        /* Créer une transaction bonus */
        await query(
          `INSERT INTO transactions (user_id, type, amount, label, status)
           VALUES ($1, 'bonus', $2, $3, 'success')`,
          [req.user.uid, bonusAmount, 'Bonus promo — ' + promo.code]
        );
        /* Notification */
        await query(
          `INSERT INTO notifications (user_id, title, body)
           VALUES ($1, $2, $3)`,
          [req.user.uid,
           '🎁 Code promo appliqué !',
           `Bonus de ${bonusAmount.toLocaleString('fr-FR')} ${promo.currency || 'GNF'} crédité sur votre compte.`]
        );
      }
    }

    /* Enregistrer l'utilisation */
    await query(
      `INSERT INTO promo_uses (promo_id, user_id, amount) VALUES ($1, $2, $3)`,
      [promo.id, req.user.uid, bonusAmount]
    );

    /* Incrémenter le compteur */
    await query(
      `UPDATE promo_codes SET uses_count = uses_count + 1 WHERE id = $1`,
      [promo.id]
    );

    /* Récupérer le nouveau solde */
    const { rows: walletRows } = await query(
      `SELECT balance FROM wallets WHERE user_id = $1`,
      [req.user.uid]
    );
    const newBalance = walletRows.length ? parseFloat(walletRows[0].balance) : 0;

    res.json({
      success: true,
      data: {
        promo: { code: promo.code, type: promo.type, value: promo.value, currency: promo.currency },
        bonusAmount,
        newBalance,
      },
    });
  } catch (err) { next(err); }
});

/* ── GET /used — codes déjà utilisés ── */
router.get('/used', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT pu.id, pc.code, pc.type, pc.value, pc.currency, pu.amount, pu.used_at
       FROM promo_uses pu
       JOIN promo_codes pc ON pc.id = pu.promo_id
       WHERE pu.user_id = $1
       ORDER BY pu.used_at DESC`,
      [req.user.uid]
    );
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

module.exports = router;
