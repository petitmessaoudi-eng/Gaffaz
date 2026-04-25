const express = require('express');
const router = express.Router();
const path = require('path');
const bcrypt = require('bcrypt');
const Product = require('../models/Product');
const ScraperLog = require('../models/ScraperLog');
const Ad = require('../models/Ad');
const multer = require('multer');
const fs = require('fs');

// ── Multer: image upload config ──
const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const name = Date.now() + '-' + Math.round(Math.random() * 1e6) + ext;
    cb(null, name);
  }
});
const fileFilter = (req, file, cb) => {
  const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) cb(null, true);
  else cb(new Error('Format non supporté. Utilisez JPG, PNG, WebP ou GIF.'), false);
};
const upload = multer({ storage, fileFilter, limits: { fileSize: 10 * 1024 * 1024 } });

let scraperModule = null;
/**
 * ════════════════════════════════════════════════════════════
 *  التعديلات المطلوبة على admin.js
 *  أضف هذا الكود في المناطق المحددة أدناه
 * ════════════════════════════════════════════════════════════
 */

// ══════════════════════════════════════════════════════════
// [1] في أعلى admin.js، بعد السطر:
//     let scraperModule = null;
//     أضف هذا:
// ══════════════════════════════════════════════════════════

let tunisianetScraperModule = null;
function getTunisianetScraper() {
  if (!tunisianetScraperModule) {
    try {
      tunisianetScraperModule = require('../scrapers/tunisianet_scraper');
    } catch (e) {
      console.error('Cannot load tunisianet_scraper:', e.message);
    }
  }
  return tunisianetScraperModule;
}


// ══════════════════════════════════════════════════════════
// [2] استبدل route POST /api/scraper/run الموجودة حالياً
//     بهذه النسخة الجديدة التي تتعامل مع Tunisianet بشكل منفصل:
// ══════════════════════════════════════════════════════════

router.post('/api/scraper/run', requireAuth, async (req, res) => {
  if (scraperState.running) {
    return res.status(409).json({ error: 'Un scraping est déjà en cours', state: scraperState });
  }

  const { stores = ['all'] } = req.body;

  /* ─── Tunisianet: مسار مخصص لتحديث الأسعار ─── */
  const isTunisianetOnly =
    stores.length === 1 && stores[0].toLowerCase() === 'tunisianet';

  if (isTunisianetOnly) {
    const scraper = getTunisianetScraper();
    if (!scraper || typeof scraper.updateTunisianetPrices !== 'function') {
      return res.status(503).json({ error: 'Module Tunisianet non disponible — vérifiez scrapers/tunisianet_scraper.js' });
    }

    scraperState.running     = true;
    scraperState.progress    = 0;
    scraperState.message     = 'جارٍ تحديث أسعار Tunisianet…';
    scraperState.currentStore = 'Tunisianet';
    scraperState.status      = 'running';
    scraperState.results     = null;

    res.json({ success: true, message: 'Mise à jour Tunisianet lancée', state: scraperState });

    setImmediate(async () => {
      try {
        const onProgress = (data) => {
          if (data.progress   != null) scraperState.progress    = data.progress;
          if (data.message)            scraperState.message     = data.message;
          if (data.currentStore)       scraperState.currentStore = data.currentStore;
          if (data.results)            scraperState.results     = data.results;
          if (data.status === 'done') {
            scraperState.status  = 'done';
            scraperState.running = false;
          }
        };

        await scraper.updateTunisianetPrices(onProgress);

        /* تأكّد من الإنهاء حتى لو لم يُطلق onProgress بـ done */
        scraperState.running = false;
        if (scraperState.status === 'running') scraperState.status = 'done';

      } catch (err) {
        console.error('Tunisianet scraper error:', err);
        scraperState.running = false;
        scraperState.status  = 'error';
        scraperState.message = err.message || 'Erreur inconnue';
      }
    });

    return; // انتهى المسار الخاص بـ Tunisianet
  }

  /* ─── باقي المتاجر: المسار الأصلي ─── */
  const scraper = getScraper();
  if (!scraper || typeof scraper.runScraper !== 'function') {
    return res.status(503).json({ error: 'Module scraper non disponible' });
  }

  scraperState.running      = true;
  scraperState.progress     = 0;
  scraperState.message      = 'Initialisation…';
  scraperState.currentStore = stores[0] === 'all' ? 'Tous les stores' : stores[0];
  scraperState.status       = 'running';
  scraperState.results      = null;

  res.json({ success: true, message: 'Scraping lancé', state: scraperState });

  setImmediate(async () => {
    try {
      const onProgress = (data) => {
        if (data.progress     != null) scraperState.progress    = data.progress;
        if (data.message)              scraperState.message     = data.message;
        if (data.currentStore)         scraperState.currentStore = data.currentStore;
      };
      const results = await scraper.runScraper(stores, onProgress);
      scraperState.running  = false;
      scraperState.progress = 100;
      scraperState.message  = 'Scraping terminé avec succès';
      scraperState.status   = 'done';
      scraperState.results  = results;
    } catch (err) {
      console.error('Scraper run error:', err);
      scraperState.running = false;
      scraperState.status  = 'error';
      scraperState.message = err.message || 'Erreur inconnue';
    }
  });
});
function getScraper() {
  if (!scraperModule) {
    try { scraperModule = require('../scrapers/scraper'); } catch (e) {}
  }
  return scraperModule;
}

