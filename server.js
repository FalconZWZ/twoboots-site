const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const multer = require('multer');
const nodemailer = require('nodemailer');
const { rateLimit } = require('express-rate-limit');
const archiver = require('archiver');
// Optional: if the native image library fails to load, uploads are simply kept as they are.
let sharp = null;
try { sharp = require('sharp'); } catch (err) {
  console.warn('⚠ sharp не загрузился — загружаемые фото не будут сжиматься:', err.message);
}

const app = express();
const port = process.env.PORT || 3000;
// Railway puts one proxy hop in front of the app; without this every visitor
// would share the proxy's IP and the rate limits below would block everyone at once.
app.set('trust proxy', 1);

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data-runtime');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const SEED_FILE = path.join(__dirname, 'data', 'seed.json');

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'two-boots-dev-secret-change-me';

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const MAIL_FROM = process.env.MAIL_FROM || 'Two Boots <no-reply@two-boots.ru>';

const mailTransport = SMTP_HOST
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    })
  : null;

const DELIVERY_METHODS = { cdek: 'СДЭК', post: 'Почта России', courier: 'Курьер по Москве', pickup: 'Самовывоз' };

// "Доставка: СДЭК — Казань, ул. …" plus the customer's comment, one line each ('' if absent).
function orderDeliveryLines(order) {
  let text = '';
  if (order.delivery) {
    const where = [order.city, order.address].filter(Boolean).join(', ');
    text += `Доставка: ${DELIVERY_METHODS[order.delivery] || order.delivery}${where ? ' — ' + where : ''}\n`;
  }
  if (order.customerComment) text += `Комментарий: ${order.customerComment}\n`;
  return text;
}

function orderPromoLine(order) {
  return order.promo ? `Промокод ${order.promo.code}: −${order.promo.discount.toLocaleString('ru-RU')} ₽\n` : '';
}

function sendOrderConfirmationEmail(order, user) {
  if (!mailTransport) return;
  const itemsList = order.items.map(it => `${it.name}${it.size ? ' (' + it.size + ')' : ''} — ${it.qty} шт. × ${it.price.toLocaleString('ru-RU')} ₽`).join('\n');
  const itemsHtml = order.items.map(it => `<tr><td style="padding:4px 8px;">${it.name}${it.size ? ' (' + it.size + ')' : ''}</td><td style="padding:4px 8px;">${it.qty}</td><td style="padding:4px 8px;">${it.price.toLocaleString('ru-RU')} ₽</td></tr>`).join('');
  mailTransport.sendMail({
    from: MAIL_FROM,
    to: user.email,
    subject: `Заказ №${order.number} принят — Two Boots`,
    text: `Спасибо за заказ №${order.number}!\n\nВ ближайшее время с вами свяжется менеджер.\n\n${orderDeliveryLines(order)}\nСостав заказа:\n${itemsList}\n\n${orderPromoLine(order)}Итого: ${order.total.toLocaleString('ru-RU')} ₽`,
    html: `<p>Спасибо за заказ <b>№${order.number}</b>!</p><p>В ближайшее время с вами свяжется менеджер.</p>
      <table style="border-collapse:collapse;">${itemsHtml}</table>
      ${order.promo ? `<p>Промокод ${order.promo.code}: −${order.promo.discount.toLocaleString('ru-RU')} ₽</p>` : ''}
      ${order.delivery ? `<p>Доставка: ${DELIVERY_METHODS[order.delivery]}${[order.city, order.address].filter(Boolean).length ? ' — ' + escHtml([order.city, order.address].filter(Boolean).join(', ')) : ''}</p>` : ''}
      <p><b>Итого: ${order.total.toLocaleString('ru-RU')} ₽</b></p>`,
  }).catch(err => console.error('Не удалось отправить письмо с подтверждением заказа:', err.message));
}

const OWNER_EMAIL = process.env.OWNER_EMAIL || 'dmitry-sokol@mail.ru';
const OWNER_PHONE = process.env.OWNER_PHONE || '79263497586';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const WHATSAPP_CALLMEBOT_APIKEY = process.env.WHATSAPP_CALLMEBOT_APIKEY || '';
// Бот заявок twoboots-botorder: рассылает заказ получателям с кнопкой «Взял в работу»
const BOTORDER_URL = process.env.BOTORDER_URL || '';
const BOTORDER_SECRET = process.env.BOTORDER_SECRET || '';

function orderNotifyText(order) {
  const itemsList = order.items.map(it => `${it.name}${it.size ? ' (' + it.size + ')' : ''} — ${it.qty} шт. × ${it.price.toLocaleString('ru-RU')} ₽`).join('\n');
  return `Новый заказ №${order.number}${order.quick ? ' (в 1 клик)' : ''}\nИмя: ${order.name}\nТелефон: ${order.phone}\n${orderDeliveryLines(order)}\n${itemsList}\n\n${orderPromoLine(order)}Итого: ${order.total.toLocaleString('ru-RU')} ₽`;
}

// Notifies the store owner (not the customer) that a new order/lead came in —
// over every channel that has credentials configured; channels without
// credentials are silently skipped (the startup warning already covers that).
function notifyOwnerNewOrder(order) {
  const text = orderNotifyText(order);

  if (mailTransport) {
    mailTransport.sendMail({
      from: MAIL_FROM,
      to: OWNER_EMAIL,
      subject: `Новый заказ №${order.number} — Two Boots`,
      text,
    }).catch(err => console.error('Не удалось отправить письмо-уведомление владельцу:', err.message));
  }

  if (BOTORDER_URL && BOTORDER_SECRET) {
    fetch(BOTORDER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Token': BOTORDER_SECRET },
      body: JSON.stringify({
        'Заказ': `№${order.number}${order.quick ? ' (в 1 клик)' : ''}`,
        name: order.name,
        phone: order.phone,
        'Состав': order.items.map(it => `${it.name}${it.size ? ' (' + it.size + ')' : ''} — ${it.qty} шт. × ${it.price.toLocaleString('ru-RU')} ₽`).join('\n'),
        'Итого': `${order.total.toLocaleString('ru-RU')} ₽`,
        ...(order.promo ? { 'Промокод': `${order.promo.code} (−${order.promo.discount.toLocaleString('ru-RU')} ₽)` } : {}),
        ...(order.delivery ? { 'Доставка': `${DELIVERY_METHODS[order.delivery]}${[order.city, order.address].filter(Boolean).length ? ' — ' + [order.city, order.address].filter(Boolean).join(', ') : ''}` } : {}),
        ...(order.customerComment ? { 'Комментарий': order.customerComment } : {}),
      }),
    }).then(r => { if (!r.ok) return r.text().then(t => { throw new Error(t); }); })
      .catch(err => console.error('Не удалось отправить заказ в бот заявок:', err.message));
  } else {
    sendOwnerTelegram(text);
  }

  if (WHATSAPP_CALLMEBOT_APIKEY) {
    const url = `https://api.callmebot.com/whatsapp.php?phone=${OWNER_PHONE}&text=${encodeURIComponent(text)}&apikey=${WHATSAPP_CALLMEBOT_APIKEY}`;
    fetch(url).catch(err => console.error('Не удалось отправить уведомление в WhatsApp:', err.message));
  }
}

function sendOwnerTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
  }).then(r => { if (!r.ok) return r.text().then(t => { throw new Error(t); }); })
    .catch(err => console.error('Не удалось отправить уведомление в Telegram:', err.message));
}

// Contact-form messages go to email (reply-to = visitor, so the owner can answer
// straight from the mail client) and to the plain Telegram bot. Not to the
// order-desk bot: its payload is order-shaped, with a "take into work" button.
function notifyOwnerContact({ name, email, message }) {
  const text = `Сообщение с сайта\nИмя: ${name}\nEmail: ${email}\n\n${message}`;
  if (mailTransport) {
    mailTransport.sendMail({
      from: MAIL_FROM,
      to: OWNER_EMAIL,
      replyTo: email,
      subject: `Сообщение с сайта от ${name} — Two Boots`,
      text,
    }).catch(err => console.error('Не удалось отправить сообщение с формы обратной связи:', err.message));
  }
  sendOwnerTelegram(text);
}

function notifyOwnerCancelled(order) {
  const text = `Клиент отменил заказ №${order.number}\nИмя: ${order.name}\nТелефон: ${order.phone}\nИтого: ${order.total.toLocaleString('ru-RU')} ₽`;
  if (mailTransport) {
    mailTransport.sendMail({
      from: MAIL_FROM,
      to: OWNER_EMAIL,
      subject: `Заказ №${order.number} отменён клиентом — Two Boots`,
      text,
    }).catch(err => console.error('Не удалось отправить уведомление об отмене заказа:', err.message));
  }
  sendOwnerTelegram(text);
}

