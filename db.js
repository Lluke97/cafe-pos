// Tiny JSON-file "database". No native modules, no external DB server needed.
// Good enough for a single cafe's order volume on a single machine.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function filePath(name) {
  return path.join(DATA_DIR, name + '.json');
}

function readJSON(name, fallback) {
  const fp = filePath(name);
  if (!fs.existsSync(fp)) {
    fs.writeFileSync(fp, JSON.stringify(fallback, null, 2));
    return JSON.parse(JSON.stringify(fallback));
  }
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (e) {
    console.error('Failed to parse', fp, e);
    return JSON.parse(JSON.stringify(fallback));
  }
}

function writeJSON(name, data) {
  const fp = filePath(name);
  // write to a temp file then rename, so a crash mid-write can't corrupt the real file
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, fp);
}

const DEFAULT_MENU = [
  { id: 'hot',    name: 'Hot Coffee',   emoji: '☕',   price: 5.00, category: '음료' },
  { id: 'icecof', name: 'Ice Coffee',   emoji: '🧊☕', price: 7.00, category: '음료' },
  { id: 'icelat', name: 'Ice Latte',    emoji: '🧊🥛', price: 8.00, category: '음료' },
  { id: 'oj',     name: 'Orange Juice', emoji: '🍊',   price: 7.00, category: '음료' },
  { id: 'omija',  name: '오미자 Tea',    emoji: '🍵',   price: 7.00, category: '음료' },
  { id: 'cookie', name: 'Cookie',       emoji: '🍪',   price: 10.00, category: '디저트' }
];

// `settlement` is the last time the owner actually counted the cash drawer
// and checked the Touch 'n Go balance: { date, actualCash, actualTng, actualBank }.
// Everything since that date is "unsettled" — compared against what the
// system recorded — until the next settlement resets the baseline.
// actualBank (은행 잔액) isn't reconciled against anything recorded here —
// cafe-pos doesn't track bank transfers — it's just carried along so the
// youth-budget site gets the full cash/TnG/bank picture on each settlement.
const DEFAULT_SETTINGS = { settlement: { at: null, date: null, actualCash: 0, actualTng: 0, actualBank: 0 } };

module.exports = {
  getMenu: () => readJSON('menu', DEFAULT_MENU),
  saveMenu: (menu) => writeJSON('menu', menu),

  getOrders: () => readJSON('orders', []),
  saveOrders: (orders) => writeJSON('orders', orders),

  getExpenses: () => readJSON('expenses', []),
  saveExpenses: (expenses) => writeJSON('expenses', expenses),

  getSettings: () => Object.assign({}, DEFAULT_SETTINGS, readJSON('settings', DEFAULT_SETTINGS)),
  saveSettings: (settings) => writeJSON('settings', settings),

  getSettlements: () => readJSON('settlements', []),
  saveSettlements: (settlements) => writeJSON('settlements', settlements)
};
