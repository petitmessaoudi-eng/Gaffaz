const express = require('express');
const router = express.Router();
const path = require('path');
const Product = require('../models/Product');

router.get('/products', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/store.html'));
});

router.get('/product/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/product.html'));
});

router.get('/api/products', async (req, res) => {
  try {
    const {
      page = 1, limit = 24, sort = 'createdAt_desc',
      search = '', category = '', subcategory = '', stores = '', brands = '',
      priceMin = '', priceMax = '', inStock = ''
    } = req.query;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const query = {};

    if (search) {
      query.$text = { $search: search };
    }

    if (category) {
      query.category = { $regex: new RegExp(category, 'i') };
    }

    if (subcategory) {
      query.subcategory = { $regex: new RegExp('^' + subcategory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') };
    }

    if (stores) {
      const storeList = stores.split(',').map(s => s.trim()).filter(Boolean);
      if (storeList.length) {
        query['prices.store'] = { $in: storeList };
      }
    }

    if (brands) {
      const brandList = brands.split(',').map(b => b.trim()).filter(Boolean);
      if (brandList.length) {
        query.brand = { $in: brandList };
      }
    }

    if (priceMin || priceMax) {
      query.bestPrice = {};
      if (priceMin) query.bestPrice.$gte = parseFloat(priceMin);
      if (priceMax) query.bestPrice.$lte = parseFloat(priceMax);
    }

    if (inStock === 'true') {
      query['prices'] = { $elemMatch: { inStock: true } };
    }

    // ── Spec filters: specs[key]=val  /  specs[key]=v1,v2  /  specs[key]=__range:min:max ──
    // specs is parsed by Express as req.query.specs = { key: 'val', ... }
    const specsRaw = req.query['specs'];
    if (specsRaw && typeof specsRaw === 'object' && !Array.isArray(specsRaw)) {
      Object.entries(specsRaw).forEach(([key, rawVal]) => {
        if (!key || rawVal == null || rawVal === '') return;
        const specField = 'specs.' + key;
        const strVal = String(rawVal).trim();

        // Boolean filter
        if (strVal === 'true') {
          query[specField] = { $in: [true, 'true', 'Oui', 'oui', 'Yes', 'yes', '1', 1] };
          return;
        }

        // Range filter: __range:min:max
        if (strVal.startsWith('__range:')) {
          const parts = strVal.slice(8).split(':'); // [min, max]
          const minV = parts[0] !== '' ? parseFloat(parts[0]) : null;
          const maxV = parts[1] !== '' ? parseFloat(parts[1]) : null;
          const rangeQ = {};
          if (minV !== null && !isNaN(minV)) rangeQ.$gte = minV;
          if (maxV !== null && !isNaN(maxV)) rangeQ.$lte = maxV;
          if (Object.keys(rangeQ).length) {
            // Match both numeric values stored as number or as string
            query.$and = query.$and || [];
            query.$and.push({
              $or: [
                { [specField]: rangeQ },
                // Also try string comparison for specs stored as strings
                ...(minV !== null ? [{ [specField]: { $gte: String(minV) } }] : []),
                ...(maxV !== null ? [{ [specField]: { $lte: String(maxV) } }] : [])
              ]
            });
          }
          return;
        }

        const vals = strVal.split(',').map(v => v.trim()).filter(Boolean);
        if (!vals.length) return;

        if (vals.length === 1) {
          // Single value: try exact match OR regex for strings, plus numeric
          const numV = parseFloat(vals[0]);
          const candidates = [vals[0]];
          if (!isNaN(numV)) candidates.push(numV);
          // Use $in for exact match (covers both stored-as-string and stored-as-number)
          query[specField] = { $in: candidates };
          return;
        }

        // Multiple values (checkbox): $in — accept stored as string OR number
        const inVals = [];
        vals.forEach(v => {
          inVals.push(v);
          const n = parseFloat(v);
          if (!isNaN(n)) inVals.push(n);
        });
        query[specField] = { $in: inVals };
      });
    }

    const sortMap = {
      'bestPrice_asc': { bestPrice: 1 },
      'bestPrice_desc': { bestPrice: -1 },
      'name_asc': { name: 1 },
      'name_desc': { name: -1 },
      'createdAt_desc': { createdAt: -1 },
      'createdAt_asc': { createdAt: 1 }
    };
    const sortObj = sortMap[sort] || { createdAt: -1 };

    const [products, total] = await Promise.all([
      Product.find(query)
        .sort(sortObj)
        .skip(skip)
        .limit(limitNum)
        .select('name slug brand category images bestPrice bestPriceStore prices createdAt')
        .lean(),
      Product.countDocuments(query)
    ]);

    const storeCounts = await Product.aggregate([
      { $match: query },
      { $unwind: '$prices' },
      { $group: { _id: '$prices.store', count: { $sum: 1 } } }
    ]);

    const storeCountMap = {};
    storeCounts.forEach(s => { storeCountMap[s._id] = s.count; });

    const brandAgg = await Product.aggregate([
      { $match: query },
      { $group: { _id: '$brand', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 30 }
    ]);
    const brandsResult = brandAgg.filter(b => b._id).map(b => ({ name: b._id, count: b.count }));

    res.json({
      products,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
      filters: {
        storeCounts: storeCountMap,
        brands: brandsResult
      }
    });
  } catch (err) {
    console.error('GET /api/products error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/api/product/:slug', async (req, res) => {
  try {
    const product = await Product.findOne({ slug: req.params.slug }).lean();
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json({ product });
  } catch (err) {
    console.error('GET /api/product/:slug error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/api/filters', async (req, res) => {
  try {
    const { category = '' } = req.query;
    const match = category ? { category: { $regex: new RegExp(category, 'i') } } : {};

    const [brands, categories, storeCounts, priceStats] = await Promise.all([
      Product.aggregate([
        { $match: match },
        { $group: { _id: '$brand', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 40 }
      ]),
      Product.aggregate([
        { $group: { _id: '$category', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      Product.aggregate([
        { $match: match },
        { $unwind: '$prices' },
        { $group: { _id: '$prices.store', count: { $sum: 1 } } }
      ]),
      Product.aggregate([
        { $match: match },
        { $group: { _id: null, min: { $min: '$bestPrice' }, max: { $max: '$bestPrice' } } }
      ])
    ]);

    const storeCountMap = {};
    storeCounts.forEach(s => { storeCountMap[s._id] = s.count; });

    res.json({
      brands: brands.filter(b => b._id).map(b => ({ name: b._id, count: b.count })),
      categories: categories.filter(c => c._id).map(c => ({ name: c._id, count: c.count })),
      storeCounts: storeCountMap,
      priceRange: priceStats[0] ? { min: priceStats[0].min, max: priceStats[0].max } : { min: 0, max: 10000 }
    });
  } catch (err) {
    console.error('GET /api/filters error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/api/search-suggest', async (req, res) => {
  try {
    const { q = '', limit = 8 } = req.query;
    if (!q || q.length < 2) return res.json({ suggestions: [] });

    const suggestions = await Product.find(
      { $text: { $search: q } },
      { score: { $meta: 'textScore' } }
    )
      .sort({ score: { $meta: 'textScore' } })
      .limit(parseInt(limit))
      .select('name slug brand category images bestPrice bestPriceStore')
      .lean();

    if (!suggestions.length) {
      const regex = new RegExp(q, 'i');
      const fallback = await Product.find({ $or: [{ name: regex }, { brand: regex }] })
        .limit(parseInt(limit))
        .select('name slug brand category images bestPrice bestPriceStore')
        .lean();
      return res.json({ suggestions: fallback });
    }

    res.json({ suggestions });
  } catch (err) {
    console.error('GET /api/search-suggest error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;