// 第三方测试计划通用 harness —— 强制 备份→clear→构造→断言→恢复 闭环
const BASE = 'http://127.0.0.1:8765';
const R2 = n => Math.round((Number(n) || 0) * 100) / 100;

let pass = 0, fail = 0; const fails = [];
const j = async (u, o) => {
  const r = await fetch(BASE + u, o);
  const t = await r.text();
  let b = null; try { b = JSON.parse(t); } catch {}
  if (!r.ok) throw new Error(u + ' HTTP ' + r.status + ' ' + (b ? b.error : t.slice(0, 200)));
  return b;
};
const P = (u, b) => j(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
const PUT = (u, b) => j(u, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
const DEL = u => j(u, { method: 'DELETE' });
const clear = () => P('/api/demo/clear', {});
const backup = tag => P('/api/backup/create', { tag });
const restore = name => P('/api/backup/restore', { name });

// 构造工厂(默认值刻意"干净",避免无关风险规则干扰)
const comp = (extra = {}) => P('/api/companies', { name: '测试公司', industry: '制造业', levyType: '查账征收', ...extra });
const proj = (extra = {}) => P('/api/projects', {
  code: '2026-RD-01', name: '测试项目', form: 'self', resultOwner: 'self', capitalization: 'expense',
  startDate: '2026-01-01', endDate: '2026-12-31', hasApprovalDoc: true, hasPlanDoc: true,
  approvalDate: '2025-12-01', ...extra,
});
const exp = (projectId, category, amount, extra = {}) => P('/api/expenses', {
  projectId, category, amount, date: '2026-06-30', period: '2026-06', capitalization: 'expense',
  summary: '测试-' + category, voucherNo: 'V-001', invoiceNo: 'INV-001', contractNo: 'C-001',
  paymentMethod: '银行转账', ...extra,
});
const staff = (name, extra = {}) => P('/api/staff', { name, dept: '研发部', role: '工程师', isDirect: true, joinDate: '2024-01-01', ...extra });
const ts = (staffId, projectId, period, rdHours, totalHours = 160) => P('/api/timesheets', { staffId, projectId, period, rdHours, totalHours });

const getSummary = async year => {
  const s = await j('/api/summary?year=' + year);
  return { d: s.summary ? s.summary.detail : s.detail, a: s.a107012, col: s.collection, s };
};
const getLedger97 = year => j('/api/ledger97?year=' + year);
const getRisks = year => j('/api/risks?year=' + year);
const LN = (rows, n) => Number((rows.find(r => String(r.line) === String(n)) || {}).amount) || 0;
const LNOTE = (rows, n) => (rows.find(r => String(r.line) === String(n)) || {}).note || '';

const fmt = v => typeof v === 'number' ? v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(v);
function eq(name, actual, expected, tol = 0.01) {
  const c = (typeof expected === 'number' && typeof actual === 'number')
    ? Math.abs(R2(actual) - R2(expected)) <= tol
    : String(actual) === String(expected);
  if (c) { pass++; console.log(`  PASS  ${name} = ${fmt(actual)}`); }
  else { fail++; fails.push(`${name}: 实际=${fmt(actual)} 期望=${fmt(expected)}`); console.log(`  FAIL  ${name}: 实际=${fmt(actual)} 期望=${fmt(expected)}`); }
  return c;
}
function ok(c, m) {
  if (c) { pass++; console.log(`  PASS  ${m}`); }
  else { fail++; fails.push(m); console.log(`  FAIL  ${m}`); }
  return c;
}
const sec = t => console.log('\n----- ' + t + ' -----');
function report(title) {
  console.log('\n########## ' + title + ': ' + pass + ' 通过 / ' + fail + ' 失败 ##########');
  if (fails.length) { console.log('\n失败明细:'); fails.forEach(f => console.log('  - ' + f)); }
  return { pass, fail, fails };
}

/** 套件执行器:自动备份 → 跑测试 → 无论成败都恢复;每套件独立计数 */
async function suite(name, tag, fn) {
  pass = 0; fail = 0; fails.length = 0; // 套件间计数隔离
  let bk;
  try {
    bk = await backup('pretest_' + tag);
    console.log(`[备份] ${bk.name}`);
    await fn();
  } catch (e) {
    fail++; fails.push('[脚本异常] ' + e.message);
    console.log('\n!! 脚本异常:', e.message);
  } finally {
    if (bk && bk.name) {
      try { await restore(bk.name); console.log(`[恢复] ${bk.name}`); }
      catch (e) { console.log('!! 恢复失败:', e.message); }
    }
  }
  return report(name);
}

module.exports = {
  BASE, R2, j, P, PUT, DEL, clear, backup, restore,
  comp, proj, exp, staff, ts,
  getSummary, getLedger97, getRisks, LN, LNOTE, fmt, eq, ok, sec, suite, report,
  stats: () => ({ pass, fail, fails }),
};
