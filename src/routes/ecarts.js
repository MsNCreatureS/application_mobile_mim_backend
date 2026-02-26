const express = require('express');
const pool = require('../config/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Toutes les routes nécessitent une authentification
router.use(requireAuth);

/**
 * GET /api/ecarts
 * Liste les écarts de l'utilisateur connecté (ou tous si Admin)
 */
router.get('/', async (req, res) => {
    try {
        const userId = req.user.id;
        const role = req.user.role;

        let query;
        let params;

        if (role === 'ADMIN') {
            query = `
        SELECT e.IdEcart, e.TypeControle, e.Description, e.Action, e.Status,
               e.DateCreation, e.IdEquipement, e.IdUtilisateurCreateur,
               eq.NumeroInterne,
               (SELECT COUNT(*) FROM MessagesEcart m WHERE m.IdEcart = e.IdEcart AND m.Lu = 0 AND m.IdUtilisateur != ?) AS messagesNonLus
        FROM Ecart e
        LEFT JOIN Equipement eq ON e.IdEquipement = eq.IdEquipement
        ORDER BY e.DateCreation DESC
        LIMIT 100`;
            params = [userId];
        } else {
            query = `
        SELECT e.IdEcart, e.TypeControle, e.Description, e.Action, e.Status,
               e.DateCreation, e.IdEquipement, e.IdUtilisateurCreateur,
               eq.NumeroInterne,
               (SELECT COUNT(*) FROM MessagesEcart m WHERE m.IdEcart = e.IdEcart AND m.Lu = 0 AND m.IdUtilisateur != ?) AS messagesNonLus
        FROM Ecart e
        LEFT JOIN Equipement eq ON e.IdEquipement = eq.IdEquipement
        WHERE e.IdUtilisateurCreateur = ?
        ORDER BY e.DateCreation DESC
        LIMIT 100`;
            params = [userId, userId];
        }

        const [rows] = await pool.execute(query, params);

        // Map StatusEcart int to label
        const statusLabels = { 0: 'Ouvert', 1: 'EnCours', 2: 'Resolu', 3: 'Ferme' };
        const ecarts = rows.map((row) => ({
            ...row,
            statusLabel: statusLabels[row.Status] || `Inconnu (${row.Status})`,
        }));

        return res.json({ success: true, ecarts });
    } catch (error) {
        console.error('Erreur list ecarts:', error);
        return res.status(500).json({ success: false, message: 'Erreur serveur.' });
    }
});

/**
 * GET /api/ecarts/unread-count
 * Récupère le nombre d'écarts non lus ou nécessitant une action (messages non lus)
 */
router.get('/unread-count', async (req, res) => {
    try {
        const userId = req.user.id;
        const role = req.user.role;

        let query;
        let params;

        // On compte les messages non lus dans les écarts de l'utilisateur
        if (role === 'ADMIN') {
            query = `
                SELECT COUNT(DISTINCT m.IdEcart) as count
                FROM MessagesEcart m
                WHERE m.Lu = 0 AND m.IdUtilisateur != ?`;
            params = [userId];
        } else {
            query = `
                SELECT COUNT(DISTINCT m.IdEcart) as count
                FROM MessagesEcart m
                INNER JOIN Ecart e ON m.IdEcart = e.IdEcart
                WHERE m.Lu = 0 AND m.IdUtilisateur != ? AND e.IdUtilisateurCreateur = ?`;
            params = [userId, userId];
        }

        const [rows] = await pool.execute(query, params);
        const count = rows[0].count;

        return res.json({ success: true, count });
    } catch (error) {
        console.error('Erreur unread-count ecarts:', error);
        return res.status(500).json({ success: false, message: 'Erreur serveur.' });
    }
});

/**
 * GET /api/ecarts/:id
 * Détail d'un écart
 */
router.get('/:id', async (req, res) => {
    try {
        const ecartId = req.params.id;

        const [rows] = await pool.execute(
            `SELECT e.IdEcart, e.TypeControle, e.Description, e.Action, e.Status,
              e.DateCreation, e.IdEquipement, e.IdUtilisateurCreateur,
              e.EmailNotification,
              eq.NumeroInterne
       FROM Ecart e
       LEFT JOIN Equipement eq ON e.IdEquipement = eq.IdEquipement
       WHERE e.IdEcart = ?`,
            [ecartId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Écart non trouvé.' });
        }

        const statusLabels = { 0: 'Ouvert', 1: 'EnCours', 2: 'Resolu', 3: 'Ferme' };
        const ecart = {
            ...rows[0],
            statusLabel: statusLabels[rows[0].Status] || `Inconnu (${rows[0].Status})`,
        };

        return res.json({ success: true, ecart });
    } catch (error) {
        console.error('Erreur detail ecart:', error);
        return res.status(500).json({ success: false, message: 'Erreur serveur.' });
    }
});

/**
 * GET /api/ecarts/:id/messages
 * Liste les messages d'un écart (discussion)
 */
router.get('/:id/messages', async (req, res) => {
    try {
        const ecartId = req.params.id;
        const userId = req.user.id;

        const [messages] = await pool.execute(
            `SELECT m.IdMessage, m.Message, m.NouveauStatus, m.DateCreation, m.Lu,
              m.IdUtilisateur,
              u.Nom, u.Prenom
       FROM MessagesEcart m
       LEFT JOIN Utilisateurs u ON m.IdUtilisateur = u.IdUtilisateur
       WHERE m.IdEcart = ?
       ORDER BY m.DateCreation ASC`,
            [ecartId]
        );

        // Marquer comme lus les messages qui ne sont pas de l'utilisateur actuel
        await pool.execute(
            `UPDATE MessagesEcart SET Lu = 1 WHERE IdEcart = ? AND IdUtilisateur != ? AND Lu = 0`,
            [ecartId, userId]
        );

        return res.json({ success: true, messages });
    } catch (error) {
        console.error('Erreur list messages ecart:', error);
        return res.status(500).json({ success: false, message: 'Erreur serveur.' });
    }
});

/**
 * POST /api/ecarts/:id/messages
 * Ajouter un message à la discussion d'un écart
 */
router.post('/:id/messages', async (req, res) => {
    try {
        const ecartId = req.params.id;
        const userId = req.user.id;
        const { message } = req.body;

        if (!message || !message.trim()) {
            return res.status(400).json({ success: false, message: 'Le message ne peut pas être vide.' });
        }

        await pool.execute(
            `INSERT INTO MessagesEcart (IdEcart, IdUtilisateur, Message, DateCreation, Lu)
       VALUES (?, ?, ?, NOW(), 0)`,
            [ecartId, userId, message.trim()]
        );

        // Créer une notification pour l'admin/le créateur de l'écart
        const [ecartRows] = await pool.execute(
            `SELECT IdUtilisateurCreateur FROM Ecart WHERE IdEcart = ?`,
            [ecartId]
        );

        if (ecartRows.length > 0) {
            const creatorId = ecartRows[0].IdUtilisateurCreateur;
            // Si c'est l'utilisateur lui-même qui envoie, notifier les admins (null)
            // Sinon notifier le créateur
            const targetUserId = creatorId === userId ? null : creatorId;

            await pool.execute(
                `INSERT INTO Notifications (IdUtilisateur, Titre, Message, Type, Lien, DateCreation, Lu)
         VALUES (?, ?, ?, 'Ecart', ?, NOW(), 0)`,
                [
                    targetUserId,
                    `Nouveau message - Écart #${ecartId}`,
                    message.trim().substring(0, 200),
                    String(ecartId),
                ]
            );
        }

        return res.json({ success: true });
    } catch (error) {
        console.error('Erreur post message ecart:', error);
        return res.status(500).json({ success: false, message: 'Erreur serveur.' });
    }
});

/**
 * PUT /api/ecarts/:id/status
 * Changer le statut d'un écart
 * Body: { status: 0|1|2|3, observation?: string }
 * Statuts: 0=Ouvert, 1=EnCours, 2=Resolu, 3=Ferme
 */
router.put('/:id/status', async (req, res) => {
    try {
        const ecartId = req.params.id;
        const userId = req.user.id;
        const { status, observation } = req.body;

        // Validations
        if (status === undefined || status === null) {
            return res.status(400).json({ success: false, message: 'Le statut est requis.' });
        }

        const validStatuses = [0, 1, 2, 3];
        if (!validStatuses.includes(parseInt(status))) {
            return res.status(400).json({ success: false, message: 'Statut invalide.' });
        }

        // Vérifier que l'écart existe
        const [ecartRows] = await pool.execute(
            `SELECT e.IdEcart, e.Status FROM Ecart WHERE IdEcart = ?`,
            [ecartId]
        );

        if (ecartRows.length === 0) {
            return res.status(404).json({ success: false, message: 'Écart non trouvé.' });
        }

        const oldStatus = ecartRows[0].Status;
        const newStatus = parseInt(status);

        // Mettre à jour le statut de l'écart
        await pool.execute(
            `UPDATE Ecart SET Status = ? WHERE IdEcart = ?`,
            [newStatus, ecartId]
        );

        // Mapper les statuts
        const statusLabels = { 0: 'Ouvert', 1: 'EnCours', 2: 'Resolu', 3: 'Ferme' };
        const newStatusLabel = statusLabels[newStatus];

        // Enregistrer le changement de statut comme un message système
        const messageText = observation ? observation : undefined;
        
        await pool.execute(
            `INSERT INTO MessagesEcart (IdEcart, IdUtilisateur, Message, NouveauStatus, DateCreation, Lu)
       VALUES (?, ?, ?, ?, NOW(), 0)`,
            [ecartId, userId, messageText || null, newStatusLabel]
        );

        // Créer une notification pour l'admin/le créateur de l'écart
        const [userRows] = await pool.execute(
            `SELECT IdUtilisateurCreateur FROM Ecart WHERE IdEcart = ?`,
            [ecartId]
        );

        if (userRows.length > 0) {
            const creatorId = userRows[0].IdUtilisateurCreateur;
            const targetUserId = creatorId === userId ? null : creatorId;

            await pool.execute(
                `INSERT INTO Notifications (IdUtilisateur, Titre, Message, Type, Lien, DateCreation, Lu)
         VALUES (?, ?, ?, 'Ecart', ?, NOW(), 0)`,
                [
                    targetUserId,
                    `Statut changé - Écart #${ecartId}`,
                    `Status : ${newStatusLabel}`,
                    String(ecartId),
                ]
            );
        }

        return res.json({ success: true, statusLabel: newStatusLabel });
    } catch (error) {
        console.error('Erreur update status ecart:', error);
        return res.status(500).json({ success: false, message: 'Erreur serveur.' });
    }
});

module.exports = router;
