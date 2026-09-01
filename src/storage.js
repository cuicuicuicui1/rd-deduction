// 极简 JSON 文件存储层(MVP 零依赖;后续可平滑替换为 SQLite)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// SEA 单文件打包模式:数据目录放在 exe 同级的 data/ 下(可携带、可备份)
// F2(审计):支持 RD_DATA_DIR 环境变量显式指定数据目录——测试/演示一律走隔离目录,
// 禁止测试脚本与生产共用同一 data/,防止"清空→灌测试数据"污染真实用户数据。
let isSea = false;
try { isSea = !!require('node:sea').isSea(); } catch {}
const DATA_DIR = process.env.RD_DATA_DIR
  ? path.resolve(process.env.RD_DATA_DIR)
  : isSea
    ? path.join(path.dirname(process.execPath), 'data')
    : path.join(__dirname, '..', 'data');
const FILES = {
  companies: 'companies.json',
  projects: 'projects.json',
  staff: 'staff.json',
  timesheets: 'timesheets.json',
  expenses: 'expenses.json',
  amortizations: 'amortizations.json',
  specialIncomes: 'specialIncomes.json',
  taxroll: 'taxroll.json',
  assets: 'assets.json', // 共用资源/设备台账(折旧分摊依据)
};

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function filePath(key) {
  return path.join(DATA_DIR, FILES[key]);
}

function loadAll(key) {
  ensureDir();
  const fp = filePath(key);
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveAll(key, arr) {
  ensureDir();
  fs.writeFileSync(filePath(key), JSON.stringify(arr, null, 2), 'utf8');
}

function uid(prefix) {
  return (prefix || 'id') + '_' + crypto.randomBytes(6).toString('hex');
}

function nextSeq(collection, prefix) {
  const max = collection.reduce((m, it) => {
    const n = parseInt(String(it.code || '').split('-').pop(), 10);
    return Number.isFinite(n) ? Math.max(m, n) : m;
  }, 0);
  return max + 1;
}

module.exports = {
  DATA_DIR,
  loadAll,
  saveAll,
  uid,
  nextSeq,
  reset() {
    // P3(审计):改为写入空数组,而非删除式清空——删除文件可能留下半清空状态(某文件删除失败则其余已删),
    // 写入空数组保证全集合原子地落到"空"且后续 loadAll 不依赖文件存在性。
    ensureDir();
    for (const k of Object.keys(FILES)) {
      saveAll(k, []);
    }
  },
};
