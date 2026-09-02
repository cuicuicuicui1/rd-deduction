// 研发费用加计扣除合规管理系统 —— 服务入口
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const archiver = require('archiver');
const storage = require('./src/storage');
const constants = require('./src/constants');
const { computeSummary, computeCalibers, capitalFormedForProject, buildA107012, buildYearlyCollection } = require('./src/summary');
const { computeTaxSaving, computeRefundScenarios } = require('./src/tax');
const { buildLedger, ledgerGrandTotal, round2 } = require('./src/ledger');
const { buildLedger97 } = require('./src/ledger97');
const { runRiskCheck, LEVELS } = require('./src/risk');
const { exportLedger, exportSummary, exportA107012, exportYearlyCollection, exportLedger97Workbook, toBuffer } = require('./src/export');
const { riskReportHtml, expensesCsv, staffCsv, timesheetsCsv, specialIncomesCsv, taxrollCsv, assetsCsv } = require('./src/report');
const { POLICIES_DB, policyStatus, checkOnline } = require('./src/policy');

// 是否单文件打包模式(Node SEA):是 → 静态资源从内嵌清单释放到临时目录,数据目录跟随 exe
let isSea = false;
try { isSea = !!require('node:sea').isSea(); } catch {}
const WEB_DIR = isSea
  ? (() => {
      const dir = path.join(os.tmpdir(), 'rd-deduction-web');
      try {
        const assets = require('./src/embedded_assets');
        for (const [rel, content] of Object.entries(assets)) {
          const p = path.join(dir, rel);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, content, 'utf8');
        }
      } catch (e) { console.error('⚠ 内嵌资源释放失败: ' + e.message); }
      return dir;
    })()
  : path.join(__dirname, 'public');

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(WEB_DIR));

// async 路由统一错误处理(express 4 不捕获 async 异常,否则会崩进程)
const ah = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
  console.error('[route error]', e.message);
  if (!res.headersSent) res.status(500).json({ error: e.message });
  else res.end();
});

// 不可加计关键词拦截(发现10):摘要命中关键词时拒绝录入;
// 特例——「水电」若记在「直接投入(direct)」类别下,属于研发直接消耗的动力费(119号/40号口径:直接投入含燃料和动力费),
// 允许录入(合法研发动力费);记在其他类别下仍拦截(办公室水电/物业管理水电等不得加计)。
function blockedKeyword(summary, category) {
  const s = String(summary || '');
  const hit = constants.NON_DEDUCTIBLE_KEYWORDS.find(k => s.includes(k));
  if (!hit) return null;
  if (hit === '水电' && category === 'direct') return null; // 研发动力费(direct)放行
  return hit;
}

// 凭证附件静态服务(data/attachments/{expenseId}/文件)
const ATT_DIR = path.join(storage.DATA_DIR, 'attachments');
app.use('/attachments', express.static(ATT_DIR));

// 风险报告「关键指标快照」:汇总加计口径关键数字 + 六大类费用构成
function buildRiskSnapshot(d, company, year) {
  const det = computeSummary({ ...d, company, year }).detail;
  const cal = computeCalibers({ ...d, company, year });
  const tax = computeTaxSaving({ ...d, company, year });
  const SIX = [
    { key: 'personnel', name: '人员人工费用' },
    { key: 'direct', name: '直接投入费用' },
    { key: 'depreciation', name: '折旧费用' },
    { key: 'amortization', name: '无形资产摊销' },
    { key: 'design', name: '新产品设计费等' },
    { key: 'other', name: '其他相关费用' },
  ];
  const raw = det.categoryActual || {};
  const rawCap = det.categoryActualCap || {};
  return {
    eligible: det.eligible !== false,
    ineligibleReason: det.ineligibleReason || '',
    accounting: cal.accounting,
    deductionBase: det.totalExpenseBase,
    amortAmount: det.amortAmount,
    totalAdd: det.totalAdd,
    taxSaving: tax.saving,
    taxRateNote: tax.rateNote,
    entrustDomestic: det.entrustDomesticOrg + det.entrustDomesticPerson,
    entrustOverseas: det.entrustOverseas,
    entrustDomesticRaw: round2((det.entrustDomesticOrg + det.entrustDomesticPerson) / constants.POLICIES.entrustDomesticRatio),
    entrustOverseasRaw: round2(det.entrustOverseasRaw / constants.POLICIES.entrustOverseasRatio),
    otherDeductible: det.otherDeductible,
    otherLimit: det.otherLimit,
    specialIncome: det.specialIncomeDeducted,
    categoryTable: SIX.map(s => ({ name: s.name, amount: round2((raw[s.key] || 0) + (rawCap[s.key] || 0)) })),
  };
}

const PORT = Number(process.env.PORT || 8765);
const HOST = '127.0.0.1';

// ---------- 通用 CRUD ----------
const ALL_KEYS = ['companies', 'projects', 'staff', 'timesheets', 'expenses', 'amortizations', 'specialIncomes', 'taxroll', 'assets'];
// expenses 走独立路由(金额/类别/关键词校验+自动补 period),其余集合走通用 CRUD
const KEYS = ALL_KEYS.filter(k => k !== 'expenses');

// ---------- 数据备份(启动自动备份 + 手动备份 + 一键恢复) ----------
const BACKUP_DIR = path.join(storage.DATA_DIR, 'backups');
const BACKUP_KEEP = 30; // 保留最近 30 份(自动备份+手动备份),防止测试/频繁操作挤掉历史备份

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return;
  const st = fs.statSync(src);
  if (!st.isDirectory()) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return;
  }
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    copyDir(path.join(src, f), path.join(dst, f));
  }
}

function dirSize(p) {
  let size = 0;
  for (const f of fs.readdirSync(p)) {
    const s = path.join(p, f);
    size += fs.statSync(s).isDirectory() ? dirSize(s) : fs.statSync(s).size;
  }
  return size;
}

function hasData() {
  for (const key of ALL_KEYS) if (fs.existsSync(path.join(storage.DATA_DIR, key + '.json'))) return true;
  return fs.existsSync(ATT_DIR) && fs.readdirSync(ATT_DIR).length > 0;
}

function backupNow(tag) {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const name = 'backup_' + stamp + (tag ? '_' + tag : '');
  const dir = path.join(BACKUP_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const key of ALL_KEYS) {
    const fp = path.join(storage.DATA_DIR, key + '.json');
    if (fs.existsSync(fp)) fs.copyFileSync(fp, path.join(dir, key + '.json'));
  }
  copyDir(ATT_DIR, path.join(dir, 'attachments'));
  const all = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter(n => n.startsWith('backup_')).sort() : [];
  // 超限时优先清理 auto 自动备份,手动备份尽量保留(防止测试/误操作挤掉用户手动备份)
  while (all.length > BACKUP_KEEP) {
    const auto = all.filter(n => n.includes('_auto'));
    const target = auto.length ? auto[0] : all[0];
    fs.rmSync(path.join(BACKUP_DIR, target), { recursive: true, force: true });
    all.splice(all.indexOf(target), 1);
  }
  return name;
}

