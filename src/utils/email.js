const nodemailer = require('nodemailer');

const LOGO_URL = 'https://support.mim-foselev.fr/logos/logo_MIM.png';

function getTransporter() {
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = String(process.env.SMTP_SECURE || 'true').toLowerCase() === 'true';

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
}

function isEmailConfigured() {
  return Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS);
}

async function sendEmail({ to, subject, html }) {
  if (!isEmailConfigured()) {
    console.warn('[Email] EMAIL_USER/EMAIL_PASS non configurés. Envoi ignoré.');
    return false;
  }

  try {
    const transporter = getTransporter();
    await transporter.sendMail({
      from: `"MIM Mobile" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html,
    });
    return true;
  } catch (error) {
    console.error('[Email] Erreur envoi:', error);
    return false;
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getForgotPasswordCodeEmailHtml({ prenom, code }) {
  const safePrenom = escapeHtml(prenom || 'Utilisateur');
  const safeCode = escapeHtml(code);

  return `
  <!DOCTYPE html>
  <html>
  <head>
      <meta charset="utf-8">
      <style>
          body { font-family: 'Segoe UI', Arial, sans-serif; background: #f5f5f5; color: #333; padding: 20px; margin: 0; }
          .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
          .header { background: #ffffff; padding: 30px; text-align: center; border-bottom: 1px solid #eee; }
          .header img { max-width: 200px; height: auto; }
          .content { padding: 30px; }
          .title { color: #E65C00; font-size: 20px; font-weight: 600; margin: 0 0 20px 0; border-left: 4px solid #E65C00; padding-left: 15px; }
          .text { color: #555; font-size: 15px; line-height: 1.5; margin-bottom: 16px; }
          .code-box { background: #fff7ed; border: 1px solid #fed7aa; border-radius: 6px; padding: 20px; text-align: center; margin: 20px 0; }
          .code { font-size: 34px; font-weight: 700; color: #c2410c; letter-spacing: 8px; }
          .hint { color: #777; font-size: 13px; text-align: center; margin-top: 12px; }
          .footer { background: #f5f5f5; color: #666; text-align: center; padding: 20px; font-size: 12px; border-top: 1px solid #eee; }
      </style>
  </head>
  <body>
      <div class="container">
          <div class="header">
              <img src="${LOGO_URL}" alt="MIM Groupe Foselev">
          </div>
          <div class="content">
              <h1 class="title">Mot de passe oublié</h1>
              <p class="text">Bonjour ${safePrenom},</p>
              <p class="text">Vous avez demandé la réinitialisation de votre mot de passe. Utilisez le code suivant dans l'application mobile :</p>

              <div class="code-box">
                  <div class="code">${safeCode}</div>
              </div>

              <p class="hint">Ce code expire dans 15 minutes.</p>
              <p class="hint">Si vous n’êtes pas à l’origine de cette demande, ignorez cet email.</p>
          </div>
          <div class="footer">
              MIM Mobile - Groupe Foselev
          </div>
      </div>
  </body>
  </html>
  `;
}

module.exports = {
  sendEmail,
  getForgotPasswordCodeEmailHtml,
};
