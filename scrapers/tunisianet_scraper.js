/**
 * ════════════════════════════════════════════════════════════
 *  Tunisianet Price Updater
 *  يجلب أسعار المنتجات الموجودة في قاعدة البيانات من Tunisianet
 *  عبر روابطها المخزّنة في prices[].url
 * ════════════════════════════════════════════════════════════
 */

const axios  = require('axios');
const cheerio = require('cheerio');
const Product = require('../models/Product');
const ScraperLog = require('../models/ScraperLog');

/* ─── ثوابت ─── */
const STORE_NAME = 'Tunisianet';
const BASE_URL   = 'https://www.tunisianet.com.tn';
const DELAYS     = { min: 1500, max: 3500 };   // تأخير عشوائي بين الطلبات (ms)
const BATCH_SIZE = 5;                           // عدد المنتجات المعالجة بالتوازي

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];

/* ─── مساعدات ─── */
const delay = (min = DELAYS.min, max = DELAYS.max) =>
  new Promise(r => setTimeout(r, Math.floor(Math.random() * (max - min + 1)) + min));

const randomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

/**
 * يستخرج السعر من صفحة منتج Tunisianet
 * يجرّب عدة مصادر بالترتيب: meta OG ← JSON-LD ← CSS selector
 */
function extractPrice($) {
  // ① الأفضل: meta property="product:price:amount"  (كما يظهر في الصورة)
  const metaPrice = $('meta[property="product:price:amount"]').attr('content');
  if (metaPrice) {
    const num = parseFloat(String(metaPrice).replace(',', '.'));
    if (!isNaN(num) && num > 0) return num;
  }

  // ② JSON-LD
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html());
      const offers = data.offers || (data['@graph'] && data['@graph'].find(x => x.offers)?.offers);
      if (offers) {
        const price = offers.price || offers.lowPrice;
        if (price) return parseFloat(price);
      }
    } catch (_e) {}
  });

  // ③ CSS Selectors  (fallback)
  const selectors = [
    '.current-price .price',
    'span[itemprop="price"]',
    '.product-price .price',
    '.price',
    '#our_price_display',
  ];
  for (const sel of selectors) {
    const raw = $(sel).first().text().trim();
    if (!raw) continue;
    const cleaned = raw.replace(/[^\d,.\s]/g, '').replace(',', '.').trim();
    const num = parseFloat(cleaned);
    if (!isNaN(num) && num > 0) return num;
  }

  return null;
}

/**
 * يستخرج حالة التوفر من الصفحة
 */
function extractInStock($) {
  // meta availability
  const avail = $('meta[property="product:availability"]').attr('content') || '';
  if (avail) {
    if (avail.toLowerCase().includes('instock') || avail.toLowerCase().includes('in stock')) return true;
    if (avail.toLowerCase().includes('outofstock') || avail.toLowerCase().includes('out of stock')) return false;
  }

  // CSS fallbacks
  if ($('.add-to-cart, #add_to_cart button:not([disabled])').length > 0) return true;
  if ($('.out-of-stock, .product-unavailable, .no-stock').length > 0) return false;

  // نص الصفحة
  const bodyText = $('body').text();
  if (/en stock|disponible|available/i.test(bodyText)) return true;
  if (/rupture|indisponible|out of stock/i.test(bodyText)) return false;

  return true; // افتراضي: متوفر
}

/**
 * يجلب بيانات صفحة منتج واحدة من Tunisianet
 * يُعيد { price, inStock } أو null عند الفشل
 */
async function fetchProductPage(url) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': randomUA(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8,ar;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache',
        'Referer': BASE_URL,
      },
      timeout: 20000,
      maxRedirects: 5,
      validateStatus: status => status < 500,
    });

    if (response.status === 404) return { notFound: true };
    if (response.status !== 200) return null;

    const $ = cheerio.load(response.data);
    const price   = extractPrice($);
    const inStock = extractInStock($);

    return price ? { price, inStock } : null;

  } catch (err) {
    if (err.code === 'ECONNABORTED') return null;  // timeout
    if (err.response?.status === 404) return { notFound: true };
    throw err;
  }
}

