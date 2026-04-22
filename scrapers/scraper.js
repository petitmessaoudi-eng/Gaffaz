const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const mongoose = require('mongoose');
const Product = require('../models/Product');
const ScraperLog = require('../models/ScraperLog');

const DELAYS = { min: 1200, max: 2800 };
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
];

const CATEGORY_MAP = {
  'pc-portable': 'PC Portable',
  'pc-portable-gamer': 'PC Portable Gamer',
  'ordinateur-portable': 'PC Portable',
  'laptop': 'PC Portable',
  'gaming-laptop': 'PC Portable Gamer',
  'pc-de-bureau': 'PC de Bureau',
  'desktop': 'PC de Bureau',
  'pc-gamer': 'PC Gamer',
  'ecran-pc': 'Écran PC',
  'moniteur': 'Écran PC',
  'composants': 'Composants PC',
  'imprimante': 'Imprimante',
  'accessoires-informatique': 'Accessoires Informatiques',
  'smartphone': 'Smartphone',
  'telephone': 'Smartphone',
  'tablette': 'Tablette',
  'accessoires-telephone': 'Accessoires Téléphonie',
  'television': 'Télévision',
  'tv': 'Télévision',
  'home-cinema': 'Home Cinéma & Barre de Son',
  'barre-de-son': 'Home Cinéma & Barre de Son',
  'enceinte': 'Enceinte Bluetooth',
  'casque': 'Casque & Écouteurs Audio',
  'refrigerateur': 'Réfrigérateur',
  'machine-a-laver': 'Machine à Laver',
  'seche-linge': 'Sèche-Linge',
  'climatiseur': 'Climatiseur',
  'cuisiniere': 'Cuisinière & Four',
  'four': 'Cuisinière & Four',
  'lave-vaisselle': 'Lave-Vaisselle',
  'micro-ondes': 'Micro-ondes',
  'aspirateur': 'Aspirateur',
  'petit-electromenager': 'Petit Électroménager Cuisine',
  'soin-personnel': 'Soin Personnel & Beauté'
};

