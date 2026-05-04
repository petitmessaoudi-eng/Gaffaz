const express = require('express');
const router = express.Router();
const path = require('path');
const crypto = require('crypto');
const { body, param, validationResult } = require('express-validator');
const User = require('../models/User');
const SecurityLog = require('../models/SecurityLog');
const { requireUser } = require('../middleware/userAuth');
const emailUtils = require('../utils/email');

const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?])/;

function makeToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  const hashed = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hashed };
}

function logSecurity(type, userId, req, details = {}) {
  SecurityLog.create({
    type,
    userId: userId || null,
    ip: req.ip,
    userAgent: req.get('user-agent') || null,
    details
  }).catch(() => {});
}

function validationErrors(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const messages = errors.array().map(e => e.msg);
    res.status(400).json({ error: messages[0], errors: messages, code: 'VALIDATION_ERROR' });
    return true;
  }
  return false;
}

function isApiRequest(req) {
  return req.xhr
    || (req.headers['accept'] && req.headers['accept'].includes('application/json'))
    || (req.headers['content-type'] && req.headers['content-type'].includes('application/json'))
    || req.path.startsWith('/auth/');
}

router.get('/register', (req, res) => {
  res.redirect('/login?tab=register');
});

router.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/auth.html'));
});

router.get('/account', requireUser, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/account.html'));
});

router.get('/verify-email', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/verify-email.html'));
});

router.get('/forgot-password', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/forgot-password.html'));
});

router.get('/reset-password', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/reset-password.html'));
});

router.post('/auth/register', [
  body('email').trim().isEmail().normalizeEmail().withMessage('Adresse e-mail invalide'),
  body('username')
    .trim()
    .isLength({ min: 3, max: 20 }).withMessage('Nom d\'utilisateur : 3 à 20 caractères')
    .matches(/^[a-zA-Z0-9_]+$/).withMessage('Nom d\'utilisateur invalide (lettres, chiffres, _ uniquement)'),
  body('displayName').trim().isLength({ max: 50 }).withMessage('Nom d\'affichage trop long').optional({ checkFalsy: true }),
  body('password')
    .isLength({ min: 8, max: 128 }).withMessage('Le mot de passe doit contenir entre 8 et 128 caractères')
    .matches(PASSWORD_REGEX).withMessage('Le mot de passe doit contenir une majuscule, une minuscule, un chiffre et un caractère spécial'),
  body('confirmPassword').custom((val, { req }) => {
    if (val !== req.body.password) throw new Error('Les mots de passe ne correspondent pas');
    return true;
  }),
  body('terms').equals('true').withMessage('Vous devez accepter les conditions d\'utilisation')
], async (req, res) => {
  if (validationErrors(req, res)) return;
  try {
    const { email, username, displayName, password } = req.body;
    const existingEmail = await User.findOne({ email: email.toLowerCase() }).lean();
    if (existingEmail) {
      await new Promise(r => setTimeout(r, 300));
      return res.status(400).json({ error: 'Un compte avec cet e-mail existe déjà', code: 'EMAIL_TAKEN' });
    }
    const existingUsername = await User.findOne({ username: username.toLowerCase() }).lean();
    if (existingUsername) {
      return res.status(400).json({ error: 'Ce nom d\'utilisateur est déjà pris', code: 'USERNAME_TAKEN' });
    }
    const { raw, hashed } = makeToken();
    const user = new User({
      email: email.toLowerCase().trim(),
      username: username.trim(),
      displayName: (displayName || username).trim(),
      password,
      emailVerifyToken: hashed,
      emailVerifyExpires: new Date(Date.now() + 24 * 60 * 60 * 1000)
    });
    await user.save();
    emailUtils.sendVerificationEmail(user, raw).catch(() => {});
    logSecurity('register', user._id, req, { email: user.email });
    res.status(201).json({ success: true, message: 'Compte créé. Vérifiez votre e-mail pour activer votre compte.' });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ error: 'Cet e-mail ou nom d\'utilisateur est déjà utilisé', code: 'DUPLICATE' });
    }
    res.status(500).json({ error: 'Erreur interne du serveur', code: 'SERVER_ERROR' });
  }
});

