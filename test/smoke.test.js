// Smoke tests: start the real server on a throwaway data dir and walk through the flows
// customers and admins rely on. Run with `npm test`; CI runs them on every push and PR.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 3900 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
let dataDir;

// Minimal cookie-keeping client: one per "browser".
function client() {
  let cookie = '';
  return async function request(url, { method = 'GET', body, form } = {}) {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(BASE + url, { method, headers, body: payload, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  };
}

// The factory admin password has to be replaced on first login; later logins use the new one.
const ADMIN_PASSWORD = 'test-admin-pass-1';
async function adminClient() {
  const admin = client();
  let r = await admin('/admin/login', { method: 'POST', body: { username: 'admin', password: ADMIN_PASSWORD } });
  if (r.status === 401) {
    r = await admin('/admin/login', { method: 'POST', body: { username: 'admin', password: 'changeme123' } });
    assert.equal(r.status, 200);
    assert.equal((await admin('/api/admin/admins/admin/password', { method: 'PUT', body: { password: ADMIN_PASSWORD } })).status, 200);
  }
  return admin;
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twoboots-test-'));
  const env = { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, SESSION_SECRET: 'test-secret' };
  for (const k of ['SMTP_HOST', 'BOTORDER_URL', 'TELEGRAM_BOT_TOKEN', 'WHATSAPP_CALLMEBOT_APIKEY']) delete env[k];
  server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + '/robots.txt')).ok) return; } catch (e) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Server did not start:\n' + log);
});

