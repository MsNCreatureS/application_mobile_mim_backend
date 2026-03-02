const { Expo } = require('expo-server-sdk');

// Optionnel : EXPO_ACCESS_TOKEN en .env pour dépasser la limite des  1000 notifs/jour sans auth
const expo = new Expo(
    process.env.EXPO_ACCESS_TOKEN ? { accessToken: process.env.EXPO_ACCESS_TOKEN } : {}
);

/**
 * Envoie des push notifications Expo à une liste de tokens.
 * Silencieux en cas d'erreur (ne doit jamais bloquer une réponse API).
 * @param {string[]} tokens   - Liste de tokens ExponentPushToken[…]
 * @param {string}   title    - Titre de la notification
 * @param {string}   body     - Corps du message
 * @param {object}   data     - Données supplémentaires (nav, etc.)
 */
async function sendPushNotifications(tokens, title, body, data = {}) {
    if (!tokens || tokens.length === 0) return;

    const messages = tokens
        .filter(t => t && Expo.isExpoPushToken(t))
        .map(token => ({
            to: token,
            sound: 'default',
            title,
            body,
            data,
            priority: 'high',
            badge: 1,
        }));

    if (messages.length === 0) return;

    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
        try {
            const tickets = await expo.sendPushNotificationsAsync(chunk);
            tickets.forEach(ticket => {
                if (ticket.status === 'error') {
                    console.warn('[Push] Erreur ticket:', ticket.message, ticket.details?.error);
                }
            });
        } catch (err) {
            console.error('[Push] Erreur envoi batch:', err.message);
        }
    }
}

/**
 * Récupère les tokens push d'une liste d'utilisateurs.
 * Retourne [] si la table n'existe pas encore.
 */
async function getUserPushTokens(pool, userIds) {
    if (!userIds || userIds.length === 0) return [];
    const ids = userIds.filter(Boolean);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    try {
        const [rows] = await pool.execute(
            `SELECT Token FROM UserPushTokens WHERE IdUtilisateur IN (${placeholders}) AND Token IS NOT NULL`,
            ids
        );
        return rows.map(r => r.Token);
    } catch {
        return [];
    }
}

/**
 * Récupère les tokens push de tous les admins.
 */
async function getAdminPushTokens(pool) {
    try {
        const [rows] = await pool.execute(
            `SELECT upt.Token
             FROM UserPushTokens upt
             INNER JOIN Utilisateurs u ON upt.IdUtilisateur = u.IdUtilisateur
             WHERE u.Role = 'ADMIN' AND upt.Token IS NOT NULL`
        );
        return rows.map(r => r.Token);
    } catch {
        return [];
    }
}

module.exports = { sendPushNotifications, getUserPushTokens, getAdminPushTokens };
