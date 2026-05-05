const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const BCRYPT_SALT_ROUNDS = 12;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_TIME_MS = 15 * 60 * 1000;

const COMMON_PASSWORDS = [
  'password','password1','password123','123456','12345678','123456789','1234567890',
  'qwerty','qwerty123','azerty','azerty123','abc123','abc1234','111111','000000',
  'monkey','1234567','letmein','trustno1','dragon','baseball','iloveyou','master',
  'sunshine','ashley','bailey','passw0rd','shadow','123123','superman','batman',
  'football','soccer','hockey','killer','george','andrew','charlie','donald',
  'welcome','login','admin','admin123','root','root123','toor','pass','test',
  'guest','qwertyuiop','1q2w3e4r','zxcvbnm','password!','P@ssword','P@ssw0rd',
  'Passw0rd','Admin123','Welcome1','123qwe','321321','666666','888888','999999'
];

const RESERVED_USERNAMES = [
  'admin','root','moderator','mod','administrator','support',
  'help','info','contact','noreply','system','superuser',
  'comparateurtn','staff','team'
];

const WatchlistItemSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  targetPrice: { type: Number, min: 0, default: null },
  addedAt: { type: Date, default: Date.now }
}, { _id: false });

const UserSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    maxlength: 254,
    match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  },
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    minlength: 3,
    maxlength: 20,
    match: /^[a-zA-Z0-9_]+$/,
    validate: {
      validator: function(v) {
        return !RESERVED_USERNAMES.includes(v.toLowerCase());
      },
      message: 'Nom d\'utilisateur réservé'
    }
  },
  password: {
    type: String,
    required: true,
    minlength: 8,
    maxlength: 128,
    select: false
  },
  displayName: {
    type: String,
    trim: true,
    maxlength: 50,
    default: ''
  },
  avatar: {
    type: String,
    default: null
  },
  isEmailVerified: { type: Boolean, default: false },
  emailVerifyToken: { type: String, default: null, select: false },
  emailVerifyExpires: { type: Date, default: null, select: false },
  emailVerifyResendCount: { type: Number, default: 0 },
  emailVerifyResendResetAt: { type: Date, default: null },
  passwordResetToken: { type: String, default: null, select: false },
  passwordResetExpires: { type: Date, default: null, select: false },
  loginAttempts: { type: Number, default: 0 },
  lockUntil: { type: Date, default: null },
  lockCount: { type: Number, default: 0 },
  lastLoginAt: { type: Date, default: null },
  lastLoginIP: { type: String, default: null },
  twoFactorEnabled: { type: Boolean, default: false },
  preferences: {
    language: { type: String, default: 'fr' },
    currency: { type: String, default: 'TND' },
    emailNotifications: {
      priceAlerts: { type: Boolean, default: true },
      weeklyDigest: { type: Boolean, default: false },
      reviews: { type: Boolean, default: true }
    }
  },
  watchlist: { type: [WatchlistItemSchema], default: [] },
  oauthProviders: { type: [mongoose.Schema.Types.Mixed], default: [] },
  isActive: { type: Boolean, default: true },
  role: { type: String, enum: ['user', 'moderator'], default: 'user' }
}, { timestamps: true });

UserSchema.index({ email: 1 }, { unique: true });
UserSchema.index({ username: 1 }, { unique: true });
UserSchema.index({ emailVerifyToken: 1 }, { sparse: true });
UserSchema.index({ passwordResetToken: 1 }, { sparse: true });
UserSchema.index({ createdAt: -1 });

UserSchema.virtual('isLocked').get(function() {
  return !!(this.lockUntil && this.lockUntil > Date.now());
});

UserSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  if (COMMON_PASSWORDS.includes(this.password.toLowerCase())) {
    return next(new Error('Mot de passe trop courant'));
  }
  this.password = await bcrypt.hash(this.password, BCRYPT_SALT_ROUNDS);
  next();
});

UserSchema.methods.comparePassword = async function(plaintext) {
  return bcrypt.compare(plaintext, this.password);
};

UserSchema.methods.incrementLoginAttempts = async function() {
  if (this.lockUntil && this.lockUntil < Date.now()) {
    this.loginAttempts = 1;
    this.lockUntil = null;
    return this.save();
  }
  this.loginAttempts += 1;
  if (this.loginAttempts >= MAX_LOGIN_ATTEMPTS && !this.isLocked) {
    this.lockCount = (this.lockCount || 0) + 1;
    const lockDuration = LOCK_TIME_MS * Math.pow(2, this.lockCount - 1);
    this.lockUntil = new Date(Date.now() + lockDuration);
  }
  return this.save();
};

UserSchema.methods.resetLoginAttempts = async function() {
  this.loginAttempts = 0;
  this.lockUntil = null;
  return this.save();
};

UserSchema.statics.findByEmailOrUsername = function(identifier) {
  const lower = identifier.toLowerCase().trim();
  return this.findOne({
    $or: [{ email: lower }, { username: lower }]
  }).select('+password');
};

UserSchema.statics.safeProfile = function(user) {
  return {
    id: user._id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    isEmailVerified: user.isEmailVerified,
    avatar: user.avatar,
    preferences: user.preferences,
    role: user.role,
    createdAt: user.createdAt
  };
};

module.exports = mongoose.model('User', UserSchema);
module.exports.COMMON_PASSWORDS = COMMON_PASSWORDS;
module.exports.RESERVED_USERNAMES = RESERVED_USERNAMES;