function restoreFrom(name) {
  const src = path.join(BACKUP_DIR, name);
  if (!/^backup_/.test(name) || !fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new Error('备份不存在: ' + name);
  storage.reset();
  if (fs.existsSync(ATT_DIR)) fs.rmSync(ATT_DIR, { recursive: true, force: true });
  for (const f of fs.readdirSync(src)) {
    if (f === 'backups') continue;
    copyDir(path.join(src, f), path.join(storage.DATA_DIR, f));
  }
  return name;
}

app.get('/api/backups', (req, res) => {
  if (!fs.existsSync(BACKUP_DIR)) return res.json({ backups: [] });
  const list = fs.readdirSync(BACKUP_DIR)
    .filter(n => n.startsWith('backup_') && fs.statSync(path.join(BACKUP_DIR, n)).isDirectory())
    .map(n => {
      const m = /^backup_(\d{8})_(\d{6})(?:_(.+))?$/.exec(n);
      return {
        name: n,
        time: m ? `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)} ${m[2].slice(0, 2)}:${m[2].slice(2, 4)}` : '',
        tag: m && m[3] ? m[3] : '',
        size: dirSize(path.join(BACKUP_DIR, n)),
      };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
  res.json({ backups: list, keep: BACKUP_KEEP });
});

app.post('/api/backup/create', (req, res) => {
  const name = backupNow(req.body && req.body.tag);
  res.json({ ok: true, name });
});

app.post('/api/backup/restore', (req, res) => {
  const name = req.body && req.body.name;
  if (!name) return res.status(400).json({ error: '缺少备份名' });
  try { restoreFrom(name); res.json({ ok: true, restored: name }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// 通用集合业务校验(NaN/Infinity/负数/必填,防止脏数据入库)
const COLLECTION_VALIDATORS = {
  specialIncomes: b => {
    if (typeof b.amount === 'number' && (!Number.isFinite(b.amount) || b.amount < 0)) return '特殊收入金额无效';
  },
  amortizations: b => {
    if (typeof b.amount === 'number' && (!Number.isFinite(b.amount) || b.amount <= 0)) return '摊销金额无效';
    if (b.year !== undefined && !(Number(b.year) >= 2000 && Number(b.year) <= 2100)) return '摊销年度无效';
    if (b.formationYear !== undefined && !(Number(b.formationYear) >= 2000 && Number(b.formationYear) <= 2100)) return '形成年度无效';
  },
  timesheets: b => {
    for (const k of ['rdHours', 'totalHours']) if (typeof b[k] === 'number' && (!Number.isFinite(b[k]) || b[k] < 0)) return `${k} 无效`;
    if (typeof b.rdHours === 'number' && typeof b.totalHours === 'number' && b.rdHours > b.totalHours) return '研发工时不能大于总工时';
  },
  assets: b => {
    for (const k of ['depreciation', 'rdHours', 'totalHours']) if (typeof b[k] === 'number' && (!Number.isFinite(b[k]) || b[k] < 0)) return `${k} 无效`;
  },
  projects: b => {
    if (b.code !== undefined && b.code !== '' && !String(b.code).trim()) return '项目编号不能为空白';
    if (!b.code && !b.name) return '项目编号与名称不能同时为空';
  },
};
KEYS.forEach(key => {
  app.get(`/api/${key}`, (req, res) => res.json(storage.loadAll(key)));
  const validate = (req, res, merged) => {
    const b = merged || req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b)) return res.status(400).json({ error: '请求体无效(需 JSON 对象)' });
    if (Object.keys(b).length === 0) return res.status(400).json({ error: '请求体不能为空' });
    for (const v of Object.values(b)) {
      if (typeof v === 'number' && !Number.isFinite(v)) return res.status(400).json({ error: '数值字段无效(不允许 NaN/Infinity)' });
      if (typeof v === 'string' && /^(NaN|Infinity|-Infinity)$/.test(v.trim())) return res.status(400).json({ error: `数值字段无效:「${v.trim()}」` });
    }
    const vf = COLLECTION_VALIDATORS[key];
    if (vf) { const err = vf(b); if (err) return res.status(400).json({ error: err }); }
    // 发现2:amortizations/specialIncomes 必须校验项目存在(防幽灵记录虚增行43/特殊收入)——与 expenses 录入端防线对齐
    if (key === 'amortizations' || key === 'specialIncomes') {
      if (!b.projectId) return res.status(400).json({ error: `缺少项目(projectId)——${key} 必须挂接项目` });
      const projExist = storage.loadAll('projects').some(p => p.id === b.projectId);
      if (!projExist) return res.status(400).json({ error: `项目不存在:${b.projectId || '(空)'}——请先录入该项目` });
    }
    return null;
  };
  app.post(`/api/${key}`, (req, res) => {
    const bad = validate(req, res);
    if (bad) return;
    const arr = storage.loadAll(key);
    const item = { id: storage.uid(key.slice(0, -1)), ...req.body };
    arr.push(item);
    storage.saveAll(key, arr);
    res.status(201).json(item);
  });
  app.put(`/api/${key}/:id`, (req, res) => {
    const arr = storage.loadAll(key);
    const i = arr.findIndex(x => x.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: 'not found' });
    const bad = validate(req, res, { ...arr[i], ...req.body }); // merged:PUT 部分字段也能交叉校验(如 rdHours>totalHours)
    if (bad) return;
    arr[i] = { ...arr[i], ...req.body, id: req.params.id };
    storage.saveAll(key, arr);
    res.json(arr[i]);
  });
  app.delete(`/api/${key}/:id`, (req, res) => {
    const arr = storage.loadAll(key).filter(x => x.id !== req.params.id);
    storage.saveAll(key, arr);
    res.json({ ok: true });
  });
});

// 费用单条保存:与批量导入同规格校验(补 period、金额/类别校验、不可加计关键词拦截)
// 修复:裸 CRUD 下漏传 period 的费用在列表页不可见(renderExpenses 按 period.startsWith(year) 过滤)
app.get('/api/expenses', (req, res) => res.json(storage.loadAll('expenses')));
app.post('/api/expenses', (req, res) => {
  const b = req.body || {};
  try {
    const amt = Number(b.amount);
    if (!Number.isFinite(amt) || amt <= 0 || typeof b.amount === 'boolean') throw new Error(`金额无效:${b.amount}`);
    if (!constants.CATEGORY_MAP[b.category]) throw new Error(`费用类别无效:${b.category}`);
    const hit = blockedKeyword(b.summary, b.category);
    if (hit) throw new Error(`摘要命中不可计入项关键词「${hit}」(培训/房屋折旧/物业水电/招待/商业保险等不得加计)`);
    const date = normDate(b.date || '');
    if (!isValidDate(date)) throw new Error('缺少有效日期(YYYY-MM-DD,须为真实日期)');
    // P1:单条保存校验项目存在(防止项目误删后费用悬空/孤儿)
    const projExist = storage.loadAll('projects').some(p => p.id === b.projectId);
    if (!projExist) throw new Error(`项目不存在:${b.projectId || '(空)'}——请先录入该项目`);
    const arr = storage.loadAll('expenses');
    // H1 幂等:完全相同的费用(项目+日期+类别+金额+摘要)重复提交时返回已有记录,不产生重复
    const fp = JSON.stringify({
      projectId: b.projectId || '', date,
      category: b.category, amount: amt,
      summary: String(b.summary || '').trim(),
    });
    const dup = arr.find(e => JSON.stringify({
      projectId: e.projectId || '', date: e.date,
      category: e.category, amount: Number(e.amount),
      summary: String(e.summary || '').trim(),
    }) === fp);
    if (dup) {
      return res.status(200).json({ ...dup, deduplicated: true, id: dup.id });
    }
    const item = {
      id: storage.uid('e'), ...b,
      amount: amt,
      date,
      period: b.period || date.slice(0, 7),
      capitalization: b.capitalization === 'capitalize' ? 'capitalize' : 'expense',
      isShared: b.allocMethod === 'ratioHours' || b.allocMethod === 'ratioCustom',
      alloc: b.alloc || {},
    };
    arr.push(item);
    storage.saveAll('expenses', arr);
    res.status(201).json(item);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.put('/api/expenses/:id', (req, res) => {
  const arr = storage.loadAll('expenses');
  const i = arr.findIndex(x => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  if (b.amount !== undefined) {
    const amt = Number(b.amount);
    if (!Number.isFinite(amt) || amt <= 0 || typeof b.amount === 'boolean') return res.status(400).json({ error: `金额无效:${b.amount}` });
    b.amount = amt;
  }
  if (b.category !== undefined && !constants.CATEGORY_MAP[b.category]) return res.status(400).json({ error: `费用类别无效:${b.category}` });
  if (b.summary !== undefined) {
    const hit = blockedKeyword(b.summary, b.category !== undefined ? b.category : arr[i].category);
    if (hit) return res.status(400).json({ error: `摘要命中不可计入项关键词「${hit}」` });
  }
  if (b.date !== undefined) {
    const dd = normDate(b.date);
    if (!isValidDate(dd)) return res.status(400).json({ error: '日期格式无效(须为真实日期)' });
    b.date = dd;
    if (!b.period) b.period = dd.slice(0, 7);
  }
  arr[i] = { ...arr[i], ...b, id: req.params.id };
  storage.saveAll('expenses', arr);
  res.json(arr[i]);
});
app.delete('/api/expenses/:id', (req, res) => {
  const arr = storage.loadAll('expenses').filter(x => x.id !== req.params.id);
  storage.saveAll('expenses', arr);
  // F4(审计):删除费用必须同步清理其附件目录,否则残留孤儿附件污染磁盘卫生与备查包整洁度。
  // 附件目录即以费用 id 命名;一律校验 id 为系统生成格式(e_<hex>),杜绝路径穿越。
  if (/^e_[0-9a-f]{12}$/i.test(String(req.params.id))) {
    const attDir = path.join(ATT_DIR, req.params.id);
    if (fs.existsSync(attDir)) fs.rmSync(attDir, { recursive: true, force: true });
  }
  res.json({ ok: true });
});

// 费用批量粘贴导入(格式:日期|项目编号|类别key|金额|摘要|期间|分摊方法|支出类型|凭证号|发票号|付款方式)
// 支持跳过 # 注释行与表头行(含「日期」与「项目编号」)
app.post('/api/expenses/batch', (req, res) => {
  const { lines } = req.body || {};
  if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: 'lines 不能为空' });
  const projects = storage.loadAll('projects');
  const projByCode = Object.fromEntries(projects.map(p => [p.code, p]));
  const arr = storage.loadAll('expenses');
  let ok = 0, errors = [];
  lines.forEach((ln, i) => {
    try {
      const line = String(ln).trim();
      if (!line || line.startsWith('#')) return;
      if (line.includes('日期') && line.includes('项目编号')) return; // 表头行
      const [date, code, category, amount, summary, period, allocMethod, capitalization, voucherNo, invoiceNo, paymentMethod] =
        line.split('|').map(s => (s || '').trim());
      const proj = projByCode[code];
      if (!proj) throw new Error(`项目编号不存在:${code}`);
      if (!constants.CATEGORY_MAP[category]) throw new Error(`费用类别无效:${category}`);
      const amt = Number(amount);
      if (!Number.isFinite(amt) || amt <= 0) throw new Error(`金额无效:${amount}`);
      const hit = blockedKeyword(summary, category);
      if (hit) throw new Error(`摘要命中不可计入项关键词「${hit}」(培训/房屋折旧/物业水电/招待/商业保险等不得加计)`);
      if (date && !isValidDate(date)) throw new Error(`日期无效:${date}(须为真实日期 YYYY-MM-DD)`);
      arr.push({
        id: storage.uid('e'), projectId: proj.id, category, amount: amt,
        summary: summary || '', period: period || date.slice(0, 7), date: date || '',
        allocMethod: allocMethod || 'direct', isShared: allocMethod === 'ratioHours' || allocMethod === 'ratioCustom',
        capitalization: capitalization === '资本化' || capitalization === 'capitalize' ? 'capitalize' : 'expense',
        voucherNo, invoiceNo, contractNo: '', paymentMethod: paymentMethod || '银行转账',
        allocNote: allocMethod && allocMethod !== 'direct' ? '批量导入' : '', alloc: {},
      });
      ok++;
    } catch (e) {
      errors.push(`第${i + 1}行:${e.message}`);
    }
  });
  storage.saveAll('expenses', arr);
  res.json({ ok, errors, total: arr.length });
});

// 工时批量粘贴导入
// ① 矩阵模式(Excel 直贴/模板下载):首行表头含「姓名」与 YYYY-MM 月份列,行=人员×项目,单元格=研发工时,总工时缺省160(可加「总工时」列)
// ② 竖排模式(原格式):人员姓名或id|月份|项目编号|研发工时|总工时
app.post('/api/timesheets/batch', (req, res) => {
  const { lines } = req.body || {};
  if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: 'lines 不能为空' });
  const staff = storage.loadAll('staff');
  const projects = storage.loadAll('projects');
  const staffByName = Object.fromEntries(staff.map(s => [s.name, s]));
  const staffById = Object.fromEntries(staff.map(s => [s.id, s]));
  const projByCode = Object.fromEntries(projects.map(p => [p.code, p]));
  const arr = storage.loadAll('timesheets');
  let ok = 0, errors = [];
  const clean = lines.map(l => String(l).replace(/\r$/, '').trim()).filter(l => l && !l.startsWith('#'));
  const first = clean.find(l => l.includes('姓名')) || '';
  const headCells = first.split(/\t|,/).map(s => s.trim());
  const matrix = headCells.length > 2 && headCells.some(h => /^\d{4}-\d{2}$/.test(h)) && headCells[0].includes('姓名');

  if (matrix) {
    // 表头:姓名 | 部门 | 项目编号 | YYYY-MM… | (可选)总工时
    const monthIdx = headCells.map((h, i) => (/^\d{4}-\d{2}$/.test(h) ? i : -1)).filter(i => i >= 0);
    const totalIdx = headCells.findIndex(h => h.includes('总工时'));
    const dataLines = clean.slice(1);
    dataLines.forEach((ln, i) => {
      try {
        const cells = ln.split(/\t|,/).map(s => s.trim());
        const pp = staffByName[cells[0]] || staffById[cells[0]];
        if (!pp) throw new Error(`人员不存在:${cells[0]}`);
        const proj = projByCode[cells[2]];
        if (!proj) throw new Error(`项目编号不存在:${cells[2]}`);
        const tot = totalIdx >= 0 && cells[totalIdx] !== '' ? Number(cells[totalIdx]) : 160;
        if (!Number.isFinite(tot) || tot < 0) throw new Error(`总工时无效:${cells[totalIdx]}`);
        let rowOk = 0;
        monthIdx.forEach(mi => {
          const v = cells[mi];
          if (v === '' || v === undefined) return;
          const rd = Number(v);
          if (!Number.isFinite(rd) || rd < 0) throw new Error(`月份 ${headCells[mi]} 工时无效:${v}`);
          if (rd <= 0) return;
          if (rd > tot) throw new Error(`研发工时(${rd})不能大于总工时(${tot})`);
          if (arr.some(t => t.staffId === pp.id && t.projectId === proj.id && t.period === headCells[mi]))
            throw new Error(`该人员该项目该月份工时已存在,请勿重复导入`);
          arr.push({
            id: storage.uid('t'), staffId: pp.id, staffName: pp.name,
            projectId: proj.id, period: headCells[mi], rdHours: rd, totalHours: tot,
          });
          rowOk++; ok++;
        });
        if (!rowOk) throw new Error('该行未填写任何月份工时');
      } catch (e) {
        errors.push(`第${i + 1}行:${e.message}`);
      }
    });
  } else {
    clean.forEach((ln, i) => {
      try {
        const [staffRef, period, code, rdHours, totalHours] = ln.split('|').map(s => (s || '').trim());
        const pp = staffByName[staffRef] || staffById[staffRef];
        if (!pp) throw new Error(`人员不存在:${staffRef}`);
        if (!/^\d{4}-\d{2}$/.test(period || '')) throw new Error(`月份格式应为 YYYY-MM:${period}`);
        const proj = projByCode[code];
        if (!proj) throw new Error(`项目编号不存在:${code}`);
        const rd = Number(rdHours), tot = Number(totalHours);
        if (!Number.isFinite(rd) || rd < 0) throw new Error(`研发工时无效:${rdHours}`);
        if (!Number.isFinite(tot) || tot < 0) throw new Error(`总工时无效:${totalHours}`);
        if (rd > tot) throw new Error(`研发工时(${rd})不能大于总工时(${tot})`);
        if (arr.some(t => t.staffId === pp.id && t.projectId === proj.id && t.period === period))
          throw new Error(`该人员该项目该月份工时已存在,请勿重复导入`);
        arr.push({
          id: storage.uid('t'), staffId: pp.id, staffName: pp.name,
          projectId: proj.id, period, rdHours: rd, totalHours: tot,
        });
        ok++;
      } catch (e) {
        errors.push(`第${i + 1}行:${e.message}`);
      }
    });
  }
  storage.saveAll('timesheets', arr);
  res.json({ ok, errors, total: arr.length });
});

// 导入模板 .xlsx 生成(数据表 + 填写说明表),构建时注入 server.js
async function buildTemplateXlsx(kind, year, staff, projects, months) {
  const exCode = (projects[0] || {}).code || 'YYYY-RD-01';
  let headers = [], example = [], noteRows = [], xname = '';
  const notes = (rows) => { noteRows = rows; };
  if (kind === 'timesheets') {
    headers = ['姓名', '部门', '项目编号', ...months, '总工时'];
    example = ['张三', '研发部', exCode, ...months.map(() => ''), 160];
    xname = `工时矩阵导入模板_${year}.xlsx`;
    notes([
      ['姓名', '必填', '研发人员姓名', '与个税/社保申报名单一致;仅“是否直接研发=是”的人员需要填工时'],
      ['部门', '选填', '部门名称', ''],
      ['项目编号', '必填', exCode, '须与「研发项目」页的项目编号一致,不一致的行导入时会报错'],
      [ '月份列(共12列)', '选填', '当月研发工时数(数字)', months.map(mo => `列 ${mo}:空白=该月未参与此项目`).join('; ') ],
      ['总工时', '选填', '160', '缺省 160,可按月修改;与各月列不必一致,系统按实际工时比例分摊'],
    ]);
  } else if (kind === 'expenses') {
    headers = ['日期', '项目编号', '类别key', '金额', '摘要', '期间', '分摊方法', '支出类型', '凭证号', '发票号', '付款方式'];
    example = [`${year}-01-15`, exCode, 'personnel', 50000, '示例:1月研发人员工资', `${year}-01`, 'direct', '费用化', `记-${year}-001`, `FP-${year}-001`, '银行转账'];
    xname = `费用导入模板_${year}.xlsx`;
    notes([
      ['日期', '必填', 'YYYY-MM-DD', '费用发生日期'],
      ['项目编号', '必填', exCode, `可选值:${projects.map(p => p.code).join('、') || '(请先在「研发项目」页录入项目)'}`],
      ['类别key', '必填', 'personnel', constants.EXPENSE_CATEGORIES.map(c => `${c.key}=${c.name}`).join('; ')],
      ['金额', '必填', '数字(元)', '正数'],
      ['摘要', '必填', '费用用途简述', `摘要命中「${constants.NON_DEDUCTIBLE_KEYWORDS.join('/')}」将被拒绝(不可计入研发费用)`],
      ['期间', '必填', 'YYYY-MM', '费用归属月份'],
      ['分摊方法', '选填', 'direct / ratioHours / ratioCustom', 'direct=直接归集;ratioHours=按研发工时比例分摊;ratioCustom=按自定义权重分摊'],
      ['支出类型', '选填', '费用化 / 资本化', '资本化项目须先在「研发项目」页设为资本化'],
      ['凭证号 / 发票号 / 付款方式', '选填', '如 记-2026-001 / FP-2026-001 / 银行转账', ''],
    ]);
  } else if (kind === 'staff') {
    headers = ['姓名', '部门', '岗位', '入职日期', '是否直接研发'];
    example = ['张三', '研发部', '软件工程师', `${year}-03-01`, '是'];
    xname = `人员导入模板_${year}.xlsx`;
    notes([
      ['姓名', '必填', '人员姓名', '与个税/社保申报名单一致'],
      ['部门', '选填', '部门名称', ''],
      ['岗位', '选填', '岗位名称', ''],
      ['入职日期', '必填', 'YYYY-MM-DD', ''],
      ['是否直接研发', '必填', '是 / 否', '是=直接从事研发活动,计入加计人员人工费用'],
    ]);
  } else if (kind === 'projects') {
    headers = ['项目编号', '项目名称', '研发形式', '成果归属', '活动类型', '开始日期', '结束日期', '状态', '费用化/资本化', '立项审批日期', '有立项决议', '有研发计划书', '备注'];
    example = [`${year}-RD-01`, '示例:新型控制系统研发', '自主研发', '成果归本企业', '电子信息技术', `${year}-01-01`, `${year}-12-31`, '进行中', 'expense', `${year}-01-15`, '是', '是', ''];
    xname = `研发项目导入模板_${year}.xlsx`;
    notes([
      ['项目编号', '必填', `${year}-RD-01`, '唯一,后续费用/工时按此编号关联'],
      ['项目名称', '必填', '项目全称', ''],
      ['研发形式', '必填', '自主研发', constants.PROJECT_FORMS.map(f => f.name).join('; ')],
      ['成果归属', '选填', '成果归本企业', '成果归客户(受托开发)整项目不得加计'],
      ['活动类型', '选填', '电子信息技术', '负面活动(常规性升级/售后服务等)不可加计'],
      ['开始日期 / 结束日期', '必填', 'YYYY-MM-DD', ''],
      ['状态', '选填', '进行中', ''],
      ['费用化/资本化', '必填', 'expense / capitalize', 'capitalize=形成无形资产的成本,转入摊销台账'],
      ['立项审批日期', '选填', 'YYYY-MM-DD', '决议日期应早于第一笔费用发生日'],
      ['有立项决议 / 有研发计划书', '选填', '是 / 否', '归档备查资料用'],
      ['备注', '选填', '', ''],
    ]);
  } else if (kind === 'specialIncomes') {
    headers = ['项目编号', '类型', '金额', '日期', '归属期间', '摘要'];
    example = [exCode, '下脚料销售', 1200, `${year}-03-31`, `${year}-03`, '研发过程产生下脚料销售'];
    xname = `特殊收入导入模板_${year}.xlsx`;
    notes([
      ['项目编号', '必填', exCode, ''],
      ['类型', '必填', '下脚料销售', constants.SPECIAL_INCOME_TYPES.map(t => t.name).join(' / ')],
      ['金额', '必填', '数字(元)', '特殊收入需冲减研发费用加计基数'],
      ['日期', '必填', 'YYYY-MM-DD', ''],
      ['归属期间', '必填', 'YYYY-MM', '冲减退回月份'],
      ['摘要', '选填', '', ''],
    ]);
  } else if (kind === 'amortizations') {
    headers = ['项目编号', '年度', '金额', '形成年度', '备注'];
    example = [exCode, Number(year), 100000, Number(year) - 1, `资本化项目${year}年摊销`];
    xname = `资本化摊销导入模板_${year}.xlsx`;
    notes([
      ['项目编号', '必填', exCode, '仅资本化项目需要'],
      ['年度', '必填', year, '摊销归属年度'],
      ['金额', '必填', '数字(元)', '本年摊销额(系统按 200% 加计)'],
      ['形成年度', '选填', String(Number(year) - 1), '无形资产达到预定可使用状态的年度;留空由系统按费用形成年度推断'],
      ['备注', '选填', '', ''],
    ]);
  } else {
    return null;
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('填写');
  ws.addRow(headers);
  ws.addRow(example);
  const hr = ws.getRow(1);
  hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
  hr.alignment = { vertical: 'middle', horizontal: 'center' };
  ws.getRow(2).font = { color: { argb: 'FF6B7280' } };
  ws.getRow(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  headers.forEach((h, i) => {
    ws.getColumn(i + 1).width = i === 0 ? 16 : i === 1 ? 24 : (String(h).length <= 7 ? 11 : Math.max(12, Math.min(24, String(h).length + 6)));
  });
  const ns = wb.addWorksheet('填写说明');
  ns.addRow(['提示:数据表第 2 行(灰色)为示例,填写前请先删除该行,再从第 3 行开始填写;若保留,导入时会被当作真实数据']);
  ns.mergeCells('A1:D1');
  ns.getCell('A1').font = { bold: true, color: { argb: 'FFB91C1C' } };
  ns.addRow(['列名', '是否必填', '格式/示例', '说明']);
  const nh = ns.getRow(2);
  nh.font = { bold: true };
  nh.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } };
  noteRows.forEach(r => ns.addRow(r));
  ns.getColumn(1).width = 16;
  ns.getColumn(2).width = 10;
  ns.getColumn(3).width = 30;
  ns.getColumn(4).width = 60;
  const buf = await wb.xlsx.writeBuffer();
  return { buf, fname: xname };
}

// ---------- 导入模板下载(方案3:模板按钮) ----------
// timesheets: 人员×项目×12月 矩阵(TSV,Excel 直填直贴);expenses: 11列 CSV;staff: 5列 CSV
app.get('/api/template/:kind', async (req, res) => {
  const year = req.query.year || String(new Date().getFullYear());
  const staff = storage.loadAll('staff');
  const projects = storage.loadAll('projects');
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);


  if (req.query.format === 'xlsx') {
    const xt = await buildTemplateXlsx(req.params.kind, year, staff, projects, months);
    if (!xt) return res.status(404).json({ error: '模板类型不存在:timesheets/expenses/staff/projects/specialIncomes/amortizations' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(xt.fname)}`);
    return res.send(Buffer.from(xt.buf));
  }
  let body = '', fname = '';
  if (req.params.kind === 'timesheets') {
    const rows = [];
    staff.filter(s => s.isDirect).forEach(s => {
      projects.forEach(p => {
        rows.push([s.name, s.dept || '', p.code, ...months.map(() => ''), 160]);
      });
    });
    if (!rows.length) rows.push(['张三', '研发部', (projects[0] || {}).code || 'YYYY-RD-01', ...months.map(() => ''), 160]);
    body = '姓名\t部门\t项目编号\t' + months.join('\t') + '\t总工时\n' +
      rows.map(r => r.join('\t')).join('\n') +
      '\n\n# 填写说明:每行=某人员在某项目的月度研发工时;空白=该月不参与此项目;总工时缺省160,可改。';
    fname = `工时矩阵模板_${year}.tsv`;
    res.setHeader('Content-Type', 'text/tab-separated-values; charset=utf-8');
  } else if (req.params.kind === 'expenses') {
    body =
      `# 项目编号可选值:${projects.map(p => p.code).join('、') || '(先录入项目)'}\n` +
      `# 类别key可选值:${constants.EXPENSE_CATEGORIES.map(c => `${c.key}=${c.name}`).join('、')}\n` +
      `# 分摊方法:direct=直接归集 | ratioHours=按工时 | ratioCustom=按权重;支出类型:费用化/资本化\n` +
      `# 摘要命中「培训/房屋折旧/物业水电/招待/商业保险」将被拒绝(不可计入研发费用)\n` +
      `日期|项目编号|类别key|金额|摘要|期间|分摊方法|支出类型|凭证号|发票号|付款方式\n` +
      `${year}-01-15|${projects[0] ? projects[0].code : 'YYYY-RD-01'}|personnel|50000|示例:1月研发人员工资|${year}-01|direct|费用化|记-${year}-001|FP-${year}-001|银行转账\n`;
    fname = `费用导入模板_${year}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  } else if (req.params.kind === 'staff') {
    body = `姓名|部门|岗位|入职日期|是否直接研发\n张三|研发部|软件工程师|${year}-03-01|是\n李四|测试部|测试工程师|${year}-01-15|否\n\n# 是否直接研发:是/否;入职日期格式 YYYY-MM-DD`;
    fname = `人员导入模板_${year}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  } else if (req.params.kind === 'projects') {
    body =
      `# 研发形式:自主研发/委托境内机构/委托境内个人/委托境外机构/合作研发/集中研发\n` +
      `# 费用化/资本化:expense=费用化 | capitalize=资本化;有立项决议/有研发计划书:是/否\n` +
      `项目编号|项目名称|研发形式|成果归属|活动类型|开始日期|结束日期|状态|费用化/资本化|立项审批日期|有立项决议|有研发计划书|备注\n` +
      `${year}-RD-01|示例:新型控制系统研发|自主研发|企业自有|电子信息技术|${year}-01-01|${year}-12-31|进行中|expense|${year}-01-15|是|是|\n`;
    fname = `研发项目导入模板_${year}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  } else if (req.params.kind === 'specialIncomes') {
    body =
      `# 类型:下脚料销售/残次品销售/试制品销售;归属期间格式 YYYY-MM\n` +
      `项目编号|类型|金额|日期|归属期间|摘要\n` +
      `${projects[0] ? projects[0].code : 'YYYY-RD-01'}|下脚料销售|1200|${year}-03-31|${year}-03|研发过程产生下脚料销售\n`;
    fname = `特殊收入导入模板_${year}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  } else if (req.params.kind === 'amortizations') {
    body =
      `# 仅资本化项目需要;年度=摊销归属年(如 ${year});形成年度=无形资产达到预定可使用状态的年度(可留空)\n` +
      `项目编号|年度|金额|形成年度|备注\n` +
      `${projects[0] ? projects[0].code : 'YYYY-RD-01'}|${year}|100000|${Number(year) - 1}|资本化项目${year}年摊销\n`;
    fname = `资本化摊销导入模板_${year}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  } else {
    return res.status(404).json({ error: '模板类型不存在:timesheets/expenses/staff/projects/specialIncomes/amortizations' });
  }
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.send(body);
});

// 人员批量导入(姓名|部门|岗位|入职日期|是否直接研发)
app.post('/api/staff/batch', (req, res) => {
  const { lines } = req.body || {};
  if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: 'lines 不能为空' });
  const arr = storage.loadAll('staff');
  let ok = 0, errors = [];
  lines.forEach((ln, i) => {
    try {
      const line = String(ln).trim();
      if (!line || line.startsWith('#')) return;
      if (line.includes('姓名') && line.includes('部门')) return;
      const [name, dept, role, joinDate, isDirect] = line.split('|').map(s => (s || '').trim());
      if (!name) throw new Error('姓名为空');
      arr.push({
        id: storage.uid('s'), name, dept: dept || '', role: role || '',
        joinDate: joinDate || '', isDirect: isDirect === '是' || isDirect === 'yes' || isDirect === 'true',
      });
      ok++;
    } catch (e) {
      errors.push(`第${i + 1}行:${e.message}`);
    }
  });
  storage.saveAll('staff', arr);
  res.json({ ok, errors, total: arr.length });
});

// ---------- 万能 Excel 导入(列映射向导) ----------
// 流程: POST /api/import/upload(原始字节 + X-Filename 头) → 解析并缓存 → POST /api/import/run(列映射) → 入库
// 支持 .xlsx(ExcelJS)与 .csv/.tsv/.txt(自动识别 UTF-8/UTF-16 BOM/GBK 编码,逗号/制表/分号/竖线分隔)
const ExcelJS = require('exceljs');
const iconv = require('iconv-lite');
const importSessions = new Map(); // id -> {filename, sheet, rows}; 上限 20,超出删除最旧
let importSeq = 0;

function parseDelimited(text, delim) {
  const rows = [];
  let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some(c => c !== '')) rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur);
  if (row.some(c => c !== '')) rows.push(row);
  return rows;
}

function detectDelimiter(text) {
  const sample = text.slice(0, 4000);
  const counts = [',', '\t', ';', '|'].map(d => ({ d, n: sample.split(d).length - 1 }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 0 ? counts[0].d : ',';
}

function normalizeCell(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    const p = n => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  if (typeof v === 'object') {
    if (v.text !== undefined) return String(v.text);      // 富文本/公式结果
    if (Array.isArray(v.richText)) return v.richText.map(t => (t && t.text != null ? t.text : '')).join(''); // exceljs 富文本
    if (v.result !== undefined) return String(v.result);  // 公式单元格
    return String(v);
  }
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  return String(v).trim();
}

async function parseUpload(buf, filename) {
  const b = Buffer.from(buf);
  const ext = (filename || '').toLowerCase().split('.').pop();
  const isZip = b.length >= 2 && b[0] === 0x50 && b[1] === 0x4b;
  if (ext === 'xlsx' || isZip) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(b);
    const ws = wb.worksheets[0];
    if (!ws) throw new Error('Excel 中没有工作表');
    const vals = ws.getSheetValues(); // 1-based 二维数组
    const rows = [];
    for (let r = 1; r <= vals.length; r++) {
      const row = vals[r];
      if (!row || typeof row !== 'object') continue;
      const cells = [];
      for (let c = 1; c <= ws.columnCount; c++) cells.push(normalizeCell(row[c]));
      while (cells.length && cells[cells.length - 1] === '') cells.pop();
      if (cells.some(x => x !== '')) rows.push(cells);
    }
    return { sheet: ws.name || 'Sheet1', rows };
  }
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt' || ext === 'xls') {
    if (ext === 'xls') throw new Error('暂不支持旧版 .xls(97-2003)格式,请另存为 .xlsx 或 .csv 后导入');
    let text;
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) text = iconv.decode(b.slice(2), 'utf16-le');
    else if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) text = iconv.decode(b.slice(2), 'utf16-be');
    else {
      const utf8 = b.toString('utf8').replace(/^\uFEFF/, '');
      text = utf8.includes('\uFFFD') ? iconv.decode(b, 'gbk') : utf8; // UTF-8 解码出替换符 → 视为 GBK
    }
    const delim = detectDelimiter(text);
    return { sheet: '', rows: parseDelimited(text, delim) };
  }
  throw new Error('不支持的文件类型,请使用 .xlsx 或 .csv');
}

// 上传解析:路由级 express.raw 只吃原始字节(不影响其他 JSON 路由)
app.post('/api/import/upload', express.raw({
  type: ['application/octet-stream', 'text/csv', 'text/plain', 'text/tab-separated-values', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  limit: '25mb',
}), ah(async (req, res) => {
  try {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!buf.length) return res.status(400).json({ error: '未收到文件内容' });
    const filename = req.get('x-filename') ? decodeURIComponent(req.get('x-filename')) : (req.query.name || 'import.csv');
    const { sheet, rows } = await parseUpload(buf, filename);
    if (!rows.length) return res.status(400).json({ error: '文件中没有数据行' });
    const headers = rows[0].map((h, i) => ({ index: i, name: h || `列${i + 1}` }));
    const id = 'imp' + Date.now().toString(36) + (importSeq++).toString(36);
    importSessions.set(id, { filename, sheet, rows });
    while (importSessions.size > 20) importSessions.delete(importSessions.keys().next().value);
    res.json({ id, filename, sheet, rowCount: rows.length, headers, sampleRows: rows.slice(1, 11) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

// ---------- 列值解析工具 ----------
const colIdx = (mapping, field) => {
  const i = mapping && mapping[field];
  return Number.isInteger(i) && i >= 0 ? i : -1;
};
const cellOf = (row, i) => (i >= 0 && row[i] !== undefined && row[i] !== null ? String(row[i]).trim() : '');
const normDate = s => {
  if (!s) return '';
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{4})年(\d{1,2})月(\d{1,2})日?/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return s; // 原样保留,由校验兜底
};
const normPeriod = s => {
  if (!s) return '';
  let m = /^(\d{4})[-/.](\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}`;
  m = /^(\d{4})(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}`;
  return s;
};
// 真实日期校验:2026-13-45 / 2026-02-30 等畸形日期拒绝(normDate 只补零不判合法性)
const isValidDate = s => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
};
const isYes = s => /^(是|直接|true|1|√|yes|y)$/i.test(s);

// ---------- 导入执行(按列映射把每行转成实体记录,逐行容错) ----------
function runImport(entity, rows, mapping, options) {
  const projects = storage.loadAll('projects');
  const projByCode = new Map(), projByName = new Map();
  projects.forEach(p => { projByCode.set(String(p.code || '').trim().toLowerCase(), p); projByName.set(String(p.name || '').trim().toLowerCase(), p); });
  const staffArr = storage.loadAll('staff');
  const staffByName = new Map();
  staffArr.forEach(s => staffByName.set(String(s.name || '').trim().toLowerCase(), s));
  const catByKey = Object.fromEntries(constants.EXPENSE_CATEGORIES.map(c => [c.key, c]));
  const catByName = Object.fromEntries(constants.EXPENSE_CATEGORIES.map(c => [c.name, c.key]));
  const formByName = Object.fromEntries(constants.PROJECT_FORMS.map(f => [f.name, f.key]));
  const typeByName = Object.fromEntries(constants.SPECIAL_INCOME_TYPES.map(t => [t.name, t.key]));
  const allocByName = Object.fromEntries(constants.ALLOC_METHODS.map(a => [a.name, a.key]));
  const errs = [];
  const rowNo = i => i + (options.skipHeader === false ? 1 : 2); // 报表行号(含表头)

  if (entity === 'expenses') {
    const arr = storage.loadAll('expenses');
    rows.forEach((row, i) => {
      try {
        const ref = cellOf(row, colIdx(mapping, 'projectCode'));
        const proj = projByCode.get(ref.toLowerCase()) || projByName.get(ref.toLowerCase());
        if (!proj) throw new Error(`项目不存在:「${ref || '(空)'}」`);
        const catRef = cellOf(row, colIdx(mapping, 'category'));
        const catKey = catByName[catRef] || (catByKey[catRef] ? catRef : '');
        if (!catKey) throw new Error(`费用类别无效:「${catRef || '(空)'}」`);
        const amount = toNum(cellOf(row, colIdx(mapping, 'amount')));
        if (!amount || amount <= 0) throw new Error(`金额无效:「${cellOf(row, colIdx(mapping, 'amount'))}」`);
        const summary = cellOf(row, colIdx(mapping, 'summary'));
        const hit = blockedKeyword(summary, catKey);
        if (hit) throw new Error(`摘要命中不可计入项关键词「${hit}」`);
        const date = normDate(cellOf(row, colIdx(mapping, 'date')));
        if (date && !isValidDate(date)) throw new Error(`日期无效:「${cellOf(row, colIdx(mapping, 'date'))}」(须为真实日期 YYYY-MM-DD)`);
        const period = normPeriod(cellOf(row, colIdx(mapping, 'period'))) || (date ? date.slice(0, 7) : `${options.year || new Date().getFullYear()}-01`);
        const cap = /资本化|capitalize/i.test(cellOf(row, colIdx(mapping, 'capitalization'))) ? 'capitalize' : 'expense';
        const allocRaw = cellOf(row, colIdx(mapping, 'allocMethod'));
        const allocMethod = allocByName[allocRaw] || allocRaw || 'direct';
        arr.push({
          id: storage.uid('e'), projectId: proj.id, category: catKey, amount,
          summary, period, date, allocMethod,
          isShared: allocMethod === 'ratioHours' || allocMethod === 'ratioCustom',
          capitalization: cap,
          voucherNo: cellOf(row, colIdx(mapping, 'voucherNo')),
          invoiceNo: cellOf(row, colIdx(mapping, 'invoiceNo')),
          contractNo: cellOf(row, colIdx(mapping, 'contractNo')),
          paymentMethod: cellOf(row, colIdx(mapping, 'paymentMethod')) || '银行转账',
          allocNote: allocMethod !== 'direct' ? 'Excel导入' : '', alloc: {},
        });
      } catch (e) { errs.push(`第${rowNo(i)}行:${e.message}`); }
    });
    storage.saveAll('expenses', arr);
  } else if (entity === 'staff') {
    const arr = storage.loadAll('staff');
    rows.forEach((row, i) => {
      try {
        const name = cellOf(row, colIdx(mapping, 'name'));
        if (!name) throw new Error('姓名为空');
        arr.push({
          id: storage.uid('s'), name,
          dept: cellOf(row, colIdx(mapping, 'dept')),
          role: cellOf(row, colIdx(mapping, 'role')),
          joinDate: normDate(cellOf(row, colIdx(mapping, 'joinDate'))),
          isDirect: colIdx(mapping, 'isDirect') >= 0 ? isYes(cellOf(row, colIdx(mapping, 'isDirect'))) : true,
        });
      } catch (e) { errs.push(`第${rowNo(i)}行:${e.message}`); }
    });
    storage.saveAll('staff', arr);
  } else if (entity === 'projects') {
    const arr = storage.loadAll('projects');
    rows.forEach((row, i) => {
      try {
        const code = cellOf(row, colIdx(mapping, 'code'));
        const name = cellOf(row, colIdx(mapping, 'name'));
        if (!code) throw new Error('项目编号为空');
        if (!name) throw new Error('项目名称为空');
        const formRaw = cellOf(row, colIdx(mapping, 'form'));
        const form = formByName[formRaw] || formRaw || 'self';
        const cap = /资本化|capitalize/i.test(cellOf(row, colIdx(mapping, 'capitalization'))) ? 'capitalize' : 'expense';
        arr.push({
          id: storage.uid('p'), code, name,
          form, resultOwner: /委托|受托|客户|client/i.test(cellOf(row, colIdx(mapping, 'resultOwner'))) ? 'client' : 'self',
          activityType: cellOf(row, colIdx(mapping, 'activityType')),
          startDate: normDate(cellOf(row, colIdx(mapping, 'startDate'))),
          endDate: normDate(cellOf(row, colIdx(mapping, 'endDate'))),
          status: cellOf(row, colIdx(mapping, 'status')) || '进行中',
          capitalization: cap,
          approvalDate: normDate(cellOf(row, colIdx(mapping, 'approvalDate'))),
          hasApprovalDoc: colIdx(mapping, 'hasApprovalDoc') >= 0 ? isYes(cellOf(row, colIdx(mapping, 'hasApprovalDoc'))) : false,
          hasPlanDoc: colIdx(mapping, 'hasPlanDoc') >= 0 ? isYes(cellOf(row, colIdx(mapping, 'hasPlanDoc'))) : false,
          note: cellOf(row, colIdx(mapping, 'note')),
        });
      } catch (e) { errs.push(`第${rowNo(i)}行:${e.message}`); }
    });
    storage.saveAll('projects', arr);
  } else if (entity === 'timesheets') {
    const arr = storage.loadAll('timesheets');
    rows.forEach((row, i) => {
      try {
        const staffRef = cellOf(row, colIdx(mapping, 'staffName'));
        const pp = staffByName.get(staffRef.toLowerCase());
        if (!pp) throw new Error(`人员不存在:「${staffRef || '(空)'}」`);
        const projRef = cellOf(row, colIdx(mapping, 'projectCode'));
        const proj = projByCode.get(projRef.toLowerCase()) || projByName.get(projRef.toLowerCase());
        if (!proj) throw new Error(`项目不存在:「${projRef || '(空)'}」`);
        const period = normPeriod(cellOf(row, colIdx(mapping, 'period')));
        if (!/^\d{4}-\d{2}$/.test(period)) throw new Error(`月份无效:「${cellOf(row, colIdx(mapping, 'period'))}」`);
        const rd = toNum(cellOf(row, colIdx(mapping, 'rdHours')));
        if (rd < 0) throw new Error(`研发工时无效:「${cellOf(row, colIdx(mapping, 'rdHours'))}」`);
        const tot = toNum(cellOf(row, colIdx(mapping, 'totalHours')));
        const totV = Number.isFinite(tot) && tot >= 0 ? tot : 160;
        if (rd > totV) throw new Error(`研发工时(${rd})不能大于总工时(${totV})`);
        if (arr.some(t => t.staffId === pp.id && t.projectId === proj.id && t.period === period))
          throw new Error(`该人员该项目该月份工时已存在,请勿重复导入`);
        arr.push({
          id: storage.uid('t'), staffId: pp.id, staffName: pp.name, projectId: proj.id, period,
          rdHours: rd, totalHours: totV,
        });
      } catch (e) { errs.push(`第${rowNo(i)}行:${e.message}`); }
    });
    storage.saveAll('timesheets', arr);
  } else if (entity === 'specialIncomes') {
    const arr = storage.loadAll('specialIncomes');
    rows.forEach((row, i) => {
      try {
        const ref = cellOf(row, colIdx(mapping, 'projectCode'));
        const proj = projByCode.get(ref.toLowerCase()) || projByName.get(ref.toLowerCase());
        if (!proj) throw new Error(`项目不存在:「${ref || '(空)'}」`);
        const typeRaw = cellOf(row, colIdx(mapping, 'type'));
        const type = typeByName[typeRaw] || typeRaw || 'scrap';
        const amount = toNum(cellOf(row, colIdx(mapping, 'amount')));
        if (amount < 0) throw new Error(`金额无效:「${cellOf(row, colIdx(mapping, 'amount'))}」`);
        const date = normDate(cellOf(row, colIdx(mapping, 'date')));
        arr.push({
          id: storage.uid('si'), projectId: proj.id, type, amount,
          date, period: normPeriod(cellOf(row, colIdx(mapping, 'period'))) || (date ? date.slice(0, 7) : ''),
          summary: cellOf(row, colIdx(mapping, 'summary')),
        });
      } catch (e) { errs.push(`第${rowNo(i)}行:${e.message}`); }
    });
    storage.saveAll('specialIncomes', arr);
  } else if (entity === 'amortizations') {
    const arr = storage.loadAll('amortizations');
    rows.forEach((row, i) => {
      try {
        const ref = cellOf(row, colIdx(mapping, 'projectCode'));
        const proj = projByCode.get(ref.toLowerCase()) || projByName.get(ref.toLowerCase());
        if (!proj) throw new Error(`项目不存在:「${ref || '(空)'}」`);
        if (proj.capitalization !== 'capitalize') throw new Error(`项目「${proj.name}」为费用化,无需摊销`);
        const year = Number(cellOf(row, colIdx(mapping, 'year')));
        if (!Number.isFinite(year) || year < 2000 || year > 2100) throw new Error(`年度无效:「${cellOf(row, colIdx(mapping, 'year'))}」`);
        const amount = toNum(cellOf(row, colIdx(mapping, 'amount')));
        if (!amount || amount <= 0) throw new Error(`金额无效:「${cellOf(row, colIdx(mapping, 'amount'))}」`);
        const fyRaw = cellOf(row, colIdx(mapping, 'formationYear'));
        const fy = fyRaw ? Number(fyRaw) : undefined;
        if (fy !== undefined && (!Number.isFinite(fy) || fy < 2000 || fy > 2100)) throw new Error(`形成年度无效:「${fyRaw}」`);
        arr.push({
          id: storage.uid('a'), projectId: proj.id, year,
          formationYear: fy,
          amount, note: cellOf(row, colIdx(mapping, 'note')),
        });
      } catch (e) { errs.push(`第${rowNo(i)}行:${e.message}`); }
    });
    storage.saveAll('amortizations', arr);
  } else {
    throw new Error(`不支持的导入类型:${entity}`);
  }
  return { entity, total: rows.length, ok: rows.length - errs.length, errors: errs };
}

// 执行导入:按列映射入库
app.post('/api/import/run', (req, res) => {
  try {
    const { id, entity, mapping, options } = req.body || {};
    const session = importSessions.get(id);
    if (!session) return res.status(400).json({ error: '导入会话不存在或已过期,请重新上传文件' });
    const skipHeader = options ? options.skipHeader !== false : true;
    const dataRows = skipHeader ? session.rows.slice(1) : session.rows;
    const result = runImport(entity, dataRows, mapping || {}, { ...(options || {}), skipHeader });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- 数电票发票解析(XML / OFD) ----------
// 输入: 电子税务局下载的数电票 XML(单张或多张 <Invoice>)或 OFD 版式文件
// 输出: {invoiceNo, date, sellerName, buyerName, amount, tax, total, remark, items[]}
// 字段提取策略: 中英标签别名表 + 属性形式 + OFD 文本坐标重排,兼容多种导出形态
const zlib = require('zlib');

// 最小 ZIP 读取器(EOCD + 中央目录 + 本地头,支持 store/deflate)
function parseZipEntries(buf) {
  const entries = new Map();
  let eocd = -1;
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 OFD/ZIP 文件');
  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  let p = cdOffset;
  for (let n = 0; n < entryCount; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    const lnLen = buf.readUInt16LE(lho + 26);
    const leLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lnLen + leLen;
    let data;
    if (method === 0) data = buf.slice(dataStart, dataStart + csize);
    else if (method === 8) data = zlib.inflateRawSync(buf.slice(dataStart, dataStart + csize));
    else throw new Error(`不支持的压缩方式:${method}`);
    entries.set(name, data);
    p += 46 + nameLen + extraLen + cmtLen;
  }
  if (!entries.size) throw new Error('ZIP 中没有条目');
  return entries;
}

function xmlDecode(buf) {
  const head = buf.slice(0, 256).toString('latin1');
  const m = /encoding\s*=\s*["']([^"']+)["']/i.exec(head);
  const enc = m && /^(gbk|gb2312|gb18030|big5)$/i.test(m[1]) ? m[1].toLowerCase() : 'utf8';
  const text = enc === 'utf8' ? buf.toString('utf8').replace(/^\uFEFF/, '') : iconv.decode(buf, enc);
  return { text, enc };
}

// 递归提取全部叶子 <Tag>text</Tag> 与属性 Tag="value"(兼容中英文标签与任意嵌套)
function xmlPairs(text) {
  const pairs = new Map(), attrs = new Map();
  const walk = s => {
    const elemRe = /<([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5:.-]*)([^>]*)>([\s\S]*?)<\/\1>/g;
    const attrRe = /([A-Za-z_\u4e00-\u9fa5]+)="([^"]*)"/g;
    let am;
    while ((am = attrRe.exec(s))) if (!attrs.has(am[1])) attrs.set(am[1], am[2]);
    let m;
    while ((m = elemRe.exec(s))) {
      const [, tag, , content] = m;
      if (/<[A-Za-z_\u4e00-\u9fa5]/.test(content)) walk(content); // 有子元素 → 递归
      else if (!pairs.has(tag)) pairs.set(tag, content.trim());
    }
  };
  walk(text);
  return { pairs, attrs };
}

const INV_FIELD_ALIASES = {
  invoiceNo: ['发票号码', 'invoiceno', 'invoicenumber', 'fphm', 'ticketno', 'ticketnumber', 'invno', 'fpno'],
  invoiceCode: ['发票代码', 'invoicecode', 'fpdm', 'ticketcode'],
  date: ['开票日期', 'invoicedate', 'issuedate', 'issuetime', 'kprq', 'issue'],
  sellerName: ['销方名称', 'sellername', 'xfmc', 'seller'],
  sellerTaxNo: ['销方税号', 'sellertaxno', 'xfsh', 'xfnsrsbh', 'sellerid'],
  buyerName: ['购方名称', 'buyername', 'gfmc', 'buyer'],
  buyerTaxNo: ['购方税号', 'buyertaxno', 'gfsh', 'gfnsrsbh'],
  amount: ['金额合计', '合计金额', '不含税金额', 'totalamount', 'amount', 'hjje', 'jmje', 'subtotal'],
  tax: ['税额合计', '合计税额', 'totaltax', 'hjse', 'tax'],
  total: ['价税合计', 'taxincluded', 'jshj', 'kphjje', 'sumamount', 'totalwithtax', 'totalamountwithtax', 'grandtotal'],
  invoiceType: ['发票类型', 'invoicetype', 'fpzl', 'fpkind'],
  remark: ['备注', 'remark', 'bz'],
};

const ITEM_FIELD_ALIASES = {
  name: ['名称', '项目名称', '商品名称', 'name', 'spmc', 'commodityname', 'goodsname'],
  spec: ['规格', '规格型号', 'spec', 'specification', 'ggxh'],
  quantity: ['数量', 'quantity', 'sl'],
  unitPrice: ['单价', 'unitprice', 'dj', 'price'],
  amount: ['金额', 'amount', 'je', 'itemamount'],
  taxRate: ['税率', 'taxrate', 'rate'],
  tax: ['税额', 'tax', 'se', 'itemtax'],
};

const toNum = v => {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(/[¥￥,]/g, '').trim());
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
const fmtRate = r => {
  const n = Number(String(r).replace('%', '').replace(/,/g, ''));
  if (!Number.isFinite(n)) return String(r || '');
  return (n <= 1 && n > 0 ? Math.round(n * 100) : n) + '%';
};

function pick(pairs, attrs, aliases) {
  for (const a of aliases) {
    const lk = a.toLowerCase();
    for (const [k, v] of pairs) if (k.toLowerCase() === lk) return v;
    for (const [k, v] of attrs) if (k.toLowerCase() === lk) return v;
  }
  return '';
}

function parseItems(block) {
  const items = [];
  const re = /<(Item|item|Goods|goods|Commodity|commodity|商品|明细)\b[^>]*>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(block))) {
    const { pairs, attrs } = xmlPairs(m[2]);
    const it = {
      name: pick(pairs, attrs, ITEM_FIELD_ALIASES.name),
      spec: pick(pairs, attrs, ITEM_FIELD_ALIASES.spec),
      quantity: toNum(pick(pairs, attrs, ITEM_FIELD_ALIASES.quantity)),
      unitPrice: toNum(pick(pairs, attrs, ITEM_FIELD_ALIASES.unitPrice)),
      amount: toNum(pick(pairs, attrs, ITEM_FIELD_ALIASES.amount)),
      taxRate: fmtRate(pick(pairs, attrs, ITEM_FIELD_ALIASES.taxRate)),
      tax: toNum(pick(pairs, attrs, ITEM_FIELD_ALIASES.tax)),
    };
    if (it.name) items.push(it);
  }
  return items;
}

// XML → 发票数组(可能含多张 <Invoice>)
function parseInvoiceXml(buf) {
  const { text } = xmlDecode(buf);
  const blocks = [];
  const invRe = /<Invoice\b[^>]*>[\s\S]*?<\/Invoice>/gi;
  let m, found = false;
  while ((m = invRe.exec(text))) { blocks.push(m[0]); found = true; } // 保留开始标签,属性形式字段(FPHM等)才可提取
  if (!found) blocks.push(text);
  return blocks.map(block => {
    // 先剥离明细行,避免明细内 Amount/Tax 干扰发票级字段
    const stripped = block.replace(/<(Item|item|Goods|goods|Commodity|commodity|商品|明细)\b[^>]*>[\s\S]*?<\/\1>/g, '');
    const { pairs, attrs } = xmlPairs(stripped);
    const inv = {
      invoiceNo: pick(pairs, attrs, INV_FIELD_ALIASES.invoiceNo),
      invoiceCode: pick(pairs, attrs, INV_FIELD_ALIASES.invoiceCode),
      date: normDate(pick(pairs, attrs, INV_FIELD_ALIASES.date)),
      sellerName: pick(pairs, attrs, INV_FIELD_ALIASES.sellerName),
      sellerTaxNo: pick(pairs, attrs, INV_FIELD_ALIASES.sellerTaxNo),
      buyerName: pick(pairs, attrs, INV_FIELD_ALIASES.buyerName),
      amount: toNum(pick(pairs, attrs, INV_FIELD_ALIASES.amount)),
      tax: toNum(pick(pairs, attrs, INV_FIELD_ALIASES.tax)),
      total: toNum(pick(pairs, attrs, INV_FIELD_ALIASES.total)),
      invoiceType: pick(pairs, attrs, INV_FIELD_ALIASES.invoiceType),
      remark: pick(pairs, attrs, INV_FIELD_ALIASES.remark),
      items: parseItems(block),
    };
    if (!inv.amount && inv.items.length) inv.amount = Math.round(inv.items.reduce((s, it) => s + it.amount, 0) * 100) / 100;
    if (!inv.tax && inv.items.length) inv.tax = Math.round(inv.items.reduce((s, it) => s + it.tax, 0) * 100) / 100;
    if (!inv.total && inv.amount) inv.total = Math.round((inv.amount + (inv.tax || 0)) * 100) / 100;
    return inv;
  });
}

// OFD: 解包 → 页面 Content.xml 的 TextObject 文本按坐标重排成行 → 标签取值
function parseInvoiceOfd(buf) {
  const entries = parseZipEntries(buf);
  const runs = [];
  for (const [name, data] of entries) {
    if (!/\.xml$/i.test(name) || !/Content\.xml$/i.test(name)) continue;
    const { text } = xmlDecode(data);
    // 兼容命名空间前缀(真实 OFD 为 <ofd:TextObject>/<ofd:TextCode>,GB/T 33190-2016)
    const toRe = /<(?:[A-Za-z_][\w.-]*:)?TextObject\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?TextObject>/g;
    let m;
    while ((m = toRe.exec(text))) {
      const g = (tagStr, n) => { const mm = new RegExp(n + '="([^"]*)"').exec(tagStr); return mm ? Number(mm[1]) : null; };
      let y = g(m[0], 'Y'), x = g(m[0], 'X');
      let buf2 = '';
      const tcRe = /<(?:[A-Za-z_][\w.-]*:)?TextCode\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?TextCode>/g;
      let t;
      while ((t = tcRe.exec(m[1]))) {
        if (y === null) y = g(t[0], 'Y');
        if (x === null) x = g(t[0], 'X');
        buf2 += t[1];
      }
      const s = buf2.trim();
      if (s) runs.push({ x: x ?? 0, y: y ?? 0, text: s });
    }
  }
  if (!runs.length) throw new Error('OFD 中未找到可识别的文本(可能不是数电票版式)');
  runs.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const lines = [];
  for (const r of runs) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - r.y) < 0.5) last.runs.push(r);
    else lines.push({ y: r.y, runs: [r] });
  }
  const all = lines.map(l => l.runs.map(r => r.text).join('')).join('\n');
  const take = label => {
    for (const line of lines) {
      const texts = line.runs.map(r => r.text);
      const idx = texts.findIndex(t => t.includes(label));
      if (idx < 0) continue;
      let v = texts[idx].replace(label, '').replace(/^[:：\s]+/, '');
      if (!v && texts[idx + 1] !== undefined) v = texts[idx + 1].replace(/^[:：\s]+/, '');
      return v.trim();
    }
    return '';
  };
  const amtM = all.match(/金额(?:合计)?(?:[（(]?小写[)）]?)?[:：]?\s*[¥￥]?\s*([\d,]+\.?\d*)/);
  const taxM = all.match(/税额(?:合计)?(?:[（(]?小写[)）]?)?[:：]?\s*[¥￥]?\s*([\d,]+\.?\d*)/);
  const totM = all.match(/价税合计(?:[（(]?小写[)）]?)?[:：]?\s*[¥￥]?\s*([\d,]+\.?\d*)/) || all.match(/价税合计[:：]?\s*[¥￥]?\s*([\d,]+\.?\d*)/);
  const amount = toNum(amtM ? amtM[1] : 0);
  const tax = toNum(taxM ? taxM[1] : 0);
  const total = toNum(totM ? totM[1] : 0) || (amount ? amount + tax : 0);
  return {
    invoiceNo: take('发票号码') || (all.match(/发票号码[:：]?\s*([0-9A-Za-z]{15,30})/) || [])[1] || '',
    date: normDate(take('开票日期')) || (all.match(/开票日期[:：]?\s*(\d{4}年\d{1,2}月\d{1,2}日)/) || [])[1] || '',
    sellerName: take('销方名称'),
    buyerName: take('购方名称'),
    amount, tax, total,
    invoiceType: '', remark: '', items: [],
  };
}

// 单文件解析(原始字节 + X-Filename 头)
app.post('/api/invoice/parse', express.raw({
  type: ['application/octet-stream', 'text/xml', 'application/xml', 'application/ofd', 'text/plain', 'application/zip'],
  limit: '25mb',
}), (req, res) => {
  try {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!buf.length) return res.status(400).json({ error: '未收到文件内容' });
    const filename = req.get('x-filename') ? decodeURIComponent(req.get('x-filename')) : 'invoice.xml';
    const ext = filename.toLowerCase().split('.').pop();
    let invoices;
    if (ext === 'ofd') invoices = [parseInvoiceOfd(buf)];
    else if (ext === 'xml') invoices = parseInvoiceXml(buf);
    else throw new Error('仅支持 .xml 或 .ofd 文件');
    res.json({ kind: ext, filename, invoices });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 发票行 → 费用记录(逐行校验: 项目/类别/金额/日期/摘要不可计入词)
app.post('/api/invoice/import', (req, res) => {
  try {
    const { rows, projectId, category, capitalization } = req.body || {};
    const projects = storage.loadAll('projects');
    const proj = projects.find(p => p.id === projectId);
    if (!proj) return res.status(400).json({ error: '项目不存在,请先在「研发项目」中创建' });
    if (!constants.CATEGORY_MAP[category]) return res.status(400).json({ error: '费用类别无效' });
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: '没有要导入的发票行' });
    const arr = storage.loadAll('expenses');
    const errors = [];
    const existing = new Set(arr.filter(e => e.invoiceNo).map(e => `${e.invoiceNo}|${e.amount}`));
    rows.forEach((r, i) => {
      try {
        const amount = toNum(r.amount);
        if (!amount || amount <= 0) throw new Error(`第${i + 1}行金额无效:「${r.amount}」`);
        const date = normDate(r.date || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`第${i + 1}行缺少有效开票日期`);
        const summary = String(r.summary || '').trim() || proj.name;
        const hit = blockedKeyword(summary, category);
        if (hit) throw new Error(`第${i + 1}行摘要命中不可计入项关键词「${hit}」`);
        const invKey = `${String(r.invoiceNo || '')}|${amount}`;
        if (r.invoiceNo && existing.has(invKey)) throw new Error(`第${i + 1}行发票号「${r.invoiceNo}」已导入过,已跳过(防重复记账)`);
        existing.add(invKey);
        arr.push({
          id: storage.uid('e'), projectId: proj.id, category, amount,
          summary, period: date.slice(0, 7), date,
          allocMethod: 'direct', isShared: false,
          capitalization: capitalization === 'capitalize' ? 'capitalize' : 'expense',
          voucherNo: '', invoiceNo: String(r.invoiceNo || ''), contractNo: '',
          paymentMethod: '银行转账', allocNote: '', alloc: {},
        });
      } catch (e) { errors.push(e.message); }
    });
    storage.saveAll('expenses', arr);
    res.json({ ok: rows.length - errors.length, errors, total: rows.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- 政策库(内置 + 联网检查) ----------
app.get('/api/policies', (req, res) => {
  const year = req.query.year || String(new Date().getFullYear());
  res.json({ policies: POLICIES_DB, status: policyStatus(year), params: constants.POLICIES });
});
app.get('/api/policy/online', ah(async (req, res) => {
  const r = await checkOnline();
  res.json({ ...r, checkedAt: new Date().toISOString() });
}));

// ---------- 元数据 ----------
app.get('/api/meta', (req, res) => {
  res.json({
    policies: constants.POLICIES,
    categories: constants.EXPENSE_CATEGORIES,
    forms: constants.PROJECT_FORMS,
    resultOwners: constants.RESULT_OWNERS,
    allocMethods: constants.ALLOC_METHODS,
    expenseTypes: constants.EXPENSE_TYPES,
    levyTypes: constants.LEVY_TYPES,
    industries: constants.INDUSTRIES,
    negativeIndustries: constants.NEGATIVE_INDUSTRIES,
    negativeActivities: constants.NEGATIVE_ACTIVITIES,
    specialIncomeTypes: constants.SPECIAL_INCOME_TYPES,
    nonDeductibleKeywords: constants.NON_DEDUCTIBLE_KEYWORDS,
    highRiskMaterials: constants.HIGH_RISK_MATERIALS,
    adminExpenseKeywords: constants.ADMIN_EXPENSE_KEYWORDS,
    aftersaleKeywords: constants.AFTERSALE_KEYWORDS,
    checklist: constants.CHECKLIST,
    checklistPhases: constants.CHECKLIST_PHASES,
    levels: LEVELS,
  });
});

// ---------- 业务计算 ----------
function snapshot() {
  return {
    companies: storage.loadAll('companies'),
    projects: storage.loadAll('projects'),
    staff: storage.loadAll('staff'),
    timesheets: storage.loadAll('timesheets'),
    expenses: storage.loadAll('expenses'),
    amortizations: storage.loadAll('amortizations'),
    specialIncomes: storage.loadAll('specialIncomes'),
    taxroll: storage.loadAll('taxroll'),
    assets: storage.loadAll('assets'),
  };
}

// 预缴期间解析:7月预缴=上半年(periodEnd YYYY-06),10月预缴=前三季度(periodEnd YYYY-09)
function periodEndOf(year, period) {
  if (!period) return undefined;
  if (period === '7' || period === '07') return `${year}-06`;
  if (period === '10') return `${year}-09`;
  return undefined;
}

app.get('/api/summary', (req, res) => {
  const d = snapshot();
  const company = d.companies[0];
  const year = req.query.year || String(new Date().getFullYear());
  const summary = computeSummary({ ...d, company, year, periodEnd: periodEndOf(year, req.query.period) });
  const a107012 = buildA107012({ ...d, company, year });
  const collection = buildYearlyCollection({ ...d, year });
  res.json({ ...summary, a107012, collection });
});

// A107012 官方表单 Excel 导出
app.get('/api/export/a107012.xlsx', ah(async (req, res) => {
  const d = snapshot();
  const company = d.companies[0];
  const year = req.query.year || String(new Date().getFullYear());
  const a = buildA107012({ ...d, company, year });
  const wb = await exportA107012({ company, year, a });
  const buf = await toBuffer(wb);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=A107012_${year}.xlsx`);
  res.send(buf);
}));

// 三套口径对照(会计/加计/高企)
app.get('/api/calibers', (req, res) => {
  const d = snapshot();
  const company = d.companies[0];
  const year = req.query.year || String(new Date().getFullYear());
  res.json(computeCalibers({ ...d, company, year }));
});

app.get('/api/ledger', (req, res) => {
  const d = snapshot();
  const year = req.query.year || String(new Date().getFullYear());
  const ledger = buildLedger({ projects: d.projects, expenses: d.expenses, timesheets: d.timesheets, amortizations: d.amortizations, year });
  const grand = ledgerGrandTotal(ledger);
  res.json({ ...ledger, grand });
});

// 97号公告四类辅助账(自主研发/委托研发/合作研发/集中研发)
app.get('/api/ledger97', (req, res) => {
  const d = snapshot();
  const year = req.query.year || String(new Date().getFullYear());
  res.json(buildLedger97({ projects: d.projects, expenses: d.expenses, timesheets: d.timesheets, amortizations: d.amortizations, year }));
});

app.get('/api/risks', (req, res) => {
  const d = snapshot();
  const company = d.companies[0];
  const year = req.query.year || String(new Date().getFullYear());
  const risks = runRiskCheck({ ...d, company, year });
  const counts = { error: 0, warning: 0, info: 0 };
  risks.forEach(r => counts[r.level]++);
  res.json({ year, risks, counts, snapshot: buildRiskSnapshot(d, company, year) });
});

app.get('/api/dashboard', (req, res) => {
  const d = snapshot();
  const company = d.companies[0];
  const year = req.query.year || String(new Date().getFullYear());
  const summary = computeSummary({ ...d, company, year });
  const risks = runRiskCheck({ ...d, company, year });
  const counts = { error: 0, warning: 0, info: 0 };
  risks.forEach(r => counts[r.level]++);
  res.json({
    year,
    company,
    summary: summary.detail,
    counts,
    projectCount: d.projects.length,
    expenseCount: d.expenses.filter(e => String(e.period || '').startsWith(String(year))).length,
    topRisks: risks.slice(0, 6),
  });
});

// ---------- 节税测算 ----------
app.get('/api/tax-saving', (req, res) => {
  const d = snapshot();
  const company = d.companies[0];
  const year = req.query.year || String(new Date().getFullYear());
  const projectedIncome = req.query.income !== undefined && req.query.income !== ''
    ? Number(req.query.income) : undefined;
  const rate = req.query.rate !== undefined && req.query.rate !== ''
    ? Number(req.query.rate) : undefined;
  const r = computeTaxSaving({ ...d, company, year, periodEnd: periodEndOf(year, req.query.period), projectedIncome, rate });
  if (req.query.income !== undefined && !Number.isFinite(projectedIncome)) {
    return res.status(400).json({ error: '预计应纳税所得额无效' });
  }
  res.json(r);
});

// 软件即征即退 vs 加计扣除 互斥测算
app.get('/api/tax-refund', (req, res) => {
  const d = snapshot();
  const company = d.companies[0];
  const year = req.query.year || String(new Date().getFullYear());
  const s = computeSummary({ ...d, company, year });
  const refund = req.query.refund !== undefined && req.query.refund !== '' ? Number(req.query.refund) : 0;
  const related = req.query.related !== undefined && req.query.related !== '' ? Number(req.query.related) : 0;
  const rate = req.query.rate !== undefined && req.query.rate !== '' ? Number(req.query.rate) : undefined;
  const r = computeRefundScenarios({
    company, totalAdd: s.detail.totalAdd, refund, related,
    rate: rate !== undefined ? rate : (company && company.isHiTech ? 0.15 : 0.25),
  });
  r.totalAdd = s.detail.totalAdd;
  res.json(r);
});

// 摊销计划自动生成:形成无形资产按200%(220% IC)摊销——存储会计口径摊销额 成本÷年限,
// 加计扣除额=摊销额×100%(120% IC)在 summary 中按 amortRatio 计算(与A107012 行43 填报口径一致)
app.post('/api/amortization/plan', (req, res) => {
  const { projectId, startYear, years, cost } = req.body || {};
  const projects = storage.loadAll('projects');
  const project = projects.find(p => p.id === projectId);
  if (!project) return res.status(400).json({ error: '项目不存在' });
  if (project.capitalization !== 'capitalize') return res.status(400).json({ error: '仅资本化项目可生成摊销计划' });
  const y = Number(startYear) || Number(new Date().getFullYear()) + 1;
  const n = Number(years);
  if (!Number.isFinite(n) || n < 10) return res.status(400).json({ error: '摊销年限不得低于10年(有约定按约定,不得短于10年)' });
  const d = snapshot();
  const formed = cost !== undefined && cost !== '' && Number(cost) > 0
    ? Number(cost)
    : capitalFormedForProject({ project, expenses: d.expenses, timesheets: d.timesheets });
  if (!(formed > 0)) return res.status(400).json({ error: '未找到该项目形成无形资产的资本化成本,请手工填写成本' });
  // 会计口径年摊销额 = 成本 ÷ 年限(加计按200%/220%在计算层处理,避免重复加计)
  const annual = round2(formed / n);
  const arr = storage.loadAll('amortizations');
  // H2 防重复:该项目已存在摊销记录时拒绝再生成,避免连调两次摊销翻倍
  if (arr.some(a => a.projectId === projectId)) {
    return res.status(400).json({ error: '该项目已生成摊销计划,请勿重复生成(如需调整请先删除原摊销记录)' });
  }
  const created = [];
  let remaining = round2(formed);
  for (let i = 0; i < n; i++) {
    const amt = i === n - 1 ? round2(remaining) : annual;
    remaining = round2(remaining - amt);
    const item = {
      id: storage.uid('a'), projectId, year: y + i,
      formationYear: y, // P2-2:形成无形资产年度=计划起始年度(首年摊销)
      amount: amt, note: `自动摊销计划:成本 ${formed} ÷ ${n} 年(会计口径,第${i + 1}年;加计按摊销额×100%/120%)`,
    };
    arr.push(item);
    created.push(item);
  }
  storage.saveAll('amortizations', arr);
  res.status(201).json({ formed, years: n, annual, count: created.length, created });
});

// ---------- 凭证附件 ----------
// 全部费用附件清单(用于费用列表角标),返回 { expenseId: [{name,size,url}], ... }
app.get('/api/attachments', (req, res) => {
  const out = {};
  if (fs.existsSync(ATT_DIR)) {
    fs.readdirSync(ATT_DIR).forEach(expId => {
      const dir = path.join(ATT_DIR, expId);
      if (!fs.statSync(dir).isDirectory()) return;
      const files = fs.readdirSync(dir)
        .filter(f => fs.statSync(path.join(dir, f)).isFile())
        .map(f => {
          const st = fs.statSync(path.join(dir, f));
          return { name: f, size: st.size, modified: st.mtime.toISOString(), url: `/attachments/${expId}/${encodeURIComponent(f)}` };
        });
      if (files.length) out[expId] = files;
    });
  }
  res.json(out);
});

app.get('/api/expenses/:id/attachments', (req, res) => {
  const dir = path.join(ATT_DIR, req.params.id);
  if (!fs.existsSync(dir)) return res.json([]);
  const files = fs.readdirSync(dir)
    .filter(f => fs.statSync(path.join(dir, f)).isFile())
    .map(f => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, size: st.size, modified: st.mtime.toISOString(), url: `/attachments/${req.params.id}/${encodeURIComponent(f)}` };
    });
  res.json(files);
});

app.post('/api/expenses/:id/attachments', (req, res) => {
  const { name, dataUrl } = req.body || {};
  if (!name || !dataUrl) return res.status(400).json({ error: 'name 与 dataUrl 必填' });
  const m = /^data:([^;]+);base64,(.*)$/s.exec(String(dataUrl));
  if (!m) return res.status(400).json({ error: 'dataUrl 格式不正确' });
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) return res.status(400).json({ error: '文件内容为空' });
  if (buf.length > 10 * 1024 * 1024) return res.status(400).json({ error: '单文件不能超过 10MB' });
  const dir = path.join(ATT_DIR, req.params.id);
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
  const finalName = `${storage.uid('f')}_${safe}`;
  fs.writeFileSync(path.join(dir, finalName), buf);
  res.status(201).json({ name: finalName, size: buf.length, url: `/attachments/${req.params.id}/${encodeURIComponent(finalName)}` });
});