const scraperState = {
  running: false,
  progress: 0,
  message: '',
  currentStore: '',
  status: 'idle',
  results: null
};

function requireAuth(req, res, next) {
  if (req.session && req.session.adminAuthenticated) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Non autorisé', authenticated: false });
  return res.redirect('/admin/login');
}

router.get('/login', (req, res) => {
  if (req.session && req.session.adminAuthenticated) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, '../public/login.html'));
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });
    const adminEmail = process.env.ADMIN_EMAIL || '';
    const adminHash = process.env.ADMIN_PASSWORD_HASH || '';
    if (!adminEmail || !adminHash) return res.status(500).json({ error: 'Configuration admin manquante' });
    if (email.toLowerCase().trim() !== adminEmail.toLowerCase().trim()) {
      await new Promise(r => setTimeout(r, 400));
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }
    const match = await bcrypt.compare(password, adminHash);
    if (!match) {
      await new Promise(r => setTimeout(r, 400));
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }
    req.session.adminAuthenticated = true;
    req.session.adminEmail = email.toLowerCase().trim();
    req.session.loginTime = new Date().toISOString();
    req.session.save(err => {
      if (err) return res.status(500).json({ error: 'Erreur de session' });
      res.json({ success: true, redirect: '/admin' });
    });
  } catch (err) {
    console.error('POST /admin/login error:', err);
    res.status(500).json({ error: 'Erreur interne du serveur' });
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) console.error('Session destroy error:', err);
    res.redirect('/admin/login');
  });
});

router.get('/api/auth-check', (req, res) => {
  res.json({
    authenticated: !!(req.session && req.session.adminAuthenticated),
    email: req.session?.adminEmail || null
  });
});

router.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin.html'));
});

/* ── PRODUCTS ── */

router.get('/api/products', requireAuth, async (req, res) => {
  try {
    const {
      page = 1, limit = 20,
      sort = 'updatedAt', sortDir = -1,
      search = '', category = '', stores = '', brands = '',
      priceMin = '', priceMax = '', inStock = ''
    } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;
    const dir = parseInt(sortDir) === 1 ? 1 : -1;
    const validSorts = ['name', 'brand', 'category', 'bestPrice', 'createdAt', 'updatedAt'];
    const sortField = validSorts.includes(sort) ? sort : 'updatedAt';
    const query = {};
    if (search) query.$text = { $search: search };
    if (category) query.category = { $regex: new RegExp(category, 'i') };
    if (stores) {
      const list = stores.split(',').map(s => s.trim()).filter(Boolean);
      if (list.length) query['prices.store'] = { $in: list };
    }
    if (brands) {
      const list = brands.split(',').map(b => b.trim()).filter(Boolean);
      if (list.length) query.brand = { $in: list };
    }
    if (priceMin || priceMax) {
      query.bestPrice = {};
      if (priceMin) query.bestPrice.$gte = parseFloat(priceMin);
      if (priceMax) query.bestPrice.$lte = parseFloat(priceMax);
    }
    if (inStock === 'true') query['prices'] = { $elemMatch: { inStock: true } };
    const sortObj = search
      ? { score: { $meta: 'textScore' }, [sortField]: dir }
      : { [sortField]: dir };
    const projection = search ? { score: { $meta: 'textScore' } } : {};
    const [products, total] = await Promise.all([
      Product.find(query, projection).sort(sortObj).skip(skip).limit(limitNum).lean(),
      Product.countDocuments(query)
    ]);
    res.json({ products, total, page: pageNum, totalPages: Math.ceil(total / limitNum) });
  } catch (err) {
    console.error('GET /admin/api/products error:', err);
    res.status(500).json({ error: 'Erreur interne du serveur' });
  }
});

