const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const multer = require('multer');
const nodemailer = require('nodemailer');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const archiver = require('archiver');
const AdmZip = require('adm-zip');
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
const DEFAULT_ADMIN_PASSWORD = 'changeme123';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
function adminPasswordProblem(password) {
  if (!password || String(password).length < 8) return 'Пароль администратора — не короче 8 символов';
  if (password === DEFAULT_ADMIN_PASSWORD) return 'Этот пароль стоит по умолчанию — придумайте другой';
  return null;
}
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

/* ===== Delivery methods =====
   The owner sets them up in the admin (store.deliveryMethods): name, what the customer has to
   fill in (kind), whose parcel it is (carrier — for the tracking link), and how it's paid:
     fixed      — a set price, added to the order total
     onDelivery — by the carrier's tariff, paid on receipt (an optional estimate is shown)
     agree      — the manager quotes it when confirming the order
     free       — free
   plus «free from N ₽» for any of them. Without carrier contracts there are no live quotes;
   the customer finds a pickup point on the map by link and types its address. */
// kind → what the customer fills in: point — city + pickup point address, address — city + address,
// courier — address in Moscow, manager — city only (the manager arranges the rest), pickup — nothing
const DELIVERY_KINDS = {
  point: 'Пункт выдачи',
  address: 'До адреса',
  courier: 'Курьер по Москве',
  manager: 'Через менеджера',
  pickup: 'Самовывоз',
};
const DELIVERY_CARRIERS = { cdek: 'СДЭК', post: 'Почта России', yandex: 'Яндекс Доставка', ozon: 'Ozon', wb: 'Wildberries', avito: 'Авито Доставка', courier: 'Курьер', other: 'Другое' };
const DELIVERY_PRICING = ['fixed', 'onDelivery', 'agree', 'free'];
const DEFAULT_DELIVERY_METHODS = [
  { id: 'cdek', name: 'СДЭК — пункт выдачи', kind: 'point', carrier: 'cdek', pricing: 'onDelivery', mapQuery: 'СДЭК пункт выдачи', note: 'По тарифам СДЭК, обычно 2–7 дней.' },
  { id: 'cdek-door', name: 'СДЭК — курьер до двери', kind: 'address', carrier: 'cdek', pricing: 'onDelivery', note: 'По тарифам СДЭК, обычно 2–7 дней.' },
  { id: 'post', name: 'Почта России', kind: 'address', carrier: 'post', pricing: 'onDelivery', note: 'В любой населённый пункт, обычно 5–14 дней. Укажите адрес с индексом.' },
  { id: 'yandex', name: 'Яндекс Доставка — пункт выдачи', kind: 'point', carrier: 'yandex', pricing: 'onDelivery', mapQuery: 'Яндекс Маркет пункт выдачи' },
  { id: 'ozon', name: 'Ozon — пункт выдачи', kind: 'point', carrier: 'ozon', pricing: 'onDelivery', mapQuery: 'Ozon пункт выдачи' },
  { id: 'wb', name: 'Wildberries — пункт выдачи', kind: 'point', carrier: 'wb', pricing: 'onDelivery', mapQuery: 'Wildberries пункт выдачи' },
  { id: 'avito', name: 'Авито Доставка', kind: 'manager', carrier: 'avito', pricing: 'onDelivery', note: 'Оформим покупку через наше объявление на Авито — менеджер пришлёт ссылку, пункт выдачи вы выберете там.' },
  { id: 'courier', name: 'Курьер по Москве', kind: 'courier', carrier: 'courier', pricing: 'agree', note: '1–2 дня.' },
  { id: 'pickup', name: 'Самовывоз', kind: 'pickup', carrier: 'other', pricing: 'free', note: 'Москва, по договорённости. Адрес и время сообщит менеджер.' },
];
// Names of the four methods orders were placed with before methods became editable
const LEGACY_DELIVERY_NAMES = { cdek: 'СДЭК', post: 'Почта России', courier: 'Курьер по Москве', pickup: 'Самовывоз' };

function cleanDeliveryMethod(m) {
  const str = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
  const num = v => Math.max(0, Math.min(1e6, Math.round(Number(v) || 0)));
  const id = str(m.id, 30).toLowerCase();
  if (!/^[a-z0-9-]+$/.test(id)) return null;
  return {
    id,
    name: str(m.name, 80) || id,
    kind: DELIVERY_KINDS[m.kind] ? m.kind : 'address',
    carrier: DELIVERY_CARRIERS[m.carrier] ? m.carrier : 'other',
    pricing: DELIVERY_PRICING.includes(m.pricing) ? m.pricing : 'agree',
    price: num(m.price),
    freeFrom: num(m.freeFrom),
    estimate: str(m.estimate, 60),
    note: str(m.note, 300),
    mapQuery: str(m.mapQuery, 80),
    enabled: m.enabled !== false,
  };
}

// What delivery costs for this order: the amount added to the total and how to describe it.
function deliveryQuote(method, goodsTotal) {
  if (method.pricing === 'free' || (method.freeFrom > 0 && goodsTotal >= method.freeFrom)) return { cost: 0, text: 'бесплатно' };
  if (method.pricing === 'fixed') return { cost: method.price, text: method.price.toLocaleString('ru-RU') + ' ₽' };
  if (method.pricing === 'onDelivery') return { cost: 0, text: 'по тарифу перевозчика, оплата при получении' + (method.estimate ? ` (${method.estimate})` : '') };
  return { cost: 0, text: 'стоимость сообщит менеджер' };
}

function deliveryLabel(order) {
  return order.deliveryName || LEGACY_DELIVERY_NAMES[order.delivery] || order.delivery || '';
}

// Where the customer can follow the parcel; carriers without a public tracking page get none.
function trackingUrl(carrier, number) {
  const n = encodeURIComponent(number);
  if (carrier === 'cdek') return `https://www.cdek.ru/ru/tracking/?order_id=${n}`;
  if (carrier === 'post') return `https://www.pochta.ru/tracking?barcode=${n}`;
  return '';
}

// "Доставка: СДЭК — Казань, ул. … · 350 ₽" plus the customer's comment, one line each ('' if absent).
function orderDeliveryLines(order) {
  let text = '';
  if (order.delivery) {
    const where = [order.city, order.address].filter(Boolean).join(', ');
    text += `Доставка: ${deliveryLabel(order)}${where ? ' — ' + where : ''}${order.deliveryPrice ? ' · ' + order.deliveryPrice : ''}\n`;
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
      ${order.delivery ? `<p>Доставка: ${escHtml(deliveryLabel(order))}${[order.city, order.address].filter(Boolean).length ? ' — ' + escHtml([order.city, order.address].filter(Boolean).join(', ')) : ''}${order.deliveryPrice ? ' · ' + escHtml(order.deliveryPrice) : ''}</p>` : ''}
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

// The order as the order-desk bot shows it: field name → text
function botOrderFields(order) {
  return {
    'Заказ': `№${order.number}${order.quick ? ' (в 1 клик)' : ''}`,
    name: order.name,
    phone: order.phone,
    'Состав': order.items.map(it => `${it.name}${it.size ? ' (' + it.size + ')' : ''} — ${it.qty} шт. × ${it.price.toLocaleString('ru-RU')} ₽`).join('\n'),
    'Итого': `${order.total.toLocaleString('ru-RU')} ₽`,
    ...(order.promo ? { 'Промокод': `${order.promo.code} (−${order.promo.discount.toLocaleString('ru-RU')} ₽)` } : {}),
    ...(order.delivery ? { 'Доставка': `${deliveryLabel(order)}${[order.city, order.address].filter(Boolean).length ? ' — ' + [order.city, order.address].filter(Boolean).join(', ') : ''}${order.deliveryPrice ? ' · ' + order.deliveryPrice : ''}` } : {}),
    ...(order.customerComment ? { 'Комментарий': order.customerComment } : {}),
  };
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
      body: JSON.stringify(botOrderFields(order)),
    }).then(r => { if (!r.ok) return r.text().then(t => { throw new Error(t); }); })
      .catch(err => {
        console.error('Не удалось отправить заказ в бот заявок:', err.message);
        sendOwnerTelegram(text); // бот недоступен — хотя бы простое уведомление в Telegram
      });
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
  const track = order.trackNumber && order.status === 'shipped'
    ? `\n\nТрек-номер: ${order.trackNumber}${order.trackUrl ? '\nОтследить посылку: ' + order.trackUrl : ''}` : '';
  mailTransport.sendMail({
    from: MAIL_FROM,
    to: email,
    replyTo: OWNER_EMAIL,
    subject: `Заказ №${order.number}: статус изменён — Two Boots`,
    text: `Здравствуйте${order.name ? ', ' + order.name : ''}!\n\nВаш заказ №${order.number} ${STATUS_EMAIL_TEXT[order.status]}${track}\n\nИстория заказов — в личном кабинете: https://www.two-boots.ru/account`,
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
// Atomic save: write a temp file, flush it to disk, then rename over store.json. A crash or a
// redeploy mid-write leaves either the old or the new file — never a truncated one.
function writeStore(store) {
  const tmp = DATA_FILE + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(store, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, DATA_FILE);
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

// Brings a store up to the current shape: seeds the admin list from env vars if there is none
// (fresh install, or a store.json from before multi-admin support), backfills admin roles and
// adds collections introduced later. Used at startup and after restoring a backup.
function normalizeStore(store) {
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
  if (!store.restockSubs) { store.restockSubs = []; changed = true; }
  if (!Array.isArray(store.deliveryMethods)) { store.deliveryMethods = DEFAULT_DELIVERY_METHODS.map(cleanDeliveryMethod); changed = true; }
  // Starter articles arrive as drafts: the owner reads them and publishes from the admin.
  if (!store.articles) {
    const now = new Date().toISOString();
    store.articles = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'articles.json'), 'utf8'))
      .map(a => ({ id: crypto.randomUUID(), ...a, cover: null, published: false, createdAt: now, updatedAt: now }));
    changed = true;
  }
  if (!store.orderSeq) {
    store.orderSeq = store.orders.reduce((max, o) => Math.max(max, o.number || 0), 0);
    changed = true;
  }
  return changed;
}
{
  const store = readStore();
  if (normalizeStore(store)) writeStore(store);
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
      // X-Forwarded-For is logged too: if every visitor shows the same req.ip, the proxy hop
      // count in `trust proxy` is wrong and the limits are shared by everyone.
      console.warn(`Rate limit: ${req.ip} (xff: ${req.headers['x-forwarded-for'] || '-'}) ${req.method} ${req.originalUrl}`);
      res.status(429).json({ error });
    },
    ...extra,
  });
}
// Only failed attempts count, so a user who logs in successfully never burns the budget.
const loginLimiter = limiter(10, 15, 'Слишком много неудачных попыток входа. Попробуйте через 15 минут.', { skipSuccessfulRequests: true });
// Only successful sign-ups count: a form mistake (no consent tick, taken email) never locks anyone out.
const registerLimiter = limiter(10, 60, 'Слишком много регистраций с вашего адреса. Попробуйте позже.', { skipFailedRequests: true });
// Only placed orders count: a customer fixing a form mistake (no address, no size) is never locked out.
const orderLimiter = limiter(Math.max(1, Number(process.env.ORDERS_PER_IP_15MIN) || 10), 15, 'Слишком много заявок подряд. Попробуйте через несколько минут или позвоните нам.', { skipFailedRequests: true });
// And per customer: at most ORDERS_PER_HOUR placed orders an hour, cart and one-click together.
// Counted by phone number (from the profile for cart orders, from the form for one-click ones),
// not by IP — mobile carriers put thousands of people behind one address.
const ORDERS_PER_HOUR = Math.max(1, Number(process.env.ORDERS_PER_HOUR) || 2);
const customerOrderLimiter = limiter(ORDERS_PER_HOUR, 60,
  `Можно оформить не больше ${ORDERS_PER_HOUR} ${ORDERS_PER_HOUR === 1 ? 'заказа' : 'заказов'} в час. Если нужно срочно — позвоните нам: +7 926 349-75-86.`, {
    skipFailedRequests: true,
    keyGenerator: req => {
      let phone = (req.body || {}).phone;
      if (req.path === '/api/orders') {
        const user = req.session && req.session.userId && readStore().users.find(u => u.id === req.session.userId);
        phone = user && user.phone;
      }
      const digits = String(phone || '').replace(/\D/g, '').slice(-10);
      return digits.length >= 5 ? 'phone:' + digits : 'ip:' + ipKeyGenerator(req.ip);
    },
  });
