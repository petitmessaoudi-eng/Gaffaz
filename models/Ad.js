const mongoose = require('mongoose');

/* ──────────────────────────────────────────────
   Ad model — Sponsored product panels
   Each ad targets one or more product categories.
   When a user views a product in a matching category,
   the ad is displayed in the sidebar ad panel.
────────────────────────────────────────────────── */

const AdSchema = new mongoose.Schema({
  /* ── Identity ── */
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 200
  },
  subtitle: {
    type: String,
    trim: true,
    default: '',
    maxlength: 300
  },
  badge: {
    type: String,
    trim: true,
    default: '',
    maxlength: 50
  },

  /* ── Visuals ── */
  image: {
    type: String,
    default: ''
  },
  accentColor: {
    type: String,
    default: '#34d399'   // any CSS colour string
  },

  /* ── Action ── */
  ctaText: {
    type: String,
    default: 'Voir l\'offre',
    maxlength: 80
  },
  ctaUrl: {
    type: String,
    required: true
  },
  price: {
    type: Number,
    default: null
  },
  oldPrice: {
    type: Number,
    default: null
  },

  /* ── Targeting ── */
  // Which top-level categories trigger this ad
  targetCategories: {
    type: [String],
    default: []   // empty = show on ALL product pages
  },
  // Optional subcategory targeting for more precision
  targetSubcategories: {
    type: [String],
    default: []
  },

  /* ── Lifecycle ── */
  active: {
    type: Boolean,
    default: true
  },
  priority: {
    type: Number,
    default: 0    // higher = shown first
  },
  startsAt: {
    type: Date,
    default: null
  },
  endsAt: {
    type: Date,
    default: null
  },

  /* ── Analytics (lightweight) ── */
  impressions: { type: Number, default: 0 },
  clicks:      { type: Number, default: 0 }
}, { timestamps: true });

AdSchema.index({ active: 1, priority: -1 });
AdSchema.index({ targetCategories: 1 });

/* Returns ads whose date range is valid (or not set) */
AdSchema.statics.getActive = function(category, subcategory) {
  const now = new Date();
  const query = {
    active: true,
    $or: [{ startsAt: null }, { startsAt: { $lte: now } }],
    $and: [{ $or: [{ endsAt: null }, { endsAt: { $gte: now } }] }]
  };

  if (category) {
    query.$or = [
      { targetCategories: { $size: 0 } },   // universal ads
      { targetCategories: category }
    ];
  }

  return this.find(query).sort({ priority: -1 }).limit(6).lean();
};

module.exports = mongoose.model('Ad', AdSchema);
