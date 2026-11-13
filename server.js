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

// Optional second admin account (e.g. a temporary/emergency login). Set
// ADMIN_USER2 / ADMIN_PASS2 as env vars; remove them to delete the account.
const ADMIN_ACCOUNTS = [{ user: ADMIN_USER, pass: ADMIN_PASS }];
if (process.env.ADMIN_USER2 && process.env.ADMIN_PASS2) {
  ADMIN_ACCOUNTS.push({ user: process.env.ADMIN_USER2, pass: process.env.ADMIN_PASS2 });
  console.warn('[cafe-pos] NOTE: a second admin account (ADMIN_USER2) is active. Remove ADMIN_USER2/ADMIN_PASS2 when you no longer need it.');
}

function safeEqual(a, b) {
  return crypto.timingSafeEqual(Buffer.from(String(a).padEnd(128)), Buffer.from(String(b).padEnd(128)));
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
    const matched = ADMIN_ACCOUNTS.some((acc) => safeEqual(user, acc.user) && safeEqual(pass, acc.pass));
    if (matched) {
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

// The business runs on Malaysia time; "today" and every order's "day" are
// always computed in Asia/Kuala_Lumpur, never the server's own UTC clock —
// otherwise orders near midnight land on the wrong day and times look off
// by 8 hours wherever they're shown.
const MY_TZ = 'Asia/Kuala_Lumpur';
const myDateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: MY_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
function myDateStr(d) {
  return myDateFormatter.format(d);
}
function todayStr(d) {
  const dt = d ? new Date(d) : new Date();
  return myDateStr(dt);
}

// ---------------- Public pages ----------------
app.use(express.static(path.join(__dirname, 'public')));

// ---------------- Public API (used by the till / entry pages, no login) ----------------

// Menu is read-only here; reordering is an admin-only action (see below).
app.get('/api/menu', (req, res) => {
  res.json(db.getMenu());
});

function reorderMenu(order) {
  const menu = db.getMenu();
  const byId = new Map(menu.map((m) => [m.id, m]));
  const reordered = order.map((id) => byId.get(id)).filter(Boolean);
  menu.forEach((m) => { if (!order.includes(m.id)) reordered.push(m); });
  db.saveMenu(reordered);
  return reordered;
}

// Staff can see today's orders from the till screen itself (read-only, no login).
app.get('/api/orders', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
  const day = req.query.date || todayStr();
  let orders = db.getOrders().filter((o) => myDateStr(new Date(o.createdAt)) === day);
  orders.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(orders.slice(0, limit));
});

// Staff places an order from the till screen.
app.post('/api/orders', (req, res) => {
  const { items, total, pay, cashier, device } = req.body || {};
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
    device: device || null, // which till/device placed this order
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

// Lets the owner set the till's menu button order by hand (drag/reorder in
// the admin UI, or just up/down). Body is the full list of item ids in the
// new order; items are re-sorted to match, nothing is added or removed here.
app.put('/api/admin/menu/reorder', (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order) || order.length === 0) {
    return res.status(400).json({ error: 'order must be a non-empty array of menu item ids' });
  }
  res.json(reorderMenu(order));
});

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
  if (req.query.date) orders = orders.filter((o) => myDateStr(new Date(o.createdAt)) === req.query.date);
  // Range filter used by the weekly settlement report: from is exclusive
  // (matches a settlement's "since"), to is inclusive.
  if (req.query.from) orders = orders.filter((o) => myDateStr(new Date(o.createdAt)) > req.query.from);
  if (req.query.to) orders = orders.filter((o) => myDateStr(new Date(o.createdAt)) <= req.query.to);
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
  // Range filter used by the weekly settlement report: from is exclusive
  // (matches a settlement's "since"), to is inclusive.
  if (req.query.from) expenses = expenses.filter((e) => e.date > req.query.from);
  if (req.query.to) expenses = expenses.filter((e) => e.date <= req.query.to);
  expenses.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(expenses);
});

app.delete('/api/admin/expenses/:id', (req, res) => {
  const expenses = db.getExpenses().filter((e) => e.id !== req.params.id);
  db.saveExpenses(expenses);
  res.json({ ok: true });
});

// Daily rollup: revenue (split by payment method), cost, profit.
app.get('/api/admin/summary', (req, res) => {
  const orders = db.getOrders();
  const expenses = db.getExpenses();
  const byDay = {};

  function day(d) {
    if (!byDay[d]) byDay[d] = { date: d, revenue: 0, cost: 0, cash: 0, tng: 0, free: 0 };
    return byDay[d];
  }

  orders.forEach((o) => {
    const d = day(myDateStr(new Date(o.createdAt)));
    // "Free" orders (e.g. comped coffee for pastoral staff) are tracked —
    // but no money actually changed hands, so they don't count as revenue.
    if (o.pay === '현금') { d.cash += o.total; d.revenue += o.total; }
    else if (o.pay === '터치앤고') { d.tng += o.total; d.revenue += o.total; }
    else { d.free += o.total; }
  });
  expenses.forEach((e) => { day(e.date).cost += e.amount; });

  const daysAsc = Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date));
  daysAsc.forEach((d) => { d.profit = d.revenue - d.cost; });

  res.json(daysAsc.slice().reverse());
});

