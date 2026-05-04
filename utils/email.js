const nodemailer = require('nodemailer');

const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const FROM = process.env.EMAIL_FROM || 'ComparateurTN <noreply@comparateurtn.com>';

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
  return transporter;
}

function baseTemplate(content) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>ComparateurTN</title>
</head>
<body style="margin:0;padding:0;background:#0f172a;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 20px;">
<tr><td align="center">
<table width="100%" style="max-width:560px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:20px;overflow:hidden;">
<tr>
  <td style="background:linear-gradient(135deg,#059669,#34d399);padding:28px 36px;text-align:center;">
    <span style="font-size:32px;font-weight:800;color:white;letter-spacing:-0.5px;">C</span>
    <span style="font-size:18px;font-weight:700;color:white;margin-left:8px;">ComparateurTN</span>
  </td>
</tr>
<tr>
  <td style="padding:36px;">
    ${content}
  </td>
</tr>
<tr>
  <td style="padding:20px 36px 28px;border-top:1px solid rgba(255,255,255,0.08);text-align:center;">
    <p style="margin:0;font-size:12px;color:rgba(248,250,252,0.35);">
      © 2026 ComparateurTN — Tunisianet · SpaceNet · Skymil · Mytek<br>
      <a href="${APP_URL}" style="color:rgba(52,211,153,0.7);text-decoration:none;">comparateurtn.com</a>
    </p>
  </td>
</tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function ctaButton(href, label) {
  return `<a href="${href}" style="display:inline-block;margin:20px 0;padding:14px 32px;background:linear-gradient(135deg,#059669,#34d399);color:white;font-size:15px;font-weight:700;text-decoration:none;border-radius:12px;box-shadow:0 8px 24px rgba(5,150,105,0.35);">${label}</a>`;
}

function heading(text) {
  return `<h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#f8fafc;">${text}</h1>`;
}

function paragraph(text) {
  return `<p style="margin:0 0 14px;font-size:15px;color:rgba(248,250,252,0.75);line-height:1.6;">${text}</p>`;
}

function warning(text) {
  return `<div style="margin:16px 0;padding:14px 18px;background:rgba(220,38,38,0.1);border:1px solid rgba(220,38,38,0.25);border-radius:10px;font-size:13px;color:#fca5a5;">${text}</div>`;
}

function info(text) {
  return `<div style="margin:16px 0;padding:14px 18px;background:rgba(52,211,153,0.08);border:1px solid rgba(52,211,153,0.2);border-radius:10px;font-size:13px;color:rgba(52,211,153,0.9);">${text}</div>`;
}

async function sendVerificationEmail(user, token) {
  const link = `${APP_URL}/auth/verify-email/${token}`;
  const html = baseTemplate(`
    ${heading('Bienvenue sur ComparateurTN !')}
    ${paragraph(`Bonjour <strong style="color:#f8fafc;">${user.displayName || user.username}</strong>,`)}
    ${paragraph('Merci de vous être inscrit. Veuillez vérifier votre adresse e-mail pour activer votre compte et accéder à toutes les fonctionnalités.')}
    <div style="text-align:center;">${ctaButton(link, 'Vérifier mon adresse e-mail')}</div>
    ${info('Ce lien expire dans <strong>24 heures</strong>.')}
    ${paragraph('Si vous n\'avez pas créé de compte, ignorez cet e-mail.')}
    <p style="margin:16px 0 0;font-size:12px;color:rgba(248,250,252,0.35);">Lien : <a href="${link}" style="color:rgba(52,211,153,0.6);word-break:break-all;">${link}</a></p>
  `);
  return getTransporter().sendMail({
    from: FROM,
    to: user.email,
    subject: 'Vérifiez votre adresse e-mail — ComparateurTN',
    html,
    text: `Bonjour ${user.displayName || user.username},\n\nVérifiez votre e-mail : ${link}\n\nCe lien expire dans 24 heures.`
  });
}

async function sendPasswordResetEmail(user, token) {
  const link = `${APP_URL}/reset-password?token=${token}`;
  const html = baseTemplate(`
    ${heading('Réinitialisation de votre mot de passe')}
    ${paragraph(`Bonjour <strong style="color:#f8fafc;">${user.displayName || user.username}</strong>,`)}
    ${paragraph('Vous avez demandé la réinitialisation de votre mot de passe. Cliquez sur le bouton ci-dessous pour continuer.')}
    <div style="text-align:center;">${ctaButton(link, 'Réinitialiser mon mot de passe')}</div>
    ${warning('Ce lien expire dans <strong>1 heure</strong>. Si vous n\'êtes pas à l\'origine de cette demande, ignorez cet e-mail — votre mot de passe restera inchangé.')}
    <p style="margin:16px 0 0;font-size:12px;color:rgba(248,250,252,0.35);">Lien : <a href="${link}" style="color:rgba(52,211,153,0.6);word-break:break-all;">${link}</a></p>
  `);
  return getTransporter().sendMail({
    from: FROM,
    to: user.email,
    subject: 'Réinitialisation de mot de passe — ComparateurTN',
    html,
    text: `Bonjour ${user.displayName || user.username},\n\nRéinitialisez votre mot de passe : ${link}\n\nCe lien expire dans 1 heure.`
  });
}

async function sendPasswordChangedEmail(user) {
  const now = new Date().toLocaleString('fr-TN', { timeZone: 'Africa/Tunis' });
  const html = baseTemplate(`
    ${heading('Votre mot de passe a été modifié')}
    ${paragraph(`Bonjour <strong style="color:#f8fafc;">${user.displayName || user.username}</strong>,`)}
    ${paragraph('Votre mot de passe a été modifié avec succès.')}
    ${info(`Date et heure : <strong>${now} (heure de Tunis)</strong>`)}
    ${warning('Si vous n\'êtes pas à l\'origine de cette modification, contactez-nous immédiatement à <a href="mailto:support@comparateurtn.com" style="color:#fca5a5;">support@comparateurtn.com</a>.')}
  `);
  return getTransporter().sendMail({
    from: FROM,
    to: user.email,
    subject: 'Mot de passe modifié — ComparateurTN',
    html,
    text: `Votre mot de passe a été modifié le ${now}. Si ce n'est pas vous, contactez support@comparateurtn.com.`
  });
}

async function sendAccountLockedEmail(user, durationMinutes) {
  const html = baseTemplate(`
    ${heading('Compte temporairement verrouillé')}
    ${paragraph(`Bonjour <strong style="color:#f8fafc;">${user.displayName || user.username}</strong>,`)}
    ${warning(`Votre compte a été verrouillé pendant <strong>${durationMinutes} minutes</strong> suite à plusieurs tentatives de connexion échouées.`)}
    ${paragraph('Si vous avez oublié votre mot de passe, vous pouvez le réinitialiser via le lien ci-dessous.')}
    <div style="text-align:center;">${ctaButton(`${APP_URL}/forgot-password`, 'Réinitialiser mon mot de passe')}</div>
    ${paragraph('Si vous n\'êtes pas à l\'origine de ces tentatives, nous vous recommandons de modifier votre mot de passe dès que possible.')}
  `);
  return getTransporter().sendMail({
    from: FROM,
    to: user.email,
    subject: 'Compte verrouillé — ComparateurTN',
    html,
    text: `Votre compte a été verrouillé pour ${durationMinutes} minutes. Réinitialisez votre mot de passe : ${APP_URL}/forgot-password`
  });
}

module.exports = {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendPasswordChangedEmail,
  sendAccountLockedEmail
};
