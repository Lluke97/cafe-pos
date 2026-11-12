const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme123';

if (ADMIN_PASS === 'changeme123') {
  console.warn('[cafe-pos] WARNING: using the default admin password. Set ADMIN_USER / ADMIN_PASS env vars before going live.');
}

// ---- very small HTTP Basic Auth, no extra dependency ----
// Brute-force protection: after 5 wrong attempts from one IP, that IP is
// locked out from trying again for 15 minutes. Successful logins reset it.
const FAILED_ATTEMPT_LIMIT = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const failedAttempts = new Map(); // ip -> { count, lockedUntil }

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

function requireAdmin(req, res, next) {
  const ip = clientIp(req);
  const record = failedAttempts.get(ip);
  if (record && record.lockedUntil && record.lockedUntil > Date.now()) {
    const waitMin = Math.ceil((record.lockedUntil - Date.now()) / 60000);
    return res.status(429).send(`Too many failed attempts. Try again in about ${waitMin} minute(s).`);
  }

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const user = decoded.slice(0, sep);
    const pass = decoded.slice(sep + 1);
    const okUser = crypto.timingSafeEqual(Buffer.from(user.padEnd(128)), Buffer.from(ADMIN_USER.padEnd(128)));
    const okPass = crypto.timingSafeEqual(Buffer.from(pass.padEnd(128)), Buffer.from(ADMIN_PASS.padEnd(128)));
    if (okUser && okPass) {
      failedAttempts.delete(ip);
      return next();
    }
  }

  const next_count = (record && record.count ? record.count : 0) + 1;
  if (next_count >= FAILED_ATTEMPT_LIMIT) {
    failedAttempts.set(ip, { count: next_count, lockedUntil: Date.now() + LOCKOUT_MS });
  } else {
    failedAttempts.set(ip, { count: next_count, lockedUntil: 0 });
  }

  res.set('WWW-Authenticate', 'Basic realm="Cafe Admin"');
  return res.status(401).send('Authentication required.');
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function todayStr(d) {
  const dt = d ? new Date(d) : new Date();
  return dt.toISOString().slice(0, 10);
}

// ---------------- Public pages ----------------
app.use(express.static(path.join(__dirname, 'public')));

// ---------------- Public API (used by the till / entry pages, no login) ----------------

// Menu is read-only here; editing happens only through the admin API.
app.get('/api/menu', (req, res) => {
  res.json(db.getMenu());
});

// Staff can see today's orders from the till screen itself (read-only, no login).
app.get('/api/orders', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
  const day = req.query.date || todayStr();
  let orders = db.getOrders().filter((o) => o.createdAt.slice(0, 10) === day);
  orders.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(orders.slice(0, limit));
});

// Staff places an order from the till screen.
app.post('/api/orders', (req, res) => {
  const { items, total, pay, cashier } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items is required' });
  }
  if (typeof total !== 'number' || total <= 0) {
    return res.status(400).json({ error: 'total must be a positive number' });
  }
  const order = {
    id: uid(),
    createdAt: new Date().toISOString(),
    items,
    total,
    pay: pay || null,
    cashier: cashier || null,
    status: 'new' // 'new' | 'done' — used by the Brew Board
  };
  const orders = db.getOrders();
  orders.push(order);
  db.saveOrders(orders);
  res.status(201).json(order);
});

// Brew Board: staff mark an order done (or back to new), no login needed.
app.post('/api/orders/:id/status', (req, res) => {
  const { status } = req.body || {};
  if (status !== 'new' && status !== 'done') {
    return res.status(400).json({ error: 'status must be "new" or "done"' });
  }
  const orders = db.getOrders();
  const idx = orders.findIndex((o) => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  orders[idx].status = status;
  db.saveOrders(orders);
  res.json(orders[idx]);
});

// Staff logs a purchase or an expense from the entry screen.
app.post('/api/expenses', (req, res) => {
  const { date, category, amount, memo, author } = req.body || {};
  if (!category || typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'category and a positive amount are required' });
  }
  const entry = {
    id: uid(),
    createdAt: new Date().toISOString(),
    date: date || todayStr(),
    category, // '원재료' | '운영비' | '기타'
    amount,
    memo: memo || '',
    author: author || ''
  };
  const expenses = db.getExpenses();
  expenses.push(entry);
  db.saveExpenses(expenses);
  res.status(201).json(entry);
});

// ---------------- Admin-only API ----------------
app.use('/api/admin', requireAdmin);

