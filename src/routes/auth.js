const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../config/database');
const { hashPassword } = require('../utils/hash');

const router = express.Router();

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

module.exports = router;
