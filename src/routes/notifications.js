const express = require('express');
const pool = require('../config/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Toutes les routes nécessitent une authentification
router.use(requireAuth);

/**
 * GET /api/notifications/unread-count
 * Renvoie le nombre de notifications non lues pour l'utilisateur connecté
 */
router.get('/unread-count', async (req, res) => {
    try {
        const userId = req.user.id;

        const [rows] = await pool.execute(
            `SELECT COUNT(*) AS count FROM Notifications
       WHERE (IdUtilisateur = ? OR IdUtilisateur IS NULL) AND Lu = 0`,
            [userId]
        );

        return res.json({ success: true, count: rows[0].count });
    } catch (error) {
        console.error('Erreur unread-count:', error);
        return res.status(500).json({ success: false, message: 'Erreur serveur.' });
    }
});

/**
 * GET /api/notifications
 * Liste les notifications de l'utilisateur (les plus récentes d'abord)
 */
router.get('/', async (req, res) => {
    try {
        const userId = req.user.id;

        const [rows] = await pool.execute(
            `SELECT IdNotification, Titre, Message, Type, Lien, Lu, DateCreation
       FROM Notifications
       WHERE IdUtilisateur = ? OR IdUtilisateur IS NULL
       ORDER BY DateCreation DESC
       LIMIT 50`,
            [userId]
        );

        return res.json({ success: true, notifications: rows });
    } catch (error) {
        console.error('Erreur list notifications:', error);
        return res.status(500).json({ success: false, message: 'Erreur serveur.' });
    }
});

/**
 * PUT /api/notifications/:id/read
 * Marque une notification comme lue
 */
router.put('/:id/read', async (req, res) => {
    try {
        const notifId = req.params.id;

        await pool.execute(
            `UPDATE Notifications SET Lu = 1 WHERE IdNotification = ?`,
            [notifId]
        );

        return res.json({ success: true });
    } catch (error) {
        console.error('Erreur mark-read:', error);
        return res.status(500).json({ success: false, message: 'Erreur serveur.' });
    }
});

module.exports = router;