// ---- Weekly cash / Touch 'n Go settlement (reconciliation) ----
// "sinceAt" is the exact timestamp of the last settlement (or null if there
// has never been one). Comparing full timestamps — not just the date — means
// a second settlement done later the same day still only counts orders
// placed after the first one, instead of double-counting or missing them.
function recordedTotalsSince(sinceAt) {
  const orders = db.getOrders();
  let cash = 0, tng = 0;
  orders.forEach((o) => {
    if (sinceAt && o.createdAt <= sinceAt) return;
    if (o.pay === '현금') cash += o.total;
    else if (o.pay === '터치앤고') tng += o.total;
  });
  return { cash, tng };
}

// Live preview: what's recorded since the last settlement, without settling.
app.get('/api/admin/settlement-status', (req, res) => {
  const settings = db.getSettings();
  const recorded = recordedTotalsSince(settings.settlement.at);
  res.json({
    since: settings.settlement.date,
    lastActualCash: settings.settlement.actualCash,
    lastActualTng: settings.settlement.actualTng,
    recordedCash: recorded.cash,
    recordedTng: recorded.tng
  });
});

// The owner counts the real drawer + checks the Touch 'n Go balance and
// submits both here. We compare against what the system recorded since the
// last settlement, log the result, and this becomes the new baseline.
app.post('/api/admin/settlement', (req, res) => {
  const { actualCash, actualTng } = req.body || {};
  if (typeof actualCash !== 'number' || typeof actualTng !== 'number' || Number.isNaN(actualCash) || Number.isNaN(actualTng)) {
    return res.status(400).json({ error: 'actualCash and actualTng must both be numbers' });
  }
  const settings = db.getSettings();
  const since = settings.settlement.date;
  const recorded = recordedTotalsSince(settings.settlement.at);
  // actualCash/actualTng are the full amount on hand right now ("최신 잔액"),
  // so what we expect them to be is last time's balance plus what came in
  // since — not just the new sales on their own.
  const expectedCash = (settings.settlement.actualCash || 0) + recorded.cash;
  const expectedTng = (settings.settlement.actualTng || 0) + recorded.tng;
  const nowIso = new Date().toISOString();
  const record = {
    id: uid(),
    createdAt: nowIso,
    date: todayStr(),
    since,
    prevCash: settings.settlement.actualCash || 0,
    prevTng: settings.settlement.actualTng || 0,
    recordedCash: recorded.cash,
    recordedTng: recorded.tng,
    expectedCash,
    expectedTng,
    actualCash,
    actualTng,
    diffCash: actualCash - expectedCash,
    diffTng: actualTng - expectedTng
  };
  const settlements = db.getSettlements();
  settlements.push(record);
  db.saveSettlements(settlements);

  settings.settlement = { at: nowIso, date: record.date, actualCash, actualTng };
  db.saveSettings(settings);

  res.status(201).json(record);
});

app.get('/api/admin/settlements', (req, res) => {
  const settlements = db.getSettlements().slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(settlements);
});

// Fix a mistyped settlement. The recorded/expected figures from when it was
// first settled are kept as-is (they reflect that moment); only the actual
// counted amounts and the diff change. If this is the current baseline
// settlement, the live baseline is updated too so future settlements stay correct.
app.put('/api/admin/settlements/:id', (req, res) => {
  const { actualCash, actualTng } = req.body || {};
  if (typeof actualCash !== 'number' || typeof actualTng !== 'number' || Number.isNaN(actualCash) || Number.isNaN(actualTng)) {
    return res.status(400).json({ error: 'actualCash and actualTng must both be numbers' });
  }
  const settlements = db.getSettlements();
  const rec = settlements.find((s) => s.id === req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });

  const expectedCash = rec.expectedCash != null ? rec.expectedCash : (rec.prevCash || 0) + rec.recordedCash;
  const expectedTng = rec.expectedTng != null ? rec.expectedTng : (rec.prevTng || 0) + rec.recordedTng;
  rec.actualCash = actualCash;
  rec.actualTng = actualTng;
  rec.expectedCash = expectedCash;
  rec.expectedTng = expectedTng;
  rec.diffCash = actualCash - expectedCash;
  rec.diffTng = actualTng - expectedTng;
  db.saveSettlements(settlements);

  const settings = db.getSettings();
  if (settings.settlement.at === rec.createdAt) {
    settings.settlement.actualCash = actualCash;
    settings.settlement.actualTng = actualTng;
    db.saveSettings(settings);
  }
  res.json(rec);
});

// Deleting the current baseline settlement falls back to the next most
// recent one (or resets to zero if none are left), so future settlements
// still compare against something sensible.
app.delete('/api/admin/settlements/:id', (req, res) => {
  const settlements = db.getSettlements();
  const rec = settlements.find((s) => s.id === req.params.id);
  const remaining = settlements.filter((s) => s.id !== req.params.id);
  db.saveSettlements(remaining);

  const settings = db.getSettings();
  if (rec && settings.settlement.at === rec.createdAt) {
    const sorted = remaining.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    settings.settlement = sorted.length > 0
      ? { at: sorted[0].createdAt, date: sorted[0].date, actualCash: sorted[0].actualCash, actualTng: sorted[0].actualTng }
      : { at: null, date: null, actualCash: 0, actualTng: 0 };
    db.saveSettings(settings);
  }
  res.json({ ok: true });
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
