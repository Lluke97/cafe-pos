const express = require('express');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const db = require('./db');

// Push a completed settlement (cash/TnG/bank) to the youth-budget site.
// This is NOT called automatically on save anymore — the owner presses a
// dedicated "정산 전송" button, which hits the /send-to-finance route below.
// Returns a promise so that route can report success/failure back to the UI.
function notifyYouthBudget(record) {
  return new Promise((resolve, reject) => {
    const url = process.env.YOUTH_BUDGET_URL;
    const secret = process.env.SETTLEMENT_WEBHOOK_SECRET;
    if (!url || !secret) {
      return reject(new Error('연동 설정이 안 되어 있어요 (YOUTH_BUDGET_URL / SETTLEMENT_WEBHOOK_SECRET)'));
    }
    try {
      const target = new URL('/api/webhook/cafe-settlement', url);
      // 현금/은행은 카페가 센 절대 금액을 그대로 보내지만, 터치앤고는 카페
      // 지갑 잔액(actualTng)을 그대로 보내면 안 된다 — 카페 지갑과 파이낸스가
      // 보는 터치앤고는 같은 숫자가 아니라서, 이번 정산으로 "얼마나 늘었는지"
      // (increase)만 보내고 파이낸스 쪽에서 자기 터치앤고 잔액에 더하게 한다.
      const tngIncrease = record.actualTng - (record.prevTng || 0);
      const payload = JSON.stringify({
        date: record.date,
        cash: record.actualCash,
        tngIncrease,
        bank: typeof record.actualBank === 'number' ? record.actualBank : null,
        memo: '카페 정산 전송'
      });
      const req = https.request(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-Webhook-Secret': secret }
      }, (res) => {
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error('youth-budget webhook returned ' + res.statusCode));
      });
      req.on('error', (e) => reject(e));
      req.write(payload);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

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

// End of a given MY_TZ calendar day (23:59:59.999 local), as a UTC ISO
// string — used to cap a settlement to a specific business date (e.g.
// settling on Monday for Sunday's sales) instead of always "right now".
// MY_TZ has no DST, so it's always a fixed +08:00 offset.
function endOfDayIso(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const nextDayMidnightUtcMs = Date.UTC(y, m - 1, d + 1, 0, 0, 0, 0) - 8 * 3600 * 1000;
  return new Date(nextDayMidnightUtcMs - 1).toISOString();
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
// How the expense was actually paid for. Youth-budget (the finance app
// everything ends up in) maps this the same way it maps a purchase's own
// payment method, so a cafe expense can be placed in the cash/TnG/bank
// breakdown instead of being left out as unattributed.
const EXPENSE_PAYMENT_METHODS = ['현금', '카드', '터치앤고'];

app.get('/api/expense-payment-methods', (req, res) => {
  res.json(EXPENSE_PAYMENT_METHODS);
});

app.post('/api/expenses', (req, res) => {
  const { date, category, amount, memo, author, payment } = req.body || {};
  if (!category || typeof amount !== 'number' || amount <= 0 || !EXPENSE_PAYMENT_METHODS.includes(payment)) {
    return res.status(400).json({ error: `category, a positive amount, and payment (${EXPENSE_PAYMENT_METHODS.join('|')}) are required` });
  }
  const entry = {
    id: uid(),
    createdAt: new Date().toISOString(),
    date: date || todayStr(),
    category, // '원재료' | '운영비' | '기타'
    amount,
    payment,
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
  // Calendar-day range filter (from exclusive, to inclusive) — used by the
  // orders tab's own date picker.
  if (req.query.from) orders = orders.filter((o) => myDateStr(new Date(o.createdAt)) > req.query.from);
  if (req.query.to) orders = orders.filter((o) => myDateStr(new Date(o.createdAt)) <= req.query.to);
  // Exact-timestamp range (sinceAt exclusive, uptoAt inclusive) — used by the
  // weekly report so it matches a settlement's own cutoffs exactly, instead
  // of the calendar-day filter above, which breaks when a settlement's
  // "since" and "to" fall on the same day (yields an always-empty range).
  if (req.query.sinceAt) orders = orders.filter((o) => o.createdAt > req.query.sinceAt);
  if (req.query.uptoAt) orders = orders.filter((o) => o.createdAt <= req.query.uptoAt);
  orders.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(orders);
});

app.delete('/api/admin/orders/:id', (req, res) => {
  const orders = db.getOrders().filter((o) => o.id !== req.params.id);
  db.saveOrders(orders);
  res.json({ ok: true });
});

// Fix a mistyped payment method or total on an existing order (e.g. the
// cashier picked the wrong button). Items/device/time are left alone.
app.put('/api/admin/orders/:id', (req, res) => {
  const { pay, total, items, device, createdAt } = req.body || {};
  if (pay !== '현금' && pay !== '터치앤고') {
    return res.status(400).json({ error: "pay must be '현금' or '터치앤고'" });
  }
  if (typeof total !== 'number' || Number.isNaN(total) || total <= 0) {
    return res.status(400).json({ error: 'total must be a positive number' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items must be a non-empty array' });
  }
  for (const it of items) {
    if (!it || typeof it.name !== 'string' || !it.name.trim()) {
      return res.status(400).json({ error: 'each item needs a name' });
    }
    if (typeof it.qty !== 'number' || Number.isNaN(it.qty) || it.qty <= 0) {
      return res.status(400).json({ error: 'each item needs a positive qty' });
    }
    if (it.price !== undefined && (typeof it.price !== 'number' || Number.isNaN(it.price) || it.price < 0)) {
      return res.status(400).json({ error: 'item price must be a non-negative number if given' });
    }
  }
  let createdAtIso;
  if (createdAt !== undefined) {
    const d = new Date(createdAt);
    if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'createdAt is not a valid date/time' });
    createdAtIso = d.toISOString();
  }
  const orders = db.getOrders();
  const idx = orders.findIndex((o) => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  orders[idx].pay = pay;
  orders[idx].total = total;
  orders[idx].items = items.map((it) => ({ name: it.name.trim(), qty: it.qty, price: typeof it.price === 'number' ? it.price : 0 }));
  orders[idx].device = device || null;
  if (createdAtIso) orders[idx].createdAt = createdAtIso;
  db.saveOrders(orders);
  res.json(orders[idx]);
});

app.get('/api/admin/expenses', (req, res) => {
  let expenses = db.getExpenses();
  if (req.query.date) expenses = expenses.filter((e) => e.date === req.query.date);
  // Calendar-day range filter (from exclusive, to inclusive) — used by the
  // expenses tab's own date picker.
  if (req.query.from) expenses = expenses.filter((e) => e.date > req.query.from);
  if (req.query.to) expenses = expenses.filter((e) => e.date <= req.query.to);
  // Exact-timestamp range (sinceAt exclusive, uptoAt inclusive) — used by the
  // weekly report so it matches a settlement's own cutoffs exactly. See the
  // matching comment on /api/admin/orders.
  if (req.query.sinceAt) expenses = expenses.filter((e) => e.createdAt > req.query.sinceAt);
  if (req.query.uptoAt) expenses = expenses.filter((e) => e.createdAt <= req.query.uptoAt);
  expenses.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(expenses);
});

app.delete('/api/admin/expenses/:id', (req, res) => {
  const expenses = db.getExpenses().filter((e) => e.id !== req.params.id);
  db.saveExpenses(expenses);
  res.json({ ok: true });
});

// Fix a mistyped expense (wrong category/amount/payment/memo) without
// deleting and re-entering it.
app.put('/api/admin/expenses/:id', (req, res) => {
  const { category, amount, payment, memo } = req.body || {};
  if (!category || typeof amount !== 'number' || Number.isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: 'category and a positive amount are required' });
  }
  if (!EXPENSE_PAYMENT_METHODS.includes(payment)) {
    return res.status(400).json({ error: `payment must be one of ${EXPENSE_PAYMENT_METHODS.join('|')}` });
  }
  const expenses = db.getExpenses();
  const idx = expenses.findIndex((e) => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  expenses[idx].category = category;
  expenses[idx].amount = amount;
  expenses[idx].payment = payment;
  expenses[idx].memo = memo || '';
  db.saveExpenses(expenses);
  res.json(expenses[idx]);
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
// beforeOrAt: optional ISO upper bound (inclusive), e.g. endOfDayIso('2026-11-15')
// when settling on Monday for Sunday's business — orders after that cutoff
// (Monday's own) are left for the next settlement instead of being swept in.
function recordedTotalsSince(sinceAt, beforeOrAt) {
  const orders = db.getOrders();
  let cash = 0, tng = 0;
  orders.forEach((o) => {
    if (sinceAt && o.createdAt <= sinceAt) return;
    if (beforeOrAt && o.createdAt > beforeOrAt) return;
    if (o.pay === '현금') cash += o.total;
    else if (o.pay === '터치앤고') tng += o.total;
  });
  return { cash, tng };
}

// Same window, but for money that left the drawer/wallet to pay for
// purchases — cash or TnG spent on 원재료/운영비/기타 reduces what should
// be on hand, so settlement needs to subtract this, not just add sales.
// 카드 (card) expenses don't touch cash/TnG on hand, so they're excluded.
function recordedExpensesSince(sinceAt, beforeOrAt) {
  const expenses = db.getExpenses();
  let cash = 0, tng = 0;
  expenses.forEach((e) => {
    if (sinceAt && e.createdAt <= sinceAt) return;
    if (beforeOrAt && e.createdAt > beforeOrAt) return;
    if (e.payment === '현금') cash += e.amount;
    else if (e.payment === '터치앤고') tng += e.amount;
  });
  return { cash, tng };
}

// Live preview: what's recorded since the last settlement, without settling.
app.get('/api/admin/settlement-status', (req, res) => {
  const settings = db.getSettings();
  // ?asOf=YYYY-MM-DD caps the recorded total to that business date — for
  // settling on Monday for Sunday's sales, so Monday's own orders (already
  // happened by the time you sit down to count) aren't swept in early.
  const beforeOrAt = req.query.asOf ? endOfDayIso(req.query.asOf) : undefined;
  const recorded = recordedTotalsSince(settings.settlement.at, beforeOrAt);
  const spent = recordedExpensesSince(settings.settlement.at, beforeOrAt);
  res.json({
    since: settings.settlement.date,
    lastActualCash: settings.settlement.actualCash,
    lastActualTng: settings.settlement.actualTng,
    lastActualBank: settings.settlement.actualBank || 0,
    recordedCash: recorded.cash,
    recordedTng: recorded.tng,
    recordedCashExpense: spent.cash,
    recordedTngExpense: spent.tng
  });
});

// Directly correct the "이전 잔액" baseline (e.g. the very first time, when
// nothing has ever been settled, or to fix a mistyped baseline) WITHOUT
// creating a settlement record or touching the recorded-sales window. If
// this is the very first baseline ever set (at is still null), we also set
// `at`/`date` to now so recordedTotalsSince starts counting from this point;
// otherwise the existing since-timestamp is left alone.
app.post('/api/admin/settlement-baseline', (req, res) => {
  const { actualCash, actualTng, actualBank, date } = req.body || {};
  if (typeof actualCash !== 'number' || typeof actualTng !== 'number' || Number.isNaN(actualCash) || Number.isNaN(actualTng)) {
    return res.status(400).json({ error: 'actualCash and actualTng must both be numbers' });
  }
  if (actualBank !== undefined && (typeof actualBank !== 'number' || Number.isNaN(actualBank))) {
    return res.status(400).json({ error: 'actualBank must be a number if provided' });
  }
  const settings = db.getSettings();
  const bankValue = typeof actualBank === 'number' ? actualBank : (settings.settlement.actualBank || 0);
  // "이전 잔액"은 반드시 어느 영업일 기준인지(date)와 같이 다녀야 그 다음부터
  // 들어온 매출/지출을 정확히 매칭해서 끌어올 수 있다. 이전에는 처음 한 번만
  // date를 정했고 그 뒤로는 고칠 방법이 없어서, 이전 잔액 금액을 고쳐도
  // 날짜가 안 맞으면 판매일-정산기준일 매칭이 어긋났다. 이제 저장할 때마다
  // date를 받아 같이 갱신한다 (안 주면 기존 날짜 유지, 처음이면 오늘).
  const settleDate = date || settings.settlement.date || todayStr();
  settings.settlement = {
    at: endOfDayIso(settleDate),
    date: settleDate,
    actualCash, actualTng, actualBank: bankValue
  };
  db.saveSettings(settings);
  res.json(settings.settlement);
});

// The owner counts the real drawer + checks the Touch 'n Go balance and
// submits both here. We compare against what the system recorded since the
// last settlement, log the result, and this becomes the new baseline.
// actualBank (은행 잔액) is optional and not reconciled against anything —
// it's just carried through to the youth-budget webhook below.
app.post('/api/admin/settlement', (req, res) => {
  const { actualCash, actualTng, actualBank, date } = req.body || {};
  if (typeof actualCash !== 'number' || typeof actualTng !== 'number' || Number.isNaN(actualCash) || Number.isNaN(actualTng)) {
    return res.status(400).json({ error: 'actualCash and actualTng must both be numbers' });
  }
  if (actualBank !== undefined && (typeof actualBank !== 'number' || Number.isNaN(actualBank))) {
    return res.status(400).json({ error: 'actualBank must be a number if provided' });
  }
  // date = the business day being settled (e.g. still Sunday's business when
  // settling on Monday morning) — defaults to today when not given. Orders
  // after that day's end are left for the next settlement, not counted here.
  const settleDate = date || todayStr();
  const beforeOrAt = endOfDayIso(settleDate);
  const settings = db.getSettings();
  const since = settings.settlement.date;
  const sinceAt = settings.settlement.at; // exact previous cutoff, for the report (see below)
  const recorded = recordedTotalsSince(sinceAt, beforeOrAt);
  const spent = recordedExpensesSince(sinceAt, beforeOrAt);
  // actualCash/actualTng are the full amount on hand right now ("최신 잔액"),
  // so what we expect them to be is last time's balance plus what came in
  // since, minus what went back out to pay for 현금/터치앤고 purchases —
  // not just the new sales on their own.
  const expectedCash = (settings.settlement.actualCash || 0) + recorded.cash - spent.cash;
  const expectedTng = (settings.settlement.actualTng || 0) + recorded.tng - spent.tng;
  const nowIso = new Date().toISOString();
  const bankValue = typeof actualBank === 'number' ? actualBank : (settings.settlement.actualBank || 0);
  const record = {
    id: uid(),
    createdAt: nowIso,
    date: settleDate,
    since,
    // Exact ISO bounds this settlement counted between — kept so the
    // weekly report's item/expense breakdown can use the identical window
    // instead of re-deriving it from the (since, date) calendar-day strings,
    // which go wrong whenever since and date fall on the same day.
    sinceAt: sinceAt || null,
    uptoAt: beforeOrAt,
    prevCash: settings.settlement.actualCash || 0,
    prevTng: settings.settlement.actualTng || 0,
    recordedCash: recorded.cash,
    recordedTng: recorded.tng,
    recordedCashExpense: spent.cash,
    recordedTngExpense: spent.tng,
    expectedCash,
    expectedTng,
    actualCash,
    actualTng,
    actualBank: bankValue,
    diffCash: actualCash - expectedCash,
    diffTng: actualTng - expectedTng
  };
  const settlements = db.getSettlements();
  settlements.push(record);
  db.saveSettlements(settlements);

  // The next settlement's lower bound is the end of the settled business
  // day, not this literal click time — so if today's (Monday's) orders have
  // already started coming in, they stay uncounted until the next
  // settlement instead of being swallowed into this one.
  settings.settlement = { at: beforeOrAt, date: record.date, actualCash, actualTng, actualBank: bankValue };
  db.saveSettings(settings);

  res.status(201).json(record);
});

app.get('/api/admin/settlements', (req, res) => {
  const settlements = db.getSettlements().slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(settlements);
});

// Explicit "정산 전송" action — only this pushes a settlement to the
// youth-budget finance site. Saving a settlement above does NOT do this
// automatically anymore, so the owner reviews the numbers first and sends
// on purpose. Safe to call again (e.g. after a webhook hiccup).
app.post('/api/admin/settlements/:id/send-to-finance', async (req, res) => {
  const settlements = db.getSettlements();
  const rec = settlements.find((s) => s.id === req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  try {
    await notifyYouthBudget(rec);
  } catch (e) {
    return res.status(502).json({ error: '파이낸스 전송 실패: ' + e.message });
  }
  rec.sentToFinance = true;
  rec.sentAt = new Date().toISOString();
  db.saveSettlements(settlements);
  res.json(rec);
});

// Fix a mistyped settlement. The recorded/expected figures from when it was
// first settled are kept as-is (they reflect that moment); only the actual
// counted amounts and the diff change. If this is the current baseline
// settlement, the live baseline is updated too so future settlements stay correct.
app.put('/api/admin/settlements/:id', (req, res) => {
  const { actualCash, actualTng, actualBank } = req.body || {};
  if (typeof actualCash !== 'number' || typeof actualTng !== 'number' || Number.isNaN(actualCash) || Number.isNaN(actualTng)) {
    return res.status(400).json({ error: 'actualCash and actualTng must both be numbers' });
  }
  if (actualBank !== undefined && (typeof actualBank !== 'number' || Number.isNaN(actualBank))) {
    return res.status(400).json({ error: 'actualBank must be a number if provided' });
  }
  const settlements = db.getSettlements();
  const rec = settlements.find((s) => s.id === req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });

  const expectedCash = rec.expectedCash != null ? rec.expectedCash : (rec.prevCash || 0) + rec.recordedCash;
  const expectedTng = rec.expectedTng != null ? rec.expectedTng : (rec.prevTng || 0) + rec.recordedTng;
  rec.actualCash = actualCash;
  rec.actualTng = actualTng;
  if (typeof actualBank === 'number') rec.actualBank = actualBank;
  rec.expectedCash = expectedCash;
  rec.expectedTng = expectedTng;
  rec.diffCash = actualCash - expectedCash;
  rec.diffTng = actualTng - expectedTng;
  db.saveSettlements(settlements);

  const settings = db.getSettings();
  if (settings.settlement.at === rec.createdAt) {
    settings.settlement.actualCash = actualCash;
    settings.settlement.actualTng = actualTng;
    if (typeof actualBank === 'number') settings.settlement.actualBank = actualBank;
    db.saveSettings(settings);
  }
  notifyYouthBudget(rec);
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
