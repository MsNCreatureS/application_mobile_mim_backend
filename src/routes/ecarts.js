const express = require('express');
const pool = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { sendPushNotifications, getUserPushTokens, getAdminPushTokens } = require('../utils/pushNotifications');

const router = express.Router();

// Toutes les routes nécessitent une authentification
router.use(requireAuth);

// Helpers de mapping de status entre la BDD (texte) et le front (codes/labels)
function mapStatusToLabel(statusValue) {
    const raw = (statusValue ?? '').toString().trim();

    // Valeurs texte telles que stockées par le logiciel (EF Core)
    if (raw === 'Ouvert' || raw.toUpperCase() === 'OUVERT' || raw === '0') {
        return 'Ouvert';
    }
    if (raw === 'En cours' || raw === 'EnCours' || raw === '1') {
        return 'EnCours';
    }
    if (raw === 'Résolu' || raw === 'Resolu' || raw === '2') {
        return 'Resolu';
    }
    if (raw === 'Fermé' || raw === 'Ferme' || raw === '3') {
        return 'Ferme';
    }

    return `Inconnu (${statusValue})`;
}

function mapCodeToDbStatus(code) {
    // Codes utilisés par le front : 0=Ouvert, 1=EnCours, 2=Resolu, 3=Ferme
    switch (Number(code)) {
        case 0:
            return 'Ouvert';
        case 1:
            return 'En cours';
        case 2:
            return 'Résolu';
        case 3:
            return 'Fermé';
        default:
            return null;
    }
}

function getFriendlyClotureType(typeCloture) {
    switch (typeCloture) {
        case 'PasAction':
            return "Pas d'action";
        case 'ActionInterne':
            return 'Action interne';
        case 'ActionExterne':
            return 'Action externe';
        default:
            return typeCloture;
    }
}

function formatDateFr(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return '';
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
}

function formatDateTimeFr(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return '';
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${day}/${month}/${year} ${hours}:${minutes}`;
}

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
               eq.NumeroInterne, eq.Affectation, eq.Localisation, eq.Observations AS EquipementObservations,
               eq.Status AS EquipementStatus,
               te.NomType, te.Famille,
               (SELECT COUNT(*) FROM MessagesEcart m WHERE m.IdEcart = e.IdEcart AND m.Lu = 0 AND m.IdUtilisateur != ?) AS messagesNonLus
        FROM Ecart e
        LEFT JOIN Equipement eq ON e.IdEquipement = eq.IdEquipement
        LEFT JOIN TypeEquipement te ON eq.IdType = te.IdType
        ORDER BY e.DateCreation DESC
        LIMIT 100`;
            params = [userId];
        } else {
            query = `
        SELECT e.IdEcart, e.TypeControle, e.Description, e.Action, e.Status,
               e.DateCreation, e.IdEquipement, e.IdUtilisateurCreateur,
               eq.NumeroInterne, eq.Affectation, eq.Localisation, eq.Observations AS EquipementObservations,
               eq.Status AS EquipementStatus,
               te.NomType, te.Famille,
               (SELECT COUNT(*) FROM MessagesEcart m WHERE m.IdEcart = e.IdEcart AND m.Lu = 0 AND m.IdUtilisateur != ?) AS messagesNonLus
        FROM Ecart e
        LEFT JOIN Equipement eq ON e.IdEquipement = eq.IdEquipement
        LEFT JOIN TypeEquipement te ON eq.IdType = te.IdType
        WHERE e.IdUtilisateurCreateur = ?
        ORDER BY e.DateCreation DESC
        LIMIT 100`;
            params = [userId, userId];
        }

        const [rows] = await pool.execute(query, params);

        const ecarts = rows.map((row) => ({
            ...row,
            statusLabel: mapStatusToLabel(row.Status),
        }));

        return res.json({ success: true, ecarts });
    } catch (error) {
        console.error('Erreur list ecarts:', error);
        return res.status(500).json({ success: false, message: 'Erreur serveur.' });
    }
});

/**
 * GET /api/ecarts/actions-internes
 * Liste les actions internes disponibles pour la clôture d'écarts
 */
