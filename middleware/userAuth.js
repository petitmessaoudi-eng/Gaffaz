const User = require('../models/User');

function requireUser(req, res, next) {
  if (req.session && req.session.userId) return next();
  if (req.xhr || req.path.startsWith('/auth/api') || req.headers['content-type'] === 'application/json') {
    return res.status(401).json({ error: 'Non autorisé', code: 'UNAUTHORIZED' });
  }
  return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
}

async function loadUser(req, res, next) {
  if (!req.session || !req.session.userId) {
    req.user = null;
    return next();
  }
  try {
    const user = await User.findById(req.session.userId).lean();
    if (!user || !user.isActive) {
      req.session.destroy(() => {});
      req.user = null;
      return next();
    }
    req.user = user;
    next();
  } catch (err) {
    req.user = null;
    next();
  }
}

function requireVerified(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Non autorisé', code: 'UNAUTHORIZED' });
  if (!req.user.isEmailVerified) {
    return res.status(403).json({ error: 'Email non vérifié', code: 'EMAIL_NOT_VERIFIED' });
  }
  next();
}

module.exports = { requireUser, loadUser, requireVerified };