const STATUS_EMAIL_TEXT = {
  processing: 'принят в работу. Менеджер свяжется с вами, чтобы уточнить детали доставки.',
  shipped: 'отправлен.',
  completed: 'выполнен. Спасибо, что выбрали Two Boots!',
  cancelled: 'отменён. Если это ошибка или остались вопросы — просто ответьте на это письмо или позвоните: +7 926 349-75-86.',
};

function sendOrderStatusEmail(order, email) {
  if (!mailTransport || !email || !STATUS_EMAIL_TEXT[order.status]) return;
  mailTransport.sendMail({
    from: MAIL_FROM,
    to: email,
    replyTo: OWNER_EMAIL,
    subject: `Заказ №${order.number}: статус изменён — Two Boots`,
    text: `Здравствуйте${order.name ? ', ' + order.name : ''}!\n\nВаш заказ №${order.number} ${STATUS_EMAIL_TEXT[order.status]}\n\nИстория заказов — в личном кабинете: https://www.two-boots.ru/account`,
  }).catch(err => console.error('Не удалось отправить письмо о смене статуса заказа:', err.message));
}

function sendPasswordResetEmail(user, link) {
  return mailTransport.sendMail({
    from: MAIL_FROM,
    to: user.email,
    subject: 'Восстановление пароля — Two Boots',
    text: `Здравствуйте!\n\nЧтобы задать новый пароль для личного кабинета Two Boots, перейдите по ссылке (действует 1 час):\n${link}\n\nЕсли вы не запрашивали восстановление пароля, просто проигнорируйте это письмо.`,
    html: `<p>Здравствуйте!</p><p>Чтобы задать новый пароль для личного кабинета Two Boots, перейдите по ссылке (действует 1 час):</p>
      <p><a href="${link}">Задать новый пароль</a></p>
      <p style="color:#777;">Если вы не запрашивали восстановление пароля, просто проигнорируйте это письмо.</p>`,
  });
}

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(BACKUPS_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) {
  fs.copyFileSync(SEED_FILE, DATA_FILE);
}

function readStore() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
function writeStore(store) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(check, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Usernames that are always treated as the top-level "super admin" role,
// regardless of case. Only super admins can add/remove other admins.
const SUPER_ADMIN_USERNAMES = ['falconzzz', 'admin'];
function roleFor(username) {
  return SUPER_ADMIN_USERNAMES.includes(String(username).toLowerCase()) ? 'super' : 'admin';
}

// Migrate/seed the admin list from env vars if the store has none yet
// (fresh install, or an older store.json created before multi-admin support),
// and backfill a role on any admin that predates the super-admin split.
{
  const store = readStore();
  let changed = false;
  if (!store.admins || store.admins.length === 0) {
    store.admins = [{ username: ADMIN_USER, passwordHash: hashPassword(ADMIN_PASSWORD), role: 'super' }];
    changed = true;
  } else {
    store.admins.forEach(a => {
      if (!a.role) { a.role = roleFor(a.username); changed = true; }
    });
    if (!store.admins.some(a => a.role === 'super')) {
      store.admins[0].role = 'super';
      changed = true;
    }
  }
  if (!store.users) { store.users = []; changed = true; }
  if (!store.orders) { store.orders = []; changed = true; }
  if (!store.promos) { store.promos = []; changed = true; }
  if (!store.reviews) { store.reviews = []; changed = true; }
  if (!store.orderSeq) {
    store.orderSeq = store.orders.reduce((max, o) => Math.max(max, o.number || 0), 0);
    changed = true;
  }
  if (changed) writeStore(store);
}
function slugify(text) {
  const translit = {
    а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',
    н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sch',
    ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya'
  };
  return String(text)
    .toLowerCase()
    .split('')
    .map(ch => translit[ch] !== undefined ? translit[ch] : ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const unique = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      cb(null, unique + path.extname(file.originalname).toLowerCase());
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 }, // phone photos are big; they're shrunk right after upload
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Только изображения'));
  },
});

app.use(express.json());
app.use(session({
  store: new FileStore({ path: SESSIONS_DIR, ttl: 7 * 24 * 60 * 60, retries: 0 }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

function limiter(limit, windowMinutes, error, extra = {}) {
  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => {
      console.warn(`Rate limit: ${req.ip} ${req.method} ${req.originalUrl}`);
      res.status(429).json({ error });
    },
    ...extra,
  });
}
// Only failed attempts count, so a user who logs in successfully never burns the budget.
const loginLimiter = limiter(10, 15, 'Слишком много неудачных попыток входа. Попробуйте через 15 минут.', { skipSuccessfulRequests: true });
const registerLimiter = limiter(5, 60, 'Слишком много регистраций с вашего адреса. Попробуйте позже.');
const orderLimiter = limiter(10, 15, 'Слишком много заявок подряд. Попробуйте через несколько минут или позвоните нам.');
const contactLimiter = limiter(5, 15, 'Слишком много сообщений подряд. Попробуйте через несколько минут.');
// Generous for real shoppers, but stops anyone from guessing codes by brute force.
const promoLimiter = limiter(20, 15, 'Слишком много попыток ввода промокода. Попробуйте позже.');
// Only accepted reviews count, so fixing a form mistake never locks a real customer out.
const reviewLimiter = limiter(10, 60, 'Слишком много отзывов подряд. Попробуйте позже.', { skipFailedRequests: true });
const resetLimiter = limiter(5, 60, 'Слишком много запросов на восстановление пароля. Попробуйте позже.');

// Uploaded files get a unique name each time, so browsers may keep them for a month.
app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '30d', immutable: true }));
// Only the public assets are served — never the repo root itself, which holds server.js,
// package.json, data/ and (when DATA_DIR is unset) data-runtime/store.json.
// Everything else, "/" and /index.html included, reaches the SPA fallback below.
app.use('/images', express.static(path.join(__dirname, 'images'), { maxAge: '1d' }));
const PUBLIC_ROOT_FILES = ['favicon.svg', 'robots.txt', 'yandex_1c7e02c88165d0f5.html'];
PUBLIC_ROOT_FILES.forEach(file => {
  app.get('/' + file, (req, res) => res.sendFile(path.join(__dirname, file)));
});

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.status(401).json({ error: 'unauthorized' });
}
function requireSuperAdmin(req, res, next) {
  if (req.session && req.session.isAdmin && req.session.role === 'super') return next();
  res.status(403).json({ error: 'Только главный администратор может это делать' });
}
function requireUser(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: 'Войдите в личный кабинет' });
}
function safeUser(u) {
  return { id: u.id, email: u.email, name: u.name, phone: u.phone, city: u.city, address: u.address, consentAt: u.consentAt || null };
}

/* ===== Public data API ===== */
app.get('/api/data', (req, res) => {
  const { categories, products, reviews } = readStore();
  const ratings = productRatings(reviews);
  res.json({
    categories,
    products: products.filter(p => !p.hidden).map(p => (ratings[p.id] ? { ...p, rating: ratings[p.id] } : p)),
  });
});

/* ===== Reviews ===== */
// Only approved reviews are public; averages are rounded to one decimal.
function productRatings(reviews) {
  const acc = {};
  for (const r of reviews || []) {
    if (r.status !== 'approved') continue;
    const a = acc[r.productId] || (acc[r.productId] = { sum: 0, count: 0 });
    a.sum += r.rating; a.count++;
  }
  const out = {};
  for (const [id, a] of Object.entries(acc)) out[id] = { avg: Math.round(a.sum / a.count * 10) / 10, count: a.count };
  return out;
}
const publicReview = r => ({ id: r.id, name: r.name, rating: r.rating, text: r.text, createdAt: r.createdAt, verified: !!r.verified });

app.get('/api/reviews', (req, res) => {
  const { reviews } = readStore();
  const list = reviews
    .filter(r => r.productId === req.query.productId && r.status === 'approved')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(publicReview);
  res.json({ reviews: list });
});

