const express = require('express');
const router = express.Router();
const path = require('path');
const Product = require('../models/Product');

const localCache = new Map();
const CACHE_MAX_SIZE = 500;

function lcGet(key) {
  const e = localCache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { localCache.delete(key); return null; }
  return e.data;
}

function lcSet(key, data, ttlMs) {
  if (localCache.size >= CACHE_MAX_SIZE) {
    const now = Date.now();
    let deleted = 0;
    for (const [k, v] of localCache) {
      if (now > v.expiresAt) { localCache.delete(k); deleted++; }
      if (deleted >= 100) break;
    }
    if (localCache.size >= CACHE_MAX_SIZE) {
      const firstKey = localCache.keys().next().value;
      if (firstKey) localCache.delete(firstKey);
    }
  }
  localCache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

function invalidateProductCache() {
  localCache.clear();
}
global.__invalidateProductCache = invalidateProductCache;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of localCache) {
    if (now > v.expiresAt) localCache.delete(k);
  }
}, 60 * 1000);

const inFlight = new Map();

async function deduped(key, fn) {
  if (inFlight.has(key)) return inFlight.get(key);
  const promise = fn().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

setInterval(() => {
  if (inFlight.size > 50) inFlight.clear();
}, 30 * 1000);

const AGG_CACHE_TTL  = 5 * 60 * 1000;
const LIST_CACHE_TTL = 45 * 1000;
const FUZZY_CACHE_TTL = 15 * 1000;

function normalizeCacheKey(url) {
  try {
    const [base, qs] = url.split('?');
    if (!qs) return url.toLowerCase().trim();
    const params = new URLSearchParams(qs);
    const sorted = [...params.entries()]
      .map(([k, v]) => [k.toLowerCase().trim(), v.toLowerCase().trim()])
      .sort(([a], [b]) => a.localeCompare(b));
    return base.toLowerCase().trim() + '?' + new URLSearchParams(sorted).toString();
  } catch {
    return url;
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSpecValue(val) {
  return String(val)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[àáâã]/g, 'a')
    .replace(/[éèêë]/g, 'e')
    .replace(/[îï]/g, 'i')
    .replace(/[ôö]/g, 'o')
    .replace(/[ùûü]/g, 'u')
    .replace(/go|gb/g, 'go')
    .replace(/mhz/g, 'mhz')
    .replace(/ghz/g, 'ghz')
    .trim();
}

function extractNumericValue(val) {
  const match = String(val).match(/[\d.]+/);
  return match ? parseFloat(match[0]) : null;
}

function buildFuzzyTextRegex(input) {
  const clean = input.trim().toLowerCase();
  const parts = clean.split(/[\s\-_,]+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) {
    const escaped = escapeRegex(parts[0]);
    return new RegExp(escaped, 'i');
  }
  const pattern = parts.map(p => escapeRegex(p)).join('.{0,6}');
  return new RegExp(pattern, 'i');
}

function buildMultiWordSpecConditions(specField, input) {
  const parts = input.trim().toLowerCase().split(/[\s\-_,]+/).filter(Boolean);
  if (parts.length <= 1) {
    return [{ [specField]: buildFuzzyTextRegex(input) }];
  }
  return parts.map(p => ({ [specField]: new RegExp(escapeRegex(p), 'i') }));
}

function buildCheckboxSpecConditions(specField, vals) {
  const orConditions = [];
  vals.forEach(v => {
    const num = extractNumericValue(v);
    const normV = normalizeSpecValue(v);

    const unitVariants = [
      v,
      v.replace(/go$/i, 'gb'), v.replace(/gb$/i, 'go'),
      v.replace(/go$/i, ' go'), v.replace(/gb$/i, ' gb'),
      v.replace(/go$/i, 'G'), v.replace(/tb$/i, 'to'),
      v.replace(/to$/i, 'tb'),
    ];
    unitVariants.forEach(variant => orConditions.push(variant));

    if (num !== null) {
      orConditions.push(num);
      orConditions.push(String(num));
      const unitMatch = v.match(/[a-zA-Z]+$/);
      const unit = unitMatch ? unitMatch[0].toLowerCase() : '';
      const unitAliases = { go: ['go', 'gb', 'g'], gb: ['go', 'gb', 'g'], mhz: ['mhz', 'MHz'], ghz: ['ghz', 'GHz'], to: ['to', 'tb'], tb: ['to', 'tb'] };
      const aliases = unitAliases[unit] || [unit];
      aliases.forEach(alias => {
        orConditions.push(num + alias);
        orConditions.push(num + ' ' + alias);
        orConditions.push(String(num) + alias);
      });
    }

    orConditions.push(new RegExp('^\\s*' + escapeRegex(normV) + '\\s*$', 'i'));
    if (num !== null) {
      orConditions.push(new RegExp('^\\s*' + num + '\\s*(go|gb|g|to|tb|mhz|ghz)?\\s*$', 'i'));
    }
  });

  const uniqueStrings = [...new Set(orConditions.filter(x => typeof x === 'string' || typeof x === 'number'))];
  const regexes = orConditions.filter(x => x instanceof RegExp);

  if (regexes.length > 0) {
    return { $or: [{ [specField]: { $in: uniqueStrings } }, ...regexes.map(r => ({ [specField]: r }))] };
  }
  return { [specField]: { $in: uniqueStrings } };
}

function isFuzzyQuery(reqQuery) {
  const specsRaw = reqQuery['specs'];
  if (!specsRaw || typeof specsRaw !== 'object') return false;
  return Object.values(specsRaw).some(v => {
    const s = String(v || '').trim();
    return s && !s.startsWith('__range:') && s !== 'true';
  });
}

function buildQuery(reqQuery) {
  const { search, category, subcategory, stores, brands, priceMin, priceMax, inStock } = reqQuery;
  const query = {};

  if (search)      query.$text = { $search: search };
  if (category)    query.category = { $regex: new RegExp(category, 'i') };
  if (subcategory) query.subcategory = { $regex: new RegExp('^' + escapeRegex(subcategory) + '$', 'i') };

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

  const specsRaw = reqQuery['specs'];
  if (specsRaw && typeof specsRaw === 'object' && !Array.isArray(specsRaw)) {
    Object.entries(specsRaw).forEach(([key, rawVal]) => {
      if (!key || rawVal == null || rawVal === '') return;
      const specField = 'specs.' + key;
      const strVal = String(rawVal).trim();

      if (strVal === 'true') {
        query[specField] = { $in: [true, 'true', 'Oui', 'oui', 'Yes', 'yes', '1', 1, '✓', 'disponible', 'Disponible'] };
        return;
      }

      if (strVal.startsWith('__range:')) {
        const parts = strVal.slice(8).split(':');
        const rawMin = parts[0] !== '' ? parts[0] : null;
        const rawMax = parts[1] !== '' ? parts[1] : null;
        const minV = rawMin !== null ? parseFloat(rawMin) : null;
        const maxV = rawMax !== null ? parseFloat(rawMax) : null;
        const rangeQ = {};
        if (minV !== null && !isNaN(minV)) rangeQ.$gte = minV;
        if (maxV !== null && !isNaN(maxV)) rangeQ.$lte = maxV;
        if (Object.keys(rangeQ).length) {
          const numericRange = { [specField]: rangeQ };
          const strExtractConditions = [];
          if (minV !== null || maxV !== null) {
            strExtractConditions.push({
              $expr: {
                $let: {
                  vars: { numVal: { $toDouble: { $arrayElemAt: [{ $regexFindAll: { input: { $ifNull: ['$' + specField, ''] }, regex: '[0-9]+(?:\\.[0-9]+)?' } }, 0] } } },
                  in: {
                    $and: [
                      minV !== null ? { $gte: ['$$numVal', minV] } : {},
                      maxV !== null ? { $lte: ['$$numVal', maxV] } : {}
                    ].filter(c => Object.keys(c).length > 0)
                  }
                }
              }
            });
          }
          query.$and = query.$and || [];
          query.$and.push({ $or: [numericRange, ...strExtractConditions] });
        }
        return;
      }

      const vals = strVal.split(',').map(v => v.trim()).filter(Boolean);
      if (!vals.length) return;

      if (vals.length === 1 && vals[0].length > 2 && !/^\d+(\.\d+)?(go|gb|mhz|ghz|to|tb|w|mm)?$/i.test(vals[0])) {
        const multiWordConditions = buildMultiWordSpecConditions(specField, vals[0]);
        if (multiWordConditions.length === 1) {
          query[specField] = multiWordConditions[0][specField];
        } else {
          query.$and = query.$and || [];
          query.$and.push(...multiWordConditions);
        }
        return;
      }

      const cbCondition = buildCheckboxSpecConditions(specField, vals);
      if (cbCondition.$or) {
        query.$and = query.$and || [];
        query.$and.push(cbCondition);
      } else {
        query[specField] = cbCondition[specField];
      }
    });
  }

  return query;
}

const SORT_MAP = {
  'bestPrice_asc':  { bestPrice: 1 },
  'bestPrice_desc': { bestPrice: -1 },
  'name_asc':       { name: 1 },
  'name_desc':      { name: -1 },
  'createdAt_desc': { createdAt: -1 },
  'createdAt_asc':  { createdAt: 1 },
  'savings_desc':   { bestPrice: 1 }
};

router.get('/products', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/store.html'));
});

router.get('/product/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/product.html'));
});