const contactLimiter = limiter(5, 15, 'Слишком много сообщений подряд. Попробуйте через несколько минут.');
// Generous for real shoppers, but stops anyone from guessing codes by brute force.
const promoLimiter = limiter(20, 15, 'Слишком много попыток ввода промокода. Попробуйте позже.');
// Only accepted reviews count, so fixing a form mistake never locks a real customer out.
const reviewLimiter = limiter(10, 60, 'Слишком много отзывов подряд. Попробуйте позже.', { skipFailedRequests: true });
const restockLimiter = limiter(10, 60, 'Слишком много подписок подряд. Попробуйте позже.', { skipFailedRequests: true });
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

// An admin who signed in with the factory password may do nothing but change it.
const MUST_CHANGE = { error: 'Сначала смените пароль по умолчанию', mustChangePassword: true };
function requireAdminSession(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.status(401).json({ error: 'unauthorized' });
}
function requireAdmin(req, res, next) {
  if (!(req.session && req.session.isAdmin)) return res.status(401).json({ error: 'unauthorized' });
  if (req.session.mustChangePassword) return res.status(403).json(MUST_CHANGE);
  next();
}
function requireSuperAdmin(req, res, next) {
  if (req.session && req.session.isAdmin && req.session.mustChangePassword) return res.status(403).json(MUST_CHANGE);
  if (req.session && req.session.isAdmin && req.session.role === 'super') return next();
  res.status(403).json({ error: 'Только главный администратор может это делать' });
}
function requireUser(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: 'Войдите в личный кабинет' });
}
// Signs the customer in and answers only once the session is on disk, so the very next request
// (loading orders, a page reload) already sees them as logged in — no second password prompt.
function signIn(req, res, user) {
  req.session.userId = user.id;
  req.session.save(err => {
    if (err) {
      console.error('Не удалось сохранить сессию:', err.message);
      return res.status(500).json({ error: 'Не получилось войти — попробуйте ещё раз' });
    }
    res.json({ user: safeUser(user) });
  });
}

function safeUser(u) {
  return {
    id: u.id, email: u.email, name: u.name, phone: u.phone, city: u.city, address: u.address, consentAt: u.consentAt || null,
    marketing: !!u.marketingConsentAt && !u.noEmails,
    favorites: u.favorites || [],
    cart: (u.cart && u.cart.items) || [],
  };
}

// Cart lines as the storefront sends them: product id, quantity, chosen size
function cleanCartItems(items) {
  return (Array.isArray(items) ? items : []).slice(0, 50).map(l => ({
    id: String((l && l.id) || '').slice(0, 80),
    qty: Math.max(1, Math.min(99, parseInt(l && l.qty, 10) || 1)),
    size: l && l.size ? String(l.size).slice(0, 40) : null,
  })).filter(l => l.id);
}

/* ===== Optional emails: unsubscribe link =====
   Reminders (abandoned cart, review requests) carry a link that turns all of them off.
   The link is signed with SESSION_SECRET, so nobody can unsubscribe someone else. */
function unsubscribeToken(userId) {
  return crypto.createHmac('sha256', SESSION_SECRET).update('unsubscribe:' + userId).digest('hex').slice(0, 32);
}
function unsubscribeUrl(user) {
  return `${SITE_ORIGIN}/unsubscribe?u=${encodeURIComponent(user.id)}&t=${unsubscribeToken(user.id)}`;
}
app.get('/unsubscribe', (req, res) => {
  const id = String(req.query.u || ''), token = String(req.query.t || '');
  const expected = unsubscribeToken(id);
  const store = readStore();
  const user = token.length === expected.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected)) && store.users.find(u => u.id === id);
  if (user) { user.noEmails = true; delete user.marketingConsentAt; writeStore(store); }
  res.set('Cache-Control', 'no-store').type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Отписка — Two Boots</title><body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:520px;margin:80px auto;padding:0 20px;color:#0F161D;">