router.get('/api/products/:id', requireAuth, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).lean();
    if (!product) return res.status(404).json({ error: 'Produit introuvable' });
    res.json({ product });
  } catch (err) {
    res.status(500).json({ error: 'Erreur interne du serveur' });
  }
});

router.post('/api/product', requireAuth, async (req, res) => {
  try {
    const { name, brand, category, subcategory, description, images, specs, prices } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Le nom est requis' });
    if (!category) return res.status(400).json({ error: 'La catégorie est requise' });
    const cleanPrices = (prices || []).map(p => ({
      store: p.store,
      price: p.price != null ? parseFloat(p.price) : undefined,
      url: p.url || '',
      inStock: p.inStock !== false,
      lastUpdated: new Date()
    })).filter(p => p.price != null && !isNaN(p.price));
    // Build initial priceHistory from the prices provided
    const initHistory = cleanPrices.map(p => ({
      store: p.store,
      price: p.price,
      date: new Date()
    }));
    const product = new Product({
      name: name.trim(),
      brand: (brand || '').trim(),
      category: category.trim(),
      subcategory: (subcategory || '').trim(),
      description: (description || '').trim(),
      images: (images || []).filter(Boolean),
      specs: specs || {},
      prices: cleanPrices,
      priceHistory: initHistory
    });
    await product.save();
    res.status(201).json({ success: true, product });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Un produit avec ce nom existe déjà' });
    console.error('POST /admin/api/product error:', err);
    res.status(500).json({ error: err.message || 'Erreur interne du serveur' });
  }
});

router.put('/api/product/:id', requireAuth, async (req, res) => {
  try {
    const { name, brand, category, subcategory, description, images, specs, prices } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Le nom est requis' });
    const cleanPrices = (prices || []).map(p => ({
      store: p.store,
      price: p.price != null ? parseFloat(p.price) : undefined,
      url: p.url || '',
      inStock: p.inStock !== false,
      lastUpdated: new Date()
    })).filter(p => p.price != null && !isNaN(p.price));
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Produit introuvable' });
    product.name = name.trim();
    product.brand = (brand || '').trim();
    product.category = (category || '').trim();
    product.subcategory = (subcategory || '').trim();
    product.description = (description || '').trim();
    product.images = (images || []).filter(Boolean);
    product.specs = specs || {};

    // Use updateStorePrice() so price changes are recorded in priceHistory
    const incomingStores = cleanPrices.map(p => p.store);
    cleanPrices.forEach(p => {
      product.updateStorePrice(p.store, {
        price: p.price,
        url: p.url,
        inStock: p.inStock
      });
    });
    // Remove store entries that were deleted in the admin form
    product.prices = product.prices.filter(p => incomingStores.includes(p.store));
    product.markModified('prices');

    await product.save();
    res.json({ success: true, product });
  } catch (err) {
    console.error('PUT /admin/api/product/:id error:', err);
    res.status(500).json({ error: err.message || 'Erreur interne du serveur' });
  }
});

router.delete('/api/product/:id', requireAuth, async (req, res) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) return res.status(404).json({ error: 'Produit introuvable' });
    res.json({ success: true, message: 'Produit supprimé avec succès' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur interne du serveur' });
  }
});

/* ── IMAGE UPLOAD ── */

// Upload single main image
router.post('/api/upload/main-image', requireAuth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
  const url = '/uploads/' + req.file.filename;
  res.json({ success: true, url });
});

// Upload multiple extra images (up to 10)
router.post('/api/upload/extra-images', requireAuth, upload.array('images', 10), (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'Aucun fichier reçu' });
  const urls = req.files.map(f => '/uploads/' + f.filename);
  res.json({ success: true, urls });
});

// Delete uploaded image
router.delete('/api/upload/image', requireAuth, (req, res) => {
  try {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: 'Nom de fichier requis' });
    const filePath = path.join(uploadsDir, path.basename(filename));
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors de la suppression' });
  }
});