router.get('/auth/verify-email/:token', [
  param('token').trim().isLength({ min: 10 }).withMessage('Token invalide')
], async (req, res) => {
  try {
    const hashed = crypto.createHash('sha256').update(req.params.token).digest('hex');
    const user = await User.findOne({
      emailVerifyToken: hashed,
      emailVerifyExpires: { $gt: new Date() }
    }).select('+emailVerifyToken +emailVerifyExpires');
    if (!user) {
      return res.redirect('/verify-email?status=invalid');
    }
    user.isEmailVerified = true;
    user.emailVerifyToken = null;
    user.emailVerifyExpires = null;
    await user.save();
    logSecurity('verify_email', user._id, req);
    res.redirect('/verify-email?status=success');
  } catch (err) {
    res.redirect('/verify-email?status=error');
  }
});

router.post('/auth/resend-verification', [
  body('email').trim().isEmail().normalizeEmail().withMessage('E-mail invalide')
], async (req, res) => {
  if (validationErrors(req, res)) return;
  try {
    const user = await User.findOne({ email: req.body.email.toLowerCase() })
      .select('+emailVerifyToken +emailVerifyExpires');
    if (!user || user.isEmailVerified) {
      return res.json({ success: true, message: 'Si ce compte existe, un e-mail a été envoyé.' });
    }
    const now = new Date();
    if (user.emailVerifyResendResetAt && user.emailVerifyResendResetAt > now) {
      if (user.emailVerifyResendCount >= 3) {
        return res.status(429).json({ error: 'Limite d\'envoi atteinte. Réessayez dans 1 heure.', code: 'RESEND_LIMIT' });
      }
    } else {
      user.emailVerifyResendCount = 0;
      user.emailVerifyResendResetAt = new Date(Date.now() + 60 * 60 * 1000);
    }
    const { raw, hashed } = makeToken();
    user.emailVerifyToken = hashed;
    user.emailVerifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    user.emailVerifyResendCount += 1;
    await user.save();
    emailUtils.sendVerificationEmail(user, raw).catch(() => {});
    logSecurity('resend_verification', user._id, req);
    res.json({ success: true, message: 'E-mail de vérification renvoyé.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur interne du serveur', code: 'SERVER_ERROR' });
  }
});

router.post('/auth/login', [
  body('email').trim().notEmpty().withMessage('E-mail ou nom d\'utilisateur requis'),
  body('password').notEmpty().withMessage('Mot de passe requis')
], async (req, res) => {
  if (validationErrors(req, res)) return;
  try {
    const { email, password } = req.body;
    const user = await User.findByEmailOrUsername(email);
    if (!user || !user.isActive) {
      await new Promise(r => setTimeout(r, 400));
      return res.status(401).json({ error: 'Identifiants incorrects', code: 'INVALID_CREDENTIALS' });
    }
    if (user.isLocked) {
      const remaining = Math.ceil((user.lockUntil - Date.now()) / 60000);
      logSecurity('login_locked', user._id, req);
      return res.status(423).json({
        error: `Compte verrouillé. Réessayez dans ${remaining} minute(s).`,
        code: 'ACCOUNT_LOCKED',
        remainingMinutes: remaining
      });
    }
    const match = await user.comparePassword(password);
    if (!match) {
      await user.incrementLoginAttempts();
      logSecurity('login_failed', user._id, req);
      if (user.isLocked) {
        const lockDuration = Math.ceil((user.lockUntil - Date.now()) / 60000);
        emailUtils.sendAccountLockedEmail(user, lockDuration).catch(() => {});
        return res.status(423).json({
          error: `Trop de tentatives. Compte verrouillé pour ${lockDuration} minutes.`,
          code: 'ACCOUNT_LOCKED',
          remainingMinutes: lockDuration
        });
      }
      const remaining = 5 - user.loginAttempts;
      return res.status(401).json({
        error: `Identifiants incorrects. ${remaining} tentative(s) restante(s) avant verrouillage.`,
        code: 'INVALID_CREDENTIALS'
      });
    }
    await user.resetLoginAttempts();
    user.lastLoginAt = new Date();
    user.lastLoginIP = req.ip;
    await user.save({ validateBeforeSave: false });
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: 'Erreur de session', code: 'SESSION_ERROR' });
      req.session.userId = user._id.toString();
      req.session.save(saveErr => {
        if (saveErr) return res.status(500).json({ error: 'Erreur de session', code: 'SESSION_ERROR' });
        logSecurity('login_success', user._id, req);
        res.json({ success: true, user: User.safeProfile(user) });
      });
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur interne du serveur', code: 'SERVER_ERROR' });
  }
});