const STORE_CONFIGS = {
  Tunisianet: {
    method: 'axios',
    baseUrl: 'https://www.tunisianet.com.tn',
    categoryUrls: [
      'https://www.tunisianet.com.tn/702-pc-portable',
      'https://www.tunisianet.com.tn/280-smartphone',
      'https://www.tunisianet.com.tn/514-television',
      'https://www.tunisianet.com.tn/296-refrigerateur',
      'https://www.tunisianet.com.tn/301-machine-a-laver',
      'https://www.tunisianet.com.tn/366-climatiseur',
      'https://www.tunisianet.com.tn/ecran-pc',
      'https://www.tunisianet.com.tn/tablette'
    ],
    pagination: { param: 'p', startPage: 1, maxPages: 15 },
    selectors: {
      productList: '.product_list .ajax_block_product, .product-container',
      name: '.product-name, h1.product_name, .product_name a',
      price: '.price, .product-price .price, span.price',
      image: 'img.replace-2x, .product_img_link img, img[itemprop="image"]',
      link: 'a.product_img_link, a.product-name, h5.product-title a',
      brand: '.manufacturer, [itemprop="brand"]',
      inStock: '.availability .label-success, .in_stock',
      nextPage: '.pagination li.next a, a[rel="next"]'
    }
  },
  SpaceNet: {
    method: 'axios',
    baseUrl: 'https://www.spacenet.tn',
    categoryUrls: [
      'https://www.spacenet.tn/informatique/pc-portables',
      'https://www.spacenet.tn/telephonie/smartphones',
      'https://www.spacenet.tn/tv-audio-video/televisions',
      'https://www.spacenet.tn/electromenager/refrigerateurs',
      'https://www.spacenet.tn/informatique/ecrans',
      'https://www.spacenet.tn/informatique/composants'
    ],
    pagination: { param: 'page', startPage: 1, maxPages: 15 },
    selectors: {
      productList: '.product-miniature, .product_list .product-container',
      name: '.product-title a, h2.product-title a',
      price: '.price, .product-price-and-shipping .price',
      image: 'img.img-fluid, .product-thumbnail img',
      link: '.product-title a, .product-thumbnail a',
      brand: '.manufacturer-name, .brand',
      inStock: '.product-availability .label-success, .add-to-cart:not([disabled])',
      nextPage: '.next a, li.next a'
    }
  },
  Skymil: {
    method: 'puppeteer',
    baseUrl: 'https://www.skymil.tn',
    categoryUrls: [
      'https://www.skymil.tn/informatique/pc-portables',
      'https://www.skymil.tn/telephonie/smartphones',
      'https://www.skymil.tn/tv-son/televiseurs',
      'https://www.skymil.tn/electromenager/refrigerateurs'
    ],
    pagination: { param: 'page', startPage: 1, maxPages: 10 },
    selectors: {
      productList: '.product-item, .product_list article',
      name: '.product-title, h3.product-title a, .product-name',
      price: '.price, .product-price .price',
      image: 'img.product_image, .product-image-container img',
      link: 'a.product_img_link, .product-title a',
      brand: '.brand, .manufacturer',
      inStock: '.add-to-cart:not(.disabled), .in-stock',
      nextPage: 'a[rel="next"], .next a'
    }
  },
  Mytek: {
    method: 'axios',
    baseUrl: 'https://www.mytek.tn',
    categoryUrls: [
      'https://www.mytek.tn/informatique/pc-portable.html',
      'https://www.mytek.tn/telephonie/smartphones.html',
      'https://www.mytek.tn/tv-son/televiseurs.html',
      'https://www.mytek.tn/electromenager/refrigerateurs.html',
      'https://www.mytek.tn/informatique/ecrans.html'
    ],
    pagination: { param: 'p', startPage: 1, maxPages: 15 },
    selectors: {
      productList: '.product-items .product-item, .products-grid .item',
      name: '.product-item-link, a.product-item-link',
      price: '.price, .special-price .price, .regular-price .price',
      image: 'img.product-image-photo, .product-image-container img',
      link: 'a.product-item-link, .product-item-photo a',
      brand: '.product-brand, .manufacturer',
      inStock: '.action.primary.tocart:not(.disabled), .stock.available',
      nextPage: 'a.action.next, li.pages-item-next a'
    }
  }
};

function randomDelay(min = DELAYS.min, max = DELAYS.max) {
  return new Promise(r => setTimeout(r, Math.floor(Math.random() * (max - min + 1)) + min));
}

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function guessCategory(urlPath, productName) {
  const combined = (urlPath + ' ' + (productName || '')).toLowerCase().replace(/[^a-z0-9]/g, '-');
  for (const [key, value] of Object.entries(CATEGORY_MAP)) {
    if (combined.includes(key.replace(/-/g, ''))) return value;
  }
  for (const [key, value] of Object.entries(CATEGORY_MAP)) {
    if (combined.includes(key)) return value;
  }
  return 'Autres';
}

function cleanPrice(raw) {
  if (!raw) return null;
  const cleaned = String(raw)
    .replace(/[^\d,.\s]/g, '')
    .replace(/\s/g, '')
    .replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) || num <= 0 ? null : num;
}

function cleanName(raw) {
  if (!raw) return null;
  return String(raw).replace(/\s+/g, ' ').trim().slice(0, 500);
}