router.get('/api/products', async (req, res) => {
  try {
    const cacheKey = normalizeCacheKey(req.originalUrl);
    const fuzzy = isFuzzyQuery(req.query);
    const cacheTTL = fuzzy ? FUZZY_CACHE_TTL : LIST_CACHE_TTL;

    const cached = lcGet(cacheKey);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(cached);
    }

    const result = await deduped(cacheKey, async () => {
      const { page = 1, limit = 24, sort = 'createdAt_desc' } = req.query;
      const pageNum  = Math.max(1, parseInt(page));
      const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
      const skip     = (pageNum - 1) * limitNum;
      const sortObj  = SORT_MAP[sort] || { createdAt: -1 };
      const query    = buildQuery(req.query);
      const aggKey   = 'agg:' + JSON.stringify(query);

      const [productsAndTotal, aggregations] = await Promise.all([
        deduped('list:' + cacheKey, () =>
          Promise.all([
            Product.find(query)
              .sort(sortObj)
              .skip(skip)
              .limit(limitNum)
              .select('name slug brand category images bestPrice bestPriceStore prices createdAt')
              .lean()
              .maxTimeMS(10000),
            Product.countDocuments(query).maxTimeMS(10000)
          ])
        ),
        deduped(aggKey, async () => {
          const fromCache = lcGet(aggKey);
          if (fromCache) return fromCache;
          const [storeCounts, brandAgg] = await Promise.all([
            Product.aggregate([
              { $match: query },
              { $unwind: '$prices' },
              { $group: { _id: '$prices.store', count: { $sum: 1 } } }
            ]).option({ maxTimeMS: 10000 }),
            Product.aggregate([
              { $match: query },
              { $group: { _id: '$brand', count: { $sum: 1 } } },
              { $sort: { count: -1 } },
              { $limit: 30 }
            ]).option({ maxTimeMS: 10000 })
          ]);
          const storeCountMap = {};
          storeCounts.forEach(s => { storeCountMap[s._id] = s.count; });
          const brandsResult = brandAgg.filter(b => b._id).map(b => ({ name: b._id, count: b.count }));
          const agg = { storeCounts: storeCountMap, brands: brandsResult };
          lcSet(aggKey, agg, AGG_CACHE_TTL);
          return agg;
        })
      ]);

      const [products, total] = productsAndTotal;
      const { storeCounts: storeCountMap, brands: brandsResult } = aggregations;

      return {
        products,
        total,
        page: pageNum,
        totalPages: Math.ceil(total / limitNum),
        filters: { storeCounts: storeCountMap, brands: brandsResult }
      };
    });

    lcSet(cacheKey, result, cacheTTL);
    res.setHeader('X-Cache', 'MISS');
    res.json(result);
  } catch (err) {
    console.error('GET /api/products error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/api/product/:slug', async (req, res) => {
  try {
    const cacheKey = 'product:' + req.params.slug;
    const cached = lcGet(cacheKey);
    if (cached) { res.setHeader('X-Cache', 'HIT'); return res.json(cached); }
    const product = await Product.findOne({ slug: req.params.slug }).lean().maxTimeMS(8000);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const body = { product };
    lcSet(cacheKey, body, 2 * 60 * 1000);
    res.setHeader('X-Cache', 'MISS');
    res.json(body);
  } catch (err) {
    console.error('GET /api/product/:slug error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/api/filters', async (req, res) => {
  try {
    const cacheKey = 'filters:' + normalizeCacheKey(req.originalUrl);
    const cached = lcGet(cacheKey);
    if (cached) { res.setHeader('X-Cache', 'HIT'); return res.json(cached); }
    const result = await deduped(cacheKey, async () => {
      const { category = '' } = req.query;
      const match = category ? { category: { $regex: new RegExp(category, 'i') } } : {};
      const [brands, categories, storeCounts, priceStats] = await Promise.all([
        Product.aggregate([{ $match: match }, { $group: { _id: '$brand', count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 40 }]),
        Product.aggregate([{ $group: { _id: '$category', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
        Product.aggregate([{ $match: match }, { $unwind: '$prices' }, { $group: { _id: '$prices.store', count: { $sum: 1 } } }]),
        Product.aggregate([{ $match: match }, { $group: { _id: null, min: { $min: '$bestPrice' }, max: { $max: '$bestPrice' } } }])
      ]);
      const storeCountMap = {};
      storeCounts.forEach(s => { storeCountMap[s._id] = s.count; });
      return {
        brands: brands.filter(b => b._id).map(b => ({ name: b._id, count: b.count })),
        categories: categories.filter(c => c._id).map(c => ({ name: c._id, count: c.count })),
        storeCounts: storeCountMap,
        priceRange: priceStats[0] ? { min: priceStats[0].min, max: priceStats[0].max } : { min: 0, max: 10000 }
      };
    });
    lcSet(cacheKey, result, AGG_CACHE_TTL);
    res.setHeader('X-Cache', 'MISS');
    res.json(result);
  } catch (err) {
    console.error('GET /api/filters error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/api/search-suggest', async (req, res) => {
  try {
    const { q = '', limit = 8 } = req.query;
    const trimmedQ = q.trim();
    if (!trimmedQ || trimmedQ.length < 2) return res.json({ suggestions: [] });
    const cacheKey = 'suggest:' + trimmedQ.toLowerCase() + ':' + limit;
    const cached = lcGet(cacheKey);
    if (cached) { res.setHeader('X-Cache', 'HIT'); return res.json(cached); }
    const result = await deduped(cacheKey, async () => {
      const lim = Math.min(20, parseInt(limit));
      let suggestions = [];

      try {
        const textResults = await Product.find(
          { $text: { $search: trimmedQ } },
          { score: { $meta: 'textScore' } }
        )
          .sort({ score: { $meta: 'textScore' } })
          .limit(lim)
          .select('name slug brand category images bestPrice bestPriceStore')
          .lean();
        suggestions = textResults;
      } catch {}

      if (suggestions.length < lim) {
        const words = trimmedQ.split(/\s+/).filter(Boolean);
        const regexPatterns = words.map(w => new RegExp(escapeRegex(w), 'i'));
        const andConditions = regexPatterns.map(r => ({
          $or: [{ name: r }, { brand: r }, { category: r }]
        }));
        const existingSlugs = new Set(suggestions.map(s => s.slug));
        const regexResults = await Product.find({ $and: andConditions })
          .limit(lim)
          .select('name slug brand category images bestPrice bestPriceStore')
          .lean();
        regexResults.forEach(p => { if (!existingSlugs.has(p.slug)) suggestions.push(p); });
      }

      if (suggestions.length < lim && trimmedQ.length >= 3) {
        const fuzzyRegex = buildFuzzyTextRegex(trimmedQ);
        if (fuzzyRegex) {
          const existingSlugs = new Set(suggestions.map(s => s.slug));
          const fuzzyResults = await Product.find({
            $or: [{ name: fuzzyRegex }, { brand: fuzzyRegex }]
          })
            .limit(lim)
            .select('name slug brand category images bestPrice bestPriceStore')
            .lean();
          fuzzyResults.forEach(p => { if (!existingSlugs.has(p.slug)) suggestions.push(p); });
        }
      }

      suggestions = suggestions.slice(0, lim);
      const exactSlug = new Set();
      const ranked = [
        ...suggestions.filter(p => p.name.toLowerCase().includes(trimmedQ.toLowerCase()) && !exactSlug.has(p.slug) && exactSlug.add(p.slug)),
        ...suggestions.filter(p => !exactSlug.has(p.slug))
      ].slice(0, lim);

      return { suggestions: ranked };
    });
    lcSet(cacheKey, result, 60 * 1000);
    res.setHeader('X-Cache', 'MISS');
    res.json(result);
  } catch (err) {
    console.error('GET /api/search-suggest error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/api/budget-build', async (req, res) => {
  try {
    const budget = parseFloat(req.query.budget);
    if (!budget || budget < 100) return res.status(400).json({ error: 'Budget invalide (minimum 100 TND)' });
    const alloc = { gpu: 0.35, cpu: 0.20, mb: 0.12, ram: 0.10, storage: 0.08, psu: 0.07, case: 0.05, cooler: 0.03 };
    const subMap = { gpu: 'Cartes Graphiques', cpu: 'Processeurs', mb: 'Cartes Mère', ram: 'RAM', storage: 'Stockage', psu: 'Alimentation', case: 'Boîtiers', cooler: 'Refroidissement' };
    const result = {};
    for (const [slot, pct] of Object.entries(alloc)) {
      const slotBudget = Math.round(budget * pct);
      const sub = subMap[slot];
      const product = await Product.findOne({
        subcategory: { $regex: new RegExp('^' + sub + '$', 'i') },
        bestPrice: { $lte: slotBudget },
        'prices': { $elemMatch: { inStock: true } }
      }).sort({ bestPrice: -1 }).lean().maxTimeMS(5000);
      result[slot] = product || null;
    }
    const total = Object.values(result).reduce((s, p) => s + (p ? p.bestPrice || 0 : 0), 0);
    const savings = Math.max(0, budget - total);
    res.json({ build: result, total: Math.round(total), savings: Math.round(savings) });
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;