app.post('/api/reviews', reviewLimiter, (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 60);
  const text = String(body.text || '').trim().slice(0, 2000);
  const rating = Math.round(Number(body.rating));
  if (!name) return res.status(400).json({ error: 'Укажите имя' });
  if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ error: 'Поставьте оценку от 1 до 5 звёзд' });
  if (text.length < 10) return res.status(400).json({ error: 'Напишите хотя бы пару слов о товаре (от 10 символов)' });
  if (body.consent !== true) return res.status(400).json({ error: CONSENT_ERROR });
  const store = readStore();
  const product = store.products.find(p => p.id === body.productId && !p.hidden);
  if (!product) return res.status(404).json({ error: 'Товар не найден' });
  const userId = (req.session && req.session.userId) || null;
  // "Покупатель" badge: the signed-in author has a non-cancelled order with this product.
  const verified = !!userId && store.orders.some(o => o.userId === userId && o.status !== 'cancelled' && o.items.some(i => i.id === product.id));
  const review = {
    id: crypto.randomUUID(), productId: product.id, name, rating, text,
    userId, verified, status: 'pending', createdAt: new Date().toISOString(),
  };
  store.reviews.push(review);
  writeStore(store);
  notifyOwnerReview(review, product);
  res.json({ ok: true });
});

function notifyOwnerReview(review, product) {
  const text = `Новый отзыв на модерации\nТовар: ${product.name}\nОценка: ${'★'.repeat(review.rating)}${'☆'.repeat(5 - review.rating)}\nИмя: ${review.name}${review.verified ? ' (покупатель)' : ''}\n\n${review.text}\n\nОпубликовать или скрыть: ${SITE_ORIGIN}/admin`;
  if (mailTransport) {
    mailTransport.sendMail({ from: MAIL_FROM, to: OWNER_EMAIL, subject: `Новый отзыв: ${product.name} — Two Boots`, text })
      .catch(err => console.error('Не удалось отправить уведомление об отзыве:', err.message));
  }
  sendOwnerTelegram(text);
}

const SITE_ORIGIN = 'https://www.two-boots.ru';

// Availability: no field = in stock, 'order' = made/brought to order, 'out' = can't be ordered.
const STOCK_VALUES = ['order', 'out'];
function normStock(v) { return STOCK_VALUES.includes(v) ? v : undefined; }

function unitPrice(product) {
  return product.discountPercent
    ? Math.round(product.price * (1 - product.discountPercent / 100))
    : product.price;
}

app.get('/sitemap.xml', (req, res) => {
  const { categories, products } = readStore();
  const staticUrls = ['/', '/catalog', '/about', '/contact', '/delivery', '/privacy'];
  const catalogUrls = Object.keys(categories).map(cat => `/catalog?cat=${cat}`);
  const productUrls = products.filter(p => !p.hidden).map(p => `/product/${p.id}`);
  const urls = [...staticUrls, ...catalogUrls, ...productUrls];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${SITE_ORIGIN}${u}</loc></url>`).join('\n')}
</urlset>`;
  res.type('application/xml').send(xml);
});

function absoluteImageUrl(img) {
  if (!img) return null;
  return /^https?:\/\//.test(img) ? img : `${SITE_ORIGIN}/${img.replace(/^\//, '')}`;
}
function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
// YML wants numeric category ids and short alphanumeric offer ids; our ids are slugs,
// so both are derived from a hash of the slug — stable across restarts and reordering.
function ymlCategoryId(slug) {
  return parseInt(crypto.createHash('sha1').update('cat:' + slug).digest('hex').slice(0, 8), 16);
}
function ymlOfferId(id) {
  return crypto.createHash('sha1').update(id).digest('hex').slice(0, 12);
}

// Product feed for Yandex (Вебмастер → «Товары», Яндекс Бизнес). Hidden and out-of-stock
// products are left out; "под заказ" goes in with available="false", as YML defines it.
app.get('/yml.xml', (req, res) => {
  const { categories, products } = readStore();
  const offers = products.filter(p => !p.hidden && p.stock !== 'out' && p.price > 0 && categories[p.cat]);
  const offerXml = p => {
    const image = absoluteImageUrl(p.img || (p.images || [])[0]);
    const params = [
      ...(p.color ? [['Цвет', p.color]] : []),
      ...(p.size ? [['Размер', p.size]] : []),
      ...(p.specs || []).filter(([k, v]) => k && v),
    ];
    return `      <offer id="${ymlOfferId(p.id)}" available="${p.stock === 'order' ? 'false' : 'true'}">
        <name>${escXml(p.name)}</name>
        <vendor>Two Boots</vendor>
        <url>${SITE_ORIGIN}/product/${encodeURIComponent(p.id)}</url>
        <price>${unitPrice(p)}</price>${p.discountPercent ? `
        <oldprice>${p.price}</oldprice>` : ''}
        <currencyId>RUR</currencyId>
        <categoryId>${ymlCategoryId(p.cat)}</categoryId>${image ? `
        <picture>${escXml(image)}</picture>` : ''}${(p.images || []).map(absoluteImageUrl).filter(u => u !== image).slice(0, 9).map(u => `
        <picture>${escXml(u)}</picture>`).join('')}
        <delivery>true</delivery>
        <pickup>true</pickup>
        <description>${escXml(p.desc || '')}</description>
        <sales_notes>Оплата переводом, по СБП или при получении</sales_notes>${params.map(([k, v]) => `
        <param name="${escXml(k)}">${escXml(v)}</param>`).join('')}
      </offer>`;
  };
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<yml_catalog date="${new Date().toISOString().replace(/\.\d+Z$/, '+00:00')}">
  <shop>
    <name>Two Boots</name>
    <company>Two Boots</company>
    <url>${SITE_ORIGIN}/</url>
    <currencies>
      <currency id="RUR" rate="1"/>
    </currencies>
    <categories>
${Object.entries(categories).map(([slug, label]) => `      <category id="${ymlCategoryId(slug)}">${escXml(label)}</category>`).join('\n')}
    </categories>
    <offers>
${offers.map(offerXml).join('\n')}
    </offers>
  </shop>
</yml_catalog>`;
  res.type('application/xml').send(xml);
});

/* ===== Auth ===== */
app.post('/admin/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const store = readStore();
  const admin = (store.admins || []).find(a => a.username === username);
  if (admin && verifyPassword(password || '', admin.passwordHash)) {
    req.session.isAdmin = true;
    req.session.username = username;
    req.session.role = admin.role;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Неверный логин или пароль' });
});
app.post('/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});
app.get('/admin/session', (req, res) => {
  res.json({
    loggedIn: !!(req.session && req.session.isAdmin),
    username: req.session && req.session.username,
    role: req.session && req.session.role,
  });
});
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

/* ===== Admin: manage admin accounts ===== */
app.get('/api/admin/admins', requireAdmin, (req, res) => {
  const store = readStore();
  res.json({
    admins: store.admins.map(a => ({ username: a.username, role: a.role })),
    me: req.session.username,
    isSuper: req.session.role === 'super',
  });
});
app.post('/api/admin/admins', requireSuperAdmin, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Логин и пароль обязательны' });
  if (password.length < 6) return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });
  const store = readStore();
  if (store.admins.some(a => a.username === username)) return res.status(400).json({ error: 'Такой логин уже существует' });
  store.admins.push({ username, passwordHash: hashPassword(password), role: roleFor(username) });
  writeStore(store);
  res.json({ admins: store.admins.map(a => ({ username: a.username, role: a.role })) });
});
app.put('/api/admin/admins/:username/password', requireAdmin, (req, res) => {
  const store = readStore();
  const { username } = req.params;
  const { password } = req.body || {};
  if (req.session.username !== username && req.session.role !== 'super') {
    return res.status(403).json({ error: 'Можно менять только свой пароль' });
  }
  if (!password || password.length < 6) return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });
  const admin = store.admins.find(a => a.username === username);
  if (!admin) return res.status(404).json({ error: 'Администратор не найден' });
  admin.passwordHash = hashPassword(password);
  writeStore(store);
  res.json({ ok: true });
});
app.delete('/api/admin/admins/:username', requireSuperAdmin, (req, res) => {
  const store = readStore();
  const { username } = req.params;
  if (store.admins.length <= 1) return res.status(400).json({ error: 'Нельзя удалить последнего администратора' });
  const idx = store.admins.findIndex(a => a.username === username);
  if (idx === -1) return res.status(404).json({ error: 'Администратор не найден' });
  if (store.admins[idx].role === 'super' && store.admins.filter(a => a.role === 'super').length <= 1) {
    return res.status(400).json({ error: 'Нельзя удалить последнего главного администратора' });
  }
  store.admins.splice(idx, 1);
  writeStore(store);
  if (req.session.username === username) {
    req.session.destroy(() => res.json({ ok: true, selfDeleted: true }));
  } else {
    res.json({ ok: true });
  }
});

/* ===== Admin: full data (includes hidden products) ===== */
app.get('/api/admin/data', requireAdmin, (req, res) => {
  const { categories, products } = readStore();
  res.json({ categories, products });
});

/* ===== Customer accounts ===== */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// 152-ФЗ: every form that collects personal data needs an explicit, unticked-by-default consent.
const CONSENT_ERROR = 'Нужно согласие на обработку персональных данных';

app.post('/api/register', registerLimiter, (req, res) => {
  const { email, password, name, phone, city, address } = req.body || {};
  if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Укажите корректный email' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'Укажите ФИО' });
  if (!phone || !phone.trim()) return res.status(400).json({ error: 'Укажите номер телефона' });
  if (req.body.consent !== true) return res.status(400).json({ error: CONSENT_ERROR });
  const store = readStore();
  const normalizedEmail = email.trim().toLowerCase();
  if (store.users.some(u => u.email.toLowerCase() === normalizedEmail)) {
    return res.status(400).json({ error: 'Пользователь с таким email уже зарегистрирован' });
  }
  const user = {
    id: crypto.randomUUID(),
    email: email.trim(),
    passwordHash: hashPassword(password),
    name, phone: phone || '', city: city || '', address: address || '',
    consentAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
  store.users.push(user);
  writeStore(store);
  req.session.userId = user.id;
  res.json({ user: safeUser(user) });
});

app.post('/api/login', loginLimiter, (req, res) => {
  const { email, password } = req.body || {};
  const store = readStore();
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const user = store.users.find(u => u.email.toLowerCase() === normalizedEmail);
  if (!user || !verifyPassword(password || '', user.passwordHash)) {
    return res.status(401).json({ error: 'Неверный email или пароль' });
  }
  req.session.userId = user.id;
  res.json({ user: safeUser(user) });
});

/* ===== Password recovery ===== */
// Only a SHA-256 of the token is stored, so a leaked store.json/backup can't be used to
// reset passwords. The token goes in the link's #fragment: fragments never reach server
// logs or the Referer header, and the page strips it from the address bar right away.
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

app.post('/api/password/forgot', resetLimiter, async (req, res) => {
  if (!mailTransport) {
    return res.status(503).json({ error: 'Восстановление пароля временно недоступно — позвоните нам: +7 926 349-75-86' });
  }
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Укажите корректный email' });
  const store = readStore();
  const user = store.users.find(u => u.email.toLowerCase() === email);
  // Same answer whether or not the account exists — the form must not reveal who is registered.
  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    user.resetTokenHash = hashToken(token);
    user.resetExpires = Date.now() + RESET_TOKEN_TTL_MS;
    writeStore(store);
    try {
      await sendPasswordResetEmail(user, `${SITE_ORIGIN}/reset-password#${token}`);
    } catch (err) {
      console.error('Не удалось отправить письмо для восстановления пароля:', err.message);
      return res.status(500).json({ error: 'Не удалось отправить письмо. Попробуйте позже.' });
    }
  }
  res.json({ ok: true });
});

