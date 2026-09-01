// verify_2025.js — 2025 demo 基线验证(P0-1 修复后应为 2,712,962.97)
const BASE = 'http://127.0.0.1:8765';
const j = async (u, o, tries = 3) => {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(BASE + u, o);
      const t = await r.text();
      let b = null; try { b = JSON.parse(t); } catch {}
      if (!r.ok) throw new Error(u + ' HTTP ' + r.status);
      return b;
    } catch (e) { if (i === tries - 1) throw e; await new Promise(res => setTimeout(res, 800)); }
  }
};
(async () => {
  const bk = await j('/api/backup/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"tag":"v2025"}' });
  console.log('backup:', bk.name);
  try {
    await j('/api/demo/clear', { method: 'POST' });
    await j('/api/demo/load', { method: 'POST' });
    const s = await j('/api/summary?year=2025');
    const d = s.summary ? s.summary.detail : s.detail;
    console.log('== 2025 demo after fix ==');
    ['base5', 'otherLimit', 'otherDeductible', 'otherExcess', 'domesticTotal', 'entrustOverseasRaw', 'entrustOverseasCap', 'entrustOverseas', 'entrustOverseasExcess', 'totalExpenseBase', 'expenseAdd', 'amortAdd', 'totalAdd'].forEach(k => console.log(k.padEnd(24), d[k]));
    const rows = s.a107012.rows;
    ['2', '34', '36', '37', '38', '40', '41', '42', '47', '51'].forEach(l => { const r = rows.find(x => String(x.line) === l); console.log('行' + l, r ? r.amount : '(缺)'); });
    console.log('EXPECTED totalAdd = 2712962.97; diff =', Math.abs(d.totalAdd - 2712962.97).toFixed(2));
  } finally {
    await j('/api/backup/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: bk.name }) });
    console.log('restored');
  }
})();