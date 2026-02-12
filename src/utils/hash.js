const crypto = require('crypto');

/**
 * Hash un mot de passe avec SHA256 (compatible avec le logiciel C#)
 * Le C# utilise SHA256 et convertit en hex lowercase
 */
function hashPassword(password) {
  return crypto.createHash('sha256').update(password, 'utf8').digest('hex');
}

module.exports = { hashPassword };