app.post('/api/password/reset', resetLimiter, (req, res) => {
  const { token, password } = req.body || {};
  if (!password || String(password).length < 6) return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });
  if (!token || typeof token !== 'string') return res.status(400).json({ error: 'Ссылка недействительна' });
  const store = readStore();
  const tokenHash = hashToken(token);
  const user = store.users.find(u => u.resetTokenHash === tokenHash);
  if (!user || !user.resetExpires || user.resetExpires < Date.now()) {
    return res.status(400).json({ error: 'Ссылка устарела или уже использована — запросите восстановление ещё раз' });
  }
  user.passwordHash = hashPassword(String(password));
  delete user.resetTokenHash;
  delete user.resetExpires;
  writeStore(store);
  req.session.userId = user.id;
  res.json({ user: safeUser(user) });
});

app.post('/api/logout', (req, res) => {
  delete req.session.userId;
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.session || !req.session.userId) return res.json({ loggedIn: false });
  const store = readStore();
  const user = store.users.find(u => u.id === req.session.userId);
  if (!user) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, user: safeUser(user) });
});

app.put('/api/me', requireUser, (req, res) => {
  const { name, phone, city, address } = req.body || {};
  if (name !== undefined && !name.trim()) return res.status(400).json({ error: 'Укажите ФИО' });
  if (phone !== undefined && !phone.trim()) return res.status(400).json({ error: 'Укажите номер телефона' });
  const store = readStore();
  const user = store.users.find(u => u.id === req.session.userId);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  if (name !== undefined) user.name = name;
  if (phone !== undefined) user.phone = phone;
  if (city !== undefined) user.city = city;
  if (address !== undefined) user.address = address;
  writeStore(store);
  res.json({ user: safeUser(user) });
});

/* ===== Pricing & promo codes ===== */
// The size recorded on an order line: one of the product's size options (false if a product
// with options arrives without a valid one), else the variant's own fixed size, else null.
function orderSize(product, requested) {
  if (product.sizes && product.sizes.length) return product.sizes.includes(requested) ? requested : false;
  return product.size || null;
}

// Server-side prices for a cart: client prices are never trusted.
function priceItems(store, items) {
  const lines = [];
  let subtotal = 0;
  for (const item of Array.isArray(items) ? items : []) {
    const product = store.products.find(p => p.id === item.id && !p.hidden);
    if (!product) continue;
    if (product.stock === 'out') return { error: `«${product.name}» сейчас нет в наличии — уберите его из корзины` };
    const size = orderSize(product, item.size);
    if (size === false) return { error: `Выберите размер для «${product.name}»` };
    const qty = Math.max(1, Math.min(99, Number(item.qty) || 1));
    const price = unitPrice(product);
    lines.push({ id: product.id, name: product.name, size, price, qty });
    subtotal += price * qty;
  }
  return { lines, subtotal };
}

const PROMO_TYPES = ['percent', 'fixed'];
const normPromoCode = c => String(c || '').trim().toUpperCase();

// { promo, discount } for a usable code, { error } for a bad one, {} when no code was given.
// The discount applies on top of per-product discounts (subtotal is already discounted).
function applyPromo(store, rawCode, subtotal) {
  const code = normPromoCode(rawCode);
  if (!code) return {};
  const promo = store.promos.find(p => p.code === code);
  if (!promo || !promo.active) return { error: 'Такого промокода нет' };
  // expiresAt is a date; the code works through the end of that day, Moscow time.
  if (promo.expiresAt && Date.now() > new Date(`${promo.expiresAt}T23:59:59+03:00`).getTime()) {
    return { error: 'Срок действия промокода истёк' };
  }
  if (promo.maxUses && (promo.uses || 0) >= promo.maxUses) return { error: 'Промокод больше не действует' };
  if (promo.minTotal && subtotal < promo.minTotal) {
    return { error: `Промокод действует для заказов от ${promo.minTotal.toLocaleString('ru-RU')} ₽` };
  }
  const discount = promo.type === 'percent'
    ? Math.round(subtotal * promo.value / 100)
    : Math.min(promo.value, subtotal);
  return { promo, discount };
}

function promoSummary(promo) {
  return { code: promo.code, type: promo.type, value: promo.value, minTotal: promo.minTotal || 0 };
}

app.post('/api/promo/check', promoLimiter, (req, res) => {
  const { code, items } = req.body || {};
  const store = readStore();
  const { subtotal, error: itemsError } = priceItems(store, items);
  if (itemsError) return res.status(400).json({ error: itemsError });
  const { promo, discount, error } = applyPromo(store, code, subtotal);
  if (error) return res.status(400).json({ error });
  if (!promo) return res.status(400).json({ error: 'Введите промокод' });
  res.json({ ...promoSummary(promo), discount, subtotal });
});

/* ===== Orders ===== */
// What a customer may see of their own order: everything except the manager's internal note.
function customerOrder(order) {
  const { comment, ...rest } = order;
  return rest;
}

