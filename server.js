const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');

const app = express();
const port = process.env.PORT || 3000;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data-runtime');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const SEED_FILE = path.join(__dirname, 'data', 'seed.json');

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'two-boots-dev-secret-change-me';

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

// Migrate/seed the admin list from env vars if the store has none yet
// (fresh install, or an older store.json created before multi-admin support).
{
  const store = readStore();
  if (!store.admins || store.admins.length === 0) {
    store.admins = [{ username: ADMIN_USER, passwordHash: hashPassword(ADMIN_PASSWORD) }];
    writeStore(store);
  }
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

/* ===== Public data API ===== */
app.get('/api/data', (req, res) => {
  const { categories, products } = readStore();
  res.json({ categories, products });
});

/* ===== Auth ===== */
app.post('/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  const store = readStore();
  const admin = (store.admins || []).find(a => a.username === username);
  if (admin && verifyPassword(password || '', admin.passwordHash)) {
    req.session.isAdmin = true;
    req.session.username = username;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Неверный логин или пароль' });
});
app.post('/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});
app.get('/admin/session', (req, res) => {
  res.json({ loggedIn: !!(req.session && req.session.isAdmin), username: req.session && req.session.username });
});
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

/* ===== Admin: manage admin accounts ===== */
app.get('/api/admin/admins', requireAdmin, (req, res) => {
  const store = readStore();
  res.json({ admins: store.admins.map(a => a.username), me: req.session.username });
});
app.post('/api/admin/admins', requireAdmin, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Логин и пароль обязательны' });
  if (password.length < 6) return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });
  const store = readStore();
  if (store.admins.some(a => a.username === username)) return res.status(400).json({ error: 'Такой логин уже существует' });
  store.admins.push({ username, passwordHash: hashPassword(password) });
  writeStore(store);
  res.json({ admins: store.admins.map(a => a.username) });
});
app.put('/api/admin/admins/:username/password', requireAdmin, (req, res) => {
  const store = readStore();
  const { username } = req.params;
  const { password } = req.body || {};
  if (!password || password.length < 6) return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });
  const admin = store.admins.find(a => a.username === username);
  if (!admin) return res.status(404).json({ error: 'Администратор не найден' });
  admin.passwordHash = hashPassword(password);
  writeStore(store);
  res.json({ ok: true });
});
app.delete('/api/admin/admins/:username', requireAdmin, (req, res) => {
  const store = readStore();
  const { username } = req.params;
  if (store.admins.length <= 1) return res.status(400).json({ error: 'Нельзя удалить последнего администратора' });
  const idx = store.admins.findIndex(a => a.username === username);
  if (idx === -1) return res.status(404).json({ error: 'Администратор не найден' });
  store.admins.splice(idx, 1);
  writeStore(store);
  if (req.session.username === username) {
    req.session.destroy(() => res.json({ ok: true, selfDeleted: true }));
  } else {
    res.json({ ok: true });
  }
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
  return {
    cat: body.cat,
    name: body.name,
    price: Number(body.price) || 0,
    desc: body.desc || '',
    color: body.color || undefined,
    size: body.size || undefined,
    specs,
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
});
