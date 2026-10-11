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
const BOT_SECRET = 'test-bot-secret-0123456789';

// A stand-in for the YooKassa API: creates payments and reports whatever status the test sets.
const http = require('node:http');
const fakeYk = { payments: {}, requests: [], port: 0 };
const ykServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    fakeYk.requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, key: req.headers['idempotence-key'], body });
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== 'Basic ' + Buffer.from('shop-1:secret-1').toString('base64')) return send(401, { description: 'bad auth' });
    if (req.method === 'POST' && req.url === '/payments') {
      const b = JSON.parse(body);
      const id = 'pay-' + String(Object.keys(fakeYk.payments).length + 1).padStart(4, '0') + '-abcdef';
      fakeYk.payments[id] = { id, status: 'pending', amount: b.amount, metadata: b.metadata, confirmation: { type: 'redirect', confirmation_url: 'https://yoomoney.example/checkout?id=' + id } };
      return send(200, fakeYk.payments[id]);
    }
    const m = req.url.match(/^\/payments\/(.+)$/);
    if (req.method === 'GET' && m && fakeYk.payments[m[1]]) return send(200, fakeYk.payments[m[1]]);
    send(404, { description: 'not found' });
  });
});

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
    const data = type.includes('json') ? await res.json()
      : type.includes('zip') ? Buffer.from(await res.arrayBuffer())
      : await res.text();
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
  await new Promise(r => ykServer.listen(0, '127.0.0.1', r));
  fakeYk.port = ykServer.address().port;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twoboots-test-'));
  const env = { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, SESSION_SECRET: 'test-secret', BOTORDER_SECRET: BOT_SECRET, NODE_ENV: 'test',
    // every test order comes from 127.0.0.1; the per-customer limit is still the real one
    ORDERS_PER_IP_15MIN: '1000',
    YOOKASSA_SHOP_ID: 'shop-1', YOOKASSA_SECRET_KEY: 'secret-1', YOOKASSA_API_URL: `http://127.0.0.1:${fakeYk.port}` };
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