<h1 style="font-size:1.4rem;">${user ? 'Вы отписались' : 'Ссылка недействительна'}</h1>
<p>${user ? 'Больше не будем присылать напоминания о корзине и просьбы оставить отзыв. Письма о ваших заказах (подтверждение, статус, трек-номер) будут приходить как обычно.' : 'Возможно, ссылка скопировалась не полностью. Отписаться можно и в личном кабинете, во вкладке «Профиль».'}</p>
<p><a href="/" style="color:#FF4B2B;">Вернуться в магазин</a></p></body>`);
});

/* ===== Public data API ===== */
// The shop window never shows exact stock — only «осталось N» when 5 or fewer are left.
const publicProduct = ratings => p => {
  const { quantity, lowStockAlerted, ...rest } = p;
  return {
    ...rest,
    ...(ratings[p.id] ? { rating: ratings[p.id] } : {}),
    ...(quantity !== undefined && quantity <= 5 && p.stock !== 'order' ? { left: quantity } : {}),
  };
};
app.get('/api/data', (req, res) => {
  const { categories, products, reviews, articles, deliveryMethods } = readStore();
  const ratings = productRatings(reviews);
  res.json({
    categories,
    deliveryMethods: deliveryMethods.filter(m => m.enabled).map(publicDeliveryMethod),
    articles: publishedArticles(articles).map(articleSummary),
    products: products.filter(p => !p.hidden).map(publicProduct(ratings)),
  });
});

/* ===== Articles ===== */
// Bodies are written in a tiny Markdown subset and rendered here, so the storefront and
// crawlers get the same escaped HTML: blank line = new block, "## "/"### " headings,
// "- " bullet lists, "1. " numbered lists, **bold**, [text](/link or https://…).
function renderArticleBody(md) {
  const inline = t => escHtml(t)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/)[^\s)]*)\)/g, (m, text, url) =>
      `<a href="${url}"${/^https?:/.test(url) ? ' target="_blank" rel="noopener"' : ''}>${text}</a>`);
  return String(md || '').replace(/\r/g, '').split(/\n\s*\n/).map(block => {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return '';
    if (lines.length === 1 && /^### /.test(lines[0])) return `<h3>${inline(lines[0].slice(4))}</h3>`;
    if (lines.length === 1 && /^## /.test(lines[0])) return `<h2>${inline(lines[0].slice(3))}</h2>`;
    if (lines.every(l => /^- /.test(l))) return `<ul>${lines.map(l => `<li>${inline(l.slice(2))}</li>`).join('')}</ul>`;
    if (lines.every(l => /^\d+[.)] /.test(l))) return `<ol>${lines.map(l => `<li>${inline(l.replace(/^\d+[.)] /, ''))}</li>`).join('')}</ol>`;
    return `<p>${lines.map(inline).join('<br>')}</p>`;
  }).join('\n');
}

const publishedArticles = articles => (articles || [])
  .filter(a => a.published)
  .sort((a, b) => new Date(b.publishedAt || b.createdAt) - new Date(a.publishedAt || a.createdAt));
const articleSummary = a => ({ slug: a.slug, title: a.title, description: a.description, cover: a.cover || null, date: a.publishedAt || a.createdAt });

app.get('/api/articles/:slug', (req, res) => {
  const a = publishedArticles(readStore().articles).find(x => x.slug === req.params.slug);
  if (!a) return res.status(404).json({ error: 'Статья не найдена' });
  res.json({ ...articleSummary(a), updatedAt: a.updatedAt, html: renderArticleBody(a.body) });
});

/* ===== Back-in-stock notifications ===== */
// A customer leaves an email on an out-of-stock product; when the product becomes orderable
// again (stock changed in the admin, or it's un-hidden) everyone waiting gets one email and
// their entries are removed.
const isAvailable = p => !!p && !p.hidden && p.stock !== 'out';

app.post('/api/restock', restockLimiter, (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase().slice(0, 200);
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Укажите корректный email' });
  if ((req.body || {}).consent !== true) return res.status(400).json({ error: CONSENT_ERROR });
  const store = readStore();
  const product = store.products.find(p => p.id === req.body.productId && !p.hidden);
  if (!product) return res.status(404).json({ error: 'Товар не найден' });
  if (isAvailable(product)) return res.status(400).json({ error: 'Товар уже в наличии — его можно заказать' });
  if (!store.restockSubs.some(s => s.productId === product.id && s.email === email)) {
    store.restockSubs.push({ id: crypto.randomUUID(), productId: product.id, email, createdAt: new Date().toISOString() });
    writeStore(store);
  }
  res.json({ ok: true });
});

// pairs: [[productBefore, productAfter], …]. Removes the waiting-list entries of products that
// just became available and returns them; the caller writes the store, then sends.
function takeRestockSubs(store, pairs) {
  const due = [];
  for (const [before, after] of pairs) {
    if (isAvailable(before) || !isAvailable(after)) continue;
    const subs = store.restockSubs.filter(s => s.productId === after.id);
    if (!subs.length) continue;
    store.restockSubs = store.restockSubs.filter(s => s.productId !== after.id);
    due.push({ product: after, emails: subs.map(s => s.email) });
  }
  return due;
}

function sendRestockEmails(due) {
  if (!mailTransport) return;
  for (const { product, emails } of due) {
    const url = `${SITE_ORIGIN}/product/${encodeURIComponent(product.id)}`;
    for (const to of emails) {
      mailTransport.sendMail({
        from: MAIL_FROM,
        to,
        subject: `«${product.name}» снова в наличии — Two Boots`,
        text: `Здравствуйте!\n\nВы просили сообщить, когда появится «${product.name}». Товар снова можно заказать${product.stock === 'order' ? ' (под заказ)' : ''}:\n${url}\n\nЦена: ${unitPrice(product).toLocaleString('ru-RU')} ₽\n\nЭто однократное письмо — больше мы не напишем по этому товару.`,
        html: `<p>Здравствуйте!</p><p>Вы просили сообщить, когда появится «${escHtml(product.name)}». Товар снова можно заказать${product.stock === 'order' ? ' (под заказ)' : ''}.</p>
          <p><a href="${url}">Перейти к товару</a> — ${unitPrice(product).toLocaleString('ru-RU')} ₽</p>
          <p style="color:#777;">Это однократное письмо — больше мы не напишем по этому товару.</p>`,
      }).catch(err => console.error('Не удалось отправить письмо о поступлении:', err.message));
    }
  }
}

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

/* ===== Stock quantity =====
   A product may have quantity — how many are on the shelf (absent = not counted). A counted
   product is «в наличии» while quantity > 0 and «нет в наличии» at 0, unless it is sold
   «под заказ». Orders take from it, cancelling gives it back; when it drops to LOW_STOCK
   or less, the owner gets one email until it is topped up again. */
const LOW_STOCK = Math.max(0, Number(process.env.LOW_STOCK) || 2);
function normQuantity(v) {
  if (v === undefined || v === null || String(v).trim() === '') return undefined;
  const n = Math.round(Number(String(v).replace(',', '.')));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 1e6) : NaN;
}
function syncStockWithQuantity(p) {
  if (p.quantity === undefined || p.stock === 'order') return;
  if (p.quantity > 0) delete p.stock; else p.stock = 'out';
  if (p.quantity > LOW_STOCK) delete p.lowStockAlerted;
}
// direction -1 takes an order's items from the shelf, +1 puts them back
function moveStock(store, items, direction) {
  const low = [];
  for (const it of items) {
    const p = store.products.find(x => x.id === it.id);
    if (!p || p.quantity === undefined) continue;
    p.quantity = Math.max(0, p.quantity + direction * it.qty);
    syncStockWithQuantity(p);
    if (direction < 0 && p.quantity <= LOW_STOCK && !p.lowStockAlerted) { p.lowStockAlerted = true; low.push(p); }
  }
  return low;
}
function notifyLowStock(products) {
  if (!products.length || !mailTransport) return;
  const text = products.map(p => `${p.name} — осталось ${p.quantity} шт.`).join('\n');
  mailTransport.sendMail({
    from: MAIL_FROM, to: OWNER_EMAIL,
    subject: `Заканчивается: ${products.map(p => p.name).join(', ')} — Two Boots`,
    text: `Товар заканчивается на складе:\n\n${text}\n\nПополнить остаток: ${SITE_ORIGIN}/admin#products`,
  }).catch(err => console.error('Не удалось отправить уведомление об остатке:', err.message));
}
// Order statuses that hold stock: everything except a cancelled order. Orders placed before
// stock was counted have no stockTaken flag and never move it.
function setOrderStatusStock(store, order, newStatus) {
  if (order.stockTaken === undefined) return [];
  if (!order.stockTaken && newStatus !== 'cancelled') { order.stockTaken = true; return moveStock(store, order.items, -1); }
  if (order.stockTaken && newStatus === 'cancelled') { order.stockTaken = false; moveStock(store, order.items, +1); }
  return [];
}

// For uptime monitoring: 200 only if the data store (Railway volume) is readable and sane.
app.get('/health', (req, res) => {
  try {
    const { products } = readStore();
    fs.accessSync(DATA_DIR, fs.constants.W_OK);
    res.set('Cache-Control', 'no-store').json({ ok: true, products: products.length, uptime: Math.round(process.uptime()) });
  } catch (err) {
    console.error('Health check failed:', err.message);
    res.status(500).json({ ok: false });
  }
});

app.get('/sitemap.xml', (req, res) => {
  const { categories, products } = readStore();
  const staticUrls = ['/', '/catalog', '/about', '/contact', '/delivery', '/privacy'];
  const articleUrls = publishedArticles(readStore().articles).map(a => `/blog/${a.slug}`);
  if (articleUrls.length) staticUrls.push('/blog', ...articleUrls);
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
    req.session.mustChangePassword = password === DEFAULT_ADMIN_PASSWORD;
    return res.json({ ok: true, mustChangePassword: req.session.mustChangePassword });
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
    mustChangePassword: !!(req.session && req.session.mustChangePassword),
  });
});
app.get('/admin', (req, res) => {
  res.set('Cache-Control', 'no-cache').sendFile(path.join(__dirname, 'admin.html'));
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
  const weak = adminPasswordProblem(password);
  if (weak) return res.status(400).json({ error: weak });
  const store = readStore();
  if (store.admins.some(a => a.username === username)) return res.status(400).json({ error: 'Такой логин уже существует' });
  store.admins.push({ username, passwordHash: hashPassword(password), role: roleFor(username) });
  writeStore(store);
  res.json({ admins: store.admins.map(a => ({ username: a.username, role: a.role })) });
});
app.put('/api/admin/admins/:username/password', requireAdminSession, (req, res) => {
  const store = readStore();
  const { username } = req.params;
  const { password } = req.body || {};
  if (req.session.username !== username && req.session.role !== 'super') {
    return res.status(403).json({ error: 'Можно менять только свой пароль' });
  }
  if (req.session.mustChangePassword && req.session.username !== username) return res.status(403).json(MUST_CHANGE);
  const weak = adminPasswordProblem(password);
  if (weak) return res.status(400).json({ error: weak });
  const admin = store.admins.find(a => a.username === username);
  if (!admin) return res.status(404).json({ error: 'Администратор не найден' });
  admin.passwordHash = hashPassword(password);
  writeStore(store);
  if (req.session.username === username) req.session.mustChangePassword = false;
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
  const { categories, products, restockSubs } = readStore();
  const restockCounts = {};
  restockSubs.forEach(s => { restockCounts[s.productId] = (restockCounts[s.productId] || 0) + 1; });
  res.json({ categories, products, restockCounts });
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
    // separate, optional consent to reminders and news (38-ФЗ «О рекламе»)
    ...(req.body.marketing === true ? { marketingConsentAt: new Date().toISOString() } : {}),
    createdAt: new Date().toISOString(),
  };
  store.users.push(user);
  writeStore(store);
  signIn(req, res, user);
});

app.post('/api/login', loginLimiter, (req, res) => {
  const { email, password } = req.body || {};
  const store = readStore();
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const user = store.users.find(u => u.email.toLowerCase() === normalizedEmail);
  if (!user || !verifyPassword(password || '', user.passwordHash)) {
    return res.status(401).json({ error: 'Неверный email или пароль' });
  }
  signIn(req, res, user);
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
  signIn(req, res, user);
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
  if (req.body.marketing === true) { user.marketingConsentAt = user.marketingConsentAt || new Date().toISOString(); delete user.noEmails; }
  if (req.body.marketing === false) { delete user.marketingConsentAt; user.noEmails = true; }
  writeStore(store);
  res.json({ user: safeUser(user) });
});

// The cart of a signed-in customer is kept on the server too: it follows them to other
// devices and lets the shop remind them about it (only if they agreed to reminders).
app.put('/api/cart', requireUser, (req, res) => {
  const store = readStore();
  const user = store.users.find(u => u.id === req.session.userId);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  const items = cleanCartItems((req.body || {}).items);
  const same = user.cart && JSON.stringify(user.cart.items) === JSON.stringify(items);
  if (!same) {
    if (items.length) user.cart = { items, updatedAt: new Date().toISOString() };
    else delete user.cart;
    writeStore(store);
  }
  res.json({ ok: true });
});

