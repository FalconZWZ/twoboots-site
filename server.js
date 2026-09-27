const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const nodemailer = require('nodemailer');

const app = express();
const port = process.env.PORT || 3000;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data-runtime');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
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

function sendOrderConfirmationEmail(order, user) {
  if (!mailTransport) return;
  const itemsList = order.items.map(it => `${it.name}${it.size ? ' (' + it.size + ')' : ''} — ${it.qty} шт. × ${it.price.toLocaleString('ru-RU')} ₽`).join('\n');
  const itemsHtml = order.items.map(it => `<tr><td style="padding:4px 8px;">${it.name}${it.size ? ' (' + it.size + ')' : ''}</td><td style="padding:4px 8px;">${it.qty}</td><td style="padding:4px 8px;">${it.price.toLocaleString('ru-RU')} ₽</td></tr>`).join('');
  mailTransport.sendMail({
    from: MAIL_FROM,
    to: user.email,
    subject: `Заказ №${order.number} принят — Two Boots`,
    text: `Спасибо за заказ №${order.number}!\n\nВ ближайшее время с вами свяжется менеджер.\n\nСостав заказа:\n${itemsList}\n\nИтого: ${order.total.toLocaleString('ru-RU')} ₽`,
    html: `<p>Спасибо за заказ <b>№${order.number}</b>!</p><p>В ближайшее время с вами свяжется менеджер.</p>
      <table style="border-collapse:collapse;">${itemsHtml}</table>
      <p><b>Итого: ${order.total.toLocaleString('ru-RU')} ₽</b></p>`,
  }).catch(err => console.error('Не удалось отправить письмо с подтверждением заказа:', err.message));
}

const OWNER_EMAIL = process.env.OWNER_EMAIL || 'dmitry-sokol@mail.ru';
const OWNER_PHONE = process.env.OWNER_PHONE || '79263497586';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const WHATSAPP_CALLMEBOT_APIKEY = process.env.WHATSAPP_CALLMEBOT_APIKEY || '';

function orderNotifyText(order) {
  const itemsList = order.items.map(it => `${it.name}${it.size ? ' (' + it.size + ')' : ''} — ${it.qty} шт. × ${it.price.toLocaleString('ru-RU')} ₽`).join('\n');
  return `Новый заказ №${order.number}${order.quick ? ' (в 1 клик)' : ''}\nИмя: ${order.name}\nТелефон: ${order.phone}\n\n${itemsList}\n\nИтого: ${order.total.toLocaleString('ru-RU')} ₽`;
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

  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
    }).then(r => { if (!r.ok) return r.text().then(t => { throw new Error(t); }); })
      .catch(err => console.error('Не удалось отправить уведомление в Telegram:', err.message));
  }

  if (WHATSAPP_CALLMEBOT_APIKEY) {
    const url = `https://api.callmebot.com/whatsapp.php?phone=${OWNER_PHONE}&text=${encodeURIComponent(text)}&apikey=${WHATSAPP_CALLMEBOT_APIKEY}`;
    fetch(url).catch(err => console.error('Не удалось отправить уведомление в WhatsApp:', err.message));
  }
}

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
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
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Только изображения'));
  },
});

app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(__dirname));

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
  return { id: u.id, email: u.email, name: u.name, phone: u.phone, city: u.city, address: u.address };
}

/* ===== Public data API ===== */
app.get('/api/data', (req, res) => {
  const { categories, products } = readStore();
  res.json({ categories, products: products.filter(p => !p.hidden) });
});

