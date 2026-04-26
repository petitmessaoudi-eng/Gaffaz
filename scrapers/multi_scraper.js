const axios = require('axios');
const cheerio = require('cheerio');
const Product = require('../models/Product');
const ScraperLog = require('../models/ScraperLog');

const BATCH_SIZE = 5;
const DELAYS = { min: 1500, max: 3500 };

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];

const delay = (min = DELAYS.min, max = DELAYS.max) =>
  new Promise(r => setTimeout(r, Math.floor(Math.random() * (max - min + 1)) + min));

const randomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

function cleanPrice(raw) {
  if (!raw) return null;
  const num = parseFloat(String(raw).replace(/[^\d.]/g, ''));
  return isNaN(num) || num <= 0 ? null : num;
}

const EXTRACTORS = {
  Skymil: ($) => {
    const contentAttr = $('span[itemprop="price"]').attr('content');
    if (contentAttr) return cleanPrice(contentAttr);

    const spanText = $('.current-price span[itemprop="price"]').text();
    if (spanText) return cleanPrice(spanText);

    const metaPrice = $('meta[itemprop="price"]').attr('content');
    if (metaPrice) return cleanPrice(metaPrice);

    return null;
  },

  SpaceNet: ($) => {
    const spanContent = $('.current-price span[content]').attr('content');
    if (spanContent) return cleanPrice(spanContent);

    const spanText = $('.current-price span').first().text();
    if (spanText) return cleanPrice(spanText);

    const metaPrice = $('meta[property="product:price:amount"]').attr('content');
    if (metaPrice) return cleanPrice(metaPrice);

    const metaItemprop = $('meta[itemprop="price"]').attr('content');
    if (metaItemprop) return cleanPrice(metaItemprop);

    return null;
  },

  Mytek: ($) => {
    const metaItemprop = $('meta[itemprop="price"]').attr('content');
    if (metaItemprop) return cleanPrice(metaItemprop);

    const dataPriceAmount = $('[data-price-amount]').first().attr('data-price-amount');
    if (dataPriceAmount) return cleanPrice(dataPriceAmount);

    const priceWrapper = $('.price-wrapper[data-price-amount]').attr('data-price-amount');
    if (priceWrapper) return cleanPrice(priceWrapper);

    const spanPrice = $('.price').first().text();
    if (spanPrice) return cleanPrice(spanPrice);

    return null;
  },
};

const STOCK_EXTRACTORS = {
  Skymil: ($) => {
    const avail = $('link[itemprop="availability"]').attr('href') || '';
    if (avail.includes('InStock')) return true;
    if (avail.includes('OutOfStock')) return false;
    return $('.product-availability').text().toLowerCase().includes('disponible');
  },

  SpaceNet: ($) => {
    const avail = $('link[href*="schema.org"]').attr('href') || '';
    if (avail.includes('InStock')) return true;
    if (avail.includes('PreOrder') || avail.includes('OutOfStock')) return false;
    const text = $('.product-availability, #product-availability').text().toLowerCase();
    return !text.includes('rupture') && !text.includes('indisponible');
  },

  Mytek: ($) => {
    const avail = $('link[itemprop="availability"]').attr('href') || '';
    if (avail.includes('InStock')) return true;
    if (avail.includes('OutOfStock')) return false;
    return !$('.unavailable, .out-of-stock').length;
  },
};

async function fetchPage(url) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': randomUA(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache',
      },
      timeout: 20000,
      maxRedirects: 5,
      validateStatus: s => s < 500,
    });

    if (response.status === 404) return { notFound: true };
    if (response.status !== 200) return null;

    return { html: response.data };
  } catch (err) {
    if (err.response?.status === 404) return { notFound: true };
    return null;
  }
}

async function updateStorePrices(storeName, onProgress = () => {}) {
  const extractPrice = EXTRACTORS[storeName];
  const extractStock = STOCK_EXTRACTORS[storeName];

  if (!extractPrice) throw new Error(`Store inconnu: ${storeName}`);

  const log = await ScraperLog.startRun(storeName);

  onProgress({ progress: 0, message: `جلب منتجات ${storeName}…`, currentStore: storeName, status: 'running' });

  const products = await Product.find({
    'prices': { $elemMatch: { store: storeName, url: { $exists: true, $ne: '' } } }
  }).select('name prices priceHistory bestPrice bestPriceStore').lean();

  if (!products.length) {
    onProgress({ progress: 100, message: `لا توجد منتجات بروابط ${storeName}`, status: 'done' });
    await log.finish('success');
    return { updated: 0, failed: 0, notFound: 0, total: 0 };
  }

  const total = products.length;
  let updated = 0, failed = 0, notFound = 0, processed = 0;

  onProgress({ progress: 2, message: `${total} منتج — بدء التحديث…`, currentStore: storeName, status: 'running' });

  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    const batch = products.slice(i, i + BATCH_SIZE);

    await Promise.all(batch.map(async (product) => {
      const storeEntry = product.prices.find(p => p.store === storeName);
      if (!storeEntry?.url) return;

      try {
        const result = await fetchPage(storeEntry.url);

        if (result?.notFound) {
          notFound++;
          log.addError(`[404] ${product.name}`);
          return;
        }

        if (!result?.html) {
          failed++;
          log.addError(`[FETCH_FAIL] ${product.name}`);
          return;
        }

        const $ = cheerio.load(result.html);
        const price = extractPrice($);
        const inStock = extractStock($);

        if (!price) {
          failed++;
          log.addError(`[NO_PRICE] ${product.name}`);
          return;
        }

        const oldPrice = storeEntry.price;
        const doc = await Product.findById(product._id);
        if (!doc) return;

        if (oldPrice != null && Math.abs(oldPrice - price) > 0.001) {
          log.addPriceChange(product.name, storeName, oldPrice, price, product._id);
        }

        doc.updateStorePrice(storeName, { price, url: storeEntry.url, inStock });
        await doc.save();
        updated++;

      } catch (err) {
        failed++;
        log.addError(`[ERROR] ${product.name}: ${err.message}`);
      }
    }));

    processed += batch.length;
    log.productsScraped = processed;
    log.productsUpdated = updated;

    const pct = Math.min(95, Math.round(2 + (processed / total) * 93));
    onProgress({
      progress: pct,
      message: `${processed}/${total} — محدَّث: ${updated} | فشل: ${failed}`,
      currentStore: storeName,
      status: 'running',
    });

    if (i + BATCH_SIZE < products.length) await delay();
  }

  const finalStatus = updated > 0 ? (failed > 0 ? 'partial' : 'success') : 'failed';
  await log.finish(finalStatus);

  const summary = { total, updated, failed, notFound };

  onProgress({
    progress: 100,
    message: `✓ ${storeName} — محدَّث: ${updated} | فشل: ${failed} | غير موجود: ${notFound}`,
    currentStore: storeName,
    status: 'done',
    results: {
      newProductsFound: log.newProductsFound,
      priceChanges: log.priceChanges,
      errors: log.errors,
      ...summary,
    },
  });

  return summary;
}

module.exports = { updateStorePrices };