/**
 * الدالة الرئيسية: تُحدّث أسعار Tunisianet لجميع المنتجات التي لها رابط مخزّن
 *
 * @param {Function} onProgress  callback(data) — يُستدعى مع تقدّم العملية
 * @returns {Object}  ملخّص النتائج
 */
async function updateTunisianetPrices(onProgress = () => {}) {

  /* ── 1. إنشاء سجل جديد في قاعدة البيانات ── */
  const log = await ScraperLog.startRun(STORE_NAME);

  onProgress({ progress: 0, message: 'جلب قائمة المنتجات من قاعدة البيانات…', currentStore: STORE_NAME, status: 'running' });

  /* ── 2. جلب المنتجات التي لها رابط Tunisianet ── */
  const products = await Product.find({
    'prices': { $elemMatch: { store: STORE_NAME, url: { $exists: true, $ne: '' } } }
  }).select('name prices priceHistory bestPrice bestPriceStore').lean();

  if (!products.length) {
    onProgress({ progress: 100, message: 'لا توجد منتجات بروابط Tunisianet', status: 'done' });
    await log.finish('success');
    return { updated: 0, failed: 0, notFound: 0, total: 0 };
  }

  const total   = products.length;
  let updated   = 0;
  let failed    = 0;
  let notFound  = 0;
  let processed = 0;

  onProgress({
    progress: 2,
    message:  `${total} منتج بروابط Tunisianet — بدء التحديث…`,
    currentStore: STORE_NAME,
    status: 'running'
  });

  /* ── 3. معالجة المنتجات على دفعات ── */
  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    const batch = products.slice(i, i + BATCH_SIZE);

    await Promise.all(batch.map(async (product) => {
      const storeEntry = product.prices.find(p => p.store === STORE_NAME);
      if (!storeEntry?.url) return;  // تجاهل المنتجات بدون رابط

      try {
        const result = await fetchProductPage(storeEntry.url);

        /* المنتج غير موجود في الموقع (404) */
        if (result?.notFound) {
          notFound++;
          log.addError(`[404] ${product.name} — ${storeEntry.url}`);
          return;
        }

        /* فشل استخراج السعر */
        if (!result?.price) {
          failed++;
          log.addError(`[NO_PRICE] ${product.name}`);
          return;
        }

        /* ── تحديث قاعدة البيانات إذا تغيّر السعر ── */
        const oldPrice = storeEntry.price;
        const newPrice = result.price;

        const doc = await Product.findById(product._id);
        if (!doc) return;

        /* تسجيل تغيير السعر في السجل */
        if (oldPrice != null && Math.abs(oldPrice - newPrice) > 0.001) {
          log.addPriceChange(product.name, STORE_NAME, oldPrice, newPrice, product._id);
        }

        /* تحديث السعر وحالة التوفر */
        doc.updateStorePrice(STORE_NAME, {
          price:   newPrice,
          url:     storeEntry.url,
          inStock: result.inStock,
        });

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
      progress:     pct,
      message:      `${processed}/${total} — محدَّث: ${updated} | فشل: ${failed}`,
      currentStore: STORE_NAME,
      status:       'running'
    });

    /* تأخير بين الدفعات لتجنّب الحظر */
    if (i + BATCH_SIZE < products.length) {
      await delay();
    }
  }

  /* ── 4. إنهاء السجل ── */
  const finalStatus = failed > 0 || notFound > 0
    ? (updated > 0 ? 'partial' : 'failed')
    : 'success';

  await log.finish(finalStatus);

  const summary = { total, updated, failed, notFound };

  onProgress({
    progress:     100,
    message:      `✓ اكتمل — محدَّث: ${updated} | فشل: ${failed} | غير موجود: ${notFound}`,
    currentStore: STORE_NAME,
    status:       'done',
    results: {
      newProductsFound: log.newProductsFound,
      priceChanges:     log.priceChanges,
      errors:           log.errors,
      ...summary,
    }
  });

  return summary;
}

module.exports = { updateTunisianetPrices };
