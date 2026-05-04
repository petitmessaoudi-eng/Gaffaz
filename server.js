require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const path = require('path');
const helmet = require('helmet');
const { loadUser } = require('./middleware/userAuth');


const rateLimitStore = new Map();

setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [k, v] of rateLimitStore) {
    if (v.windowStart < cutoff) rateLimitStore.delete(k);
  }
}, 5 * 60 * 1000);

function rateLimit({ windowMs = 60000, max = 120, message = 'Too Many Requests' } = {}) {
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${ip}:${req.path.split('/')[1] || 'root'}`;
    const now = Date.now();
    const windowStart = now - windowMs;

    let record = rateLimitStore.get(key);
    if (!record || record.windowStart < windowStart) {
      record = { count: 1, windowStart: now };
    } else {
      record.count++;
    }
    rateLimitStore.set(key, record);

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - record.count));

    if (record.count > max) {
      return res.status(429).json({ error: message });
    }
    next();
  };
}


const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/comparateurtn';

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
  maxPoolSize: 10
}).then(() => {
  console.log('MongoDB connected:', MONGODB_URI);
}).catch(err => {
  console.error('MongoDB connection error:', err.message);
  process.exit(1);
});

mongoose.connection.on('error', err => {
  console.error('MongoDB runtime error:', err.message);
});

mongoose.connection.on('disconnected', () => {
  console.warn('MongoDB disconnected, attempting reconnect...');
});

process.on('uncaughtException', err => {
  console.error('Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'comparateur-tn-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  store: MongoStore.create({
    mongoUrl: MONGODB_URI,
    ttl: 7 * 24 * 60 * 60,
    touchAfter: 24 * 3600
  }),
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: 'strict'
  }
}));

app.use(loadUser);


app.use('/api/products',    rateLimit({ windowMs: 60000, max: 120, message: 'Trop de requêtes, réessayez dans une minute.' }));
app.use('/api/budget-build', rateLimit({ windowMs: 60000, max: 30,  message: 'Trop de requêtes budget-build.' }));
app.use('/api/search-suggest', rateLimit({ windowMs: 60000, max: 60,  message: 'Trop de requêtes de suggestion.' }));
app.use('/api/',            rateLimit({ windowMs: 60000, max: 200, message: 'Trop de requêtes API.' }));
app.use('/admin',           rateLimit({ windowMs: 60000, max: 60,  message: 'Trop de requêtes admin.' }));


app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
  etag: true
}));

const fs = require('fs');
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));


app.get('/', (req, res) => res.redirect('/products'));

app.get('/pc-builder', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'pc-builder.html'))
);

app.get('/product/:slug', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'product.html'))
);

const mainRoutes  = require('./routes/main');
const adminRoutes = require('./routes/admin');
const authRoutes  = require('./routes/auth');

app.use('/', authRoutes);
app.use('/', mainRoutes);
app.use('/admin', adminRoutes);


app.use((req, res) => res.status(404).json({ error: 'Route not found', path: req.path }));

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message
  });
});


const server = app.listen(PORT, () =>
  console.log(`ComparateurTN running → http://localhost:${PORT}`)
);

process.on('SIGTERM', () => server.close(() => mongoose.connection.close(false, () => process.exit(0))));
process.on('SIGINT',  () => server.close(() => mongoose.connection.close(false, () => process.exit(0))));

module.exports = app;