app.delete('/api/expenses/:id/attachments/:fileId', (req, res) => {
  const fp = path.join(ATT_DIR, req.params.id, req.params.fileId);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  res.json({ ok: true });
});

// ---------- Excel 导出 ----------
app.get('/api/export/ledger.xlsx', ah(async (req, res) => {
  const d = snapshot();
  const year = req.query.year || String(new Date().getFullYear());
  const wb = await exportLedger({ projects: d.projects, expenses: d.expenses, timesheets: d.timesheets, amortizations: d.amortizations, year });
  const buf = await toBuffer(wb);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=ledger_${year}.xlsx`);
  res.send(buf);
}));

app.get('/api/export/summary.xlsx', ah(async (req, res) => {
  const d = snapshot();
  const company = d.companies[0];
  const year = req.query.year || String(new Date().getFullYear());
  const summary = computeSummary({ ...d, company, year });
  const wb = await exportSummary({ ...d, company, year, summary });
  const buf = await toBuffer(wb);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=summary_${year}.xlsx`);
  res.send(buf);
}));

// 97号公告四类辅助账 Excel 导出(独立下载)
app.get('/api/export/ledger97.xlsx', ah(async (req, res) => {
  const d = snapshot();
  const year = req.query.year || String(new Date().getFullYear());
  const wb = await exportLedger97Workbook({ projects: d.projects, expenses: d.expenses, timesheets: d.timesheets, amortizations: d.amortizations, year });
  const buf = await toBuffer(wb);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=ledger97_${year}.xlsx`);
  res.send(buf);
}));

// 年度研发支出归集汇总表(97号附件5样式) Excel 导出
app.get('/api/export/collection.xlsx', ah(async (req, res) => {
  const d = snapshot();
  const company = d.companies[0];
  const year = req.query.year || String(new Date().getFullYear());
  const c = buildYearlyCollection({ ...d, year });
  const wb = await exportYearlyCollection({ company, year, c });
  const buf = await toBuffer(wb);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=collection_${year}.xlsx`);
  res.send(buf);
}));

