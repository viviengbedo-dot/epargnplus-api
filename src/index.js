require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();

// Trust Render's reverse proxy (required for rate-limit + IP headers)
app.set('trust proxy', 1);

// Security headers
app.use(helmet());

// CORS — allow iOS app + dashboard
app.use(cors({
  origin: [
    'https://epargnplus.com',
    'https://www.epargnplus.com',
    'https://epargnplus-web.vercel.app',
    /\.vercel\.app$/,
    /localhost/,
  ],
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Body parsing
app.use(express.json({ limit: '2mb' }));

// Global rate limit: 100 req / 15 min per IP
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Trop de requêtes. Réessayez plus tard.' },
}));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// Routes — all under /v1
const v1 = express.Router();
v1.use('/auth',          require('./routes/auth'));
v1.use('/user',          require('./routes/user'));
v1.use('/wallet',        require('./routes/wallet'));
v1.use('/transactions',  require('./routes/transactions'));
v1.use('/projects',      require('./routes/projects'));
v1.use('/notifications', require('./routes/notifications'));
v1.use('/referral',      require('./routes/referral'));
v1.use('/support',       require('./routes/support'));
v1.use('/promos',        require('./routes/promos'));
v1.use('/admin',         require('./routes/admin'));

app.use('/v1', v1);

// 404
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route introuvable.' });
});

// Error handler
app.use((err, req, res, _next) => {
  console.error('[Error]', err.message);
  res.status(err.status || 500).json({
    success: false,
    message: process.env.NODE_ENV === 'production' ? 'Erreur serveur.' : err.message,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Epargn+ API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
});