app.put('/api/favorites', requireUser, (req, res) => {
  const store = readStore();
  const user = store.users.find(u => u.id === req.session.userId);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  const ids = [...new Set((Array.isArray((req.body || {}).ids) ? req.body.ids : []).map(String))]
    .filter(id => store.products.some(p => p.id === id)).slice(0, 200);
  if (ids.length) user.favorites = ids; else delete user.favorites;
  writeStore(store);
  res.json({ favorites: ids });
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
  const short = stockShortage(store, lines);
  if (short) return { error: short };
  return { lines, subtotal };
}
// '' if the shelf has enough of every counted product for these lines, else what is missing
function stockShortage(store, lines) {
  const wanted = {};
  lines.forEach(l => { wanted[l.id] = (wanted[l.id] || 0) + l.qty; });
  for (const [id, qty] of Object.entries(wanted)) {
    const p = store.products.find(x => x.id === id);
    if (p && p.quantity !== undefined && p.stock !== 'order' && qty > p.quantity) {
      return p.quantity > 0 ? `«${p.name}» осталось только ${p.quantity} шт. — уменьшите количество` : `«${p.name}» закончился — уберите его из корзины`;
    }
  }
  return '';
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

app.post('/api/orders', orderLimiter, customerOrderLimiter, requireUser, (req, res) => {
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
  const method = store.deliveryMethods.find(m => m.id === delivery && m.enabled);
  if (!method) return res.status(400).json({ error: 'Выберите способ доставки' });
  const kind = method.kind;
  const city = kind === 'pickup' ? '' : kind === 'courier' ? 'Москва' : String(req.body.city || '').trim().slice(0, 100);
  const address = kind === 'pickup' || kind === 'manager' ? '' : String(req.body.address || '').trim().slice(0, 300);
  if (kind !== 'pickup' && kind !== 'courier' && !city) return res.status(400).json({ error: 'Укажите город' });
  if (kind === 'point' && !address) return res.status(400).json({ error: 'Укажите адрес пункта выдачи' });
  if ((kind === 'address' || kind === 'courier') && !address) return res.status(400).json({ error: 'Укажите адрес доставки' });
  const customerComment = String(req.body.comment || '').trim().slice(0, 1000);
  // First address a customer types to their door becomes their profile default for next time.
  if (kind === 'address' || kind === 'courier') {
    if (!user.city) user.city = city;
    if (!user.address) user.address = address;
  }
  const { promo, discount = 0, error: promoError } = applyPromo(store, req.body.promoCode, subtotal);
  if (promoError) return res.status(400).json({ error: promoError });
  if (promo) promo.uses = (promo.uses || 0) + 1;
  const quote = deliveryQuote(method, subtotal - discount);

  store.orderSeq = (store.orderSeq || 0) + 1;
  const order = {
    id: crypto.randomUUID(),
    number: store.orderSeq,
    userId: user.id,
    items: lines,
    subtotal,
    ...(promo ? { promo: { code: promo.code, discount } } : {}),
    total: subtotal - discount + quote.cost,
    status: 'new',
    name: user.name, phone: user.phone, email: user.email,
    delivery,
    deliveryName: method.name,
    deliveryCarrier: method.carrier,
    deliveryCost: quote.cost,
    deliveryPrice: quote.text,
    city,
    address,
    ...(customerComment ? { customerComment } : {}),
    createdAt: new Date().toISOString(),
  };
  store.orders.push(order);
  delete user.cart;
  order.stockTaken = false;
  const low = setOrderStatusStock(store, order, order.status);
  writeStore(store);
  notifyLowStock(low);
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
  setOrderStatusStock(store, order, 'cancelled');
  writeStore(store);
  notifyOwnerCancelled(order);
  res.json({ order: customerOrder(order) });
});

/* ===== Quick order (buy in one click, no account needed) ===== */
app.post('/api/quick-order', orderLimiter, customerOrderLimiter, (req, res) => {
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
  const short = stockShortage(store, [{ id: product.id, qty: qtyNum }]);
  if (short) return res.status(400).json({ error: short });
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
  order.stockTaken = false;
  const low = setOrderStatusStock(store, order, order.status);
  writeStore(store);
  notifyLowStock(low);
  notifyOwnerNewOrder(order);
  res.json({ order });
});

/* ===== Order-desk bot pulls new orders =====
   When the site can't reach the bot (the Russian server can't reach Railway or Telegram),
   the bot fetches orders itself: GET /api/bot/orders?after=<last order number it has>,
   authorised with the same X-Webhook-Token secret. Without `after` it only reports the
   latest number, so a freshly started bot doesn't re-send the whole history. */
app.get('/api/bot/orders', (req, res) => {
  const token = Buffer.from(String(req.get('X-Webhook-Token') || ''));
  const secret = Buffer.from(BOTORDER_SECRET);
  if (secret.length < 16 || token.length !== secret.length || !crypto.timingSafeEqual(token, secret)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const store = readStore();
  const latest = store.orders.reduce((max, o) => Math.max(max, o.number || 0), 0);
  if (req.query.after === undefined) return res.json({ latest, orders: [] });
  let after = Math.max(0, parseInt(req.query.after, 10) || 0);
  if (after > latest) after = 0; // order numbering was reset in the admin
  const orders = store.orders
    .filter(o => o.number > after)
    .sort((a, b) => a.number - b.number)
    .slice(0, 20)
    .map(o => ({ number: o.number, fields: botOrderFields(o) }));
  res.json({ latest, orders });
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

/* ===== Delivery methods: public list and admin editing ===== */
const publicDeliveryMethod = ({ enabled, ...m }) => m;
app.get('/api/delivery-methods', (req, res) => {
  res.json({ methods: readStore().deliveryMethods.filter(m => m.enabled).map(publicDeliveryMethod) });
});

app.get('/api/admin/delivery-methods', requireAdmin, (req, res) => {
  res.json({ methods: readStore().deliveryMethods, kinds: DELIVERY_KINDS, carriers: DELIVERY_CARRIERS });
});

app.put('/api/admin/delivery-methods', requireAdmin, (req, res) => {
  const list = Array.isArray((req.body || {}).methods) ? req.body.methods : null;
  if (!list || list.length > 30) return res.status(400).json({ error: 'Некорректный список способов доставки' });
  const methods = [];
  for (const raw of list) {
    const m = cleanDeliveryMethod(raw || {});
    if (!m) return res.status(400).json({ error: 'ID способа доставки — латинские буквы, цифры и дефис' });
    if (methods.some(x => x.id === m.id)) return res.status(400).json({ error: `ID «${m.id}» встречается дважды` });
    methods.push(m);
  }
  if (!methods.some(m => m.enabled)) return res.status(400).json({ error: 'Оставьте включённым хотя бы один способ доставки' });
  const store = readStore();
  store.deliveryMethods = methods;
  writeStore(store);
  res.json({ methods });
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
  const { status, comment, trackNumber, trackCarrier } = req.body || {};
  if (status !== undefined && !ORDER_STATUSES.includes(status)) return res.status(400).json({ error: 'Некорректный статус' });
  const store = readStore();
  const order = store.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Заказ не найден' });
  let changed = status !== undefined && order.status !== status;
  let low = [];
  if (status !== undefined) { low = setOrderStatusStock(store, order, status); order.status = status; }
  // A new tracking number marks the order as shipped and tells the customer (with the number).
  if (trackNumber !== undefined) {
    const number = String(trackNumber).replace(/\s+/g, '').slice(0, 60);
    if (number && !/^[A-Za-z0-9-]+$/.test(number)) return res.status(400).json({ error: 'Трек-номер: только буквы, цифры и дефис' });
    if (trackCarrier !== undefined) order.deliveryCarrier = DELIVERY_CARRIERS[trackCarrier] ? trackCarrier : 'other';
    if (!number) { delete order.trackNumber; delete order.trackUrl; }
    else if (number !== order.trackNumber) {
      order.trackNumber = number;
      order.trackUrl = trackingUrl(order.deliveryCarrier, number);
      if (order.status === 'new' || order.status === 'processing' || order.status === 'shipped') { order.status = 'shipped'; changed = true; }
    }
  }
  // Internal manager note — never sent to the customer (see customerOrder()).
  if (comment !== undefined) {
    const text = String(comment).trim().slice(0, 1000);
    if (text) order.comment = text;
    else delete order.comment;
  }
  // when an order was shipped / completed: the review request is timed from these
  if (changed && ['shipped', 'completed'].includes(order.status) && !order[order.status + 'At']) {
    order[order.status + 'At'] = new Date().toISOString();
  }
  writeStore(store);
  notifyLowStock(low);
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
/* ===== Admin: sales statistics ===== */
// Figures for the admin dashboard over the last N days (Moscow calendar days), compared with the
// N days before. Cancelled orders are counted separately and never add to revenue.
const moscowDay = iso => new Date(new Date(iso).getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const days = [7, 30, 90, 365].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  const { orders, users } = readStore();
  const today = moscowDay(new Date().toISOString());
  const dayList = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - i);
    dayList.push(d.toISOString().slice(0, 10));
  }
  const from = dayList[0];
  const prevFromDate = new Date(from + 'T00:00:00Z');
  prevFromDate.setUTCDate(prevFromDate.getUTCDate() - days);
  const prevFrom = prevFromDate.toISOString().slice(0, 10);

  const inPeriod = orders.filter(o => moscowDay(o.createdAt) >= from);
  const inPrev = orders.filter(o => { const d = moscowDay(o.createdAt); return d >= prevFrom && d < from; });
  const live = list => list.filter(o => o.status !== 'cancelled');
  const summary = list => {
    const ok = live(list);
    const revenue = ok.reduce((s, o) => s + o.total, 0);
    return { orders: ok.length, revenue, avgCheck: ok.length ? Math.round(revenue / ok.length) : 0, cancelled: list.length - ok.length };
  };

  const byDay = Object.fromEntries(dayList.map(d => [d, { date: d, orders: 0, revenue: 0 }]));
  live(inPeriod).forEach(o => { const b = byDay[moscowDay(o.createdAt)]; if (b) { b.orders++; b.revenue += o.total; } });

  const products = {};
  live(inPeriod).forEach(o => o.items.forEach(it => {
    const p = products[it.id] || (products[it.id] = { id: it.id, name: it.name, qty: 0, revenue: 0 });
    p.qty += it.qty; p.revenue += it.price * it.qty;
  }));
  const promos = {};
  live(inPeriod).filter(o => o.promo).forEach(o => {
    const p = promos[o.promo.code] || (promos[o.promo.code] = { code: o.promo.code, orders: 0, discount: 0, revenue: 0 });
    p.orders++; p.discount += o.promo.discount; p.revenue += o.total;
  });
  const count = (list, key) => list.reduce((acc, o) => { const k = key(o); if (k) acc[k] = (acc[k] || 0) + 1; return acc; }, {});

  res.json({
    days, from, to: today,
    current: summary(inPeriod),
    previous: summary(inPrev),
    byDay: dayList.map(d => byDay[d]),
    topProducts: Object.values(products).sort((a, b) => b.revenue - a.revenue).slice(0, 10),
    promos: Object.values(promos).sort((a, b) => b.orders - a.orders),
    delivery: count(live(inPeriod), o => o.quick ? 'quick' : deliveryLabel(o)),
    statuses: count(inPeriod, o => o.status),
    newCustomers: users.filter(u => u.createdAt && moscowDay(u.createdAt) >= from).length,
  });
});

/* ===== Visitor counter =====
   The site's own count for the admin: unique visitors and page views per (Moscow) day, pages,
   traffic sources, devices and who is on the site right now. The storefront sends a beacon per
   page shown and a ping every minute while the tab is open. No cookies and no IPs on disk:
   a visitor is a hash of IP + browser with a salt that changes every day, so nobody can be
   followed from one day to the next. Kept in DATA_DIR/visits.json, saved once a minute. */
const VISITS_FILE = path.join(DATA_DIR, 'visits.json');
const VISIT_DAYS_KEPT = 400;
const ONLINE_WINDOW_MS = 5 * 60 * 1000;
const BOT_UA = /bot|crawl|spider|slurp|headless|lighthouse|preview|monitor|curl|wget|python|java\//i;
const MOBILE_UA = /mobi|android|iphone|ipad|ipod/i;

function loadVisits() {
  try {
    const v = JSON.parse(fs.readFileSync(VISITS_FILE, 'utf8'));
    if (v && v.days && v.today) return v;
  } catch (e) { /* first start or unreadable — start empty */ }
  return { days: {}, today: { day: '', salt: '', seen: [] } };
}
const visits = loadVisits();
let visitorsSeenToday = new Set(visits.today.seen);
const onlineNow = new Map(); // visitor hash → last activity, ms
let visitsDirty = false;

function saveVisits() {
  if (!visitsDirty) return;
  visits.today.seen = [...visitorsSeenToday];
  const tmp = VISITS_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(visits));
    fs.renameSync(tmp, VISITS_FILE);
    visitsDirty = false;
  } catch (e) { console.error('Не удалось сохранить счётчик посетителей:', e.message); }
}
setInterval(saveVisits, 60 * 1000).unref();
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => { saveVisits(); process.exit(0); });
}