function cleanUrl(href, baseUrl) {
  if (!href) return '';
  if (href.startsWith('http')) return href;
  if (href.startsWith('//')) return 'https:' + href;
  return baseUrl.replace(/\/$/, '') + '/' + href.replace(/^\//, '');
}

async function loadDbConfig() {
  try {
    const db = mongoose.connection.db;
    const config = await db.collection('scraper_config').findOne({ _id: 'main' });
    if (config && config.stores) {
      Object.entries(config.stores).forEach(([store, conf]) => {
        if (STORE_CONFIGS[store] && conf.categoryUrls) {
          STORE_CONFIGS[store].categoryUrls = conf.categoryUrls;
        }
      });
    }
  } catch (e) {}
}

async function scrapeWithAxios(storeName, config, onProgress, log) {
  const results = [];
  const storeColor = { Tunisianet: '#e2001a', SpaceNet: '#0066cc', Mytek: '#00933b' };
  const totalUrls = config.categoryUrls.length;

  for (let urlIdx = 0; urlIdx < totalUrls; urlIdx++) {
    const catUrl = config.categoryUrls[urlIdx];
    let page = config.pagination.startPage;
    let hasMore = true;

    while (hasMore && page <= config.pagination.maxPages) {
      const separator = catUrl.includes('?') ? '&' : '?';
      const pageUrl = page === 1 ? catUrl : `${catUrl}${separator}${config.pagination.param}=${page}`;

      try {
        const response = await axios.get(pageUrl, {
          headers: {
            'User-Agent': randomUA(),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Cache-Control': 'no-cache'
          },
          timeout: 25000,
          maxRedirects: 5
        });

        const $ = cheerio.load(response.data);
        const productEls = $(config.selectors.productList);

        if (!productEls.length) { hasMore = false; break; }

        productEls.each((i, el) => {
          const nameEl = $(el).find(config.selectors.name).first();
          const priceEl = $(el).find(config.selectors.price).first();
          const imgEl = $(el).find(config.selectors.image).first();
          const linkEl = $(el).find(config.selectors.link).first();
          const brandEl = $(el).find(config.selectors.brand).first();
          const stockEl = $(el).find(config.selectors.inStock);

          const name = cleanName(nameEl.text() || nameEl.attr('title'));
          const price = cleanPrice(priceEl.text());
          const imgSrc = imgEl.attr('data-src') || imgEl.attr('src') || imgEl.attr('data-lazy-src') || '';
          const href = linkEl.attr('href') || '';
          const brand = (brandEl.text() || '').trim().slice(0, 100);
          const inStock = stockEl.length > 0;

          if (!name || !price) return;

          const url = cleanUrl(href, config.baseUrl);
          const image = cleanUrl(imgSrc, config.baseUrl);
          const category = guessCategory(catUrl + ' ' + url, name);

          results.push({ name, price, url, image: image || '', brand, inStock, category });
        });

        const nextPageEl = $(config.selectors.nextPage);
        hasMore = nextPageEl.length > 0 && productEls.length > 0;
        page++;

        const pct = Math.round(((urlIdx + page / config.pagination.maxPages) / totalUrls) * 100);
        onProgress({ progress: Math.min(pct, 95), message: `${storeName}: page ${page - 1} — ${results.length} produits`, currentStore: storeName });

        await randomDelay();
      } catch (err) {
        log.addError(`${storeName} [${pageUrl}]: ${err.message}`);
        hasMore = false;
      }
    }
  }

  return results;
}

async function scrapeWithPuppeteer(storeName, config, onProgress, log) {
  const results = [];
  let browser = null;

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent(randomUA());
    await page.setViewport({ width: 1366, height: 768 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'fr-FR,fr;q=0.9' });

    const totalUrls = config.categoryUrls.length;

    for (let urlIdx = 0; urlIdx < totalUrls; urlIdx++) {
      const catUrl = config.categoryUrls[urlIdx];
      let pageNum = config.pagination.startPage;
      let hasMore = true;

      while (hasMore && pageNum <= config.pagination.maxPages) {
        const separator = catUrl.includes('?') ? '&' : '?';
        const pageUrl = pageNum === 1 ? catUrl : `${catUrl}${separator}${config.pagination.param}=${pageNum}`;

        try {
          await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await randomDelay(800, 1500);

          const pageResults = await page.evaluate((selectors, base) => {
            const items = [];
            document.querySelectorAll(selectors.productList).forEach(el => {
              const nameEl = el.querySelector(selectors.name);
              const priceEl = el.querySelector(selectors.price);
              const imgEl = el.querySelector(selectors.image);
              const linkEl = el.querySelector(selectors.link);
              const brandEl = el.querySelector(selectors.brand);
              const stockEl = el.querySelector(selectors.inStock);

              const name = (nameEl?.textContent || nameEl?.getAttribute('title') || '').trim();
              const priceRaw = (priceEl?.textContent || '').trim();
              const imgSrc = imgEl?.getAttribute('data-src') || imgEl?.getAttribute('src') || '';
              const href = linkEl?.getAttribute('href') || '';
              const brand = (brandEl?.textContent || '').trim().slice(0, 100);
              const inStock = !!stockEl;

              if (name && priceRaw) {
                items.push({ name, priceRaw, imgSrc, href, brand, inStock });
              }
            });
            return items;
          }, config.selectors, config.baseUrl);

          if (!pageResults.length) { hasMore = false; break; }

          pageResults.forEach(item => {
            const price = cleanPrice(item.priceRaw);
            if (!item.name || !price) return;
            results.push({
              name: cleanName(item.name),
              price,
              url: cleanUrl(item.href, config.baseUrl),
              image: cleanUrl(item.imgSrc, config.baseUrl),
              brand: item.brand,
              inStock: item.inStock,
              category: guessCategory(catUrl + ' ' + item.href, item.name)
            });
          });

          const hasNext = await page.$(config.selectors.nextPage);
          hasMore = !!hasNext && pageResults.length > 0;
          pageNum++;

          const pct = Math.round(((urlIdx + pageNum / config.pagination.maxPages) / totalUrls) * 100);
          onProgress({ progress: Math.min(pct, 95), message: `${storeName}: page ${pageNum - 1} — ${results.length} produits`, currentStore: storeName });

          await randomDelay();
        } catch (err) {
          log.addError(`${storeName} [${pageUrl}]: ${err.message}`);
          hasMore = false;
        }
      }
    }
  } catch (err) {
    log.addError(`${storeName} browser error: ${err.message}`);
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
  }

  return results;
}