router.get('/actions-internes', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT Id, Libelle, Description, Ordre
             FROM ActionInterneEcart
             WHERE EstActif = 1
             ORDER BY Ordre ASC, Libelle ASC`
        );

        return res.json({ success: true, actions: rows });
    } catch (error) {
        console.error('Erreur list actions internes ecart:', error);
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
              eq.NumeroInterne, eq.Affectation, eq.Localisation, eq.Observations AS EquipementObservations,
              eq.Status AS EquipementStatus,
              te.NomType, te.Famille
       FROM Ecart e
       LEFT JOIN Equipement eq ON e.IdEquipement = eq.IdEquipement
       LEFT JOIN TypeEquipement te ON eq.IdType = te.IdType
       WHERE e.IdEcart = ?`,
            [ecartId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Écart non trouvé.' });
        }

        const row = rows[0];
        const ecart = {
            ...row,
            statusLabel: mapStatusToLabel(row.Status),
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
            const isCreatorSending = (creatorId === userId);
            const targetUserId = (!isCreatorSending && creatorId) ? creatorId : null;

            // Notification en base
            try {
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
            } catch (notifErr) {
                console.warn('Notification message ignorée:', notifErr.message);
            }

            // Push notification (non-bloquant)
            try {
                let pushTokens = [];
                if (isCreatorSending) {
                    // Créateur envoie → notifier les admins
                    pushTokens = await getAdminPushTokens(pool);
                } else if (creatorId) {
                    // Admin envoie → notifier le créateur
                    pushTokens = await getUserPushTokens(pool, [creatorId]);
                }

                const [senderRow] = await pool.execute(
                    `SELECT Prenom, Nom FROM Utilisateurs WHERE IdUtilisateur = ?`,
                    [userId]
                );
                const senderName = senderRow.length > 0
                    ? `${senderRow[0].Prenom || ''} ${senderRow[0].Nom || ''}`.trim()
                    : 'Quelqu\'un';

                await sendPushNotifications(
                    pushTokens,
                    `Écart #${ecartId} - Nouveau message`,
                    `${senderName} : ${message.trim().substring(0, 100)}`,
                    { screen: 'ecart-discussion', ecartId: String(ecartId) }
                );
            } catch (pushErr) {
                console.warn('[Push] Erreur message:', pushErr.message);
            }
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

        const numericStatus = parseInt(status, 10);
        const validStatuses = [0, 1, 2, 3];
        if (!validStatuses.includes(numericStatus)) {
            return res.status(400).json({ success: false, message: 'Statut invalide.' });
        }

        const dbStatus = mapCodeToDbStatus(numericStatus);
        if (!dbStatus) {
            return res.status(400).json({ success: false, message: 'Statut invalide.' });
        }

        // Vérifier que l'écart existe
        const [ecartRows] = await pool.execute(
            `SELECT IdEcart, Status FROM Ecart WHERE IdEcart = ?`,
            [ecartId]
        );

        if (ecartRows.length === 0) {
            return res.status(404).json({ success: false, message: 'Écart non trouvé.' });
        }

        // Mettre à jour le statut de l'écart (texte, comme le logiciel)
        await pool.execute(
            `UPDATE Ecart SET Status = ? WHERE IdEcart = ?`,
            [dbStatus, ecartId]
        );

        // Libellé pour le front (mêmes valeurs que statusLabel)
        const newStatusLabel = mapStatusToLabel(dbStatus);

        // Message par défaut si pas d'observation (comme le logiciel)
        const defaultMessages = {
            'EnCours': 'Écart marqué comme "En cours"',
            'Resolu':  'Écart marqué comme "Résolu"',
            'Ouvert':  'Écart remis en "Ouvert"',
            'Ferme':   'Écart clôturé',
        };
        const messageText = (observation && observation.trim())
            ? observation.trim()
            : (defaultMessages[newStatusLabel] || `Statut changé : ${newStatusLabel}`);

        await pool.execute(
            `INSERT INTO MessagesEcart (IdEcart, IdUtilisateur, Message, NouveauStatus, DateCreation, Lu)
       VALUES (?, ?, ?, ?, NOW(), 0)`,
            [ecartId, userId, messageText, newStatusLabel]
        );

        // Créer une notification (non-bloquante — ne doit pas faire échouer la réponse)
        try {
            const [userRows] = await pool.execute(
                `SELECT IdUtilisateurCreateur FROM Ecart WHERE IdEcart = ?`,
                [ecartId]
            );

            if (userRows.length > 0) {
                const creatorId = userRows[0].IdUtilisateurCreateur;
                const targetUserId = (creatorId !== null && creatorId !== userId) ? creatorId : null;

                // N'insérer la notification que si on a un destinataire valide
                if (targetUserId !== null) {
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
            }
        } catch (notifError) {
            // La notification est optionnelle, on log sans bloquer la réponse
            console.warn('Erreur création notification (non-bloquante):', notifError.message);
        }

        // Notification push (non-bloquante)
        try {
            const [userRows2] = await pool.execute(
                `SELECT IdUtilisateurCreateur FROM Ecart WHERE IdEcart = ?`,
                [ecartId]
            );
            if (userRows2.length > 0) {
                const creatorId2 = userRows2[0].IdUtilisateurCreateur;
                let pushTokens = [];
                if (creatorId2 && creatorId2 !== userId) {
                    pushTokens = await getUserPushTokens(pool, [creatorId2]);
                } else {
                    pushTokens = await getAdminPushTokens(pool);
                }
                await sendPushNotifications(
                    pushTokens,
                    `Écart #${ecartId} - Statut mis à jour`,
                    `Le statut est maintenant : ${newStatusLabel.replace('EnCours', 'En cours')}`,
                    { screen: 'ecart-discussion', ecartId: String(ecartId) }
                );
            }
        } catch (pushErr) {
            console.warn('[Push] Erreur statut:', pushErr.message);
        }

        return res.json({ success: true, statusLabel: newStatusLabel });
    } catch (error) {
        console.error('Erreur update status ecart:', error);
        return res.status(500).json({ success: false, message: 'Erreur serveur.' });
    }
});