router.post('/auth/logout', (req, res) => {
  const userId = req.session && req.session.userId;
  if (userId) logSecurity('logout', userId, req);
  req.session.destroy(err => {
    res.clearCookie('connect.sid');
    if (err) return res.status(500).json({ error: 'Erreur lors de la déconnexion', code: 'SESSION_ERROR' });
    res.json({ success: true });
  });
});

router.get('/auth/me', async (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Non autorisé', code: 'UNAUTHORIZED' });
  }
  try {
    const user = await User.findById(req.session.userId).lean();
    if (!user) return res.status(401).json({ error: 'Non autorisé', code: 'UNAUTHORIZED' });
    res.json({ user: User.safeProfile(user) });
  } catch (err) {
    res.status(500).json({ error: 'Erreur interne du serveur', code: 'SERVER_ERROR' });
  }
});

router.post('/auth/forgot-password', [
  body('email').trim().isEmail().normalizeEmail().withMessage('E-mail invalide')
], async (req, res) => {
  if (validationErrors(req, res)) return;
  try {
    const user = await User.findOne({ email: req.body.email.toLowerCase() })
      .select('+passwordResetToken +passwordResetExpires');
    if (user && user.isActive) {
      const { raw, hashed } = makeToken();
      user.passwordResetToken = hashed;
      user.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000);
      await user.save({ validateBeforeSave: false });
      emailUtils.sendPasswordResetEmail(user, raw).catch(() => {});
      logSecurity('forgot_password', user._id, req, { email: user.email });
    }
    res.json({ success: true, message: 'Si un compte correspond à cet e-mail, un lien de réinitialisation a été envoyé.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur interne du serveur', code: 'SERVER_ERROR' });
  }
});

router.post('/auth/reset-password/:token', [
  param('token').trim().isLength({ min: 10 }).withMessage('Token invalide'),
  body('password')
    .isLength({ min: 8, max: 128 }).withMessage('Le mot de passe doit contenir entre 8 et 128 caractères')
    .matches(PASSWORD_REGEX).withMessage('Le mot de passe doit contenir une majuscule, une minuscule, un chiffre et un caractère spécial'),
  body('confirmPassword').custom((val, { req }) => {
    if (val !== req.body.password) throw new Error('Les mots de passe ne correspondent pas');
    return true;
  })
], async (req, res) => {
  if (validationErrors(req, res)) return;
  try {
    const hashed = crypto.createHash('sha256').update(req.params.token).digest('hex');
    const user = await User.findOne({
      passwordResetToken: hashed,
      passwordResetExpires: { $gt: new Date() }
    }).select('+password +passwordResetToken +passwordResetExpires');
    if (!user) {
      return res.status(400).json({ error: 'Lien de réinitialisation invalide ou expiré', code: 'INVALID_TOKEN' });
    }
    user.password = req.body.password;
    user.passwordResetToken = null;
    user.passwordResetExpires = null;
    user.loginAttempts = 0;
    user.lockUntil = null;
    await user.save();
    emailUtils.sendPasswordChangedEmail(user).catch(() => {});
    logSecurity('reset_password', user._id, req);
    res.json({ success: true, message: 'Mot de passe réinitialisé avec succès.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur interne du serveur', code: 'SERVER_ERROR' });
  }
});