app.get('/api/orders', requireUser, (req, res) => {
  const store = readStore();
  const orders = store.orders
    .filter(o => o.userId === req.session.userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(customerOrder);
  res.json({ orders });
});

app.post('/api/orders', orderLimiter, requireUser, (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Корзина пуста' });
  const store = readStore();
  const user = store.users.find(u => u.id === req.session.userId);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  if (!user.name || !user.name.trim() || !user.phone || !user.phone.trim() || !user.email) {
    return res.status(400).json({ error: 'Заполните имя, телефон и email в профиле, чтобы оформить заказ' });
  }
  // Accounts registered before the consent checkbox existed give it with their next order.
  if (!user.consentAt) {
    if (req.body.consent !== true) return res.status(400).json({ error: CONSENT_ERROR });
    user.consentAt = new Date().toISOString();
  }

  const { lines, subtotal, error: itemsError } = priceItems(store, items);
  if (itemsError) return res.status(400).json({ error: itemsError });
  if (lines.length === 0) return res.status(400).json({ error: 'Товары не найдены' });

  const delivery = String(req.body.delivery || '');
  if (!DELIVERY_METHODS[delivery]) return res.status(400).json({ error: 'Выберите способ доставки' });
  const city = String(req.body.city || '').trim().slice(0, 100) || (delivery === 'courier' ? 'Москва' : '');
  const address = String(req.body.address || '').trim().slice(0, 300);
  if (delivery !== 'pickup' && !address) return res.status(400).json({ error: 'Укажите адрес доставки или пункт выдачи' });
  if ((delivery === 'cdek' || delivery === 'post') && !city) return res.status(400).json({ error: 'Укажите город' });
  const customerComment = String(req.body.comment || '').trim().slice(0, 1000);
  // First address a customer types becomes their profile default for next time.
  if (delivery !== 'pickup') {
    if (!user.city) user.city = city;
    if (!user.address) user.address = address;
  }
  const { promo, discount = 0, error: promoError } = applyPromo(store, req.body.promoCode, subtotal);
  if (promoError) return res.status(400).json({ error: promoError });
  if (promo) promo.uses = (promo.uses || 0) + 1;

  store.orderSeq = (store.orderSeq || 0) + 1;
  const order = {
    id: crypto.randomUUID(),
    number: store.orderSeq,
    userId: user.id,
    items: lines,
    subtotal,
    ...(promo ? { promo: { code: promo.code, discount } } : {}),
    total: subtotal - discount,
    status: 'new',
    name: user.name, phone: user.phone, email: user.email,
    delivery,
    city: delivery === 'pickup' ? '' : city,
    address: delivery === 'pickup' ? '' : address,
    ...(customerComment ? { customerComment } : {}),
    createdAt: new Date().toISOString(),
  };
  store.orders.push(order);
  writeStore(store);
  sendOrderConfirmationEmail(order, user);
  notifyOwnerNewOrder(order);
  res.json({ order });
});

const CUSTOMER_CANCELLABLE_STATUSES = ['new', 'processing'];

app.patch('/api/orders/:id/cancel', requireUser, (req, res) => {
  const store = readStore();
  const order = store.orders.find(o => o.id === req.params.id && o.userId === req.session.userId);
  if (!order) return res.status(404).json({ error: 'Заказ не найден' });
  if (!CUSTOMER_CANCELLABLE_STATUSES.includes(order.status)) {
    return res.status(400).json({ error: 'Этот заказ уже нельзя отменить' });
  }
  order.status = 'cancelled';
  writeStore(store);
  notifyOwnerCancelled(order);
  res.json({ order: customerOrder(order) });
});

/* ===== Quick order (buy in one click, no account needed) ===== */
app.post('/api/quick-order', orderLimiter, (req, res) => {
  const { productId, qty, name, phone, size: requestedSize } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Укажите имя' });
  if (!phone || !phone.trim()) return res.status(400).json({ error: 'Укажите номер телефона' });
  if (req.body.consent !== true) return res.status(400).json({ error: CONSENT_ERROR });
  const store = readStore();
  const product = store.products.find(p => p.id === productId && !p.hidden);
  if (!product) return res.status(404).json({ error: 'Товар не найден' });
  if (product.stock === 'out') return res.status(400).json({ error: 'Этого товара сейчас нет в наличии' });
  const size = orderSize(product, requestedSize);
  if (size === false) return res.status(400).json({ error: 'Выберите размер' });

  const qtyNum = Math.max(1, Math.min(99, Number(qty) || 1));
  const price = unitPrice(product);
  const subtotal = price * qtyNum;
  const { promo, discount = 0, error: promoError } = applyPromo(store, req.body.promoCode, subtotal);
  if (promoError) return res.status(400).json({ error: promoError });
  if (promo) promo.uses = (promo.uses || 0) + 1;

  store.orderSeq = (store.orderSeq || 0) + 1;
  const order = {
    id: crypto.randomUUID(),
    number: store.orderSeq,
    userId: null,
    quick: true,
    items: [{ id: product.id, name: product.name, size, price, qty: qtyNum }],
    subtotal,
    ...(promo ? { promo: { code: promo.code, discount } } : {}),
    total: subtotal - discount,
    status: 'new',
    name: name.trim(), phone: phone.trim(), email: null, city: '', address: '',
    consentAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
  store.orders.push(order);
  writeStore(store);
  notifyOwnerNewOrder(order);
  res.json({ order });
});

/* ===== Contact form ===== */
app.post('/api/contact', contactLimiter, (req, res) => {
  const name = String((req.body || {}).name || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 100);
  const email = String((req.body || {}).email || '').trim().slice(0, 200);
  const message = String((req.body || {}).message || '').trim().slice(0, 5000);
  if (!name) return res.status(400).json({ error: 'Укажите имя' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Укажите корректный email' });
  if (!message) return res.status(400).json({ error: 'Напишите сообщение' });
  if ((req.body || {}).consent !== true) return res.status(400).json({ error: CONSENT_ERROR });
  notifyOwnerContact({ name, email, message });
  res.json({ ok: true });
});

/* ===== Admin: orders ===== */
const ORDER_STATUSES = ['new', 'processing', 'shipped', 'completed', 'cancelled'];

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const store = readStore();
  const orders = [...store.orders]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(o => {
      const user = store.users.find(u => u.id === o.userId);
      return { ...o, email: user ? user.email : null };
    });
  res.json({ orders });
});

app.patch('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const { status, comment } = req.body || {};
  if (status !== undefined && !ORDER_STATUSES.includes(status)) return res.status(400).json({ error: 'Некорректный статус' });
  const store = readStore();
  const order = store.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Заказ не найден' });
  const changed = status !== undefined && order.status !== status;
  if (status !== undefined) order.status = status;
  // Internal manager note — never sent to the customer (see customerOrder()).
  if (comment !== undefined) {
    const text = String(comment).trim().slice(0, 1000);
    if (text) order.comment = text;
    else delete order.comment;
  }
  writeStore(store);
  if (changed) {
    const user = order.userId && store.users.find(u => u.id === order.userId);
    sendOrderStatusEmail(order, (user && user.email) || order.email);
  }
  res.json({ order });
});

app.delete('/api/admin/orders/:id', requireSuperAdmin, (req, res) => {
  const store = readStore();
  const idx = store.orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Заказ не найден' });
  store.orders.splice(idx, 1);
  writeStore(store);
  res.json({ ok: true });
});

// Deletes every order and resets the order-number counter to 0 — for
// clearing out test orders before going live, so the next real order starts at №1.
app.delete('/api/admin/orders', requireSuperAdmin, (req, res) => {
  const store = readStore();
  store.orders = [];
  store.orderSeq = 0;
  writeStore(store);
  res.json({ ok: true });
});

/* ===== Admin: backup ===== */
// Super-admin only: the store holds password hashes of admins and customers.
/* ===== Admin: reviews ===== */
app.get('/api/admin/reviews', requireAdmin, (req, res) => {
  const { reviews, products } = readStore();
  const names = Object.fromEntries(products.map(p => [p.id, p.name]));
  res.json({
    reviews: [...reviews]
      // awaiting moderation first, then newest first
      .sort((a, b) => (b.status === 'pending') - (a.status === 'pending') || new Date(b.createdAt) - new Date(a.createdAt))
      .map(r => ({ ...r, productName: names[r.productId] || r.productId })),
  });
});

app.patch('/api/admin/reviews/:id', requireAdmin, (req, res) => {
  const { status } = req.body || {};
  if (!['approved', 'hidden', 'pending'].includes(status)) return res.status(400).json({ error: 'Некорректный статус' });
  const store = readStore();
  const review = store.reviews.find(r => r.id === req.params.id);
  if (!review) return res.status(404).json({ error: 'Отзыв не найден' });
  review.status = status;
  writeStore(store);
  res.json({ ok: true });
});

app.delete('/api/admin/reviews/:id', requireAdmin, (req, res) => {
  const store = readStore();
  const idx = store.reviews.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Отзыв не найден' });
  store.reviews.splice(idx, 1);
  writeStore(store);
  res.json({ ok: true });
});

/* ===== Admin: promo codes ===== */
app.get('/api/admin/promos', requireAdmin, (req, res) => {
  res.json({ promos: readStore().promos });
});

app.post('/api/admin/promos', requireAdmin, (req, res) => {
  const body = req.body || {};
  const code = normPromoCode(body.code);
  if (!/^[A-Z0-9_-]{3,30}$/.test(code)) {
    return res.status(400).json({ error: 'Код — от 3 до 30 символов: латинские буквы, цифры, «-» или «_»' });
  }
  if (!PROMO_TYPES.includes(body.type)) return res.status(400).json({ error: 'Выберите тип скидки' });
  const value = Math.round(Number(body.value));
  if (!(value > 0) || (body.type === 'percent' && value > 90)) {
    return res.status(400).json({ error: body.type === 'percent' ? 'Скидка — от 1 до 90%' : 'Укажите сумму скидки в рублях' });
  }
  const expiresAt = body.expiresAt ? String(body.expiresAt) : null;
  if (expiresAt && !/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) return res.status(400).json({ error: 'Некорректная дата окончания' });
  const store = readStore();
  if (store.promos.some(p => p.code === code)) return res.status(400).json({ error: 'Такой промокод уже есть' });
  store.promos.push({
    code, type: body.type, value,
    minTotal: Math.max(0, Math.round(Number(body.minTotal) || 0)),
    expiresAt,
    maxUses: Math.max(0, Math.round(Number(body.maxUses) || 0)),
    uses: 0,
    active: true,
    createdAt: new Date().toISOString(),
  });
  writeStore(store);
  res.json({ promos: store.promos });
});

app.patch('/api/admin/promos/:code', requireAdmin, (req, res) => {
  const store = readStore();
  const promo = store.promos.find(p => p.code === req.params.code);
  if (!promo) return res.status(404).json({ error: 'Промокод не найден' });
  if (typeof (req.body || {}).active === 'boolean') promo.active = req.body.active;
  writeStore(store);
  res.json({ promos: store.promos });
});

app.delete('/api/admin/promos/:code', requireAdmin, (req, res) => {
  const store = readStore();
  const idx = store.promos.findIndex(p => p.code === req.params.code);
  if (idx === -1) return res.status(404).json({ error: 'Промокод не найден' });
  store.promos.splice(idx, 1);
  writeStore(store);
  res.json({ promos: store.promos });
});

app.get('/api/admin/backup', requireSuperAdmin, (req, res) => {
  const date = new Date().toISOString().slice(0, 10);
  res.attachment(`two-boots-backup-${date}.zip`);
  const archive = archiver('zip');
  archive.on('error', err => { console.error('Не удалось собрать резервную копию:', err.message); res.destroy(err); });
  archive.pipe(res);
  // Read synchronously so a concurrent writeStore can't leave a half-written store.json in the zip.
  archive.append(fs.readFileSync(DATA_FILE), { name: 'store.json' });
  archive.directory(UPLOADS_DIR, 'uploads');
  archive.finalize();
});

/* ===== Daily automatic backups ===== */
// Every night (after 03:00 Moscow time) store.json is zipped into DATA_DIR/backups — the last
// BACKUP_KEEP_DAYS are kept, so a mistake in the admin can be rolled back — and emailed to
// BACKUP_EMAIL, so a copy survives even if the Railway volume is lost. Photos are not included
// (they can be large for email); the manual «Резервная копия» button still has them.
const BACKUP_KEEP_DAYS = 14;
const BACKUP_EMAIL = process.env.BACKUP_EMAIL === 'off' ? '' : (process.env.BACKUP_EMAIL || OWNER_EMAIL);
const BACKUP_NAME_RE = /^store-\d{4}-\d{2}-\d{2}\.zip$/;
const moscowNow = () => new Date(Date.now() + 3 * 60 * 60 * 1000); // UTC+3, no DST

function zipStoreJson() {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip');
    const chunks = [];
    archive.on('data', c => chunks.push(c));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    archive.append(fs.readFileSync(DATA_FILE), { name: 'store.json' });
    archive.finalize();
  });
}

