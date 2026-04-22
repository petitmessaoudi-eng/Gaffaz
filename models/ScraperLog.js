const mongoose = require('mongoose');

const PriceChangeSchema = new mongoose.Schema({
  productName: {
    type: String,
    required: true,
    trim: true
  },
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    default: null
  },
  store: {
    type: String,
    required: true,
    enum: ['Tunisianet', 'SpaceNet', 'Skymil', 'Mytek']
  },
  oldPrice: {
    type: Number,
    required: true
  },
  newPrice: {
    type: Number,
    required: true
  },
  percentChange: {
    type: Number
  }
}, { _id: false });

PriceChangeSchema.pre('validate', function(next) {
  if (this.oldPrice && this.newPrice) {
    this.percentChange = parseFloat(
      (((this.newPrice - this.oldPrice) / this.oldPrice) * 100).toFixed(2)
    );
  }
  next();
});

const ScraperLogSchema = new mongoose.Schema({
  runDate: {
    type: Date,
    default: Date.now,
    index: true
  },
  store: {
    type: String,
    default: 'all',
    index: true
  },
  status: {
    type: String,
    enum: ['success', 'partial', 'failed', 'running'],
    default: 'running',
    index: true
  },
  newProductsFound: {
    type: [String],
    default: []
  },
  priceChanges: {
    type: [PriceChangeSchema],
    default: []
  },
  errors: {
    type: [String],
    default: []
  },
  duration: {
    type: Number,
    default: 0
  },
  productsScraped: {
    type: Number,
    default: 0
  },
  productsUpdated: {
    type: Number,
    default: 0
  },
  meta: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

ScraperLogSchema.index({ runDate: -1, store: 1 });
ScraperLogSchema.index({ status: 1, runDate: -1 });

ScraperLogSchema.statics.startRun = async function(store = 'all') {
  const log = new this({
    store,
    status: 'running',
    runDate: new Date()
  });
  await log.save();
  return log;
};

ScraperLogSchema.statics.getLastRun = function(store) {
  const filter = store ? { store } : {};
  return this.findOne(filter).sort({ runDate: -1 }).lean();
};

ScraperLogSchema.statics.getRecentLogs = function(limit = 20, store) {
  const filter = store ? { store } : {};
  return this.find(filter).sort({ runDate: -1 }).limit(limit).lean();
};

ScraperLogSchema.methods.finish = async function(status = 'success') {
  this.status = status;
  this.duration = Date.now() - new Date(this.runDate).getTime();
  await this.save();
  return this;
};

ScraperLogSchema.methods.addPriceChange = function(productName, store, oldPrice, newPrice, productId) {
  this.priceChanges.push({ productName, store, oldPrice, newPrice, productId: productId || null });
  this.markModified('priceChanges');
};

ScraperLogSchema.methods.addNewProduct = function(productName) {
  if (!this.newProductsFound.includes(productName)) {
    this.newProductsFound.push(productName);
    this.markModified('newProductsFound');
  }
};

ScraperLogSchema.methods.addError = function(errorMsg) {
  this.errors.push(String(errorMsg));
  this.markModified('errors');
};

module.exports = mongoose.model('ScraperLog', ScraperLogSchema);