function visitDay() {
  const day = moscowDay(new Date().toISOString());
  if (visits.today.day !== day) {
    visits.today = { day, salt: crypto.randomBytes(16).toString('hex'), seen: [] };
    visitorsSeenToday = new Set();
    const oldest = new Date(Date.now() - VISIT_DAYS_KEPT * 86400000).toISOString().slice(0, 10);
    for (const d of Object.keys(visits.days)) if (d < oldest) delete visits.days[d];
  }
  return visits.days[day] || (visits.days[day] = { views: 0, visitors: 0, pages: {}, sources: {}, devices: {} });
}

// Where a visitor came from, by the referring site's host
function visitSource(ref) {
  let host = '';
  try { host = new URL(String(ref)).hostname.replace(/^www\./, ''); } catch (e) { return 'direct'; }
  if (!host || host.endsWith('two-boots.ru')) return 'direct';
  if (/(^|\.)yandex\.|(^|\.)ya\.ru$/.test(host)) return 'yandex';
  if (/(^|\.)google\./.test(host)) return 'google';
  if (/(^|\.)(vk\.com|vk\.ru|vkontakte\.ru)$/.test(host)) return 'vk';
  if (/(^|\.)(t\.me|telegram\.org|web\.telegram\.org)$/.test(host)) return 'telegram';
  if (/(^|\.)(avito\.ru)$/.test(host)) return 'avito';
  return host.slice(0, 60);
}

// Page key: the path, plus the category for catalog pages; search text is never stored
function visitPage(raw) {
  let u;
  try { u = new URL(String(raw || '/'), 'https://www.two-boots.ru'); } catch (e) { return null; }
  if (u.origin !== 'https://www.two-boots.ru' || u.pathname.startsWith('/admin') || u.pathname.startsWith('/api/')) return null;
  const cat = u.pathname === '/catalog' && u.searchParams.get('cat');
  return (u.pathname + (cat ? '?cat=' + cat : '')).slice(0, 120);
}

const hitLimiter = limiter(120, 1, 'Слишком много запросов');
app.post('/api/hit', hitLimiter, (req, res) => {
  res.status(204).end();
  const ua = String(req.get('user-agent') || '');
  if (!ua || BOT_UA.test(ua) || (req.session && req.session.isAdmin)) return;
  const body = req.body || {};
  const stats = visitDay();
  const visitor = crypto.createHash('sha256').update(visits.today.salt + '|' + req.ip + '|' + ua).digest('hex').slice(0, 20);
  onlineNow.set(visitor, Date.now());
  if (body.ping) return;
  const page = visitPage(body.path);
  if (!page) return;
  stats.views++;
  stats.pages[page] = (stats.pages[page] || 0) + 1;
  if (!visitorsSeenToday.has(visitor)) {
    visitorsSeenToday.add(visitor);
    stats.visitors++;
    const device = MOBILE_UA.test(ua) ? 'mobile' : 'desktop';
    stats.devices[device] = (stats.devices[device] || 0) + 1;
    const source = visitSource(body.ref);
    stats.sources[source] = (stats.sources[source] || 0) + 1;
  }
  visitsDirty = true;
});

function visitorsOnline() {
  const cutoff = Date.now() - ONLINE_WINDOW_MS;
  for (const [k, t] of onlineNow) if (t < cutoff) onlineNow.delete(k);
  return onlineNow.size;
}

// Human names for page keys in the admin: products and articles by title
function visitPageLabel(key, store) {
  const titles = { '/': 'Главная', '/catalog': 'Каталог', '/about': 'О нас', '/contact': 'Контакты', '/delivery': 'Доставка и оплата',
    '/privacy': 'Политика конфиденциальности', '/consent': 'Согласие на обработку данных', '/blog': 'Статьи', '/cart': 'Корзина', '/account': 'Личный кабинет' };
  if (titles[key]) return titles[key];
  const [p, q] = key.split('?cat=');
  if (p === '/catalog' && q) return 'Каталог: ' + (store.categories[q] || q);
  const product = p.startsWith('/product/') && store.products.find(x => x.id === decodeURIComponent(p.slice(9)));
  if (product) return product.name;
  const article = p.startsWith('/blog/') && (store.articles || []).find(a => a.slug === decodeURIComponent(p.slice(6)));
  if (article) return article.title;
  return key;
}

app.get('/api/admin/visitors-now', requireAdmin, (req, res) => {
  const today = visits.days[moscowDay(new Date().toISOString())] || { views: 0, visitors: 0 };
  res.json({ online: visitorsOnline(), today: { visitors: today.visitors, views: today.views } });
});

app.get('/api/admin/visits', requireAdmin, (req, res) => {
  const days = [7, 30, 90, 365].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  const store = readStore();
  const today = moscowDay(new Date().toISOString());
  const dayList = [];
  for (let i = 2 * days - 1; i >= 0; i--) {
    const d = new Date(today + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - i);
    dayList.push(d.toISOString().slice(0, 10));
  }
  const prevDays = dayList.slice(0, days), curDays = dayList.slice(days);
  const sum = (list, key) => list.reduce((s, d) => s + ((visits.days[d] || {})[key] || 0), 0);
  const merge = key => {
    const acc = {};
    curDays.forEach(d => Object.entries((visits.days[d] || {})[key] || {}).forEach(([k, n]) => { acc[k] = (acc[k] || 0) + n; }));
    return acc;
  };
  const orders = store.orders.filter(o => o.status !== 'cancelled' && moscowDay(o.createdAt) >= curDays[0]).length;
  const visitors = sum(curDays, 'visitors');
  res.json({
    days,
    online: visitorsOnline(),
    since: Object.keys(visits.days).sort()[0] || null,
    current: { visitors, views: sum(curDays, 'views'), orders, conversion: visitors ? orders / visitors : 0 },
    previous: { visitors: sum(prevDays, 'visitors'), views: sum(prevDays, 'views') },
    byDay: curDays.map(d => ({ date: d, visitors: (visits.days[d] || {}).visitors || 0, views: (visits.days[d] || {}).views || 0 })),
    pages: Object.entries(merge('pages')).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([key, views]) => ({ key, label: visitPageLabel(key, store), views })),
    sources: Object.entries(merge('sources')).sort((a, b) => b[1] - a[1]).map(([source, visitors]) => ({ source, visitors })),
    devices: merge('devices'),
  });
});

/* ===== Admin: articles ===== */
function parseArticleBody(body) {
  return {
    title: String(body.title || '').trim().slice(0, 150),
    slug: slugify(String(body.slug || '').trim() || String(body.title || '')).slice(0, 80),
    description: String(body.description || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    body: String(body.body || '').slice(0, 50000),
    published: body.published === 'true' || body.published === true,
  };
}

app.get('/api/admin/articles', requireAdmin, (req, res) => {
  const articles = [...readStore().articles].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ articles });
});

app.post('/api/admin/articles/preview', requireAdmin, (req, res) => {
  res.json({ html: renderArticleBody((req.body || {}).body) });
});