async function processScrapedProducts(storeName, scrapedProducts, log) {
  let updated = 0;
  const BATCH = 20;

  for (let i = 0; i < scrapedProducts.length; i += BATCH) {
    const batch = scrapedProducts.slice(i, i + BATCH);

    await Promise.all(batch.map(async (item) => {
      try {
        const existing = await Product.findOne({
          $or: [
            { name: { $regex: new RegExp('^' + item.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') } },
            { 'prices.url': item.url }
          ]
        });

        if (existing) {
          const storeEntry = existing.prices.find(p => p.store === storeName);
          const oldPrice = storeEntry ? storeEntry.price : null;

          if (oldPrice !== null && Math.abs(oldPrice - item.price) > 0.001) {
            log.addPriceChange(existing.name, storeName, oldPrice, item.price, existing._id);
          }

          existing.updateStorePrice(storeName, {
            price: item.price,
            url: item.url,
            inStock: item.inStock,
            lastUpdated: new Date()
          });

          if (!existing.images || !existing.images.length) {
            if (item.image) existing.images = [item.image];
          }
          if (!existing.brand && item.brand) existing.brand = item.brand;

          await existing.save();
          updated++;
        } else {
          log.addNewProduct(item.name);
          // Create new product with initial price history entry
          try {
            const initPrices = [{
              store: storeName,
              price: item.price,
              url: item.url,
              inStock: item.inStock,
              lastUpdated: new Date()
            }];
            const newProduct = new Product({
              name: item.name,
              brand: item.brand || '',
              category: item.category || 'Autres',
              images: item.image ? [item.image] : [],
              prices: initPrices,
              priceHistory: [{ store: storeName, price: item.price, date: new Date() }]
            });
            await newProduct.save();
            log.productsUpdated++;
          } catch (err) {
            log.addError(`Création "${item.name}": ${err.message}`);
          }
        }
      } catch (err) {
        log.addError(`Traitement "${item.name}": ${err.message}`);
      }
    }));
  }

  return updated;
}

async function runStore(storeName, onProgress, log) {
  const config = STORE_CONFIGS[storeName];
  if (!config) throw new Error(`Store inconnu: ${storeName}`);

  onProgress({ currentStore: storeName, message: `Démarrage ${storeName}…`, progress: 2 });

  let scrapedProducts = [];

  try {
    if (config.method === 'puppeteer') {
      scrapedProducts = await scrapeWithPuppeteer(storeName, config, onProgress, log);
    } else {
      scrapedProducts = await scrapeWithAxios(storeName, config, onProgress, log);
    }
  } catch (err) {
    log.addError(`${storeName} scrape failed: ${err.message}`);
    return { store: storeName, scraped: 0, updated: 0 };
  }

  onProgress({ message: `${storeName}: traitement de ${scrapedProducts.length} produits…`, progress: 96 });

  log.productsScraped += scrapedProducts.length;
  const updated = await processScrapedProducts(storeName, scrapedProducts, log);
  log.productsUpdated += updated;

  onProgress({ message: `${storeName}: terminé — ${scrapedProducts.length} scrapés, ${updated} mis à jour`, progress: 100 });

  return { store: storeName, scraped: scrapedProducts.length, updated };
}

async function runScraper(stores = ['all'], onProgress = () => {}) {
  await loadDbConfig();

  const storeNames = stores.includes('all') || stores[0] === 'all'
    ? Object.keys(STORE_CONFIGS)
    : stores.filter(s => STORE_CONFIGS[s]);

  if (!storeNames.length) throw new Error('Aucun store valide spécifié');

  const storeLabel = storeNames.length === 1 ? storeNames[0] : 'all';
  const log = await ScraperLog.startRun(storeLabel);

  onProgress({ progress: 0, message: 'Initialisation…', currentStore: storeLabel, status: 'running' });

  const storeResults = [];
  const totalStores = storeNames.length;

  for (let i = 0; i < totalStores; i++) {
    const storeName = storeNames[i];
    const baseProgress = Math.round((i / totalStores) * 90);

    const storeProgress = (data) => {
      const localPct = data.progress || 0;
      const globalPct = baseProgress + Math.round((localPct / 100) * (90 / totalStores));
      onProgress({ ...data, progress: globalPct });
    };

    try {
      const result = await runStore(storeName, storeProgress, log);
      storeResults.push(result);
    } catch (err) {
      log.addError(`${storeName}: ${err.message}`);
      storeResults.push({ store: storeName, scraped: 0, updated: 0, error: err.message });
    }

    if (i < totalStores - 1) await randomDelay(2000, 4000);
  }

  const hasErrors = log.errors.length > 0;
  const hasSuccess = storeResults.some(r => r.scraped > 0);
  const finalStatus = hasSuccess ? (hasErrors ? 'partial' : 'success') : 'failed';

  await log.finish(finalStatus);

  onProgress({
    progress: 100,
    message: `Scraping terminé — ${log.productsScraped} scrapés, ${log.productsUpdated} mis à jour`,
    status: 'done',
    currentStore: ''
  });

  return {
    status: finalStatus,
    newProductsFound: log.newProductsFound,
    priceChanges: log.priceChanges,
    errors: log.errors,
    storeResults,
    duration: log.duration,
    productsScraped: log.productsScraped,
    productsUpdated: log.productsUpdated
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const storeArg = args.find(a => a.startsWith('--store='));
  const stores = storeArg ? [storeArg.replace('--store=', '')] : ['all'];

  const mongoose = require('mongoose');
  require('dotenv').config();

  mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/comparateurtn')
    .then(() => {
      console.log('MongoDB connecté');
      return runScraper(stores, (data) => {
        if (data.message) console.log(`[${data.progress || 0}%] ${data.message}`);
      });
    })
    .then(results => {
      console.log('\n=== Résultats ===');
      console.log('Statut:', results.status);
      console.log('Produits scrapés:', results.productsScraped);
      console.log('Produits mis à jour:', results.productsUpdated);
      console.log('Nouveaux produits détectés:', results.newProductsFound.length);
      console.log('Changements de prix:', results.priceChanges.length);
      if (results.errors.length) console.log('Erreurs:', results.errors.length);
      process.exit(0);
    })
    .catch(err => {
      console.error('Erreur:', err.message);
      process.exit(1);
    });
}

module.exports = { runScraper, STORE_CONFIGS, CATEGORY_MAP };