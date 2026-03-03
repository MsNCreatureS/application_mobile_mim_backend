const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../config/database');
const { hashPassword } = require('../utils/hash');
const { requireAuth } = require('../middleware/auth');
const { sendEmail, getForgotPasswordCodeEmailHtml } = require('../utils/email');

const router = express.Router();

async function ensurePasswordResetTable() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS MobilePasswordResetCodes (
      Id INT NOT NULL AUTO_INCREMENT,
      IdUtilisateur INT NOT NULL,
      Email VARCHAR(255) NOT NULL,
      Code VARCHAR(6) NOT NULL,
      ExpireAt DATETIME NOT NULL,
      IsUsed TINYINT(1) NOT NULL DEFAULT 0,
      CreatedAt DATETIME NOT NULL DEFAULT NOW(),
      PRIMARY KEY (Id),
      INDEX idx_email (Email),
      INDEX idx_expire (ExpireAt)
    )
  `);
}

function generateSixDigitCode() {
  const value = crypto.randomInt(0, 1000000);
  return String(value).padStart(6, '0');
}

/**
 * POST /api/auth/login
 * Body: { email, password }
 * Compatible avec le hash SHA256 du logiciel C#
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email et mot de passe requis.',
      });
    }

    const [rows] = await pool.execute(
      'SELECT * FROM Utilisateurs WHERE Email = ?',
      [email]
    );

    if (rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Email ou mot de passe incorrect.',
      });
    }

    const utilisateur = rows[0];
    const motDePasseHashe = hashPassword(password);

    if (utilisateur.MotDePasseHashe !== motDePasseHashe) {
      return res.status(401).json({
        success: false,
        message: 'Email ou mot de passe incorrect.',
      });
    }

    const token = jwt.sign(
      {
        id: utilisateur.IdUtilisateur,
        email: utilisateur.Email,
        role: utilisateur.Role,
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({
      success: true,
      token,
      user: {
        id: utilisateur.IdUtilisateur,
        email: utilisateur.Email,
        nom: utilisateur.Nom,
        prenom: utilisateur.Prenom,
        role: utilisateur.Role,
        estPremiereConnexion: utilisateur.EstPremiereConnexion === 1,
      },
    });
  } catch (error) {
    console.error('Erreur login:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur serveur.',
    });
  }
});

/**
 * POST /api/auth/forgot-password/request
 * Body: { email }
 */
router.post('/forgot-password/request', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim();

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email requis.',
      });
    }

    await ensurePasswordResetTable();

    const [users] = await pool.execute(
      'SELECT IdUtilisateur, Email, Prenom FROM Utilisateurs WHERE Email = ? LIMIT 1',
      [email]
    );

    if (users.length === 0) {
      return res.json({
        success: true,
        message: 'Si cet email existe, un code vous a été envoyé.',
      });
    }

    const user = users[0];
    const code = generateSixDigitCode();

    await pool.execute(
      `UPDATE MobilePasswordResetCodes
       SET IsUsed = 1
       WHERE Email = ? AND IsUsed = 0`,
      [email]
    );

    await pool.execute(
      `INSERT INTO MobilePasswordResetCodes (IdUtilisateur, Email, Code, ExpireAt, IsUsed)
       VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 15 MINUTE), 0)`,
      [user.IdUtilisateur, email, code]
    );

    const emailSent = await sendEmail({
      to: email,
      subject: 'MIM Mobile - Code mot de passe oublié',
      html: getForgotPasswordCodeEmailHtml({
        prenom: user.Prenom,
        code,
      }),
    });

    if (!emailSent) {
      return res.status(500).json({
        success: false,
        message: 'Impossible d’envoyer l’email pour le moment.',
      });
    }

    return res.json({
      success: true,
      message: 'Si cet email existe, un code vous a été envoyé.',
    });
  } catch (error) {
    console.error('Erreur forgot-password/request:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

/**
 * POST /api/auth/forgot-password/verify
 * Body: { email, code }
 */
router.post('/forgot-password/verify', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim();
    const code = String(req.body?.code || '').trim();

    if (!email || !code) {
      return res.status(400).json({ success: false, message: 'Email et code requis.' });
    }

    await ensurePasswordResetTable();

    const [rows] = await pool.execute(
      `SELECT Id, IdUtilisateur
       FROM MobilePasswordResetCodes
       WHERE Email = ? AND Code = ? AND IsUsed = 0 AND ExpireAt > NOW()
       ORDER BY Id DESC
       LIMIT 1`,
      [email, code]
    );

    if (rows.length === 0) {
      return res.status(400).json({ success: false, message: 'Code invalide ou expiré.' });
    }

    const resetToken = jwt.sign(
      {
        id: rows[0].IdUtilisateur,
        email,
        purpose: 'password-reset',
      },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );

    return res.json({ success: true, resetToken });
  } catch (error) {
    console.error('Erreur forgot-password/verify:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

/**
 * POST /api/auth/forgot-password/reset
 * Body: { resetToken, newPassword }
 */
router.post('/forgot-password/reset', async (req, res) => {
  try {
    const resetToken = String(req.body?.resetToken || '').trim();
    const newPassword = String(req.body?.newPassword || '');

    if (!resetToken || !newPassword) {
      return res.status(400).json({ success: false, message: 'Token et nouveau mot de passe requis.' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'Le mot de passe doit contenir au moins 6 caractères.' });
    }

    let decoded;
    try {
      decoded = jwt.verify(resetToken, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ success: false, message: 'Token invalide ou expiré.' });
    }

    if (decoded.purpose !== 'password-reset' || !decoded.id || !decoded.email) {
      return res.status(401).json({ success: false, message: 'Token invalide.' });
    }

    const hashed = hashPassword(newPassword);

    await pool.execute(
      'UPDATE Utilisateurs SET MotDePasseHashe = ?, EstPremiereConnexion = 0 WHERE IdUtilisateur = ? AND Email = ?',
      [hashed, decoded.id, decoded.email]
    );

    await ensurePasswordResetTable();
    await pool.execute(
      'UPDATE MobilePasswordResetCodes SET IsUsed = 1 WHERE Email = ? AND IsUsed = 0',
      [decoded.email]
    );

    return res.json({ success: true, message: 'Mot de passe mis à jour.' });
  } catch (error) {
    console.error('Erreur forgot-password/reset:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

/**
 * GET /api/auth/me
 * Header: Authorization: Bearer <token>
 */
router.get('/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Token manquant.' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const [rows] = await pool.execute(
      'SELECT IdUtilisateur, Email, Nom, Prenom, Role, EstPremiereConnexion FROM Utilisateurs WHERE IdUtilisateur = ?',
      [decoded.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé.' });
    }

    const utilisateur = rows[0];
    return res.json({
      success: true,
      user: {
        id: utilisateur.IdUtilisateur,
        email: utilisateur.Email,
        nom: utilisateur.Nom,
        prenom: utilisateur.Prenom,
        role: utilisateur.Role,
        estPremiereConnexion: utilisateur.EstPremiereConnexion === 1,
      },
    });
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Token invalide ou expiré.' });
    }
    console.error('Erreur /me:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

/**
 * PUT /api/auth/push-token
 * Enregistre ou met à jour le token push Expo de l'utilisateur connecté.
 * Body: { token: 'ExponentPushToken[...]' }
 */
router.put('/push-token', requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const { token } = req.body;

        if (!token) {
            return res.status(400).json({ success: false, message: 'Token requis.' });
        }

        // Créer la table si elle n'existe pas encore
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS UserPushTokens (
                IdUtilisateur INT NOT NULL,
                Token         VARCHAR(255) NOT NULL,
                UpdatedAt     DATETIME DEFAULT NOW() ON UPDATE NOW(),
                PRIMARY KEY (IdUtilisateur)
            )
        `);

        // Upsert du token
        await pool.execute(
            `INSERT INTO UserPushTokens (IdUtilisateur, Token, UpdatedAt)
             VALUES (?, ?, NOW())
             ON DUPLICATE KEY UPDATE Token = VALUES(Token), UpdatedAt = NOW()`,
            [userId, token]
        );

        return res.json({ success: true });
    } catch (error) {
        console.error('Erreur save push token:', error);
        return res.status(500).json({ success: false, message: 'Erreur serveur.' });
    }
});

module.exports = router;
