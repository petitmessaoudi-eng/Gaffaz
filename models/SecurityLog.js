const mongoose = require('mongoose');

const SecurityLogSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true,
    enum: [
      'login_success','login_failed','login_locked',
      'register','logout',
      'verify_email','resend_verification',
      'forgot_password','reset_password',
      'change_password','update_profile',
      'delete_account','account_locked'
    ]
  },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  ip: { type: String, default: null },
  userAgent: { type: String, default: null },
  details: { type: mongoose.Schema.Types.Mixed, default: {} },
  timestamp: { type: Date, default: Date.now }
}, { timestamps: false });

SecurityLogSchema.index({ timestamp: -1 });
SecurityLogSchema.index({ userId: 1, timestamp: -1 });
SecurityLogSchema.index({ type: 1, timestamp: -1 });

module.exports = mongoose.model('SecurityLog', SecurityLogSchema);