// 风险自检报告(可打印 HTML,浏览器另存 PDF)
app.get('/api/export/risks.html', (req, res) => {
  const d = snapshot();
  const company = d.companies[0];
  const year = req.query.year || String(new Date().getFullYear());
  const risks = runRiskCheck({ ...d, company, year });
  const counts = { error: 0, warning: 0, info: 0 };
  risks.forEach(r => counts[r.level]++);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('风险自检报告_' + year + '.html')}`);
  res.send(riskReportHtml({ company, year, risks, counts, snapshot: buildRiskSnapshot(d, company, year) }));
});

// 共用资源分摊台账 CSV(备查:共用设备按工时分配折旧的依据)
app.get('/api/export/assets.csv', ah(async (req, res) => {
  const d = snapshot();
  const year = req.query.year || String(new Date().getFullYear());
  const list = (d.assets || []).filter(a => !a.period || String(a.period).startsWith(String(year)));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=assets_${year}.csv`);
  res.send(assetsCsv(list));
}));

// 备查资料包:一键打包 辅助账 + A107012 + 风险报告 + CSV + 立项模板 + 凭证附件
app.get('/api/export/archive.zip', ah(async (req, res) => {
  const d = snapshot();
  const company = d.companies[0];
  const year = req.query.year || String(new Date().getFullYear());
  const summary = computeSummary({ ...d, company, year });
  const risks = runRiskCheck({ ...d, company, year });
  const counts = { error: 0, warning: 0, info: 0 };
  risks.forEach(r => counts[r.level]++);

  const [bufLedger97, bufCollection, bufA107012, bufSummary] = await Promise.all([
    exportLedger97Workbook({ projects: d.projects, expenses: d.expenses, timesheets: d.timesheets, amortizations: d.amortizations, year }).then(toBuffer),
    exportYearlyCollection({ company, year, c: buildYearlyCollection({ ...d, year }) }).then(toBuffer),
    exportA107012({ company, year, a: buildA107012({ ...d, company, year }) }).then(toBuffer),
    exportSummary({ ...d, company, year, summary }).then(toBuffer),
  ]);

  const projMap = Object.fromEntries(d.projects.map(p => [p.id, p]));
  const yearExps = d.expenses.filter(e => String(e.period || e.date || '').startsWith(String(year)));
  const yearTs = d.timesheets.filter(t => String(t.period || '').startsWith(String(year)));

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename=rd_archive_${year}.zip`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', e => { console.error('zip error', e.message); res.status(500).end(); });
  archive.pipe(res);

  archive.append(bufLedger97, { name: `01_研发支出辅助账(97号公告四类)_${year}.xlsx` });
  archive.append(bufCollection, { name: `02_研发支出辅助账汇总表(附件5)_${year}.xlsx` });
  archive.append(bufA107012, { name: `03_A107012_${year}.xlsx` });
  archive.append(bufSummary, { name: `04_A107012申报参考_${year}.xlsx` });
  archive.append(riskReportHtml({ company, year, risks, counts, snapshot: buildRiskSnapshot(d, company, year) }), { name: `05_风险自检报告_${year}.html` });
  archive.append(expensesCsv(yearExps, d.projects), { name: `06_费用明细_${year}.csv` });
  archive.append(staffCsv(d.staff), { name: '07_研发人员名单.csv' });
  archive.append(timesheetsCsv(yearTs, d.staff, d.projects), { name: `08_工时台账_${year}.csv` });
  const tmpl = path.join(WEB_DIR, 'templates', '立项书模板.md');
  if (fs.existsSync(tmpl)) archive.file(tmpl, { name: '09_立项书模板.md' });
  const yearSIs = (d.specialIncomes || []).filter(si => String(si.period || si.date || '').startsWith(String(year)));
  if (yearSIs.length) archive.append(specialIncomesCsv(yearSIs, d.projects), { name: `11_特殊收入冲减_${year}.csv` });
  const yearTaxroll = (d.taxroll || []).filter(t => String(t.year) === String(year));
  if (yearTaxroll.length) archive.append(taxrollCsv(yearTaxroll, d.staff), { name: `12_个税申报名单_${year}.csv` });
  const yearAssets = (d.assets || []).filter(a => !a.period || String(a.period).startsWith(String(year)));
  if (yearAssets.length) archive.append(assetsCsv(yearAssets), { name: `13_共用资源分摊台账_${year}.csv` });
  archive.append(
    '本压缩包由「研发费用加计扣除合规管理系统」生成,用于汇算清缴申报与留存备查。\n' +
    '留存期限:自年度汇算清缴结束之日起 ' + constants.POLICIES.retentionYears + ' 年。\n' +
    '五件套目录说明:\n' +
    '  01 研发支出辅助账(97号公告四类:自主研发/委托/合作/集中,每项目一个区块)\n' +
    '  02 研发支出辅助账汇总表(97号公告附件5样式,留存备查)\n' +
    '  03 A107012《研发费用加计扣除优惠明细表》(官方行次,含填报口径说明)\n' +
    '  04 A107012申报参考(限额计算明细与三套口径对照)\n' +
    '  05 风险自检报告(可打印,红黄绿风险提示与整改建议)\n' +
    '辅助材料:\n' +
    '  06 费用明细(按年度)  07 研发人员名单  08 工时台账\n' +
    '  09 立项书模板(新项目立项时填写)  10 凭证附件(发票/付款凭证,按项目分组)\n' +
    '  11 特殊收入冲减(如有登记)  12 个税申报名单(如有登记)  13 共用资源分摊台账(如有登记)\n',
    { name: '00_说明.txt' });

  // 凭证附件按项目编号分组打包(发现8:跳过无主附件——对应费用已删除的孤儿目录不打入备查包)
  const attBase = ATT_DIR;
  if (fs.existsSync(attBase)) {
    const expMap = Object.fromEntries(d.expenses.map(e => [e.id, e]));
    fs.readdirSync(attBase).forEach(expId => {
      const dir = path.join(attBase, expId);
      if (!fs.statSync(dir).isDirectory()) return;
      const exp = expMap[expId];
      if (!exp) return; // 孤儿附件目录(对应费用已删除),跳过
      const prefix = projMap[exp.projectId] ? projMap[exp.projectId].code + '_' : 'unlinked_';
      fs.readdirSync(dir)
        .filter(f => fs.statSync(path.join(dir, f)).isFile())
        .forEach(f => archive.file(path.join(dir, f), { name: `08_凭证附件/${prefix}${expId}/${f}` }));
    });
  }

  await archive.finalize();
}));

// ---------- 示例数据 ----------
app.post('/api/demo/load', (req, res) => {
  // 发现7:载入示例数据会覆盖全部当前数据,执行前强制备份,防止误操作丢数据
  try { if (hasData()) { console.log(` demo/load 前置备份: ${backupNow('predemo')}`); } } catch (e) { console.warn('⚠ demo/load 前置备份失败: ' + e.message); }
  const demo = require('./src/demo');
  const d = demo.load();
  res.json({ ok: true, ...d });
});

app.post('/api/demo/clear', (req, res) => {
  // 发现7:一键清空会删除全部数据文件,执行前强制备份(审计报告:曾两次被外部进程清空/覆写)
  try { if (hasData()) { console.log(` demo/clear 前置备份: ${backupNow('preclear')}`); } } catch (e) { console.warn('⚠ demo/clear 前置备份失败: ' + e.message); }
  storage.reset();
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true, name: 'rd-deduction' }));

if (hasData()) {
  try { console.log(` 自动备份已创建: ${backupNow('auto')}`); }
  catch (e) { console.warn(`⚠ 自动备份失败: ${e.message}`); }
}

// 打包模式自动打开浏览器(RD_NO_OPEN=1 时跳过,供测试/静默启动)
function openBrowser() {
  if (process.env.RD_NO_OPEN === '1') return;
  try { require('child_process').exec(`start "" http://${HOST}:${PORT}`); } catch (e) { console.warn('⚠ 自动打开浏览器失败: ' + e.message); }
}

const server = app.listen(PORT, HOST, () => {
  console.log(` 研发费用加计扣除辅助软件已启动`);
  console.log(`   访问: http://${HOST}:${PORT}`);
  console.log(`   数据目录: ${storage.DATA_DIR}${process.env.RD_DATA_DIR ? ' (RD_DATA_DIR 隔离模式)' : ''}`);
  console.log(`   数据自动备份至 data/backups(保留最近 ${BACKUP_KEEP} 份)`);
  console.log(`   提示: 首次使用请点击页面「载入示例数据」体验全流程`);
  if (isSea) { openBrowser(); }
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.log(`⚠ 端口 ${PORT} 已被占用——软件可能已在运行,正在打开页面…`);
    if (isSea) openBrowser();
    process.exit(0);
  }
  console.error('启动失败: ' + e.message);
  process.exit(1);
});