app.get('/api/admin/menu', (req, res) => res.json(db.getMenu()));

app.post('/api/admin/menu', (req, res) => {
  const { name, emoji, price, category } = req.body || {};
  if (!name || typeof price !== 'number' || price <= 0) {
    return res.status(400).json({ error: 'name and a positive price are required' });
  }
  const menu = db.getMenu();
  const item = { id: uid(), name, emoji: emoji || '🍽️', price, category: category || '기타' };
  menu.push(item);
  db.saveMenu(menu);
  res.status(201).json(item);
});

app.put('/api/admin/menu/:id', (req, res) => {
  const menu = db.getMenu();
  const idx = menu.findIndex((m) => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const { name, emoji, price, category } = req.body || {};
  if (name !== undefined) menu[idx].name = name;
  if (emoji !== undefined) menu[idx].emoji = emoji;
  if (price !== undefined) menu[idx].price = price;
  if (category !== undefined) menu[idx].category = category;
  db.saveMenu(menu);
  res.json(menu[idx]);
});

app.delete('/api/admin/menu/:id', (req, res) => {
  const menu = db.getMenu();
  const next = menu.filter((m) => m.id !== req.params.id);
  db.saveMenu(next);
  res.json({ ok: true });
});

app.get('/api/admin/orders', (req, res) => {
  let orders = db.getOrders();
  if (req.query.date) orders = orders.filter((o) => o.createdAt.slice(0, 10) === req.query.date);
  orders.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(orders);
});

app.delete('/api/admin/orders/:id', (req, res) => {
  const orders = db.getOrders().filter((o) => o.id !== req.params.id);
  db.saveOrders(orders);
  res.json({ ok: true });
});

app.get('/api/admin/expenses', (req, res) => {
  let expenses = db.getExpenses();
  if (req.query.date) expenses = expenses.filter((e) => e.date === req.query.date);
  expenses.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(expenses);
});

app.delete('/api/admin/expenses/:id', (req, res) => {
  const expenses = db.getExpenses().filter((e) => e.id !== req.params.id);
  db.saveExpenses(expenses);
  res.json({ ok: true });
});

// Daily rollup: revenue (split by payment method), cost, profit, and a
// running balance that starts from the admin-set opening balance.
app.get('/api/admin/summary', (req, res) => {
  const orders = db.getOrders();
  const expenses = db.getExpenses();
  const settings = db.getSettings();
  const byDay = {};

  function day(d) {
    if (!byDay[d]) byDay[d] = { date: d, revenue: 0, cost: 0, cash: 0, tng: 0, other: 0 };
    return byDay[d];
  }

  orders.forEach((o) => {
    const d = day(o.createdAt.slice(0, 10));
    d.revenue += o.total;
    if (o.pay === '현금') d.cash += o.total;
    else if (o.pay === '터치앤고') d.tng += o.total;
    else d.other += o.total;
  });
  expenses.forEach((e) => { day(e.date).cost += e.amount; });

  const daysAsc = Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date));
  let running = settings.startingBalance || 0;
  daysAsc.forEach((d) => {
    d.profit = d.revenue - d.cost;
    running += d.profit;
    d.balance = running;
  });

  res.json(daysAsc.slice().reverse());
});

// Opening cash balance that carries forward into the running balance above.
app.get('/api/admin/settings', (req, res) => {
  res.json(db.getSettings());
});

app.put('/api/admin/settings', (req, res) => {
  const { startingBalance } = req.body || {};
  if (typeof startingBalance !== 'number' || Number.isNaN(startingBalance)) {
    return res.status(400).json({ error: 'startingBalance must be a number' });
  }
  const settings = db.getSettings();
  settings.startingBalance = startingBalance;
  db.saveSettings(settings);
  res.json(settings);
});

// Admin page itself needs the same auth before the browser even gets the HTML.
app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public-admin', 'admin.html'));
});
app.use('/admin-assets', requireAdmin, express.static(path.join(__dirname, 'public-admin')));

app.listen(PORT, () => {
  console.log(`[cafe-pos] listening on http://localhost:${PORT}`);
  console.log(`[cafe-pos] till screen:   http://localhost:${PORT}/pos.html`);
  console.log(`[cafe-pos] expense entry: http://localhost:${PORT}/entry.html`);
  console.log(`[cafe-pos] admin panel:   http://localhost:${PORT}/admin  (user: ${ADMIN_USER})`);
});