function listBackups() {
  return fs.readdirSync(BACKUPS_DIR).filter(f => BACKUP_NAME_RE.test(f)).sort().reverse();
}

let backupRunning = false;
async function runDailyBackup() {
  const now = moscowNow();
  if (backupRunning || now.getUTCHours() < 3) return;
  const day = now.toISOString().slice(0, 10);
  const name = `store-${day}.zip`;
  const file = path.join(BACKUPS_DIR, name);
  if (fs.existsSync(file)) return;
  backupRunning = true;
  try {
    const zip = await zipStoreJson();
    fs.writeFileSync(file, zip);
    listBackups().slice(BACKUP_KEEP_DAYS).forEach(old => fs.unlinkSync(path.join(BACKUPS_DIR, old)));
    console.log(`Резервная копия сохранена: ${name}`);
    if (mailTransport && BACKUP_EMAIL) {
      const s = readStore();
      await mailTransport.sendMail({
        from: MAIL_FROM,
        to: BACKUP_EMAIL,
        subject: `Резервная копия Two Boots за ${day.split('-').reverse().join('.')}`,
        text: `Автоматическая резервная копия базы сайта (без фото).\n\nТоваров: ${s.products.length}, заказов: ${s.orders.length}, клиентов: ${s.users.length}, промокодов: ${(s.promos || []).length}.\n\nВнутри store.json — каталог, заказы, клиенты (с хешами паролей), администраторы и промокоды. Храните письмо в надёжном месте. Чтобы восстановить, положите store.json в DATA_DIR на сервере и перезапустите сервис.`,
        attachments: [{ filename: `two-boots-${name}`, content: zip }],
      });
    }
  } catch (err) {
    console.error('Не удалось сделать автоматическую резервную копию:', err.message);
  } finally {
    backupRunning = false;
  }
}
setInterval(runDailyBackup, 30 * 60 * 1000);
setTimeout(runDailyBackup, 60 * 1000);

app.get('/api/admin/backups', requireSuperAdmin, (req, res) => {
  res.json({
    backups: listBackups().map(name => ({ name, size: fs.statSync(path.join(BACKUPS_DIR, name)).size })),
    email: BACKUP_EMAIL && mailTransport ? BACKUP_EMAIL : null,
  });
});

app.get('/api/admin/backups/:name', requireSuperAdmin, (req, res) => {
  if (!BACKUP_NAME_RE.test(req.params.name)) return res.status(400).json({ error: 'Некорректное имя файла' });
  const file = path.join(BACKUPS_DIR, req.params.name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Копия не найдена' });
  res.download(file, `two-boots-${req.params.name}`);
});

/* ===== Admin: categories ===== */
app.post('/api/admin/categories', requireAdmin, (req, res) => {
  const { id, label } = req.body || {};
  if (!id || !label) return res.status(400).json({ error: 'id и label обязательны' });
  const slug = slugify(id);
  const store = readStore();
  if (store.categories[slug]) return res.status(400).json({ error: 'Категория с таким id уже существует' });
  store.categories[slug] = label;
  writeStore(store);
  res.json({ categories: store.categories, products: store.products });
});
app.put('/api/admin/categories/:id', requireAdmin, (req, res) => {
  const store = readStore();
  const { id } = req.params;
  const { label } = req.body || {};
  if (!store.categories[id]) return res.status(404).json({ error: 'Категория не найдена' });
  store.categories[id] = label;
  writeStore(store);
  res.json({ categories: store.categories, products: store.products });
});
app.delete('/api/admin/categories/:id', requireAdmin, (req, res) => {
  const store = readStore();
  const { id } = req.params;
  if (!store.categories[id]) return res.status(404).json({ error: 'Категория не найдена' });
  const inUse = store.products.some(p => p.cat === id);
  if (inUse) return res.status(400).json({ error: 'В категории ещё есть товары — сначала удалите или перенесите их' });
  delete store.categories[id];
  writeStore(store);
  res.json({ categories: store.categories, products: store.products });
});

/* ===== Admin: products ===== */
// Size options the buyer picks from ("S, M, L" in the admin form). Separate from `size`, which
// marks a colour/size variant that is its own product (the suitcases).
function parseSizes(raw) {
  const list = String(raw || '').split(/[,;\n]/).map(x => x.trim().slice(0, 30)).filter(Boolean);
  return [...new Set(list)].slice(0, 20);
}

function parseProductBody(body) {
  let specs = [];
  if (body.specs) {
    try { specs = JSON.parse(body.specs); } catch (e) { specs = []; }
  }
  const discountPercent = Math.min(95, Math.max(0, Number(body.discountPercent) || 0));
  return {
    cat: body.cat,
    name: body.name,
    price: Number(body.price) || 0,
    desc: body.desc || '',
    color: body.color || undefined,
    size: body.size || undefined,
    specs,
    discountPercent: discountPercent || undefined,
    stock: normStock(body.stock),
    sizes: parseSizes(body.sizes).length ? parseSizes(body.sizes) : undefined,
    hidden: body.hidden === 'true' || body.hidden === true || undefined,
  };
}

/* ===== Photo optimisation ===== */
// Phone photos arrive at 3–8 MB and 4000px; the site never shows them larger than ~600px.
// Every upload becomes a JPEG no bigger than IMAGE_MAX_SIDE, EXIF-rotated, transparency on white.
const IMAGE_MAX_SIDE = 1200;
const IMAGE_OK_BYTES = 400 * 1024;

// Returns the filename to store: the optimised JPEG, or the original if it can't be processed
// (unsupported format, sharp missing) or if re-encoding a JPEG wouldn't make it smaller.
async function optimizeImage(filename) {
  if (!sharp) return filename;
  const src = path.join(UPLOADS_DIR, filename);
  const outName = path.basename(filename, path.extname(filename)) + '.jpg';
  const tmp = path.join(UPLOADS_DIR, outName + '.tmp');
  try {
    await sharp(src)
      .rotate()
      .resize(IMAGE_MAX_SIDE, IMAGE_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 82, mozjpeg: true })
      .toFile(tmp);
    if (outName === filename && fs.statSync(tmp).size >= fs.statSync(src).size) {
      fs.unlinkSync(tmp);
      return filename;
    }
    fs.renameSync(tmp, path.join(UPLOADS_DIR, outName));
    if (outName !== filename) fs.unlinkSync(src);
    return outName;
  } catch (err) {
    console.error(`Не удалось сжать фото ${filename}:`, err.message);
    fs.rmSync(tmp, { force: true });
    return filename;
  }
}