app.post('/api/admin/articles', requireAdmin, upload.single('cover'), async (req, res) => {
  const cover = req.file ? '/uploads/' + await optimizeImage(req.file.filename) : null;
  const data = parseArticleBody(req.body || {});
  const store = readStore();
  if (!data.title || !data.body.trim()) { removeUpload(cover); return res.status(400).json({ error: 'Нужны заголовок и текст статьи' }); }
  if (store.articles.some(a => a.slug === data.slug)) { removeUpload(cover); return res.status(400).json({ error: 'Статья с таким адресом уже есть — поменяйте заголовок или адрес' }); }
  const now = new Date().toISOString();
  const article = { id: crypto.randomUUID(), ...data, cover, createdAt: now, updatedAt: now, ...(data.published ? { publishedAt: now } : {}) };
  store.articles.push(article);
  writeStore(store);
  res.json(article);
});

app.put('/api/admin/articles/:id', requireAdmin, upload.single('cover'), async (req, res) => {
  const cover = req.file ? '/uploads/' + await optimizeImage(req.file.filename) : null;
  const data = parseArticleBody(req.body || {});
  const store = readStore();
  const article = store.articles.find(a => a.id === req.params.id);
  if (!article) { removeUpload(cover); return res.status(404).json({ error: 'Статья не найдена' }); }
  if (!data.title || !data.body.trim()) { removeUpload(cover); return res.status(400).json({ error: 'Нужны заголовок и текст статьи' }); }
  if (store.articles.some(a => a.slug === data.slug && a.id !== article.id)) { removeUpload(cover); return res.status(400).json({ error: 'Статья с таким адресом уже есть' }); }
  if (data.published && !article.published) article.publishedAt = new Date().toISOString();
  if (cover) { removeUpload(article.cover); article.cover = cover; }
  if (req.body.removeCover === 'true' && !cover) { removeUpload(article.cover); article.cover = null; }
  Object.assign(article, data, { updatedAt: new Date().toISOString() });
  writeStore(store);
  res.json(article);
});

app.delete('/api/admin/articles/:id', requireAdmin, (req, res) => {
  const store = readStore();
  const idx = store.articles.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Статья не найдена' });
  const [removed] = store.articles.splice(idx, 1);
  removeUpload(removed.cover);
  writeStore(store);
  res.json({ ok: true });
});

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
  const partner = String(body.partner || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  store.promos.push({
    code, type: body.type, value,
    minTotal: Math.max(0, Math.round(Number(body.minTotal) || 0)),
    expiresAt,
    maxUses: Math.max(0, Math.round(Number(body.maxUses) || 0)),
    uses: 0,
    active: true,
    // a coach or partner who hands out this code, and their share of what it brings in
    ...(partner ? { partner, commission: Math.max(0, Math.min(50, Number(body.commission) || 0)), paidOut: 0 } : {}),
    createdAt: new Date().toISOString(),
  });
  writeStore(store);
  res.json({ promos: store.promos });
});

