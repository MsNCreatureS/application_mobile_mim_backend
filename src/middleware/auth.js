const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Token manquant.' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    return next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Token invalide ou expiré.' });
    }

    console.error('Erreur auth middleware:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
}

module.exports = { requireAuth };
