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

// 재고 항목 — 각 항목의 "최소 재고"(minQty) 밑으로 떨어지면 장사 끝나고
// 재고 입력할 때 "구매 필요"로 표시된다. 단위/최소 재고는 그냥 기본값이라
// 관리자가 재고 탭에서 언제든 고치거나 항목을 추가/삭제할 수 있다.
//
// type: 'count'(숫자로 세는 항목 — 원두/우유처럼 정확한 수량을 셀 수 있는
// 것) 또는 'request'(컵/빨대/휴지처럼 낱개로 세기 번거로운 소모품 — 수량
// 대신 그냥 "구매 요청"만 보낼 수 있다).
const DEFAULT_INVENTORY_ITEMS = [
  { id: 'inv_coffeebean', name: '원두',     unit: 'kg', minQty: 1,  type: 'count' },
  { id: 'inv_milk',       name: '우유',     unit: 'L',  minQty: 2,  type: 'count' },
  { id: 'inv_omija',      name: '오미자',   unit: '병', minQty: 1,  type: 'count' },
  { id: 'inv_juice',      name: '주스',     unit: '병', minQty: 1,  type: 'count' },
  { id: 'inv_ice',        name: '얼음',     unit: '봉', minQty: 2,  type: 'count' },
  { id: 'inv_icecup',     name: '아이스컵', unit: '개', minQty: 20, type: 'request' },
  { id: 'inv_hotcup',     name: '핫 컵',    unit: '개', minQty: 20, type: 'request' },
  { id: 'inv_straw',      name: '빨대',     unit: '개', minQty: 30, type: 'request' },
  { id: 'inv_tissue',     name: '휴지',     unit: '개', minQty: 1,  type: 'request' }
];

// 이름으로 보고 request형이어야 할 것 같은 항목들 — 이미 저장된(type이 없는
// 예전) 데이터를 보정할 때만 쓰는 기준.
const REQUEST_TYPE_NAMES = ['아이스컵', '핫 컵', '핫컵', '빨대', '휴지'];

module.exports = {
  getMenu: () => readJSON('menu', DEFAULT_MENU),
  saveMenu: (menu) => writeJSON('menu', menu),

  getOrders: () => readJSON('orders', []),
  saveOrders: (orders) => writeJSON('orders', orders),

  getExpenses: () => readJSON('expenses', []),
  saveExpenses: (expenses) => writeJSON('expenses', expenses),

  // type이 없는 기존 데이터(이 기능을 처음 추가했을 때 저장된 것)는 읽을
  // 때 이름 기준으로 한 번 보정해서 저장해준다 — 그래야 이미 돌아가고
  // 있던 서버도 재배포만으로 request형 항목이 자동으로 구분된다.
  getInventoryItems: () => {
    const items = readJSON('inventoryItems', DEFAULT_INVENTORY_ITEMS);
    let changed = false;
    items.forEach((it) => {
      if (!it.type) {
        it.type = REQUEST_TYPE_NAMES.includes(it.name) ? 'request' : 'count';
        changed = true;
      }
    });
    if (changed) writeJSON('inventoryItems', items);
    return items;
  },
  saveInventoryItems: (items) => writeJSON('inventoryItems', items),

  // 재고 기록(로그) — 재고를 셀 때마다(보통 장사 끝나고 한 번) 그날 날짜로
  // 항목별 수량 한 줄씩. 같은 항목+같은 날짜에 다시 입력하면 그 줄을
  // 덮어쓴다(하루에 여러 번 고쳐도 중복으로 쌓이지 않도록). count형
  // 항목에만 쓰인다.
  getInventoryLogs: () => readJSON('inventoryLogs', []),
  saveInventoryLogs: (logs) => writeJSON('inventoryLogs', logs),

  // 구매 요청 — request형 항목(컵/빨대/휴지 등)을 "수량 대신 그냥 부족하다"고
  // 알리는 기록. 관리자가 재고 탭에서 보고 사 온 뒤 처리완료로 닫는다.
  getInventoryRequests: () => readJSON('inventoryRequests', []),
  saveInventoryRequests: (requests) => writeJSON('inventoryRequests', requests),

  getSettings: () => Object.assign({}, DEFAULT_SETTINGS, readJSON('settings', DEFAULT_SETTINGS)),
  saveSettings: (settings) => writeJSON('settings', settings),

  getSettlements: () => readJSON('settlements', []),
  saveSettlements: (settlements) => writeJSON('settlements', settlements)
};