/**
 * POST /api/ecarts/:id/cloture
 * Clôturer un écart avec formulaire détaillé (comme le logiciel)
 * Body: {
 *   typeCloture: 'PasAction' | 'ActionInterne' | 'ActionExterne',
 *   raisonPasAction?: string,
 *   idActionInterne?: number,
 *   dateTravaux?: string (YYYY-MM-DD),
 *   descriptifTravaux?: string,
 *   prestataireExterne?: string,
 *   dateInterventionExterne?: string (YYYY-MM-DD)
 * }
 */
router.post('/:id/cloture', async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const ecartId = req.params.id;
        const userId = req.user.id;
        const {
            typeCloture,
            raisonPasAction,
            idActionInterne,
            dateTravaux,
            descriptifTravaux,
            prestataireExterne,
            dateInterventionExterne,
        } = req.body;

        // Validation type
        const allowedTypes = ['PasAction', 'ActionInterne', 'ActionExterne'];
        if (!typeCloture || !allowedTypes.includes(typeCloture)) {
            return res.status(400).json({ success: false, message: 'Type de clôture invalide.' });
        }

        // Validation détaillée (on reste proche du logiciel, sans être bloquant sur les dates)
        if (typeCloture === 'PasAction') {
            const txt = (raisonPasAction || '').trim();
            if (!txt || txt.length < 10) {
                return res.status(400).json({
                    success: false,
                    message: 'La raison du non-traitement est obligatoire (au moins 10 caractères).',
                });
            }
        } else if (typeCloture === 'ActionInterne') {
            if (!idActionInterne) {
                return res.status(400).json({
                    success: false,
                    message: 'Une action interne doit être sélectionnée.',
                });
            }
            const desc = (descriptifTravaux || '').trim();
            if (!desc || desc.length < 10) {
                return res.status(400).json({
                    success: false,
                    message: 'Le descriptif des travaux internes est obligatoire (au moins 10 caractères).',
                });
            }
        } else if (typeCloture === 'ActionExterne') {
            const prest = (prestataireExterne || '').trim();
            const desc = (descriptifTravaux || '').trim();
            if (!prest) {
                return res.status(400).json({
                    success: false,
                    message: 'Le nom du prestataire externe est obligatoire.',
                });
            }
            if (!desc || desc.length < 10) {
                return res.status(400).json({
                    success: false,
                    message: "Le descriptif des travaux externes est obligatoire (au moins 10 caractères).",
                });
            }
        }

        // Normaliser les dates (laisser null si vide)
        const dateTravauxDb = dateTravaux && String(dateTravaux).trim() ? String(dateTravaux).trim() : null;
        const dateIntervDb =
            dateInterventionExterne && String(dateInterventionExterne).trim()
                ? String(dateInterventionExterne).trim()
                : null;

        await connection.beginTransaction();

        // Récupérer l'écart et l'équipement (pour le résumé et la notif)
        const [ecartRows] = await connection.execute(
            `SELECT e.IdEcart, e.Action, e.IdEquipement, eq.NumeroInterne
             FROM Ecart e
             LEFT JOIN Equipement eq ON e.IdEquipement = eq.IdEquipement
             WHERE e.IdEcart = ?`,
            [ecartId]
        );

        if (ecartRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: 'Écart non trouvé.' });
        }

        const ecartRow = ecartRows[0];

        // Récupérer éventuellement l'action interne pour le libellé
        let actionInterneLibelle = null;
        if (typeCloture === 'ActionInterne' && idActionInterne) {
            const [actionRows] = await connection.execute(
                `SELECT Libelle FROM ActionInterneEcart WHERE Id = ?`,
                [idActionInterne]
            );
            if (actionRows.length > 0) {
                actionInterneLibelle = actionRows[0].Libelle;
            }
        }

        // Enregistrement de clôture (non-bloquant — la table peut ne pas exister en dev)
        try {
            await connection.execute(
                `INSERT INTO ClotureEcart
                 (IdEcart, TypeCloture, RaisonPasAction, IdActionInterne, DescriptifTravaux,
                  DateTravaux, PrestataireExterne, DateInterventionExterne, DateCloture, IdUtilisateurCloture)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
                [
                    ecartId,
                    typeCloture,
                    typeCloture === 'PasAction' ? (raisonPasAction || '').trim() : null,
                    typeCloture === 'ActionInterne' ? idActionInterne || null : null,
                    descriptifTravaux ? descriptifTravaux.trim() : null,
                    typeCloture === 'ActionInterne' ? dateTravauxDb : null,
                    typeCloture === 'ActionExterne' ? (prestataireExterne || '').trim() : null,
                    typeCloture === 'ActionExterne' ? dateIntervDb : null,
                    userId || null,
                ]
            );
        } catch (clotureInsertErr) {
            console.warn('ClotureEcart INSERT ignoré (table absente ou contrainte):', clotureInsertErr.message);
        }

        // Générer le résumé de clôture (même logique que le logiciel)
        let resumeCloture = '';
        if (typeCloture === 'PasAction') {
            resumeCloture = `Pas d'action - Raison: ${(raisonPasAction || '').trim()}`;
        } else if (typeCloture === 'ActionInterne') {
            resumeCloture =
                `Action interne (${actionInterneLibelle || 'N/A'})` +
                (dateTravauxDb ? ` - Date: ${formatDateFr(dateTravauxDb)}` : '') +
                (descriptifTravaux ? ` - Travaux: ${descriptifTravaux.trim()}` : '');
        } else if (typeCloture === 'ActionExterne') {
            resumeCloture =
                `Action externe par ${(prestataireExterne || '').trim()}` +
                (dateIntervDb ? ` - Date: ${formatDateFr(dateIntervDb)}` : '') +
                (descriptifTravaux ? ` - Travaux: ${descriptifTravaux.trim()}` : '');
        }

        const now = new Date();
        const resumeLigne = `[${formatDateTimeFr(now)}] CLÔTURE: ${resumeCloture}`;
        const nouvelleAction = `${ecartRow.Action || ''}\n\n${resumeLigne}`.trim();

        // Mettre l'écart en "Résolu" et ajouter le résumé dans Action
        await connection.execute(
            `UPDATE Ecart SET Status = 'Résolu', Action = ? WHERE IdEcart = ?`,
            [nouvelleAction, ecartId]
        );

        // Créer un message d'historique
        const friendlyType = getFriendlyClotureType(typeCloture);
        await connection.execute(
            `INSERT INTO MessagesEcart (IdEcart, IdUtilisateur, Message, NouveauStatus, DateCreation, Lu)
             VALUES (?, ?, ?, ?, NOW(), 0)`,
            [
                ecartId,
                userId || null,
                `Écart clôturé - ${friendlyType}`,
                'Cloture',
            ]
        );

        // Notification (non-bloquante)
        try {
            const titreNotif = 'Écart clôturé';
            const messageNotifLines = [];
            if (ecartRow.NumeroInterne) {
                messageNotifLines.push(`L'écart sur l'équipement ${ecartRow.NumeroInterne} a été clôturé`);
            } else {
                messageNotifLines.push("Un écart a été clôturé");
            }
            messageNotifLines.push(`Type: ${friendlyType}`);

            // Chercher un admin à notifier plutôt que d'insérer NULL
            const [adminRows] = await connection.execute(
                `SELECT IdUtilisateur FROM Utilisateurs WHERE Role = 'ADMIN' LIMIT 1`
            );
            if (adminRows.length > 0) {
                await connection.execute(
                    `INSERT INTO Notifications (IdUtilisateur, Titre, Message, Type, Lien, DateCreation, Lu)
                     VALUES (?, ?, ?, 'ClotureEcart', ?, NOW(), 0)`,
                    [
                        adminRows[0].IdUtilisateur,
                        titreNotif,
                        messageNotifLines.join('\n'),
                        String(ecartId),
                    ]
                );
            }
        } catch (notifErr) {
            console.warn('Notification clôture ignorée (non-bloquante):', notifErr.message);
        }

        await connection.commit();

        return res.json({ success: true });
    } catch (error) {
        try {
            await connection.rollback();
        } catch (rollbackError) {
            console.error('Erreur rollback cloture ecart:', rollbackError);
        }
        console.error('Erreur cloture ecart:', error);
        return res.status(500).json({ success: false, message: 'Erreur serveur.' });
    } finally {
        connection.release();
    }
});

module.exports = router;