after(async () => {
  if (server && server.exitCode === null) {
    // the server saves its visitor counter on shutdown — let it finish before removing the dir
    const exited = new Promise(r => server.once('exit', r));
    server.kill();
    await exited;
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
  ykServer.close();
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
  const noConsent = await req('/api/register', { method: 'POST', body: { name: 'Тест', email: 'buyer@test.ru', password: 'secret1', phone: '+7 900 000-00-01' } });
  assert.equal(noConsent.status, 400);
  const reg = await req('/api/register', { method: 'POST', body: { name: 'Тест', email: 'buyer@test.ru', password: 'secret1', phone: '+7 900 000-00-01', consent: true } });
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
  assert.equal((await req('/api/quick-order', { method: 'POST', body: { productId: 'grip-lace', name: 'Катя', phone: '+7 911 000-00-02' } })).status, 400);
  const r = await req('/api/quick-order', { method: 'POST', body: { productId: 'grip-lace', name: 'Катя', phone: '+7 911 000-00-02', consent: true, qty: 3 } });
  assert.equal(r.status, 200);
  assert.equal(r.data.order.total, 390 * 3);
  assert.equal(r.data.order.quick, true);
});

test('the order bot pulls new orders with its secret, and nothing without it', async () => {
  const pull = (query, token) => fetch(`${BASE}/api/bot/orders${query}`, { headers: token ? { 'X-Webhook-Token': token } : {} });
  assert.equal((await pull('?after=0')).status, 403);
  assert.equal((await pull('?after=0', 'wrong-secret-0123456789ab')).status, 403);

  const start = await (await pull('', BOT_SECRET)).json();
  assert.deepEqual(start.orders, [], 'a fresh bot only learns the latest number');
  const r = await client()('/api/quick-order', { method: 'POST', body: { productId: 'grip-lace', name: 'Бот', phone: '+7 900 000-00-03', consent: true } });
  assert.equal(r.status, 200);

  const next = await (await pull(`?after=${start.latest}`, BOT_SECRET)).json();
  assert.equal(next.orders.length, 1);
  assert.equal(next.orders[0].number, r.data.order.number);
  assert.equal(next.orders[0].fields.name, 'Бот');
  assert.match(next.orders[0].fields['Заказ'], /в 1 клик/);
  assert.deepEqual((await (await pull(`?after=${next.latest}`, BOT_SECRET)).json()).orders, []);
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

test('visitor counter: counts people and pages, skips bots and admins, keeps no search text', async () => {
  const hit = (body, headers = {}) => fetch(BASE + '/api/hit', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (iPhone) Test', ...headers }, body: JSON.stringify(body) });
  assert.equal((await hit({ path: '/', ref: 'https://yandex.ru/search/?text=чехлы' })).status, 204);
  await hit({ path: '/catalog?cat=bags&q=секрет' });
  await hit({ ping: true });
  await hit({ path: '/' }, { 'User-Agent': 'Mozilla/5.0 (compatible; YandexBot/3.0)' });
  await hit({ path: '/admin' });

  const admin = await adminClient();
  // the admin's own browsing is not counted
  assert.equal((await admin('/api/hit', { method: 'POST', body: { path: '/about' } })).status, 204);

  const v = (await admin('/api/admin/visits?days=7')).data;
  assert.equal(v.current.visitors, 1);
  assert.equal(v.current.views, 2);
  assert.deepEqual(v.sources, [{ source: 'yandex', visitors: 1 }]);
  assert.deepEqual(v.devices, { mobile: 1 });
  assert.ok(v.pages.some(p => p.key === '/catalog?cat=bags' && /^Каталог: /.test(p.label)));
  assert.ok(!JSON.stringify(v).includes('секрет'));
  assert.ok(v.online >= 1);
  assert.equal(v.byDay.length, 7);
  const now = (await admin('/api/admin/visitors-now')).data;
  assert.deepEqual(now.today, { visitors: 1, views: 2 });
  assert.equal((await client()('/api/admin/visits')).status, 401);
});

test('delivery: methods from the admin, price in the total, free threshold, tracking number', async () => {
  const pub = (await client()('/api/data')).data.deliveryMethods;
  assert.deepEqual(pub.map(m => m.id), ['cdek', 'cdek-door', 'post', 'yandex', 'ozon', 'wb', 'avito', 'courier', 'pickup']);
  assert.ok(!('enabled' in pub[0]));

  const admin = await adminClient();
  const { methods } = (await admin('/api/admin/delivery-methods')).data;
  const edited = methods.map(m => m.id === 'courier' ? { ...m, pricing: 'fixed', price: 400, freeFrom: 5000 } : m.id === 'wb' ? { ...m, enabled: false } : m);
  assert.equal((await admin('/api/admin/delivery-methods', { method: 'PUT', body: { methods: [...edited, { ...edited[0] }] } })).status, 400, 'duplicate id');
  assert.equal((await admin('/api/admin/delivery-methods', { method: 'PUT', body: { methods: [{ id: 'Bad id!' }] } })).status, 400);
  assert.equal((await admin('/api/admin/delivery-methods', { method: 'PUT', body: { methods: edited } })).status, 200);
  assert.ok(!(await client()('/api/data')).data.deliveryMethods.some(m => m.id === 'wb'), 'disabled methods are not offered');

  const req = client();
  await req('/api/register', { method: 'POST', body: { name: 'Доставка', email: 'ship@test.ru', password: 'secret1', phone: '+7 901 000-00-04', consent: true } });
  const order = body => req('/api/orders', { method: 'POST', body: { items: [{ id: 'dry-glide', qty: 1 }], ...body } });
  assert.equal((await order({ delivery: 'wb', city: 'Казань', address: 'ПВЗ' })).status, 400, 'disabled method');
  assert.equal((await order({ delivery: 'ozon', city: 'Казань' })).data.error, 'Укажите адрес пункта выдачи');
  assert.equal((await order({ delivery: 'avito' })).data.error, 'Укажите город');

  const courier = await order({ delivery: 'courier', address: 'Тверская 1' });
  assert.equal(courier.status, 200, JSON.stringify(courier.data));
  assert.equal(courier.data.order.total, 1490 + 400, 'a fixed price is added to the total');
  assert.equal(courier.data.order.city, 'Москва');
  assert.equal(courier.data.order.deliveryName, 'Курьер по Москве');
  const freeCourier = await req('/api/orders', { method: 'POST', body: { items: [{ id: 'dry-glide', qty: 4 }], delivery: 'courier', address: 'Тверская 1' } });
  assert.equal(freeCourier.data.order.total, 1490 * 4, 'free from 5000 ₽');
  assert.equal(freeCourier.data.order.deliveryPrice, 'бесплатно');
  const third = await order({ delivery: 'pickup' });
  assert.equal(third.status, 429, 'no more than 2 orders an hour per customer');
  assert.match(third.data.error, /не больше 2 заказов в час/);
  // the same phone can't get round it with a one-click order
  assert.equal((await req('/api/quick-order', { method: 'POST', body: { productId: 'grip-lace', name: 'Д', phone: '8 (901) 000-00-04', consent: true } })).status, 429);

  const req2 = client();
  await req2('/api/register', { method: 'POST', body: { name: 'Доставка 2', email: 'ship2@test.ru', password: 'secret1', phone: '+7 901 000-00-05', consent: true } });
  const order2 = body => req2('/api/orders', { method: 'POST', body: { items: [{ id: 'dry-glide', qty: 1 }], ...body } });
  const avito = await order2({ delivery: 'avito', city: 'Пермь', address: 'ignored' });
  assert.equal(avito.status, 200);
  assert.equal(avito.data.order.address, '', 'manager-arranged delivery keeps only the city');
  assert.match(avito.data.order.deliveryPrice, /при получении/);

  const cdek = await order2({ delivery: 'cdek', city: 'Казань', address: 'ПВЗ на Баумана' });
  const id = cdek.data.order.id;
  assert.equal((await admin('/api/admin/orders/' + id, { method: 'PATCH', body: { trackNumber: 'bad track!' } })).status, 400);
  const tracked = await admin('/api/admin/orders/' + id, { method: 'PATCH', body: { trackNumber: ' 1234 5678 ' } });
  assert.equal(tracked.status, 200);
  assert.equal(tracked.data.order.status, 'shipped', 'a tracking number marks the order shipped');
  assert.equal(tracked.data.order.trackUrl, 'https://www.cdek.ru/ru/tracking/?order_id=12345678');
  const mine = (await req2('/api/orders')).data.orders.find(o => o.id === id);
  assert.equal(mine.trackNumber, '12345678');

  const stats = (await admin('/api/admin/stats?days=7')).data;
  assert.ok(stats.delivery['Курьер по Москве'] >= 2, 'statistics count by method name');
});

test('account cart and favorites; cart reminder only with consent, once, with a working unsubscribe link', async () => {
  const crypto = require('node:crypto');
  const optIn = client(), optOut = client();
  const reg = await optIn('/api/register', { method: 'POST', body: { name: 'Корзина', email: 'cart@test.ru', password: 'secret1', phone: '+7 902 000-00-07', consent: true, marketing: true } });
  assert.equal(reg.data.user.marketing, true);
  await optOut('/api/register', { method: 'POST', body: { name: 'Без писем', email: 'nomail@test.ru', password: 'secret1', phone: '+7 902 000-00-08', consent: true } });

  for (const c of [optIn, optOut]) {
    assert.equal((await c('/api/cart', { method: 'PUT', body: { items: [{ id: 'dry-glide', qty: 2 }, { id: 'street-guard', qty: 1, size: 'M' }] } })).status, 200);
  }
  assert.equal((await client()('/api/cart', { method: 'PUT', body: { items: [] } })).status, 401);
  assert.deepEqual((await optIn('/api/me')).data.user.cart, [{ id: 'dry-glide', qty: 2, size: null }, { id: 'street-guard', qty: 1, size: 'M' }]);

  const fav = await optIn('/api/favorites', { method: 'PUT', body: { ids: ['dry-glide', 'no-such-product', 'dry-glide'] } });
  assert.deepEqual(fav.data.favorites, ['dry-glide'], 'unknown and repeated ids are dropped');

  const run = shiftMs => fetch(BASE + '/api/test/run-reminders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shiftMs }) }).then(r => r.json());
  assert.equal((await run(0)).cart, 0, 'not before 3 hours');
  assert.equal((await run(4 * 3600 * 1000)).cart, 1, 'only the customer who agreed to reminders');
  assert.equal((await run(5 * 3600 * 1000)).cart, 0, 'never twice for the same cart');

  const me = (await optIn('/api/me')).data.user;
  const bad = await fetch(`${BASE}/unsubscribe?u=${me.id}&t=0000`);
  assert.match(await bad.text(), /недействительна/);
  const token = crypto.createHmac('sha256', 'test-secret').update('unsubscribe:' + me.id).digest('hex').slice(0, 32);
  assert.match(await (await fetch(`${BASE}/unsubscribe?u=${me.id}&t=${token}`)).text(), /Вы отписались/);
  assert.equal((await optIn('/api/me')).data.user.marketing, false);

  // a placed order clears the saved cart
  const placed = await optOut('/api/orders', { method: 'POST', body: { items: [{ id: 'dry-glide', qty: 1 }], delivery: 'pickup' } });
  assert.equal(placed.status, 200, JSON.stringify(placed.data));
  assert.deepEqual((await optOut('/api/me')).data.user.cart, []);
  assert.equal((await client()('/favorites')).status, 200);
});

test('review request after shipping or completion, once; partner code report and payouts', async () => {
  const admin = await adminClient();
  assert.equal((await admin('/api/admin/promos', { method: 'POST', body: { code: 'COACH10', type: 'percent', value: 10, partner: 'Тренер Мария', commission: 15 } })).status, 200);

  const buyer = client();
  await buyer('/api/register', { method: 'POST', body: { name: 'Отзыв', email: 'review@test.ru', password: 'secret1', phone: '+7 903 000-00-09', consent: true } });
  const a = (await buyer('/api/orders', { method: 'POST', body: { items: [{ id: 'dry-glide', qty: 2 }], delivery: 'pickup', promoCode: 'COACH10' } })).data.order;
  const b = (await buyer('/api/orders', { method: 'POST', body: { items: [{ id: 'grip-lace', qty: 1 }], delivery: 'pickup' } })).data.order;
  assert.equal(a.promo.code, 'COACH10');

  const run = shiftMs => fetch(BASE + '/api/test/run-reminders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shiftMs }) }).then(r => r.json());
  assert.equal((await admin('/api/admin/orders/' + a.id, { method: 'PATCH', body: { status: 'completed' } })).data.order.completedAt !== undefined, true);
  await admin('/api/admin/orders/' + b.id, { method: 'PATCH', body: { status: 'shipped' } });
  assert.equal((await run(0)).reviews, 0, 'not right away');
  assert.equal((await run(3 * 86400000)).reviews, 1, '2 days after completion');
  assert.ok((await run(11 * 86400000)).reviews >= 1, '10 days after shipping');
  const flagged = (await admin('/api/admin/orders')).data.orders.filter(o => o.reviewRequestedAt).map(o => o.id);
  assert.ok(flagged.includes(a.id) && flagged.includes(b.id));
  assert.equal((await run(30 * 86400000)).reviews, 0, 'once per order');

  const report = async () => (await admin('/api/admin/partners')).data.partners.find(p => p.code === 'COACH10');
  let p = await report();
  const goods = 1490 * 2 - Math.round(1490 * 2 * 0.1);
  assert.equal(p.orders, 1);
  assert.equal(p.sales, goods);
  assert.equal(p.earned, Math.round(goods * 0.15));
  assert.equal(p.toPay, p.earned);
  assert.equal((await admin('/api/admin/promos/COACH10', { method: 'PATCH', body: { payout: p.earned } })).status, 200);
  p = await report();
  assert.equal(p.paidOut, p.earned);
  assert.equal(p.toPay, 0);
});

test('stock quantity: limits orders, goes out at 0, comes back on cancel; catalog CSV round trip; print', async () => {
  const admin = await adminClient();
  const ID = 'speedjump-orange';
  const pub = async () => (await client()('/api/data')).data.products.find(p => p.id === ID);
  assert.equal((await admin('/api/admin/products/' + ID, { method: 'PATCH', body: { quantity: 'много' } })).status, 400);
  assert.equal((await admin('/api/admin/products/' + ID, { method: 'PATCH', body: { quantity: 3 } })).status, 200);
  assert.equal((await pub()).left, 3);
  assert.ok(!('quantity' in await pub()), 'exact stock stays private');

  const quick = (qty, phone) => client()('/api/quick-order', { method: 'POST', body: { productId: ID, qty, name: 'Склад', phone, consent: true } });
  const tooMany = await quick(4, '+7 904 000-00-10');
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.data.error, /осталось только 3/);
  const first = await quick(2, '+7 904 000-00-11');
  assert.equal(first.status, 200);
  assert.equal((await pub()).left, 1);
  assert.equal((await quick(1, '+7 904 000-00-12')).status, 200);
  assert.equal((await pub()).stock, 'out', 'sold out at 0');
  assert.equal((await quick(1, '+7 904 000-00-13')).status, 400);

  assert.equal((await admin('/api/admin/orders/' + first.data.order.id, { method: 'PATCH', body: { status: 'cancelled' } })).status, 200);
  const back = await pub();
  assert.equal(back.left, 2, 'a cancelled order gives its items back');
  assert.ok(!back.stock);

  // export → edit in "Excel" (Windows-1251, commas) → check → apply
  const csv = await fetch(BASE + '/api/admin/products/export.csv', { headers: { cookie: '' } });
  assert.equal(csv.status, 401);
  const exp = await admin('/api/admin/products/export.csv');
  assert.match(exp.headers.get('content-type'), /text\/csv/);
  assert.ok(exp.data.startsWith('"ID";"Название";"Категория";"Цена"'), exp.data.slice(0, 60)); // fetch's text() drops the BOM
  const cp1251 = str => Buffer.from([...str].map(ch => {
    const c = ch.charCodeAt(0);
    if (c < 128) return c;
    if (c >= 0x410 && c <= 0x44f) return c - 0x410 + 0xc0;
    return c === 0x401 ? 0xa8 : c === 0x451 ? 0xb8 : 0x3f;
  }));
  const file = cp1251(`ID,Название,Цена,"Скидка, %",Остаток,Наличие,Скрыт\r\n${ID},Скакалка,999,"10",5,в наличии,нет\r\nno-such-id,Что-то,1,0,,в наличии,нет\r\n`);
  const upload = async dry => {
    const fd = new FormData();
    fd.append('file', new Blob([file], { type: 'text/csv' }), 'catalog.csv');
    return admin('/api/admin/products/import' + (dry ? '?dryRun=1' : ''), { method: 'POST', form: fd });
  };
  const check = await upload(true);
  assert.equal(check.status, 200, JSON.stringify(check.data));
  assert.equal(check.data.changes.length, 1);
  assert.match(check.data.changes[0].changes.join('; '), /цена \d+ → 999/);
  assert.equal(check.data.errors.length, 1, 'unknown ID is reported, not created');
  assert.notEqual((await pub()).price, 999, 'a check changes nothing');
  assert.equal((await upload(false)).status, 200);
  const after = await pub();
  assert.equal(after.price, 999);
  assert.equal(after.discountPercent, 10);
  assert.equal(after.left, 5);

  const print = await admin('/admin/orders/' + first.data.order.id + '/print');
  assert.equal(print.status, 200);
  assert.match(print.data, /Заказ №\d+/);
  assert.match(print.data, /Склад/);
});

test('gift certificates: buy without delivery, issue once, pay in parts, refund on cancel', async () => {
  const admin = await adminClient();
  const giver = client();
  await giver('/api/register', { method: 'POST', body: { name: 'Даритель', email: 'giver@test.ru', password: 'secret1', phone: '+7 905 000-00-14', consent: true } });
  assert.equal((await giver('/api/orders', { method: 'POST', body: { items: [{ id: 'gift-1234', qty: 1 }] } })).status, 400, 'only the offered amounts');
  assert.match((await giver('/api/orders', { method: 'POST', body: { items: [{ id: 'gift-3000', qty: 1 }], promoCode: 'TEST10' } })).data.error, /не действуют на подарочные/);
  const bought = await giver('/api/orders', { method: 'POST', body: { items: [{ id: 'gift-3000', qty: 1 }], comment: 'для Маши' } });
  assert.equal(bought.status, 200, JSON.stringify(bought.data));
  assert.equal(bought.data.order.total, 3000);
  assert.equal(bought.data.order.delivery, '', 'no delivery for a certificate');

  const issued = await admin('/api/admin/orders/' + bought.data.order.id + '/issue-gifts', { method: 'POST' });
  assert.equal(issued.status, 200);
  const code = issued.data.order.giftCodes[0].code;
  assert.match(code, /^TB-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal((await admin('/api/admin/orders/' + bought.data.order.id + '/issue-gifts', { method: 'POST' })).status, 400, 'issued once');
  assert.equal((await giver('/api/orders')).data.orders[0].giftCodes[0].code, code, 'the buyer sees the code in the account');

  const check = await client()('/api/gift/check', { method: 'POST', body: { code: code.toLowerCase().replace(/-/g, ' ') } });
  assert.equal(check.data.balance, 3000);

  const friend = client();
  await friend('/api/register', { method: 'POST', body: { name: 'Маша', email: 'masha@test.ru', password: 'secret1', phone: '+7 905 000-00-15', consent: true } });
  const spend = await friend('/api/orders', { method: 'POST', body: { items: [{ id: 'dry-glide', qty: 1 }, { id: 'gift-1000', qty: 1 }], delivery: 'pickup', giftCode: code } });
  assert.equal(spend.status, 200, JSON.stringify(spend.data));
  assert.equal(spend.data.order.giftCard.amount, 1490, 'pays the goods, not the certificate in the same cart');
  assert.equal(spend.data.order.total, 1000);
  assert.equal((await client()('/api/gift/check', { method: 'POST', body: { code } })).data.balance, 1510);

  assert.equal((await friend(`/api/orders/${spend.data.order.id}/cancel`, { method: 'PATCH' })).status, 200);
  assert.equal((await client()('/api/gift/check', { method: 'POST', body: { code } })).data.balance, 3000, 'cancelling gives the money back');

  const manual = await admin('/api/admin/gift-cards', { method: 'POST', body: { amount: 500, note: 'розыгрыш' } });
  assert.equal(manual.data.giftCard.balance, 500);
  await admin('/api/admin/gift-cards/' + manual.data.giftCard.code, { method: 'PATCH', body: { active: false } });
  assert.match((await client()('/api/gift/check', { method: 'POST', body: { code: manual.data.giftCard.code } })).data.error, /отключён/);
  assert.equal((await client()('/gift')).status, 200);
});

test('category texts and FAQ: shown, pre-rendered with FAQPage markup, editable', async () => {
  const data = (await client()('/api/data')).data;
  assert.match(data.categoryContent.blades.html, /<b>Жёсткие/);
  assert.ok(data.categoryContent.blades.faq.length >= 3);
  const page = await client()('/catalog?cat=blades');
  assert.match(page.data, /"@type":"FAQPage"/);
  assert.match(page.data, /<main id="app"><section class="block"><div class="wrap doc-page"><h1>Чехлы для лезвий<\/h1>/);
  assert.match(page.data, /<meta name="description" content="Чехлы для лезвий фигурных коньков нужны двух видов/);

  const admin = await adminClient();
  assert.equal((await admin('/api/admin/category-content/nope', { method: 'PUT', body: { text: 'x' } })).status, 404);
  const saved = await admin('/api/admin/category-content/ropes', { method: 'PUT', body: { text: 'Новый текст <script>', faq: [{ q: 'Вопрос?', a: 'Ответ.' }, { q: '', a: 'без вопроса' }] } });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.content.faq.length, 1, 'empty questions are dropped');
  const ropes = (await client()('/api/data')).data.categoryContent.ropes;
  assert.match(ropes.html, /Новый текст &lt;script&gt;/);
});

test('online payment: redirect to YooKassa, paid only when YooKassa says so, certificates issued', async () => {
  assert.equal((await client()('/api/data')).data.payments.online, true);
  const buyer = client();
  await buyer('/api/register', { method: 'POST', body: { name: 'Оплата', email: 'pay@test.ru', password: 'secret1', phone: '+7 906 000-00-16', consent: true } });
  const placed = await buyer('/api/orders', { method: 'POST', body: { items: [{ id: 'dry-glide', qty: 1 }], delivery: 'pickup', payOnline: true } });
  assert.equal(placed.status, 200, JSON.stringify(placed.data));
  assert.match(placed.data.paymentUrl, /^https:\/\/yoomoney\.example\/checkout/);
  const created = fakeYk.requests.find(r => r.method === 'POST');
  assert.ok(created.key, 'idempotence key sent');
  assert.equal(JSON.parse(created.body).amount.value, '1490.00');
  const id = placed.data.order.id;
  const payId = Object.values(fakeYk.payments).find(p => p.metadata.orderId === id).id;

  const hook = paymentId => fetch(BASE + '/api/payments/yookassa', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'payment.succeeded', object: { id: paymentId, status: 'succeeded' } }) });
  const state = async () => (await buyer('/api/orders/' + id + '/payment')).data;
  // a notification is only a hint: YooKassa still says "pending", so nothing is paid
  assert.equal((await hook(payId)).status, 200);
  assert.equal((await hook('forged-payment-0001')).status, 200);
  assert.equal((await state()).paid, false);

  fakeYk.payments[payId].status = 'succeeded';
  await hook(payId);
  let paid = false;
  for (let i = 0; i < 20 && !paid; i++) { await new Promise(r => setTimeout(r, 50)); paid = (await buyer('/api/orders')).data.orders.find(o => o.id === id).paidAt !== undefined; }
  assert.ok(paid, 'the webhook marked it paid');
  const s = await state();
  assert.equal(s.order.status, 'processing');
  assert.equal(s.order.paidAmount, 1490);
  assert.equal((await buyer(`/api/orders/${id}/cancel`, { method: 'PATCH' })).status, 400, 'a paid order is cancelled by the manager');
  assert.equal((await buyer(`/api/orders/${id}/pay`, { method: 'POST' })).status, 400, 'already paid');

  // a certificate paid online is issued without the admin
  const gift = await buyer('/api/orders', { method: 'POST', body: { items: [{ id: 'gift-2000', qty: 1 }], payOnline: true } });
  const giftPay = Object.values(fakeYk.payments).find(p => p.metadata.orderId === gift.data.order.id);
  giftPay.status = 'succeeded';
  const after = await buyer('/api/orders/' + gift.data.order.id + '/payment');
  assert.equal(after.data.paid, true, 'checked on return from YooKassa');
  assert.equal(after.data.order.giftCodes.length, 1);
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
  const quick = await shopper('/api/quick-order', { method: 'POST', body: { productId: 'grip-lace', name: 'П', phone: '+7 999 000-00-06', consent: true, promoCode: 'test10' } });
  assert.equal(quick.data.order.total, 351);

  // out of stock can't be ordered
  assert.equal((await admin('/api/admin/products/warm-leg', { method: 'PATCH', body: { stock: 'out' } })).status, 200);
  assert.equal((await shopper('/api/quick-order', { method: 'POST', body: { productId: 'warm-leg', name: 'П', phone: '+7 999 000-00-06', consent: true } })).status, 400);
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

test('restore from a backup: round-trips the data, rejects junk, never writes outside DATA_DIR', async () => {
  const AdmZip = require('adm-zip');
  const admin = await adminClient();
  const backup = await admin('/api/admin/backup');
  assert.equal(backup.status, 200);
  const before = (await admin('/api/admin/orders')).data.orders.length;

  const upload = (buf, name = 'b.zip') => { const f = new FormData(); f.append('backup', new Blob([buf]), name); return f; };
  assert.equal((await client()('/api/admin/restore', { method: 'POST', form: upload(backup.data) })).status, 403);
  assert.equal((await admin('/api/admin/restore', { method: 'POST', form: upload(Buffer.from('nope')) })).status, 400);

  const evil = new AdmZip(backup.data);
  evil.addFile('uploads/../../escaped.txt', Buffer.from('x'));
  evil.addFile('../escaped2.txt', Buffer.from('x'));
  const r = await admin('/api/admin/restore', { method: 'POST', form: upload(evil.toBuffer()) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.orders, before);
  assert.equal(fs.existsSync(path.join(dataDir, '..', 'escaped.txt')) || fs.existsSync(path.join(dataDir, 'escaped.txt')), false);
  assert.equal(fs.existsSync(path.join(dataDir, '..', 'escaped2.txt')), false);
  assert.ok(fs.readdirSync(dataDir).some(f => f.startsWith('store.before-restore-')));
  assert.equal((await admin('/api/admin/orders')).data.orders.length, before);
});
