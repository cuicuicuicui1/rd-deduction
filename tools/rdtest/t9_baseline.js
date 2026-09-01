// T9 用户数据基线核对(全程只读,不修改任何数据)
const BASE = 'http://127.0.0.1:8765';
const R2 = n => Math.round((Number(n) || 0) * 100) / 100;
const j = async (u, o) => {
  const r = await fetch(BASE + u, o);
  const t = await r.text();
  let b = null; try { b = JSON.parse(t); } catch {}
  if (!r.ok) throw new Error(u + ' HTTP ' + r.status + ' ' + (b ? b.error : t.slice(0, 150)));
  return b;
};
let pass = 0, fail = 0; const fails = [];
const ok = (c, m) => {
  if (c) { pass++; console.log('  OK   ' + m); }
  else { fail++; fails.push(m); console.log('  FAIL ' + m); }
};
const eq = (name, actual, expected) => {
  const c = typeof expected === 'number' ? Math.abs(R2(actual) - R2(expected)) < 0.01 : String(actual) === String(expected);
  ok(c, `${name}: 实际=${fmt(actual)} 期望=${fmt(expected)}`);
};
const fmt = v => typeof v === 'number' ? v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(v);
const LN = (rows, n) => Number((rows.find(r => String(r.line) === String(n)) || {}).amount) || 0;

(async () => {
  console.log('########## T9 用户数据基线核对(只读) ##########\n');
  const Y = '2026';
  const expenses = await j('/api/expenses');
  const projects = await j('/api/projects');
  const companies = await j('/api/companies');
  const sum = await j(`/api/summary?year=${Y}`);
  const cal = await j(`/api/calibers?year=${Y}`);
  const l97 = await j(`/api/ledger97?year=${Y}`);
  const led = await j(`/api/ledger?year=${Y}`);
  const d = sum.detail || sum.summary.detail;
  const a = sum.a107012;

  console.log('--- 原始数据规模 ---');
  eq('费用条数', expenses.length, 14);
  console.log('      项目:', projects.map(p => `${p.code}(${p.capitalization})`).join(', '));
  console.log('      企业:', companies[0] && companies[0].name);

  console.log('\n--- 口径基线 ---');
  eq('会计口径(费用合计)', cal.accounting, 1260000);
  eq('加计基数 totalExpenseBase', d.totalExpenseBase, 940000);
  eq('高企口径 hiTech', cal.hiTech, 1140000);
  eq('otherLimit', d.otherLimit, 67777.78);
  eq('otherDeductible', d.otherDeductible, 50000);
  eq('domesticTotal(境外限额基准)', d.domesticTotal, 740000);
  eq('entrustOverseas', d.entrustOverseas, 400000);
  eq('entrustOverseasCap', d.entrustOverseasCap, 493333.33);

  console.log('\n--- A107012 行次 ---');
  eq('行47(应=加计基数)', LN(a.rows, '47'), 940000);
  console.log('      行40 =', fmt(LN(a.rows, '40')), '| 行41 =', fmt(LN(a.rows, '41')), '| 行42 =', fmt(LN(a.rows, '42')), '| 行51 =', fmt(LN(a.rows, '51')));
  eq('两口径汇合:|加计基数 − 行47| < 1', Math.abs(d.totalExpenseBase - LN(a.rows, '47')) < 1, true);

  console.log('\n--- ledger97 对账 ---');
  eq('l97.domesticBase', l97.domesticBase, 740000);
  eq('l97.cap2of3', l97.cap2of3, 493333.33);
  eq('l97.overseasTotalBase', l97.overseasTotalBase, 400000);
  eq('l97.overseasExcess', l97.overseasExcess, 0);

  console.log('\n--- 项目级 six 列 ---');
  const all = [...(l97.self || []), ...(l97.entrust || []), ...(l97.cooperation || []), ...(l97.centralized || [])];
  all.forEach(it => {
    console.log(`      ${it.project.code}: six=${JSON.stringify(it.six)}`);
    console.log(`         entrustDomestic=${it.entrustDomestic} entrustOverseas=${it.entrustOverseas} total=${it.total} 费=${it.expenseSum} 资=${it.capitalizeSum}`);
  });
  const p1 = all.find(x => x.project.code === '2026-RD-01');
  const p2 = all.find(x => x.project.code === '2026-RD-02');
  if (p1) {
    eq('RD-01 six.other', p1.six.other, 50000);
    eq('RD-01 entrustDomestic', p1.entrustDomestic, 80000);
    eq('RD-01 entrustOverseas', p1.entrustOverseas, 400000);
    eq('RD-01 total', p1.total, 1060000);
  } else ok(false, '未找到 2026-RD-01');
  if (p2) {
    eq('RD-02 six.personnel', p2.six.personnel, 100000);
    eq('RD-02 six.direct', p2.six.direct, 80000);
  } else ok(false, '未找到 2026-RD-02');

  console.log('\n--- 辅助账 ---');
  eq('辅助账合计(四类)', led.grand.total, 1260000);
  console.log('      费用化 =', fmt(led.grand.expenseSum), '| 资本化 =', fmt(led.grand.capitalizeSum));

  console.log('\n########## T9 结果:' + pass + ' 通过 / ' + fail + ' 失败 ##########');
  if (fails.length) { console.log('\n失败项:'); fails.forEach(f => console.log('  - ' + f)); }
})().catch(e => { console.error('脚本异常:', e); process.exit(1); });