// One-off pass over photos uploaded before optimisation existed. Each product is re-read and
// written right after its own conversion, so concurrent admin edits aren't overwritten.
async function optimizeExistingUploads() {
  const marker = path.join(DATA_DIR, '.uploads-optimized-v1');
  if (!sharp || fs.existsSync(marker)) return;
  let saved = 0, count = 0;
  for (const p of readStore().products) {
    if (!p.img || !p.img.startsWith('/uploads/')) continue;
    const name = path.basename(p.img);
    const file = path.join(UPLOADS_DIR, name);
    if (!fs.existsSync(file)) continue;
    const before = fs.statSync(file).size;
    let big = before > IMAGE_OK_BYTES || !/\.jpe?g$/i.test(name);
    if (!big) {
      try {
        const { width, height } = await sharp(file).metadata();
        big = width > IMAGE_MAX_SIDE || height > IMAGE_MAX_SIDE;
      } catch (e) { continue; }
    }
    if (!big) continue;
    const newName = await optimizeImage(name);
    if (newName === name && fs.statSync(file).size === before) continue;
    const store = readStore();
    store.products.forEach(x => { if (x.img === p.img) x.img = '/uploads/' + newName; });
    writeStore(store);
    count++;
    saved += before - fs.statSync(path.join(UPLOADS_DIR, newName)).size;
  }
  fs.writeFileSync(marker, new Date().toISOString());
  if (count) console.log(`Сжато ранее загруженных фото: ${count}, освобождено ${Math.round(saved / 1024 / 1024 * 10) / 10} МБ`);
}
setTimeout(() => optimizeExistingUploads().catch(err => console.error('Сжатие старых фото:', err.message)), 5000);

// Main photo (`image`, stored as `img`) plus up to MAX_EXTRA_IMAGES gallery photos (`images`).
const MAX_EXTRA_IMAGES = 10;
const productUpload = upload.fields([{ name: 'image', maxCount: 1 }, { name: 'images', maxCount: MAX_EXTRA_IMAGES }]);

function removeUpload(url) {
  if (url && url.startsWith('/uploads/')) fs.unlink(path.join(UPLOADS_DIR, path.basename(url)), () => {});
}
// Optimise every uploaded file before the store is read: nothing awaits after that point,
// so a concurrent admin write can't be lost.
async function optimizeProductUploads(req) {
  const files = req.files || {};
  const main = files.image && files.image[0] ? '/uploads/' + await optimizeImage(files.image[0].filename) : null;
  const extras = [];
  for (const f of files.images || []) extras.push('/uploads/' + await optimizeImage(f.filename));
  return { main, extras, discard: () => [main, ...extras].forEach(removeUpload) };
}

app.post('/api/admin/products', requireAdmin, productUpload, async (req, res) => {
  const uploads = await optimizeProductUploads(req);
  const store = readStore();
  const data = parseProductBody(req.body);
  const invalid = !data.cat || !store.categories[data.cat] ? 'Укажите существующую категорию'
    : !data.name ? 'Название обязательно' : null;
  if (invalid) { uploads.discard(); return res.status(400).json({ error: invalid }); }

  let id = slugify(data.name);
  if (store.products.some(p => p.id === id)) id = id + '-' + Date.now().toString(36);

  const product = { id, ...data };
  if (!product.color) delete product.color;
  if (!product.size) delete product.size;
  if (uploads.main) product.img = uploads.main;
  if (uploads.extras.length) product.images = uploads.extras;

  store.products.push(product);
  writeStore(store);
  res.json(product);
});

app.put('/api/admin/products/:id', requireAdmin, productUpload, async (req, res) => {
  const uploads = await optimizeProductUploads(req);
  const store = readStore();
  const idx = store.products.findIndex(p => p.id === req.params.id);
  if (idx === -1) { uploads.discard(); return res.status(404).json({ error: 'Товар не найден' }); }
  const data = parseProductBody(req.body);
  if (!data.cat || !store.categories[data.cat]) { uploads.discard(); return res.status(400).json({ error: 'Укажите существующую категорию' }); }

  const existing = store.products[idx];
  const updated = { ...existing, ...data };
  if (!data.color) delete updated.color;
  if (!data.size) delete updated.size;

  if (uploads.main) {
    removeUpload(existing.img);
    updated.img = uploads.main;
  }

  // keepImages lists the gallery photos the admin left in place (absent = keep all).
  const before = existing.images || [];
  let kept = before;
  if (req.body.keepImages !== undefined) {
    let wanted = [];
    try { wanted = JSON.parse(req.body.keepImages); } catch (e) { wanted = before; }
    kept = before.filter(u => Array.isArray(wanted) && wanted.includes(u));
  }
  before.filter(u => !kept.includes(u)).forEach(removeUpload);
  const gallery = [...kept, ...uploads.extras];
  gallery.slice(MAX_EXTRA_IMAGES).forEach(removeUpload);
  if (gallery.length) updated.images = gallery.slice(0, MAX_EXTRA_IMAGES);
  else delete updated.images;

  store.products[idx] = updated;
  writeStore(store);
  res.json(updated);
});

app.patch('/api/admin/products/:id', requireAdmin, (req, res) => {
  const store = readStore();
  const idx = store.products.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Товар не найден' });
  const { hidden, discountPercent, stock } = req.body || {};
  if (hidden !== undefined) {
    if (hidden) store.products[idx].hidden = true;
    else delete store.products[idx].hidden;
  }
  if (stock !== undefined) {
    if (normStock(stock)) store.products[idx].stock = normStock(stock);
    else delete store.products[idx].stock;
  }
  if (discountPercent !== undefined) {
    const pct = Math.min(95, Math.max(0, Number(discountPercent) || 0));
    if (pct > 0) store.products[idx].discountPercent = pct;
    else delete store.products[idx].discountPercent;
  }
  writeStore(store);
  res.json(store.products[idx]);
});

app.post('/api/admin/products/bulk', requireAdmin, (req, res) => {
  const { ids, hidden, discountPercent, stock } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'Не выбраны товары' });
  const store = readStore();
  let count = 0;
  store.products.forEach(p => {
    if (!ids.includes(p.id)) return;
    count++;
    if (hidden !== undefined) {
      if (hidden) p.hidden = true;
      else delete p.hidden;
    }
    if (discountPercent !== undefined) {
      const pct = Math.min(95, Math.max(0, Number(discountPercent) || 0));
      if (pct > 0) p.discountPercent = pct;
      else delete p.discountPercent;
    }
    if (stock !== undefined) {
      if (normStock(stock)) p.stock = normStock(stock);
      else delete p.stock;
    }
  });
  writeStore(store);
  res.json({ ok: true, count });
});

app.delete('/api/admin/products/:id', requireAdmin, (req, res) => {
  const store = readStore();
  const idx = store.products.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Товар не найден' });
  const [removed] = store.products.splice(idx, 1);
  [removed.img, ...(removed.images || [])].forEach(removeUpload);
  writeStore(store);
  res.json({ ok: true });
});