/* ===== Auth ===== */
app.post('/admin/login', (req, res) => {
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

app.post('/api/register', (req, res) => {
  const { email, password, name, phone, city, address } = req.body || {};
  if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Укажите корректный email' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'Укажите ФИО' });
  if (!phone || !phone.trim()) return res.status(400).json({ error: 'Укажите номер телефона' });
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
    createdAt: new Date().toISOString(),
  };
  store.users.push(user);
  writeStore(store);
  req.session.userId = user.id;
  res.json({ user: safeUser(user) });
});

app.post('/api/login', (req, res) => {
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

/* ===== Orders ===== */
app.get('/api/orders', requireUser, (req, res) => {
  const store = readStore();
  const orders = store.orders
    .filter(o => o.userId === req.session.userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ orders });
});

app.post('/api/orders', requireUser, (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Корзина пуста' });
  const store = readStore();
  const user = store.users.find(u => u.id === req.session.userId);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  if (!user.name || !user.name.trim() || !user.phone || !user.phone.trim() || !user.email) {
    return res.status(400).json({ error: 'Заполните имя, телефон и email в профиле, чтобы оформить заказ' });
  }

  const lines = [];
  let total = 0;
  for (const item of items) {
    const product = store.products.find(p => p.id === item.id);
    if (!product) continue;
    const qty = Math.max(1, Math.min(99, Number(item.qty) || 1));
    const unitPrice = product.discountPercent
      ? Math.round(product.price * (1 - product.discountPercent / 100))
      : product.price;
    lines.push({ id: product.id, name: product.name, size: item.size || null, price: unitPrice, qty });
    total += unitPrice * qty;
  }
  if (lines.length === 0) return res.status(400).json({ error: 'Товары не найдены' });

  store.orderSeq = (store.orderSeq || 0) + 1;
  const order = {
    id: crypto.randomUUID(),
    number: store.orderSeq,
    userId: user.id,
    items: lines,
    total,
    status: 'new',
    name: user.name, phone: user.phone, email: user.email, city: user.city, address: user.address,
    createdAt: new Date().toISOString(),
  };
  store.orders.push(order);
  writeStore(store);
  sendOrderConfirmationEmail(order, user);
  notifyOwnerNewOrder(order);
  res.json({ order });
});

/* ===== Quick order (buy in one click, no account needed) ===== */
app.post('/api/quick-order', (req, res) => {
  const { productId, qty, name, phone } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Укажите имя' });
  if (!phone || !phone.trim()) return res.status(400).json({ error: 'Укажите номер телефона' });
  const store = readStore();
  const product = store.products.find(p => p.id === productId && !p.hidden);
  if (!product) return res.status(404).json({ error: 'Товар не найден' });

  const qtyNum = Math.max(1, Math.min(99, Number(qty) || 1));
  const unitPrice = product.discountPercent
    ? Math.round(product.price * (1 - product.discountPercent / 100))
    : product.price;
  const total = unitPrice * qtyNum;

  store.orderSeq = (store.orderSeq || 0) + 1;
  const order = {
    id: crypto.randomUUID(),
    number: store.orderSeq,
    userId: null,
    quick: true,
    items: [{ id: product.id, name: product.name, size: null, price: unitPrice, qty: qtyNum }],
    total,
    status: 'new',
    name: name.trim(), phone: phone.trim(), email: null, city: '', address: '',
    createdAt: new Date().toISOString(),
  };
  store.orders.push(order);
  writeStore(store);
  notifyOwnerNewOrder(order);
  res.json({ order });
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
  const { status } = req.body || {};
  if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ error: 'Некорректный статус' });
  const store = readStore();
  const order = store.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Заказ не найден' });
  order.status = status;
  writeStore(store);
  res.json({ order });
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
    hidden: body.hidden === 'true' || body.hidden === true || undefined,
  };
}

app.post('/api/admin/products', requireAdmin, upload.single('image'), (req, res) => {
  const store = readStore();
  const data = parseProductBody(req.body);
  if (!data.cat || !store.categories[data.cat]) return res.status(400).json({ error: 'Укажите существующую категорию' });
  if (!data.name) return res.status(400).json({ error: 'Название обязательно' });

  let id = slugify(data.name);
  if (store.products.some(p => p.id === id)) id = id + '-' + Date.now().toString(36);

  const product = { id, ...data };
  if (!product.color) delete product.color;
  if (!product.size) delete product.size;
  if (req.file) product.img = '/uploads/' + req.file.filename;

  store.products.push(product);
  writeStore(store);
  res.json(product);
});

app.put('/api/admin/products/:id', requireAdmin, upload.single('image'), (req, res) => {
  const store = readStore();
  const idx = store.products.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Товар не найден' });
  const data = parseProductBody(req.body);
  if (!data.cat || !store.categories[data.cat]) return res.status(400).json({ error: 'Укажите существующую категорию' });

  const existing = store.products[idx];
  const updated = { ...existing, ...data };
  if (!data.color) delete updated.color;
  if (!data.size) delete updated.size;

  if (req.file) {
    if (existing.img && existing.img.startsWith('/uploads/')) {
      const oldPath = path.join(UPLOADS_DIR, path.basename(existing.img));
      fs.unlink(oldPath, () => {});
    }
    updated.img = '/uploads/' + req.file.filename;
  }

  store.products[idx] = updated;
  writeStore(store);
  res.json(updated);
});

app.patch('/api/admin/products/:id', requireAdmin, (req, res) => {
  const store = readStore();
  const idx = store.products.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Товар не найден' });
  const { hidden, discountPercent } = req.body || {};
  if (hidden !== undefined) {
    if (hidden) store.products[idx].hidden = true;
    else delete store.products[idx].hidden;
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
  const { ids, hidden, discountPercent } = req.body || {};
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
  });
  writeStore(store);
  res.json({ ok: true, count });
});

app.delete('/api/admin/products/:id', requireAdmin, (req, res) => {
  const store = readStore();
  const idx = store.products.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Товар не найден' });
  const [removed] = store.products.splice(idx, 1);
  if (removed.img && removed.img.startsWith('/uploads/')) {
    fs.unlink(path.join(UPLOADS_DIR, path.basename(removed.img)), () => {});
  }
  writeStore(store);
  res.json({ ok: true });
});

/* ===== SPA fallback ===== */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => {
  console.log(`Two Boots site running on port ${port}`);
  console.log(`Data dir: ${DATA_DIR}`);
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
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
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