/* ── SCRAPER ── */

router.post('/api/scraper/run', requireAuth, async (req, res) => {
  if (scraperState.running) {
    return res.status(409).json({ error: 'Un scraping est déjà en cours', state: scraperState });
  }
  const { stores = ['all'] } = req.body;
  const scraper = getScraper();
  if (!scraper || typeof scraper.runScraper !== 'function') {
    return res.status(503).json({ error: 'Module scraper non disponible' });
  }
  scraperState.running = true;
  scraperState.progress = 0;
  scraperState.message = 'Initialisation…';
  scraperState.currentStore = stores[0] === 'all' ? 'Tous les stores' : stores[0];
  scraperState.status = 'running';
  scraperState.results = null;
  res.json({ success: true, message: 'Scraping lancé', state: scraperState });
  setImmediate(async () => {
    try {
      const onProgress = (data) => {
        if (data.progress != null) scraperState.progress = data.progress;
        if (data.message) scraperState.message = data.message;
        if (data.currentStore) scraperState.currentStore = data.currentStore;
      };
      const results = await scraper.runScraper(stores, onProgress);
      scraperState.running = false;
      scraperState.progress = 100;
      scraperState.message = 'Scraping terminé avec succès';
      scraperState.status = 'done';
      scraperState.results = results;
    } catch (err) {
      console.error('Scraper run error:', err);
      scraperState.running = false;
      scraperState.status = 'error';
      scraperState.message = err.message || 'Erreur inconnue';
    }
  });
});

router.get('/api/scraper/status', requireAuth, (req, res) => res.json(scraperState));

router.get('/api/scraper/logs', requireAuth, async (req, res) => {
  try {
    const { limit = 20, store } = req.query;
    const filter = {};
    if (store) filter.store = store;
    const logs = await ScraperLog.find(filter).sort({ runDate: -1 }).limit(Math.min(100, parseInt(limit))).lean();
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: 'Erreur interne du serveur' });
  }
});

router.get('/api/scraper/config', requireAuth, async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const db = mongoose.connection.db;
    const config = await db.collection('scraper_config').findOne({ _id: 'main' });
    res.json({ config: config || {} });
  } catch (err) {
    res.status(500).json({ error: 'Erreur interne du serveur' });
  }
});

router.put('/api/scraper/config', requireAuth, async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const db = mongoose.connection.db;
    await db.collection('scraper_config').updateOne(
      { _id: 'main' },
      { $set: { ...req.body, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur interne du serveur' });
  }
});

router.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const [totalProducts, lastLog, storeStats] = await Promise.all([
      Product.countDocuments(),
      ScraperLog.findOne().sort({ runDate: -1 }).lean(),
      Product.aggregate([
        { $unwind: '$prices' },
        { $group: { _id: '$prices.store', count: { $sum: 1 }, avgPrice: { $avg: '$prices.price' } } },
        { $sort: { count: -1 } }
      ])
    ]);
    const priceChanges24h = lastLog
      ? await ScraperLog.aggregate([
          { $match: { runDate: { $gte: new Date(Date.now() - 86400000) } } },
          { $project: { count: { $size: '$priceChanges' } } },
          { $group: { _id: null, total: { $sum: '$count' } } }
        ])
      : [];
    res.json({
      totalProducts,
      priceChanges24h: priceChanges24h[0]?.total || 0,
      lastRun: lastLog ? { date: lastLog.runDate, status: lastLog.status } : null,
      storeStats,
      storesMonitored: 4
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur interne du serveur' });
  }
});

/* ══════════════════════════════════════════════════
   ADS — Admin CRUD
══════════════════════════════════════════════════ */

router.get('/api/ads', requireAuth, async (req, res) => {
  try {
    const ads = await Ad.find({}).sort({ priority: -1, createdAt: -1 }).lean();
    res.json({ ads, total: ads.length });
  } catch (err) {
    res.status(500).json({ error: 'Erreur interne du serveur' });
  }
});

router.get('/api/ads/:id', requireAuth, async (req, res) => {
  try {
    const ad = await Ad.findById(req.params.id).lean();
    if (!ad) return res.status(404).json({ error: 'Publicité introuvable' });
    res.json({ ad });
  } catch (err) {
    res.status(500).json({ error: 'Erreur interne du serveur' });
  }
});