/* ===== SPA fallback with per-page SEO tags ===== */
// Page content is rendered in the browser, but crawlers and link previews read the raw
// HTML — so the title, description, canonical, og:* tags and Schema.org data are filled
// in here. Titles mirror the setMeta() calls in index.html; keep the two in sync.
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const DEFAULT_DESCRIPTION = 'Two Boots — экипировка для фигурного катания: чехлы для лезвий, сумки и чемоданы, скакалки и аксессуары.';
const CATALOG_DESCRIPTION = 'Чехлы для лезвий, сумки и чемоданы, скакалки и аксессуары для фигурного катания.';

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// aggregateRating + the latest approved reviews, for the Product JSON-LD ({} when there are none).
function productReviewsLd(store, productId) {
  const approved = (store.reviews || []).filter(r => r.productId === productId && r.status === 'approved');
  if (!approved.length) return {};
  const { avg, count } = productRatings(approved)[productId];
  return {
    aggregateRating: { '@type': 'AggregateRating', ratingValue: avg, reviewCount: count, bestRating: 5, worstRating: 1 },
    review: approved.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5).map(r => ({
      '@type': 'Review',
      author: { '@type': 'Person', name: r.name },
      datePublished: r.createdAt.slice(0, 10),
      reviewBody: r.text,
      reviewRating: { '@type': 'Rating', ratingValue: r.rating, bestRating: 5, worstRating: 1 },
    })),
  };
}

function pageSeo(pathname, query) {
  const store = readStore();
  const { categories, products } = store;
  const url = SITE_ORIGIN + pathname;
  if (pathname === '/') {
    return { title: 'Two Boots — экипировка для фигурного катания', url, jsonLd: [{
      '@context': 'https://schema.org', '@type': 'Organization', name: 'Two Boots', url: SITE_ORIGIN + '/',
      telephone: '+7 926 349-75-86', email: 'hello@two-boots.ru',
    }] };
  }
  if (pathname === '/catalog') {
    const cat = typeof query.cat === 'string' && categories[query.cat] ? query.cat : null;
    if (!cat) return { title: 'Каталог — Two Boots', description: CATALOG_DESCRIPTION, url };
    return {
      title: `${categories[cat]} — Two Boots`,
      description: `${categories[cat]} для фигурного катания — каталог Two Boots.`,
      url: `${url}?cat=${encodeURIComponent(cat)}`,
    };
  }
  const productMatch = pathname.match(/^\/product\/([^/]+)$/);
  if (productMatch) {
    const p = products.find(x => x.id === productMatch[1] && !x.hidden);
    if (!p) return { status: 404, title: 'Товар не найден — Two Boots', url };
    const image = absoluteImageUrl(p.img || (p.images || [])[0]);
    const crumbs = [{ name: 'Каталог', item: `${SITE_ORIGIN}/catalog` }];
    if (categories[p.cat]) crumbs.push({ name: categories[p.cat], item: `${SITE_ORIGIN}/catalog?cat=${encodeURIComponent(p.cat)}` });
    crumbs.push({ name: p.name, item: url });
    return {
      title: `${p.name} — Two Boots`, description: p.desc, url, image,
      jsonLd: [
        {
          '@context': 'https://schema.org', '@type': 'Product',
          name: p.name, description: p.desc, sku: p.id,
          ...(image ? { image: [...new Set([image, ...(p.images || []).map(absoluteImageUrl)])] } : {}),
          brand: { '@type': 'Brand', name: 'Two Boots' },
          ...productReviewsLd(store, p.id),
          offers: {
            '@type': 'Offer', url, priceCurrency: 'RUB', price: unitPrice(p),
            availability: `https://schema.org/${({ order: 'BackOrder', out: 'OutOfStock' })[p.stock] || 'InStock'}`, itemCondition: 'https://schema.org/NewCondition',
          },
        },
        {
          '@context': 'https://schema.org', '@type': 'BreadcrumbList',
          itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: c.item })),
        },
      ],
    };
  }
  const staticTitles = {
    '/about': 'О бренде — Two Boots', '/contact': 'Контакты — Two Boots', '/account': 'Личный кабинет — Two Boots',
    '/privacy': 'Политика конфиденциальности — Two Boots', '/consent': 'Согласие на обработку персональных данных — Two Boots',
  };
  if (staticTitles[pathname]) return { title: staticTitles[pathname], url };
  if (pathname === '/delivery') {
    return { title: 'Доставка и оплата — Two Boots', url,
      description: 'Доставка СДЭК, Почтой России, курьером по Москве и самовывоз. Оплата переводом, по СБП или при получении. Условия возврата.' };
  }
  if (pathname === '/reset-password') return { title: 'Новый пароль — Two Boots', url, noindex: true };
  return { status: 404, title: 'Страница не найдена — Two Boots', url };
}

function renderIndex(seo) {
  const title = escHtml(seo.title);
  const desc = escHtml(seo.description || DEFAULT_DESCRIPTION);
  const url = escHtml(seo.url);
  // Function replacers: a "$&" or "$1" inside product text must not be treated as a pattern.
  let html = INDEX_HTML
    .replace(/<title>[^<]*<\/title>/, () => `<title>${title}</title>`)
    .replace(/(<meta name="description" content=")[^"]*/, (_, pre) => pre + desc)
    .replace(/(<link rel="canonical" href=")[^"]*/, (_, pre) => pre + url)
    .replace(/(<meta property="og:title" content=")[^"]*/, (_, pre) => pre + title)
    .replace(/(<meta property="og:description" content=")[^"]*/, (_, pre) => pre + desc)
    .replace(/(<meta property="og:url" content=")[^"]*/, (_, pre) => pre + url);
  let extra = '';
  if (seo.image) extra += `<meta property="og:image" content="${escHtml(seo.image)}">\n`;
  if (seo.status === 404 || seo.noindex) extra += '<meta name="robots" content="noindex">\n';
  // "<" escaped so product text can never close the <script> tag early.
  if (seo.jsonLd) extra += `<script type="application/ld+json">${JSON.stringify(seo.jsonLd).replace(/</g, '\\u003c')}</script>\n`;
  return html.replace('</head>', () => extra + '</head>');
}

app.get('*', (req, res) => {
  const seo = pageSeo(req.path, req.query);
  res.status(seo.status || 200).type('html').send(renderIndex(seo));
});

app.listen(port, () => {
  console.log(`Two Boots site running on port ${port}`);
  console.log(`Data dir: ${DATA_DIR}`);
  if (!process.env.SESSION_SECRET) {
    console.warn(
      '⚠ SESSION_SECRET is not set — using the default from the public source code. ' +
      'Set SESSION_SECRET to a long random string in Railway → Variables.'
    );
  }
  const defaultPwdAdmins = readStore().admins.filter(a => verifyPassword('changeme123', a.passwordHash));
  if (defaultPwdAdmins.length) {
    console.warn(
      `⚠ Admin(s) ${defaultPwdAdmins.map(a => a.username).join(', ')} still use the default password ` +
      '"changeme123" — anyone can log in to /admin. Change it in the admin panel (Администраторы → Пароль).'
    );
  }
  if (!process.env.DATA_DIR) {
    console.warn(
      '⚠ DATA_DIR is not set — data is stored inside the container and will be LOST on the next ' +
      'redeploy/restart (added admins, categories, products, uploaded photos, discounts). ' +
      'Attach a Volume in Railway and set DATA_DIR to its mount path (e.g. /data) to persist it.'
    );
  }
  if (!mailTransport) {
    console.warn(
      '⚠ SMTP is not configured — order confirmation emails will not be sent. ' +
      'Set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS (and optionally MAIL_FROM) to enable them.'
    );
  }
  if (!BOTORDER_URL || !BOTORDER_SECRET) {
    console.warn(
      '⚠ Order-desk bot (twoboots-botorder) is not configured — orders won\'t be forwarded there. ' +
      'Set BOTORDER_URL and BOTORDER_SECRET to enable it.'
    );
  }
  if ((!BOTORDER_URL || !BOTORDER_SECRET) && (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID)) {
    console.warn(
      '⚠ Telegram is not configured — new-order notifications will not be sent there. ' +
      'Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to enable them.'
    );
  }
  if (!WHATSAPP_CALLMEBOT_APIKEY) {
    console.warn(
      '⚠ WhatsApp (CallMeBot) is not configured — new-order notifications will not be sent there. ' +
      'Set WHATSAPP_CALLMEBOT_APIKEY to enable them (get a free key by messaging CallMeBot on WhatsApp).'
    );
  }
});
