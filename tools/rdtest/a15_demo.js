// T1-A15 补验:载入 2025 示例数据,核对 totalAdd 基线,然后恢复用户数据
const H = require('./harness');
const { P, clear, backup, restore, getSummary, fmt, eq, ok, sec, j } = H;

(async () => {
  const bk = await backup('pretest_a15');
  try {
    await clear();
    await P('/api/demo/load', {});
    const { d } = await getSummary('2025');
    console.log('      2025 示例数据: totalAdd =', fmt(d.totalAdd), 'totalExpenseBase =', fmt(d.totalExpenseBase));
    console.log('      其他费用限额 =', fmt(d.otherLimit), '可扣 =', fmt(d.otherDeductible), '超限 =', fmt(d.otherExcess));
    console.log('      境外×80% =', fmt(d.entrustOverseasRaw), '限额 =', fmt(d.entrustOverseasCap), '可扣 =', fmt(d.entrustOverseas), '超限 =', fmt(d.entrustOverseasExcess));
    eq('A15 2025 示例数据 totalAdd', d.totalAdd, 2712962.97);
    const risk = await H.getRisks('2025');
    console.log('      2025 风险计数:', JSON.stringify(risk.counts));
  } finally {
    await restore(bk.name);
    const chk = await j('/api/expenses');
    console.log('[恢复] 费用条数 =', chk.length, '(应为 14)');
  }
})();