function parseAdBody(body) {
  const {
    title, subtitle, badge,
    image, accentColor,
    ctaText, ctaUrl, price, oldPrice,
    targetCategories, targetSubcategories,
    active, priority, startsAt, endsAt
  } = body;
  return {
    title: (title || '').trim(),
    subtitle: (subtitle || '').trim(),
    badge: (badge || '').trim(),
    image: image || '',
    accentColor: accentColor || '#34d399',
    ctaText: (ctaText || 'Voir l\'offre').trim(),
    ctaUrl: (ctaUrl || '').trim(),
    price: price != null && price !== '' ? parseFloat(price) : null,
    oldPrice: oldPrice != null && oldPrice !== '' ? parseFloat(oldPrice) : null,
    targetCategories: Array.isArray(targetCategories)
      ? targetCategories.filter(Boolean)
      : (targetCategories ? targetCategories.split(',').map(s => s.trim()).filter(Boolean) : []),
    targetSubcategories: Array.isArray(targetSubcategories)
      ? targetSubcategories.filter(Boolean)
      : (targetSubcategories ? targetSubcategories.split(',').map(s => s.trim()).filter(Boolean) : []),
    active: active !== false && active !== 'false',
    priority: parseInt(priority) || 0,
    startsAt: startsAt || null,
    endsAt: endsAt || null
  };
}

router.post('/api/ad', requireAuth, async (req, res) => {
  try {
    const data = parseAdBody(req.body);
    if (!data.title) return res.status(400).json({ error: 'Le titre est requis' });
    if (!data.ctaUrl) return res.status(400).json({ error: 'L\'URL de destination est requise' });
    const ad = new Ad(data);
    await ad.save();
    res.status(201).json({ success: true, ad });
  } catch (err) {
    console.error('POST /admin/api/ad error:', err);
    res.status(500).json({ error: err.message || 'Erreur interne du serveur' });
  }
});

router.put('/api/ad/:id', requireAuth, async (req, res) => {
  try {
    const ad = await Ad.findById(req.params.id);
    if (!ad) return res.status(404).json({ error: 'Publicité introuvable' });
    const data = parseAdBody(req.body);
    if (!data.title) return res.status(400).json({ error: 'Le titre est requis' });
    if (!data.ctaUrl) return res.status(400).json({ error: 'L\'URL de destination est requise' });
    Object.assign(ad, data);
    await ad.save();
    res.json({ success: true, ad });
  } catch (err) {
    console.error('PUT /admin/api/ad/:id error:', err);
    res.status(500).json({ error: err.message || 'Erreur interne du serveur' });
  }
});

router.delete('/api/ad/:id', requireAuth, async (req, res) => {
  try {
    const ad = await Ad.findByIdAndDelete(req.params.id);
    if (!ad) return res.status(404).json({ error: 'Publicité introuvable' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur interne du serveur' });
  }
});

router.patch('/api/ad/:id/toggle', requireAuth, async (req, res) => {
  try {
    const ad = await Ad.findById(req.params.id);
    if (!ad) return res.status(404).json({ error: 'Publicité introuvable' });
    ad.active = !ad.active;
    await ad.save();
    res.json({ success: true, active: ad.active });
  } catch (err) {
    res.status(500).json({ error: 'Erreur interne du serveur' });
  }
});

/* ── ADS — Public endpoints (called from product.html) ── */

router.get('/public/ads', async (req, res) => {
  try {
    const { category = '' } = req.query;
    const now = new Date();
    const query = {
      active: true,
      $or: [{ startsAt: null }, { startsAt: { $lte: now } }],
      $and: [{ $or: [{ endsAt: null }, { endsAt: { $gte: now } }] }]
    };
    if (category) {
      query.$or = [
        { targetCategories: { $size: 0 } },
        { targetCategories: category }
      ];
    }
    const ads = await Ad.find(query).sort({ priority: -1 }).limit(6).lean();
    if (ads.length) {
      Ad.updateMany({ _id: { $in: ads.map(a => a._id) } }, { $inc: { impressions: 1 } }).catch(() => {});
    }
    res.json({ ads });
  } catch (err) {
    res.status(500).json({ error: 'Erreur interne du serveur' });
  }
});

router.post('/public/ads/:id/click', async (req, res) => {
  try {
    await Ad.findByIdAndUpdate(req.params.id, { $inc: { clicks: 1 } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur interne du serveur' });
  }
});

module.exports = router;