router.put('/auth/update-profile', requireUser, [
  body('displayName').trim().isLength({ max: 50 }).withMessage('Nom d\'affichage trop long').optional({ checkFalsy: true }),
  body('preferences.language').optional().isIn(['fr', 'ar', 'en']).withMessage('Langue invalide'),
  body('preferences.currency').optional().isIn(['TND', 'EUR', 'USD']).withMessage('Devise invalide'),
  body('preferences.emailNotifications.priceAlerts').optional().isBoolean(),
  body('preferences.emailNotifications.weeklyDigest').optional().isBoolean(),
  body('preferences.emailNotifications.reviews').optional().isBoolean()
], async (req, res) => {
  if (validationErrors(req, res)) return;
  try {
    const { displayName, preferences } = req.body;
    const update = {};
    if (displayName !== undefined) update.displayName = displayName.trim();
    if (preferences) {
      if (preferences.language) update['preferences.language'] = preferences.language;
      if (preferences.currency) update['preferences.currency'] = preferences.currency;
      if (preferences.emailNotifications) {
        const en = preferences.emailNotifications;
        if (en.priceAlerts !== undefined) update['preferences.emailNotifications.priceAlerts'] = en.priceAlerts;
        if (en.weeklyDigest !== undefined) update['preferences.emailNotifications.weeklyDigest'] = en.weeklyDigest;
        if (en.reviews !== undefined) update['preferences.emailNotifications.reviews'] = en.reviews;
      }
    }
    const user = await User.findByIdAndUpdate(req.session.userId, { $set: update }, { new: true, lean: true });
    logSecurity('update_profile', req.session.userId, req);
    res.json({ success: true, user: User.safeProfile(user) });
  } catch (err) {
    res.status(500).json({ error: 'Erreur interne du serveur', code: 'SERVER_ERROR' });
  }
});

router.put('/auth/change-password', requireUser, [
  body('currentPassword').notEmpty().withMessage('Mot de passe actuel requis'),
  body('newPassword')
    .isLength({ min: 8, max: 128 }).withMessage('Le nouveau mot de passe doit contenir entre 8 et 128 caractères')
    .matches(PASSWORD_REGEX).withMessage('Le nouveau mot de passe doit contenir une majuscule, une minuscule, un chiffre et un caractère spécial'),
  body('confirmPassword').custom((val, { req }) => {
    if (val !== req.body.newPassword) throw new Error('Les mots de passe ne correspondent pas');
    return true;
  })
], async (req, res) => {
  if (validationErrors(req, res)) return;
  try {
    const user = await User.findById(req.session.userId).select('+password');
    if (!user) return res.status(401).json({ error: 'Non autorisé', code: 'UNAUTHORIZED' });
    const match = await user.comparePassword(req.body.currentPassword);
    if (!match) {
      return res.status(401).json({ error: 'Mot de passe actuel incorrect', code: 'WRONG_PASSWORD' });
    }
    user.password = req.body.newPassword;
    await user.save();
    emailUtils.sendPasswordChangedEmail(user).catch(() => {});
    logSecurity('change_password', user._id, req);
    res.json({ success: true, message: 'Mot de passe modifié avec succès.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur interne du serveur', code: 'SERVER_ERROR' });
  }
});

router.delete('/auth/delete-account', requireUser, [
  body('password').notEmpty().withMessage('Mot de passe requis pour confirmer la suppression')
], async (req, res) => {
  if (validationErrors(req, res)) return;
  try {
    const user = await User.findById(req.session.userId).select('+password');
    if (!user) return res.status(401).json({ error: 'Non autorisé', code: 'UNAUTHORIZED' });
    const match = await user.comparePassword(req.body.password);
    if (!match) {
      return res.status(401).json({ error: 'Mot de passe incorrect', code: 'WRONG_PASSWORD' });
    }
    logSecurity('delete_account', user._id, req, { email: user.email });
    await User.findByIdAndDelete(user._id);
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.json({ success: true, message: 'Compte supprimé avec succès.' });
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur interne du serveur', code: 'SERVER_ERROR' });
  }
});

router.get('/auth/check-username/:username', [
  param('username')
    .trim()
    .isLength({ min: 3, max: 20 }).withMessage('Nom d\'utilisateur invalide')
    .matches(/^[a-zA-Z0-9_]+$/).withMessage('Caractères invalides')
], async (req, res) => {
  if (validationErrors(req, res)) return;
  try {
    const existing = await User.findOne({ username: req.params.username.toLowerCase() }).lean();
    res.json({ available: !existing });
  } catch (err) {
    res.status(500).json({ error: 'Erreur interne du serveur', code: 'SERVER_ERROR' });
  }
});

module.exports = router;