app.patch('/api/admin/promos/:code', requireAdmin, (req, res) => {
  const store = readStore();
  const promo = store.promos.find(p => p.code === req.params.code);
  if (!promo) return res.status(404).json({ error: 'Промокод не найден' });
  const body = req.body || {};
  if (typeof body.active === 'boolean') promo.active = body.active;
  if (body.partner !== undefined) {
    const partner = String(body.partner || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (partner) { promo.partner = partner; promo.paidOut = promo.paidOut || 0; } else { delete promo.partner; delete promo.commission; }
  }
  if (body.commission !== undefined && promo.partner) promo.commission = Math.max(0, Math.min(50, Number(body.commission) || 0));
  // a payout to the partner is recorded as an amount added to what they have been paid
  if (body.payout !== undefined && promo.partner) {
    const amount = Math.round(Number(body.payout));
    if (!amount) return res.status(400).json({ error: 'Укажите сумму выплаты' });
    promo.paidOut = Math.max(0, (promo.paidOut || 0) + amount);
    (promo.payouts = promo.payouts || []).push({ amount, at: new Date().toISOString() });
  }
  writeStore(store);
  res.json({ promos: store.promos });
});

// What each partner's code brought: orders and sales (goods after discount, without delivery),
// commission on completed orders («заработано») and on orders still in progress («ожидается»).
app.get('/api/admin/partners', requireAdmin, (req, res) => {
  const store = readStore();
  const monthStart = moscowDay(new Date().toISOString()).slice(0, 8) + '01';
  const partners = store.promos.filter(p => p.partner).map(p => {
    const orders = store.orders.filter(o => o.promo && o.promo.code === p.code && o.status !== 'cancelled');
    const goods = o => (o.subtotal != null ? o.subtotal : o.total) - (o.promo ? o.promo.discount : 0);
    const sum = list => list.reduce((s, o) => s + goods(o), 0);
    const pct = (p.commission || 0) / 100;
    const done = orders.filter(o => o.status === 'completed');
    const earned = Math.round(sum(done) * pct);
    return {
      code: p.code, partner: p.partner, commission: p.commission || 0, active: p.active,
      orders: orders.length, sales: sum(orders),
      monthOrders: orders.filter(o => moscowDay(o.createdAt) >= monthStart).length,
      earned, pending: Math.round(sum(orders.filter(o => o.status !== 'completed')) * pct),
      paidOut: p.paidOut || 0, toPay: Math.max(0, earned - (p.paidOut || 0)),
    };
  });
  res.json({ partners });
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

/* ===== Abandoned cart reminder =====
   One email, 3 hours after a signed-in customer last changed a cart they didn't order —
   only to those who ticked «напоминания и новости», never twice for the same cart. */
const CART_REMIND_AFTER_MS = 3 * 3600 * 1000;
const CART_REMIND_UNTIL_MS = 7 * 24 * 3600 * 1000;
function sendCartReminders(now = Date.now()) {
  const store = readStore();
  let sent = 0;
  for (const user of store.users) {
    const c = user.cart;
    if (!c || !c.items.length || c.remindedAt || !user.marketingConsentAt || user.noEmails) continue;
    const age = now - new Date(c.updatedAt).getTime();
    if (age < CART_REMIND_AFTER_MS || age > CART_REMIND_UNTIL_MS) continue;
    if (store.orders.some(o => o.userId === user.id && o.createdAt > c.updatedAt)) continue;
    const lines = c.items.map(l => {
      const p = store.products.find(x => x.id === l.id && !x.hidden && x.stock !== 'out');
      return p && `${p.name}${l.size ? ' (' + l.size + ')' : ''} — ${l.qty} шт.`;
    }).filter(Boolean);
    c.remindedAt = new Date(now).toISOString();
    if (!lines.length) continue;
    sent++;
    if (mailTransport) mailTransport.sendMail({
      from: MAIL_FROM,
      to: user.email,
      subject: 'Вы оставили товары в корзине — Two Boots',
      text: `Здравствуйте${user.name ? ', ' + user.name : ''}!\n\nВ вашей корзине остались товары:\n${lines.join('\n')}\n\nОформить заказ: ${SITE_ORIGIN}/?cart=1\n\nЕсли есть вопросы по размеру или доставке — просто ответьте на это письмо или позвоните: +7 926 349-75-86.\n\nНе хотите получать напоминания? Отписаться: ${unsubscribeUrl(user)}`,
    }).catch(err => console.error('Не удалось отправить напоминание о корзине:', err.message));
  }
  writeStore(store);
  return sent;
}

/* ===== Review request =====
   One email per order: 2 days after it was marked completed, or 10 days after it was shipped
   if nobody marked it completed — with links straight to each product's reviews. Not for
   one-click orders (no email) and not for customers who unsubscribed. */
const DAY_MS = 24 * 3600 * 1000;
function sendReviewRequests(now = Date.now()) {
  const store = readStore();
  let sent = 0;
  for (const order of store.orders) {
    if (order.reviewRequestedAt || order.status === 'cancelled' || !order.userId) continue;
    const due = (order.completedAt && now - new Date(order.completedAt).getTime() >= 2 * DAY_MS)
      || (order.status === 'shipped' && order.shippedAt && now - new Date(order.shippedAt).getTime() >= 10 * DAY_MS);
    if (!due) continue;
    order.reviewRequestedAt = new Date(now).toISOString();
    const user = store.users.find(u => u.id === order.userId);
    if (!user || user.noEmails) continue;
    const products = [...new Map(order.items.map(it => [it.id, store.products.find(p => p.id === it.id && !p.hidden)])).values()].filter(Boolean);
    if (!products.length) continue;
    sent++;
    if (mailTransport) mailTransport.sendMail({
      from: MAIL_FROM,
      to: user.email,
      replyTo: OWNER_EMAIL,
      subject: `Как вам покупка? Заказ №${order.number} — Two Boots`,
      text: `Здравствуйте${user.name ? ', ' + user.name : ''}!\n\nНадеемся, заказ №${order.number} уже радует на льду. Расскажите, как вам покупка — пара слов и оценка очень помогут другим фигуристам с выбором:\n\n${products.map(p => `${p.name}: ${SITE_ORIGIN}/product/${p.id}#reviews`).join('\n')}\n\nЕсли что-то не так — просто ответьте на это письмо, разберёмся.\n\nНе хотите получать такие письма? Отписаться: ${unsubscribeUrl(user)}`,
    }).catch(err => console.error('Не удалось отправить просьбу об отзыве:', err.message));
  }
  writeStore(store);
  return sent;
}
setInterval(() => {
  try { sendCartReminders(); } catch (e) { console.error('Напоминания о корзине:', e.message); }
  try { sendReviewRequests(); } catch (e) { console.error('Просьбы об отзыве:', e.message); }
}, 15 * 60 * 1000).unref();
// Lets the smoke tests run the reminder job at a chosen moment instead of waiting hours.
if (process.env.NODE_ENV === 'test') {
  app.post('/api/test/run-reminders', (req, res) => {
    const at = Date.now() + Number((req.body || {}).shiftMs || 0);
    res.json({ cart: sendCartReminders(at), reviews: sendReviewRequests(at) });
  });
}
setTimeout(runDailyBackup, 60 * 1000);

app.get('/api/admin/backups', requireSuperAdmin, (req, res) => {
  res.json({
    backups: listBackups().map(name => ({ name, size: fs.statSync(path.join(BACKUPS_DIR, name)).size })),
    email: BACKUP_EMAIL && mailTransport ? BACKUP_EMAIL : null,
  });
});

/* ===== Restore from a backup (moving servers, undoing a mistake) ===== */
// Accepts the zip from «Резервная копия» (store.json + uploads/) or a nightly store-*.zip.
// Only store.json and flat uploads/<file> entries are used — nothing can be written outside
// DATA_DIR. The current store is kept as store.before-restore-<time>.json.
const restoreUpload = multer({ dest: os.tmpdir(), limits: { fileSize: 500 * 1024 * 1024 } });
app.post('/api/admin/restore', requireSuperAdmin, restoreUpload.single('backup'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Выберите файл резервной копии (.zip)' });
  try {
    let zip;
    try { zip = new AdmZip(req.file.path); } catch (e) { return res.status(400).json({ error: 'Это не zip-архив резервной копии' }); }
    const entries = zip.getEntries();
    const storeEntry = entries.find(e => e.entryName === 'store.json');
    if (!storeEntry) return res.status(400).json({ error: 'В архиве нет store.json — это не резервная копия сайта' });
    let restored;
    try { restored = JSON.parse(storeEntry.getData().toString('utf8')); } catch (e) { return res.status(400).json({ error: 'store.json в архиве повреждён' }); }
    if (!restored || !Array.isArray(restored.products) || typeof restored.categories !== 'object' || !Array.isArray(restored.admins) || !restored.admins.length) {
      return res.status(400).json({ error: 'store.json в архиве не похож на базу сайта' });
    }
    const photos = entries.filter(e => !e.isDirectory && /^uploads\/[A-Za-z0-9._-]+$/.test(e.entryName) && !e.entryName.includes('..'));
    fs.copyFileSync(DATA_FILE, path.join(DATA_DIR, `store.before-restore-${Date.now()}.json`));
    photos.forEach(e => fs.writeFileSync(path.join(UPLOADS_DIR, path.basename(e.entryName)), e.getData()));
    normalizeStore(restored);
    writeStore(restored);
    console.log(`Восстановлено из копии: товаров ${restored.products.length}, заказов ${restored.orders.length}, фото ${photos.length}`);
    res.json({ ok: true, products: restored.products.length, orders: restored.orders.length, users: restored.users.length, photos: photos.length });
  } finally {
    fs.rm(req.file.path, { force: true }, () => {});
  }
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

// "С этим покупают": ids picked in the admin (JSON array); unknown ids are dropped on save.
function parseRelated(raw) {
  let ids = [];
  try { ids = JSON.parse(raw || '[]'); } catch (e) { ids = []; }
  ids = Array.isArray(ids) ? [...new Set(ids.filter(x => typeof x === 'string'))].slice(0, 8) : [];
  return ids.length ? ids : undefined;
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
    quantity: normQuantity(body.quantity),
    sizes: parseSizes(body.sizes).length ? parseSizes(body.sizes) : undefined,
    related: parseRelated(body.related),
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
    : !data.name ? 'Название обязательно' : Number.isNaN(data.quantity) ? 'Остаток — целое число от 0' : null;
  if (invalid) { uploads.discard(); return res.status(400).json({ error: invalid }); }

  let id = slugify(data.name);
  if (store.products.some(p => p.id === id)) id = id + '-' + Date.now().toString(36);
  if (data.related) data.related = data.related.filter(r => store.products.some(p => p.id === r));
  if (data.related && !data.related.length) delete data.related;

  const product = { id, ...data };
  if (!product.color) delete product.color;
  if (!product.size) delete product.size;
  if (product.quantity === undefined) delete product.quantity;
  syncStockWithQuantity(product);
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
  if (Number.isNaN(data.quantity)) { uploads.discard(); return res.status(400).json({ error: 'Остаток — целое число от 0' }); }

  const existing = store.products[idx];
  if (data.related) data.related = data.related.filter(r => r !== existing.id && store.products.some(p => p.id === r));
  if (data.related && !data.related.length) data.related = undefined;
  const updated = { ...existing, ...data };
  if (!data.color) delete updated.color;
  if (!data.size) delete updated.size;
  if (data.quantity === undefined) { delete updated.quantity; delete updated.lowStockAlerted; }
  syncStockWithQuantity(updated);

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
  const restockDue = takeRestockSubs(store, [[existing, updated]]);
  writeStore(store);
  sendRestockEmails(restockDue);
  res.json(updated);
});

app.patch('/api/admin/products/:id', requireAdmin, (req, res) => {
  const store = readStore();
  const idx = store.products.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Товар не найден' });
  const { hidden, discountPercent, stock, quantity } = req.body || {};
  const before = { ...store.products[idx] };
  if (quantity !== undefined) {
    const q = normQuantity(quantity);
    if (Number.isNaN(q)) return res.status(400).json({ error: 'Остаток — целое число от 0' });
    if (q === undefined) { delete store.products[idx].quantity; delete store.products[idx].lowStockAlerted; } else store.products[idx].quantity = q;
  }
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
  syncStockWithQuantity(store.products[idx]);
  const restockDue = takeRestockSubs(store, [[before, store.products[idx]]]);
  writeStore(store);
  sendRestockEmails(restockDue);
  res.json(store.products[idx]);
});

app.post('/api/admin/products/bulk', requireAdmin, (req, res) => {
  const { ids, hidden, discountPercent, stock } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'Не выбраны товары' });
  const store = readStore();
  let count = 0;
  const pairs = [];
  store.products.forEach(p => {
    if (!ids.includes(p.id)) return;
    count++;
    pairs.push([{ ...p }, p]);
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
  const restockDue = takeRestockSubs(store, pairs);
  writeStore(store);
  sendRestockEmails(restockDue);
  res.json({ ok: true, count });
});

/* ===== Catalog in Excel: export and import =====
   CSV with «;» and a UTF-8 BOM, so Russian Excel opens it straight away with columns and
   Cyrillic intact. Import only updates products that already exist (matched by ID): price,
   discount, stock quantity, availability, visibility and size options. Excel may save the
   file back in Windows-1251 and with «,» or tabs — both are understood. */
const STOCK_WORDS = { '': 'в наличии', order: 'под заказ', out: 'нет в наличии' };
const CATALOG_COLUMNS = ['ID', 'Название', 'Категория', 'Цена', 'Скидка, %', 'Остаток', 'Наличие', 'Скрыт', 'Размеры'];
function csvCell(v) {
  let str = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(str)) str = "'" + str;
  return '"' + str.replace(/"/g, '""') + '"';
}
app.get('/api/admin/products/export.csv', requireAdmin, (req, res) => {
  const store = readStore();
  const rows = store.products.map(p => [
    p.id, p.name, store.categories[p.cat] || p.cat, p.price, p.discountPercent || 0,
    p.quantity === undefined ? '' : p.quantity, STOCK_WORDS[p.stock || ''], p.hidden ? 'да' : 'нет', (p.sizes || []).join(', '),
  ]);
  const csv = '\ufeff' + [CATALOG_COLUMNS, ...rows].map(r => r.map(csvCell).join(';')).join('\r\n');
  res.attachment(`two-boots-catalog-${new Date().toISOString().slice(0, 10)}.csv`);
  res.type('text/csv; charset=utf-8').send(csv);
});

function decodeSpreadsheet(buf) {
  let text = buf.toString('utf8');
  if (text.includes('\ufffd')) text = new TextDecoder('windows-1251').decode(buf);
  return text.replace(/^\ufeff/, '');
}
function parseCsv(text) {
  const firstLine = text.split(/\r?\n/, 1)[0];
  const delim = [';', '\t', ','].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}
const yes = v => /^(да|yes|1|true|скрыт)$/i.test(String(v).trim());
const catalogUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

app.post('/api/admin/products/import', requireAdmin, catalogUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Выберите файл .csv' });
  const rows = parseCsv(decodeSpreadsheet(req.file.buffer));
  if (rows.length < 2) return res.status(400).json({ error: 'В файле нет строк с товарами' });
  // headers are matched loosely: «Скидка, %», «скидка %» and «Скидка» are the same column
  const key = h => String(h).toLowerCase().replace(/[^a-zа-яё0-9]/g, '');
  const head = rows[0].map(key);
  const col = name => head.indexOf(key(name));
  if (col('ID') === -1) return res.status(400).json({ error: 'Нет столбца «ID» — выгрузите каталог кнопкой «Скачать» и правьте этот файл' });
  const dryRun = req.query.dryRun === '1';
  const store = readStore();
  const changes = [], errors = [], pairs = [];
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const get = name => { const c = col(name); return c === -1 ? undefined : String(r[c] == null ? '' : r[c]).trim().replace(/^'/, ''); };
    const id = get('ID');
    const p = store.products.find(x => x.id === id);
    if (!p) { errors.push(`Строка ${line}: товар с ID «${id}» не найден`); return; }
    const before = { ...p };
    const diff = [];
    const num = v => Number(String(v).replace(/\s/g, '').replace(',', '.'));
    const price = get('Цена');
    if (price !== undefined && price !== '') {
      const n = Math.round(num(price));
      if (!(n >= 0)) { errors.push(`Строка ${line}: цена «${price}» — не число`); return; }
      if (n !== p.price) { diff.push(`цена ${p.price} → ${n}`); p.price = n; }
    }
    const disc = get('Скидка, %');
    if (disc !== undefined) {
      const n = disc === '' ? 0 : Math.round(num(disc));
      if (!(n >= 0 && n <= 95)) { errors.push(`Строка ${line}: скидка «${disc}» — от 0 до 95`); return; }
      if (n !== (p.discountPercent || 0)) { diff.push(`скидка ${p.discountPercent || 0}% → ${n}%`); if (n) p.discountPercent = n; else delete p.discountPercent; }
    }
    const stockWord = get('Наличие');
    if (stockWord !== undefined) {
      const key = Object.keys(STOCK_WORDS).find(k => STOCK_WORDS[k] === stockWord.toLowerCase()) ?? (stockWord === '' ? '' : null);
      if (key === null) { errors.push(`Строка ${line}: наличие «${stockWord}» — пишите «в наличии», «под заказ» или «нет в наличии»`); return; }
      if (key !== (p.stock || '')) { diff.push(`наличие: ${STOCK_WORDS[key]}`); if (key) p.stock = key; else delete p.stock; }
    }
    const qty = get('Остаток');
    if (qty !== undefined) {
      const q = normQuantity(qty);
      if (Number.isNaN(q)) { errors.push(`Строка ${line}: остаток «${qty}» — целое число от 0 или пусто`); return; }
      if (q !== p.quantity) { diff.push(`остаток ${p.quantity ?? '—'} → ${q ?? '—'}`); if (q === undefined) { delete p.quantity; delete p.lowStockAlerted; } else p.quantity = q; }
    }
    const hidden = get('Скрыт');
    if (hidden !== undefined && yes(hidden) !== !!p.hidden) { diff.push(yes(hidden) ? 'скрыт' : 'показан'); if (yes(hidden)) p.hidden = true; else delete p.hidden; }
    const sizes = get('Размеры');
    if (sizes !== undefined) {
      const list = parseSizes(sizes);
      if (list.join('|') !== (p.sizes || []).join('|')) { diff.push(`размеры: ${list.join(', ') || 'нет'}`); if (list.length) p.sizes = list; else delete p.sizes; }
    }
    syncStockWithQuantity(p);
    if (diff.length) { changes.push({ id, name: p.name, changes: diff }); pairs.push([before, p]); }
  });
  if (!dryRun && changes.length) {
    const restockDue = takeRestockSubs(store, pairs);
    writeStore(store);
    sendRestockEmails(restockDue);
  }
  res.json({ dryRun, changes, errors, products: store.products.length });
});

/* ===== Printable order ===== */
app.get('/admin/orders/:id/print', requireAdmin, (req, res) => {
  const store = readStore();
  const o = store.orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).send('Заказ не найден');
  const user = o.userId && store.users.find(u => u.id === o.userId);
  const money = n => (n || 0).toLocaleString('ru-RU') + ' ₽';
  const date = new Date(o.createdAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const where = [o.city, o.address].filter(Boolean).join(', ');
  const row = (k, v) => v ? `<tr><th>${k}</th><td>${escHtml(v)}</td></tr>` : '';
  res.set('Cache-Control', 'no-store').type('html').send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Заказ №${o.number} — Two Boots</title>
<style>
  body{font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#111;margin:28px;font-size:14px;}
  h1{font-size:22px;margin:0 0 4px;} .muted{color:#555;}
  .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:16px;}
  table{border-collapse:collapse;width:100%;margin-bottom:16px;}
  .info th{text-align:left;width:150px;font-weight:600;color:#444;vertical-align:top;padding:3px 8px 3px 0;}
  .info td{padding:3px 0;}
  .items th,.items td{border:1px solid #999;padding:6px 8px;text-align:left;}
  .items th{background:#eee;} .r{text-align:right!important;white-space:nowrap;}
  .total td{font-weight:700;font-size:16px;}
  .checks{display:flex;gap:28px;margin-top:22px;font-size:15px;} .checks span::before{content:'';display:inline-block;width:14px;height:14px;border:1.5px solid #111;margin-right:8px;vertical-align:-2px;}
  .no-print{margin-bottom:16px;} @media print{.no-print{display:none;} body{margin:12mm;}}
</style></head><body>
<div class="no-print"><button onclick="print()">Печать</button></div>
<div class="head"><div><h1>Заказ №${o.number}</h1><div class="muted">${date}${o.quick ? ' · заказ в 1 клик' : ''}</div></div>
<div style="text-align:right;"><b>Two Boots</b><br>www.two-boots.ru<br>+7 (926) 349-75-86</div></div>
<table class="info">
${row('Покупатель', o.name)}${row('Телефон', o.phone)}${row('Email', o.email || (user && user.email))}
${row('Доставка', o.delivery ? deliveryLabel(o) + (o.deliveryPrice ? ' · ' + o.deliveryPrice : '') : '')}${row('Адрес', where)}
${row('Трек-номер', o.trackNumber)}${row('Комментарий покупателя', o.customerComment)}${row('Заметка менеджера', o.comment)}
</table>
<table class="items"><thead><tr><th>#</th><th>Товар</th><th>Размер</th><th class="r">Кол-во</th><th class="r">Цена</th><th class="r">Сумма</th></tr></thead><tbody>
${o.items.map((it, i) => `<tr><td>${i + 1}</td><td>${escHtml(it.name)}</td><td>${escHtml(it.size || '—')}</td><td class="r">${it.qty}</td><td class="r">${money(it.price)}</td><td class="r">${money(it.price * it.qty)}</td></tr>`).join('')}
${o.promo ? `<tr><td colspan="5">Промокод ${escHtml(o.promo.code)}</td><td class="r">−${money(o.promo.discount)}</td></tr>` : ''}
${o.deliveryCost ? `<tr><td colspan="5">Доставка</td><td class="r">${money(o.deliveryCost)}</td></tr>` : ''}
<tr class="total"><td colspan="5">Итого</td><td class="r">${money(o.total)}</td></tr>
</tbody></table>
<div class="checks"><span>Собран</span><span>Проверен</span><span>Упакован</span><span>Отправлен</span></div>
<script>window.addEventListener('load', () => setTimeout(() => print(), 300));</script>
</body></html>`);
});

app.delete('/api/admin/products/:id', requireAdmin, (req, res) => {
  const store = readStore();
  const idx = store.products.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Товар не найден' });
  const [removed] = store.products.splice(idx, 1);
  [removed.img, ...(removed.images || [])].forEach(removeUpload);
  store.restockSubs = store.restockSubs.filter(sub => sub.productId !== removed.id);
  writeStore(store);
  res.json({ ok: true });
});

/* ===== SPA fallback with per-page SEO tags ===== */
// Page content is rendered in the browser, but crawlers and link previews read the raw
// HTML — so the title, description, canonical, og:* tags and Schema.org data are filled
// in here. Titles mirror the setMeta() calls in index.html; keep the two in sync.
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
// Fingerprint of the storefront page this server ships. The page carries it in <meta name="build">
// and polls /api/version: a tab left open across a deploy notices it's stale and reloads, instead
// of sending the new server requests in an old format (e.g. a sign-up without the consent flag).
const BUILD_ID = crypto.createHash('sha1').update(INDEX_HTML).digest('hex').slice(0, 12);
app.get('/api/version', (req, res) => res.set('Cache-Control', 'no-store').json({ build: BUILD_ID }));
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
  if (pathname === '/favorites') return { title: 'Избранное — Two Boots', url, noindex: true };
  if (pathname === '/blog') {
    const list = publishedArticles(store.articles);
    if (!list.length) return { status: 404, title: 'Страница не найдена — Two Boots', url };
    return {
      title: 'Статьи — Two Boots', url,
      description: 'Советы для фигуристов и родителей: как выбрать и ухаживать за экипировкой, что взять на тренировки и соревнования.',
      bodyHtml: `<section class="block"><div class="wrap"><h1>Статьи</h1><ul>${list.map(a => `<li><a href="/blog/${escHtml(a.slug)}">${escHtml(a.title)}</a> — ${escHtml(a.description)}</li>`).join('')}</ul></div></section>`,
    };
  }
  const articleMatch = pathname.match(/^\/blog\/([^/]+)$/);
  if (articleMatch) {
    const a = publishedArticles(store.articles).find(x => x.slug === articleMatch[1]);
    if (!a) return { status: 404, title: 'Статья не найдена — Two Boots', url };
    const image = absoluteImageUrl(a.cover);
    return {
      title: `${a.title} — Two Boots`, description: a.description, url, image,
      // crawlers get the article text in the raw HTML; the SPA re-renders the same content
      bodyHtml: `<article class="block"><div class="wrap doc-page"><h1>${escHtml(a.title)}</h1>${renderArticleBody(a.body)}</div></article>`,
      jsonLd: [{
        '@context': 'https://schema.org', '@type': 'BlogPosting',
        headline: a.title, description: a.description, url,
        datePublished: (a.publishedAt || a.createdAt).slice(0, 10), dateModified: a.updatedAt.slice(0, 10),
        ...(image ? { image: [image] } : {}),
        author: { '@type': 'Organization', name: 'Two Boots', url: SITE_ORIGIN + '/' },
        publisher: { '@type': 'Organization', name: 'Two Boots', url: SITE_ORIGIN + '/' },
        mainEntityOfPage: url,
      }],
    };
  }
  if (pathname === '/delivery') {
    return { title: 'Доставка и оплата — Two Boots', url,
      description: 'Доставка СДЭК, Почтой России, Яндекс Доставкой, в пункты Ozon и Wildberries, Авито Доставкой, курьером по Москве и самовывоз. Оплата переводом, по СБП или при получении. Условия возврата.' };
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
  extra += `<meta name="build" content="${BUILD_ID}">\n`;
  html = html.replace('</head>', () => extra + '</head>');
  if (seo.bodyHtml) html = html.replace('<main id="app"></main>', () => `<main id="app">${seo.bodyHtml}</main>`);
  return html;
}

app.get('*', (req, res) => {
  const seo = pageSeo(req.path, req.query);
  // no-cache: the browser may keep a copy but must check with the server before using it
  res.status(seo.status || 200).set('Cache-Control', 'no-cache').type('html').send(renderIndex(seo));
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
  const defaultPwdAdmins = readStore().admins.filter(a => verifyPassword(DEFAULT_ADMIN_PASSWORD, a.passwordHash));
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