after(() => {
  if (server) server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('inline scripts in the pages parse', () => {
  for (const file of ['index.html', 'admin.html']) {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    assert.ok(scripts.length > 0, `${file} has inline scripts`);
    scripts.forEach(code => new Function(code)); // throws on a syntax error
  }
});

test('pages render with per-page SEO and real 404s', async () => {
  const req = client();
  const home = await req('/');
  assert.equal(home.status, 200);
  assert.match(home.data, /<title>Two Boots — экипировка для фигурного катания<\/title>/);
  const product = await req('/product/dry-glide');
  assert.equal(product.status, 200);
  assert.match(product.data, /<title>Чехлы-сушилки Dry Glide — Two Boots<\/title>/);
  const ld = JSON.parse(product.data.match(/<script type="application\/ld\+json">(.*?)<\/script>/)[1]);
  assert.equal(ld[0]['@type'], 'Product');
  for (const url of ['/catalog', '/catalog?cat=bags', '/about', '/contact', '/delivery', '/privacy', '/consent', '/account']) {
    assert.equal((await req(url)).status, 200, url);
  }
  for (const url of ['/product/nope', '/no-such-page', '/index.html']) {
    const r = await req(url);
    assert.equal(r.status, 404, url);
    assert.match(r.data, /name="robots" content="noindex"/);
  }
});

test('pages are revalidated and carry the build id the version endpoint reports', async () => {
  const req = client();
  const page = await req('/catalog');
  assert.equal(page.headers.get('cache-control'), 'no-cache');
  const build = page.data.match(/<meta name="build" content="([0-9a-f]+)">/)[1];
  assert.equal((await req('/api/version')).data.build, build);
});

test('public files are served, private files are not', async () => {
  const req = client();
  for (const url of ['/robots.txt', '/sitemap.xml', '/yml.xml', '/favicon.svg', '/images/two-boots-s-black.jpg']) {
    assert.equal((await req(url)).status, 200, url);
  }
  for (const url of ['/server.js', '/package.json', '/data/seed.json', '/README.md', '/.git/config', '/admin.html']) {
    assert.equal((await req(url)).status, 404, url);
  }
  const yml = (await req('/yml.xml')).data;
  assert.match(yml, /^<\?xml/);
  assert.ok((yml.match(/<offer /g) || []).length > 10);
});

test('health check reports the store', async () => {
  const { status, data } = await client()('/health');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(data.products >= 19);
});

test('catalog API lists visible products', async () => {
  const { status, data } = await client()('/api/data');
  assert.equal(status, 200);
  assert.ok(Object.keys(data.categories).length >= 4);
  assert.ok(data.products.length >= 19);
});

test('customer: register, order with delivery, see it, cancel it', async () => {
  const req = client();
  const noConsent = await req('/api/register', { method: 'POST', body: { name: 'Тест', email: 'buyer@test.ru', password: 'secret1', phone: '+7900' } });
  assert.equal(noConsent.status, 400);
  const reg = await req('/api/register', { method: 'POST', body: { name: 'Тест', email: 'buyer@test.ru', password: 'secret1', phone: '+7900', consent: true } });
  assert.equal(reg.status, 200);

  const noSize = await req('/api/orders', { method: 'POST', body: { items: [{ id: 'street-guard', qty: 1 }], delivery: 'pickup' } });
  assert.equal(noSize.status, 400, 'a product with size options needs a size');
  const noDelivery = await req('/api/orders', { method: 'POST', body: { items: [{ id: 'dry-glide', qty: 1 }], city: 'Казань', address: 'ул. Баумана 1' } });
  assert.equal(noDelivery.status, 400);
  assert.equal(noDelivery.data.error, 'Выберите способ доставки');

  const order = await req('/api/orders', { method: 'POST', body: {
    items: [{ id: 'dry-glide', qty: 2, price: 1 }, { id: 'street-guard', qty: 1, size: 'M' }],
    delivery: 'cdek', city: 'Казань', address: 'ПВЗ, ул. Баумана 1', comment: 'после 18:00',
  } });
  assert.equal(order.status, 200, JSON.stringify(order.data));
  assert.equal(order.data.order.number, 1);
  assert.equal(order.data.order.total, 1490 * 2 + 1290, 'server prices, client price ignored');
  assert.equal(order.data.order.items[1].size, 'M');

  const mine = await req('/api/orders');
  assert.equal(mine.data.orders.length, 1);
  const cancel = await req(`/api/orders/${order.data.order.id}/cancel`, { method: 'PATCH' });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.data.order.status, 'cancelled');

  await req('/api/logout', { method: 'POST' });
  assert.equal((await req('/api/login', { method: 'POST', body: { email: 'buyer@test.ru', password: 'wrong' } })).status, 401);
  assert.equal((await req('/api/login', { method: 'POST', body: { email: 'BUYER@test.ru', password: 'secret1' } })).status, 200);
});

test('quick order needs consent and gets the next number', async () => {
  const req = client();
  assert.equal((await req('/api/quick-order', { method: 'POST', body: { productId: 'grip-lace', name: 'Катя', phone: '+7911' } })).status, 400);
  const r = await req('/api/quick-order', { method: 'POST', body: { productId: 'grip-lace', name: 'Катя', phone: '+7911', consent: true, qty: 3 } });
  assert.equal(r.status, 200);
  assert.equal(r.data.order.total, 390 * 3);
  assert.equal(r.data.order.quick, true);
});

test('admin: the factory password must be changed before anything else', async () => {
  const admin = client();
  const login = await admin('/admin/login', { method: 'POST', body: { username: 'admin', password: 'changeme123' } });
  assert.equal(login.status, 200);
  assert.equal(login.data.mustChangePassword, true);
  assert.equal((await admin('/admin/session')).data.mustChangePassword, true);
  assert.equal((await admin('/api/admin/orders')).status, 403);
  assert.equal((await admin('/api/admin/backup')).status, 403);
  assert.equal((await admin('/api/admin/admins/admin/password', { method: 'PUT', body: { password: 'short' } })).status, 400);
  assert.equal((await admin('/api/admin/admins/admin/password', { method: 'PUT', body: { password: 'changeme123' } })).status, 400);
  assert.equal((await admin('/api/admin/admins/admin/password', { method: 'PUT', body: { password: ADMIN_PASSWORD } })).status, 200);
  assert.equal((await admin('/api/admin/orders')).status, 200);
  assert.equal((await client()('/admin/login', { method: 'POST', body: { username: 'admin', password: 'changeme123' } })).status, 401);
});

test('admin: auth, promo code, stock, review moderation', async () => {
  const anon = client();
  assert.equal((await anon('/api/admin/orders')).status, 401);

  const admin = await adminClient();
  const orders = await admin('/api/admin/orders');
  assert.ok(orders.data.orders.length >= 2);

  // promo: 10% off, applied server-side
  assert.equal((await admin('/api/admin/promos', { method: 'POST', body: { code: 'test10', type: 'percent', value: 10 } })).status, 200);
  const shopper = client();
  const check = await shopper('/api/promo/check', { method: 'POST', body: { code: 'TEST10', items: [{ id: 'grip-lace', qty: 1 }] } });
  assert.equal(check.status, 200);
  assert.equal(check.data.discount, 39);
  const quick = await shopper('/api/quick-order', { method: 'POST', body: { productId: 'grip-lace', name: 'П', phone: '1', consent: true, promoCode: 'test10' } });
  assert.equal(quick.data.order.total, 351);

  // out of stock can't be ordered
  assert.equal((await admin('/api/admin/products/warm-leg', { method: 'PATCH', body: { stock: 'out' } })).status, 200);
  assert.equal((await shopper('/api/quick-order', { method: 'POST', body: { productId: 'warm-leg', name: 'П', phone: '1', consent: true } })).status, 400);
  assert.equal((await shopper('/api/restock', { method: 'POST', body: { productId: 'warm-leg', email: 'wait@test.ru', consent: true } })).status, 200);

  // review is hidden until approved
  assert.equal((await shopper('/api/reviews', { method: 'POST', body: { productId: 'dry-glide', name: 'Оля', rating: 5, text: 'Отличные чехлы, рекомендую', consent: true } })).status, 200);
  assert.equal((await shopper('/api/reviews?productId=dry-glide')).data.reviews.length, 0);
  const pending = (await admin('/api/admin/reviews')).data.reviews.find(r => r.status === 'pending');
  assert.equal((await admin(`/api/admin/reviews/${pending.id}`, { method: 'PATCH', body: { status: 'approved' } })).status, 200);
  assert.equal((await shopper('/api/reviews?productId=dry-glide')).data.reviews.length, 1);
  const product = (await shopper('/api/data')).data.products.find(p => p.id === 'dry-glide');
  assert.deepEqual(product.rating, { avg: 5, count: 1 });
});

test('articles: drafts hidden, published ones rendered and escaped', async () => {
  const visitor = client();
  assert.equal((await visitor('/api/data')).data.articles.length, 0, 'starter articles arrive as drafts');
  assert.equal((await visitor('/blog')).status, 404);

  const admin = await adminClient();
  const drafts = (await admin('/api/admin/articles')).data.articles;
  assert.equal(drafts.length, 3);

  const form = new FormData();
  form.append('title', 'Тест <script>'); form.append('description', 'desc');
  form.append('body', '## Раздел\n\n- пункт **жирный**\n- [ссылка](/catalog)\n\n<img src=x onerror=alert(1)> [плохо](javascript:alert(1))');
  form.append('published', 'true');
  const created = await admin('/api/admin/articles', { method: 'POST', form });
  assert.equal(created.status, 200, JSON.stringify(created.data));

  const list = (await visitor('/api/data')).data.articles;
  assert.equal(list.length, 1);
  const article = await visitor('/api/articles/' + list[0].slug);
  assert.match(article.data.html, /<h2>Раздел<\/h2>/);
  assert.match(article.data.html, /<b>жирный<\/b>/);
  assert.match(article.data.html, /<a href="\/catalog">ссылка<\/a>/);
  assert.doesNotMatch(article.data.html, /<img|href="javascript/);

  const page = await visitor('/blog/' + list[0].slug);
  assert.equal(page.status, 200);
  assert.match(page.data, /"@type":"BlogPosting"/);
  assert.match(page.data, /<main id="app"><article/, 'article text is in the raw HTML for crawlers');
  assert.doesNotMatch(page.data, /<title>Тест <script>/);
  assert.match((await visitor('/sitemap.xml')).data, /\/blog\//);
});

test('admin can pick "С этим покупают" products; unknown ids are dropped', async () => {
  const admin = await adminClient();
  const form = new FormData();
  form.append('cat', 'bags'); form.append('name', 'Чемодан Алюминиевый Two Boots M (черный)'); form.append('price', '23500');
  form.append('color', 'черный'); form.append('size', 'M'); form.append('specs', '[]');
  form.append('related', JSON.stringify(['grip-lace', 'no-such-product', 'two-boots-black-m', 'grip-lace']));
  const r = await admin('/api/admin/products/two-boots-black-m', { method: 'PUT', form });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.related, ['grip-lace']);
  const product = (await client()('/api/data')).data.products.find(p => p.id === 'two-boots-black-m');
  assert.deepEqual(product.related, ['grip-lace']);
});

test('admin statistics: revenue excludes cancelled orders, days are bucketed', async () => {
  const admin = await adminClient();
  assert.equal((await client()('/api/admin/stats')).status, 401);
  const st = (await admin('/api/admin/stats?days=7')).data;
  assert.equal(st.byDay.length, 7);
  const all = (await admin('/api/admin/orders')).data.orders;
  const live = all.filter(o => o.status !== 'cancelled');
  assert.equal(st.current.orders, live.length);
  assert.equal(st.current.revenue, live.reduce((s, o) => s + o.total, 0));
  assert.equal(st.current.cancelled, all.length - live.length);
  assert.equal(st.byDay.reduce((s, d) => s + d.revenue, 0), st.current.revenue);
  assert.ok(st.topProducts.length > 0);
  assert.equal((await admin('/api/admin/stats?days=365')).data.byDay.length, 365);
});

test('customers never see the manager comment', async () => {
  const buyer = client();
  await buyer('/api/login', { method: 'POST', body: { email: 'buyer@test.ru', password: 'secret1' } });
  const order = (await buyer('/api/orders')).data.orders[0];
  const admin = await adminClient();
  assert.equal((await admin(`/api/admin/orders/${order.id}`, { method: 'PATCH', body: { comment: 'internal note' } })).status, 200);
  const seen = (await buyer('/api/orders')).data.orders[0];
  assert.equal('comment' in seen, false);
});

test('the store is saved atomically: valid JSON, no temp file left behind', () => {
  const file = path.join(dataDir, 'store.json');
  const store = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(store.orders.length >= 3);
  assert.equal(fs.existsSync(file + '.tmp'), false);
});
