// T1 端到端业务流 + 五件套
const H = require('./harness');
const { P, clear, comp, proj, exp, staff, ts, getSummary, getLedger97, getRisks, LN, fmt, eq, ok, sec, suite, j, BASE } = H;

(async () => {
  await suite('T1 端到端业务流', 't1', async () => {
    await clear();
    const c = await comp({
      industry: '制造业', isHiTech: true, headcount: 120, techStaff: 18,
      revenue: { 2026: 20000000, 2025: 18000000 },
      electricity: { 2026: 500000, 2025: 480000 },
      output: { 2026: 8000, 2025: 8200 },
      hiTechIncome: { 2026: 13000000 },
    });
    const p1 = await proj({ code: '2026-RD-01', name: '项目一(自研费用化)', capitalization: 'expense' });
    const p2 = await proj({ code: '2026-RD-02', name: '项目二(自研资本化)', capitalization: 'capitalize' });
    const p3 = await proj({ code: '2026-RD-03', name: '项目三(委托境内)', form: 'entrust_domestic_org', techContractNo: 'JS2026-001' });

    // 费用 705,000
    await exp(p1.id, 'personnel', 300000);
    await exp(p1.id, 'direct', 60000, { materialNo: 'LL-2026-001' });
    await exp(p1.id, 'depreciation', 20000, { allocMethod: 'ratioHours', isShared: true, period: '2026-06' });
    await exp(p1.id, 'other', 13000);
    await exp(p2.id, 'personnel', 200000, { capitalization: 'capitalize' });
    await exp(p2.id, 'direct', 12000, { capitalization: 'capitalize', materialNo: 'LL-2026-002' });
    await exp(p3.id, 'entrust_domestic_org', 100000);

    await P('/api/specialIncomes', { projectId: p1.id, type: 'trial', amount: 10000, date: '2026-06-20', period: '2026-06', summary: '试制品销售' });

    // 工时:RD-01 160h / RD-02 80h
    const s1 = await staff('张三'); const s2 = await staff('李四');
    const s3 = await staff('王五'); const s4 = await staff('赵六');
    await ts(s1.id, p1.id, '2026-06', 80, 160);
    await ts(s2.id, p1.id, '2026-06', 80, 160);
    await ts(s3.id, p2.id, '2026-06', 40, 160);
    await ts(s4.id, p2.id, '2026-06', 40, 160);

    await P('/api/assets', { name: '3D扫描仪', type: 'equipment', period: '2026', depreciation: 33333, rdHours: 600, totalHours: 1000 });

    const plan = await P('/api/amortization/plan', { projectId: p2.id, startYear: 2026, years: 10 });
    console.log('      摊销计划: formed=' + plan.formed + ' annual=' + plan.annual);

    const Y = '2026';
    const { d, a, col } = await getSummary(Y);
    const cal = await j(`/api/calibers?year=${Y}`);
    const l97 = await getLedger97(Y);
    const led = await j(`/api/ledger?year=${Y}`);
    const risk = await getRisks(Y);

    sec('A1-A7 口径与基数');
    eq('A1 会计口径(费用合计)', cal.accounting, 705000);
    const all97 = [...(l97.self || []), ...(l97.entrust || []), ...(l97.cooperation || []), ...(l97.centralized || [])];
    const sum97 = all97.reduce((s, x) => s + (x.total || 0), 0);
    eq('A2 辅助账四类合计', sum97, 705000);
    eq('A3 加计基数 totalExpenseBase', d.totalExpenseBase, 463000);
    eq('A4 委托境内×80%', d.entrustDomesticOrg, 80000);
    eq('A5 其他费用可扣(13,000未超限)', d.otherDeductible, 13000);
    eq('A6 特殊收入冲减', d.specialIncomeDeducted, 10000);
    const diffRate = Math.abs(705000 - d.totalExpenseBase - 212000) / 705000;
    eq('A7 口径差异率', Math.round(diffRate * 1000) / 10, 4.3);
    eq('A7b 资本化形成成本', d.capitalFormed, 212000);

    sec('A8-A9 A107012 行次');
    console.log('      行2=' + fmt(LN(a.rows, '2')) + ' 行36=' + fmt(LN(a.rows, '36')) + ' 行40=' + fmt(LN(a.rows, '40')) +
      ' 行41=' + fmt(LN(a.rows, '41')) + ' 行42=' + fmt(LN(a.rows, '42')) +
      ' 行43=' + fmt(LN(a.rows, '43')) + ' 行45=' + fmt(LN(a.rows, '45')) +
      ' 行46=' + fmt(LN(a.rows, '46')) + ' 行47=' + fmt(LN(a.rows, '47')) + ' 行51=' + fmt(LN(a.rows, '51')));
    eq('A8 A107012 行40', LN(a.rows, '40'), 685000);
    eq('A9 A107012 行47', LN(a.rows, '47'), 463000);

    sec('两口径汇合断言(计划第152行要求)');
    const gap1 = Math.abs(d.totalExpenseBase - LN(a.rows, '47'));
    ok(gap1 < 1, `|totalExpenseBase(${fmt(d.totalExpenseBase)}) − 行47(${fmt(LN(a.rows, '47'))})| = ${fmt(gap1)} < 1`);
    const gap2 = Math.abs(d.totalAdd - LN(a.rows, '51'));
    ok(gap2 < 1, `|totalAdd(${fmt(d.totalAdd)}) − 行51(${fmt(LN(a.rows, '51'))})| = ${fmt(gap2)} < 1`);

    sec('A10-A11 汇总表');
    eq('A10 汇总表 totals.total', col.totals.total, 705000);
    ok(Math.abs((col.totals.expenseSum + col.totals.capitalizeSum) - col.totals.total) < 1,
      `A11 费用化+资本化=合计 (${fmt(col.totals.expenseSum)}+${fmt(col.totals.capitalizeSum)}=${fmt(col.totals.total)})`);

    sec('A12 风险');
    console.log('      风险计数:', JSON.stringify(risk.counts));
    risk.risks.forEach(r => console.log(`        [${r.level}] ${r.code} ${r.title}`));
    eq('A12 风险红项数', risk.counts.error, 0);
    const r09 = risk.risks.filter(r => r.code === 'R09');
    ok(r09.length <= 1, `R09 聚合条数=${r09.length}(计划要求:工时占比应聚合,不得逐期噪音)`);

    sec('A13 备查资料包 zip 条目');
    const zipRes = await fetch(BASE + '/api/export/archive.zip?year=2026');
    const zipBuf = Buffer.from(await zipRes.arrayBuffer());
    console.log('      zip 大小 =', zipBuf.length, '字节');
    const names = [];
    for (let i = 0; i < zipBuf.length - 30; i++) {
      if (zipBuf.readUInt32LE(i) === 0x04034b50) {
        const nl = zipBuf.readUInt16LE(i + 26);
        try { names.push(zipBuf.slice(i + 30, i + 30 + nl).toString('utf8')); } catch {}
      }
    }
    console.log('      条目:', names.join(' | '));
    const want = ['00', '01', '02', '03', '04', '05', '06', '07', '08', '09', '13'];
    want.forEach(w => ok(names.some(n => n.includes('/' + w) || n.includes(w)), `A13 含条目 ${w}`));
    ok(zipBuf.length > 5120, `A13b zip > 5KB (${zipBuf.length})`);

    sec('A14 风险报告 HTML');
    const html = await (await fetch(BASE + '/api/export/risks.html?year=2026')).text();
    ok(html.includes('测试公司'), 'A14 风险报告含公司名');
    ok(html.includes('关键指标快照'), 'A14 风险报告含"关键指标快照"');

    sec('A15 2025 demo 基线');
    try {
      const d25 = await j('/api/summary?year=2025');
      const det = d25.summary ? d25.summary.detail : d25.detail;
      eq('A15 2025 totalAdd(示例数据)', det.totalAdd, 2712962.97);
    } catch (e) { console.log('      (2025 无示例数据,跳过: ' + e.message + ')'); }
  });

  // 验证用户数据已恢复
  const chk = await j('/api/expenses');
  console.log('\n[数据恢复校验] 当前费用条数 =', chk.length, '(应为 14)');
})();
