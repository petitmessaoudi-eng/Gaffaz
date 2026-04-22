const mongoose = require('mongoose');
const slugify = require('slugify');

const PriceEntrySchema = new mongoose.Schema({
  store: {
    type: String,
    required: true,
    enum: ['Tunisianet', 'SpaceNet', 'Skymil', 'Mytek']
  },
  price: {
    type: Number,
    min: 0
  },
  url: {
    type: String,
    default: ''
  },
  inStock: {
    type: Boolean,
    default: true
  },
  lastUpdated: {
    type: Date,
    default: Date.now
  }
}, { _id: false });

const PriceHistoryEntrySchema = new mongoose.Schema({
  store: {
    type: String,
    required: true,
    enum: ['Tunisianet', 'SpaceNet', 'Skymil', 'Mytek']
  },
  price: {
    type: Number,
    required: true,
    min: 0
  },
  date: {
    type: Date,
    default: Date.now
  }
}, { _id: false });

const ProductSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 500
  },
  slug: {
    type: String,
    unique: true,
    index: true
  },
  brand: {
    type: String,
    trim: true,
    default: '',
    index: true
  },
  category: {
    type: String,
    trim: true,
    default: '',
    index: true
  },
  subcategory: {
    type: String,
    trim: true,
    default: ''
  },
  images: {
    type: [String],
    default: []
  },
  description: {
    type: String,
    trim: true,
    default: '',
    maxlength: 5000
  },
  specs: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  prices: {
    type: [PriceEntrySchema],
    default: []
  },
  priceHistory: {
    type: [PriceHistoryEntrySchema],
    default: []
  },
  bestPrice: {
    type: Number,
    default: null,
    index: true
  },
  bestPriceStore: {
    type: String,
    default: null
  }
}, {
  timestamps: true
});

ProductSchema.index(
  { name: 'text', brand: 'text', description: 'text' },
  { weights: { name: 10, brand: 5, description: 1 }, name: 'product_text_index' }
);

ProductSchema.index({ category: 1, bestPrice: 1 });
ProductSchema.index({ brand: 1, bestPrice: 1 });
ProductSchema.index({ 'prices.store': 1 });
ProductSchema.index({ createdAt: -1 });
ProductSchema.index({ updatedAt: -1 });
ProductSchema.index({ 'priceHistory.date': -1 });

ProductSchema.pre('save', function(next) {
  if (this.isModified('name') || !this.slug) {
    const base = slugify(this.name, {
      lower: true,
      strict: true,
      locale: 'fr',
      trim: true
    });
    this.slug = base + '-' + this._id.toString().slice(-6);
  }

  if (this.prices && this.prices.length > 0) {
    const available = this.prices.filter(
      p => p.price != null && p.price > 0 && p.inStock !== false
    );

    if (available.length > 0) {
      const best = available.reduce((min, p) => p.price < min.price ? p : min);
      this.bestPrice = best.price;
      this.bestPriceStore = best.store;
    } else {
      const anyPrice = this.prices.filter(p => p.price != null && p.price > 0);
      if (anyPrice.length > 0) {
        const best = anyPrice.reduce((min, p) => p.price < min.price ? p : min);
        this.bestPrice = best.price;
        this.bestPriceStore = best.store;
      } else {
        this.bestPrice = null;
        this.bestPriceStore = null;
      }
    }
  } else {
    this.bestPrice = null;
    this.bestPriceStore = null;
  }

  next();
});

ProductSchema.pre('findOneAndUpdate', function(next) {
  const update = this.getUpdate();
  const prices = update?.prices || update?.$set?.prices;

  if (prices && prices.length > 0) {
    const available = prices.filter(
      p => p.price != null && p.price > 0 && p.inStock !== false
    );

    let bestPrice = null;
    let bestPriceStore = null;

    if (available.length > 0) {
      const best = available.reduce((min, p) => p.price < min.price ? p : min);
      bestPrice = best.price;
      bestPriceStore = best.store;
    } else {
      const anyPrice = prices.filter(p => p.price != null && p.price > 0);
      if (anyPrice.length > 0) {
        const best = anyPrice.reduce((min, p) => p.price < min.price ? p : min);
        bestPrice = best.price;
        bestPriceStore = best.store;
      }
    }

    if (update.$set) {
      update.$set.bestPrice = bestPrice;
      update.$set.bestPriceStore = bestPriceStore;
    } else {
      update.bestPrice = bestPrice;
      update.bestPriceStore = bestPriceStore;
    }
  }

  next();
});

ProductSchema.methods.updateStorePrice = function(store, priceData) {
  const idx = this.prices.findIndex(p => p.store === store);
  const oldEntry = idx >= 0 ? this.prices[idx] : null;
  const newPrice = priceData.price;

  // Record in priceHistory only if price changed or no existing entry
  if (newPrice != null && newPrice > 0) {
    const oldPrice = oldEntry ? oldEntry.price : null;
    if (oldPrice === null || Math.abs(oldPrice - newPrice) > 0.001) {
      if (!this.priceHistory) this.priceHistory = [];
      this.priceHistory.push({ store, price: newPrice, date: new Date() });
      this.markModified('priceHistory');
    }
  }

  if (idx >= 0) {
    this.prices[idx] = { ...this.prices[idx], ...priceData, store, lastUpdated: new Date() };
  } else {
    this.prices.push({ store, lastUpdated: new Date(), ...priceData });
    // Also record initial price in history
    if (newPrice != null && newPrice > 0) {
      if (!this.priceHistory) this.priceHistory = [];
      // Already pushed above, no duplicate needed
    }
  }
  this.markModified('prices');
};

ProductSchema.methods.getStorePrice = function(store) {
  return this.prices.find(p => p.store === store) || null;
};

ProductSchema.statics.findBySlugOrId = function(identifier) {
  if (mongoose.Types.ObjectId.isValid(identifier)) {
    return this.findById(identifier);
  }
  return this.findOne({ slug: identifier });
};

ProductSchema.statics.searchProducts = function(query, options = {}) {
  const {
    page = 1,
    limit = 24,
    sort = { createdAt: -1 },
    category,
    stores,
    brands,
    priceMin,
    priceMax,
    inStock
  } = options;

  const filter = { ...query };

  if (category) filter.category = { $regex: new RegExp(category, 'i') };
  if (brands && brands.length) filter.brand = { $in: brands };
  if (stores && stores.length) filter['prices.store'] = { $in: stores };
  if (priceMin != null || priceMax != null) {
    filter.bestPrice = {};
    if (priceMin != null) filter.bestPrice.$gte = priceMin;
    if (priceMax != null) filter.bestPrice.$lte = priceMax;
  }
  if (inStock) filter['prices'] = { $elemMatch: { inStock: true } };

  const skip = (page - 1) * limit;

  return Promise.all([
    this.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    this.countDocuments(filter)
  ]);
};

module.exports = mongoose.model('Product', ProductSchema);