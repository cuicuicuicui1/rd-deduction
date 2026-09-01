// T2 政策口径数字矩阵(22 场景,每场景 clear→构造→断言 detail 与 A107012 两口径汇合)
const H = require('./harness');
const { P, clear, comp, proj, exp, getSummary, LN, LNOTE, fmt, eq, ok, sec, suite, j } = H;

// 汇合断言:有摊销时 totalExpenseBase 不含摊销,与行47 口径不同,改用 totalAdd==行51
function converge(d, a, name, hasAmort) {
  const l47 = LN(a.rows, '47'), l51 = LN(a.rows, '51');
  if (!hasAmort) {
    ok(Math.abs(d.totalExpenseBase - l47) < 1, `${name} 汇合:|totalExpenseBase(${fmt(d.totalExpenseBase)}) − 行47(${fmt(l47)})| < 1`);
  }
  if (d.totalAdd > 0) ok(Math.abs(d.totalAdd - l51) < 1, `${name} 汇合:|totalAdd(${fmt(d.totalAdd)}) − 行51(${fmt(l51)})| < 1`);
}

(async () => {
  await suite('T2 政策口径数字矩阵', 't2', async () => {
    const Y = '2026';

    sec('S1 纯费用化 100%');
    {
      await clear(); await comp(); const p = await proj();
      await exp(p.id, 'personnel', 100000); await exp(p.id, 'direct', 50000, { materialNo: 'L1' });
      await exp(p.id, 'depreciation', 20000); await exp(p.id, 'other', 10000);
      const { d, a } = await getSummary(Y);
      eq('S1 基数', d.totalExpenseBase, 180000);
      eq('S1 行2', LN(a.rows, '2'), 180000); eq('S1 行40', LN(a.rows, '40'), 180000);
      eq('S1 行41', LN(a.rows, '41'), 180000); eq('S1 行47', LN(a.rows, '47'), 180000);
      eq('S1 行51', LN(a.rows, '51'), 180000); eq('S1 行42', LN(a.rows, '42'), 0);
      converge(d, a, 'S1');
    }

    sec('S2 资本化 200%摊销(annual=会计口径摊销额,不是×2)');
    {
      await clear(); await comp(); const p = await proj({ capitalization: 'capitalize' });
      await exp(p.id, 'personnel', 150000, { capitalization: 'capitalize' });
      const plan = await P('/api/amortization/plan', { projectId: p.id, startYear: 2026, years: 10 });
      eq('S2 摊销计划年摊销额', plan.annual, 15000);
      const { d, a } = await getSummary(Y);
      eq('S2 行43 本年摊销额', LN(a.rows, '43'), 15000);
      eq('S2 行51 摊销加计(×100%)', LN(a.rows, '51'), 15000);
      eq('S2 totalAdd', d.totalAdd, 15000);
      eq('S2 费用化基数(全资本化)', d.totalExpenseBase, 0);
      converge(d, a, 'S2', true);
    }

    sec('S3 委托境内 80%(自研项目挂委托类别)');
    {
      await clear(); await comp(); const p = await proj();
      await exp(p.id, 'entrust_domestic_org', 100000);
      const { d, a } = await getSummary(Y);
      eq('S3 委托境内×80%', d.entrustDomesticOrg, 80000);
      eq('S3 行36', LN(a.rows, '36'), 100000);
      eq('S3 行40', LN(a.rows, '40'), 80000); eq('S3 行47', LN(a.rows, '47'), 80000);
      converge(d, a, 'S3');
    }

    sec('S4 境外 2/3 限额(超限)');
    {
      await clear(); await comp(); const p = await proj();
      await exp(p.id, 'personnel', 100000); await exp(p.id, 'entrust_overseas', 100000);
      const { d, a } = await getSummary(Y);
      eq('S4 境外×80%', d.entrustOverseasRaw, 80000);
      eq('S4 境内基准', d.domesticTotal, 100000);
      eq('S4 2/3 限额', d.entrustOverseasCap, 66666.67);
      eq('S4 可扣', d.entrustOverseas, 66666.67);
      eq('S4 剔除', d.entrustOverseasExcess, 13333.33);
      eq('S4 基数', d.totalExpenseBase, 166666.67);
      eq('S4 行38', LN(a.rows, '38'), 66666.67);
      converge(d, a, 'S4');
    }

    sec('S5 境外不超限');
    {
      await clear(); await comp(); const p = await proj();
      await exp(p.id, 'personnel', 300000); await exp(p.id, 'entrust_overseas', 100000);
      const { d, a } = await getSummary(Y);
      eq('S5 境外全额', d.entrustOverseas, 80000);
      eq('S5 基数', d.totalExpenseBase, 380000);
      converge(d, a, 'S5');
    }

    sec('S6 其他费用 10% 限额超限');
    {
      await clear(); await comp(); const p = await proj();
      await exp(p.id, 'personnel', 100000); await exp(p.id, 'other', 30000);
      const { d, a } = await getSummary(Y);
      eq('S6 限额', d.otherLimit, 11111.11);
      eq('S6 可扣', d.otherDeductible, 11111.11);
      eq('S6 剔除', d.otherExcess, 18888.89);
      eq('S6 基数', d.totalExpenseBase, 111111.11);
      eq('S6 行34', LN(a.rows, '34'), 11111.11);
      converge(d, a, 'S6');
    }

    sec('S7 IC 120%(费用化)');
    {
      await clear(); await comp({ icIndustrial: true }); const p = await proj();
      await exp(p.id, 'personnel', 100000);
      const { d, a } = await getSummary(Y);
      eq('S7 deductRatio', d.deductRatio, 1.2);
      eq('S7 expenseAdd', d.expenseAdd, 120000);
      eq('S7 行51', LN(a.rows, '51'), 120000);
      ok(LNOTE(a.rows, '50').includes('120%'), 'S7 行50 note 含 120%: ' + LNOTE(a.rows, '50'));
    }

    sec('S8 IC 摊销 220%');
    {
      await clear(); await comp({ icIndustrial: true }); const p = await proj({ capitalization: 'capitalize' });
      await exp(p.id, 'personnel', 150000, { capitalization: 'capitalize' });
      await P('/api/amortization/plan', { projectId: p.id, startYear: 2026, years: 10 });
      const { d, a } = await getSummary(Y);
      eq('S8 摊销额', d.amortAmount, 15000);
      eq('S8 摊销加计(×120%)', d.amortAdd, 18000);
      eq('S8 行51', LN(a.rows, '51'), 18000);
      converge(d, a, 'S8', true);
    }

    sec('S9 小微 5%');
    {
      await clear(); await comp(); const p = await proj(); await exp(p.id, 'personnel', 100000);
      const t = await j('/api/tax-saving?year=2026&income=2000000');
      eq('S9 税率', t.rate, 0.05);
      ok(t.rateNote.includes('小型微利'), 'S9 rateNote 含小型微利: ' + t.rateNote);
    }

    sec('S10 高企 15%');
    {
      await clear(); await comp({ isHiTech: true }); const p = await proj(); await exp(p.id, 'personnel', 100000);
      const t = await j('/api/tax-saving?year=2026&income=10000000');
      eq('S10 税率', t.rate, 0.15);
    }

    sec('S11 特殊收入冲减(不超)');
    {
      await clear(); await comp(); const p = await proj();
      await exp(p.id, 'personnel', 50000);
      await P('/api/specialIncomes', { projectId: p.id, type: 'scrap', amount: 10000, date: '2026-06-20', period: '2026-06' });
      const { d, a } = await getSummary(Y);
      eq('S11 冲减', d.specialIncomeDeducted, 10000);
      eq('S11 基数', d.totalExpenseBase, 40000);
      eq('S11 行46', LN(a.rows, '46'), 10000);
      eq('S11 行47', LN(a.rows, '47'), 40000);
      converge(d, a, 'S11');
    }

    sec('S12 不征税收入剔除');
    {
      await clear(); await comp({ nonTaxRelated: { 2026: 30000 } }); const p = await proj();
      await exp(p.id, 'personnel', 100000);
      const { d, a } = await getSummary(Y);
      eq('S12 剔除', d.exemptExcluded, 30000);
      eq('S12 基数', d.totalExpenseBase, 70000);
      eq('S12 行47', LN(a.rows, '47'), 70000);
      converge(d, a, 'S12');
    }

    sec('S13 年度隔离');
    {
      await clear(); await comp(); const p = await proj();
      await exp(p.id, 'personnel', 70000, { date: '2025-06-30', period: '2025-06' });
      await exp(p.id, 'personnel', 150000, { date: '2026-06-30', period: '2026-06' });
      const d25 = await getSummary('2025'); const d26 = await getSummary('2026');
      eq('S13 2025 基数', d25.d.totalExpenseBase, 70000);
      eq('S13 2026 基数', d26.d.totalExpenseBase, 150000);
    }

    sec('S14 混合费+资');
    {
      await clear(); await comp(); const p = await proj();
      await exp(p.id, 'personnel', 100000);
      await exp(p.id, 'direct', 50000, { capitalization: 'capitalize', materialNo: 'L2' });
      const { d, a } = await getSummary(Y);
      console.log('      行2=' + fmt(LN(a.rows, '2')) + ' 行40=' + fmt(LN(a.rows, '40')) + ' 行41=' + fmt(LN(a.rows, '41')) + ' 行42=' + fmt(LN(a.rows, '42')));
      eq('S14 行2', LN(a.rows, '2'), 150000);
      eq('S14 行40', LN(a.rows, '40'), 150000);
      eq('S14 行41', LN(a.rows, '41'), 100000);
      eq('S14 行42', LN(a.rows, '42'), 50000);
      eq('S14 费用化基数', d.totalExpenseBase, 100000);
      eq('S14 capitalFormed', d.capitalFormed, 50000);
    }

    sec('S15 受托开发剔除');
    {
      await clear(); await comp(); const p = await proj({ resultOwner: 'client' });
      await exp(p.id, 'personnel', 100000);
      const { d, a } = await getSummary(Y);
      eq('S15 基数', d.totalExpenseBase, 0);
      eq('S15 行47', LN(a.rows, '47'), 0);
      eq('S15 行1 项目数', LN(a.rows, '1'), 0);
      eq('S15 excludedProjectCount', d.excludedProjectCount, 1);
    }

    sec('S16 资本化 other 共享限额');
    {
      await clear(); await comp(); const p = await proj();
      await exp(p.id, 'personnel', 100000);
      await exp(p.id, 'other', 20000, { capitalization: 'capitalize' });
      const { d, a } = await getSummary(Y);
      eq('S16 费用化可扣 other', d.otherDeductible, 0);
      eq('S16 基数', d.totalExpenseBase, 100000);
      eq('S16 行47', LN(a.rows, '47'), 100000);
      eq('S16 资本化成本(capitalFormed 不受限额)', d.capitalFormed, 20000);
    }

    sec('S17 特殊收入超基数+摊销');
    {
      await clear(); await comp(); const p = await proj();
      await exp(p.id, 'personnel', 100000);
      await exp(p.id, 'personnel', 100000, { capitalization: 'capitalize' });
      await P('/api/amortizations', { projectId: p.id, year: 2026, amount: 10000, note: '测试摊销' });
      await P('/api/specialIncomes', { projectId: p.id, type: 'trial', amount: 105000, date: '2026-06-20', period: '2026-06' });
      const { d, a } = await getSummary(Y);
      eq('S17 基数被冲完', d.totalExpenseBase, 0);
      eq('S17 摊销被冲减后', d.amortAmount, 5000);
      eq('S17 totalAdd', d.totalAdd, 5000);
      eq('S17 行47', LN(a.rows, '47'), 5000);
      eq('S17 行51', LN(a.rows, '51'), 5000);
      eq('S17 资本化形成成本不受冲', d.capitalFormed, 100000);
    }

    sec('S18 高企口径含资本化');
    {
      await clear(); await comp({ isHiTech: true }); const p = await proj();
      await exp(p.id, 'personnel', 100000);
      await exp(p.id, 'direct', 50000, { capitalization: 'capitalize', materialNo: 'L3' });
      const cal = await j(`/api/calibers?year=${Y}`);
      eq('S18 高企口径(含资本化)', cal.hiTech, 150000);
    }

    sec('S19 委托境内个人 80%');
    {
      await clear(); await comp(); const p = await proj();
      await exp(p.id, 'entrust_domestic_person', 50000);
      const { d, a } = await getSummary(Y);
      eq('S19 ×80%', d.entrustDomesticPerson, 40000);
      eq('S19 行36', LN(a.rows, '36'), 50000);
      eq('S19 行47', LN(a.rows, '47'), 40000);
      converge(d, a, 'S19');
    }

    sec('S20 境外个人不得加计');
    {
      await clear(); await comp(); const p = await proj();
      await exp(p.id, 'entrust_overseas_person', 50000);
      const { d, a } = await getSummary(Y);
      eq('S20 基数', d.totalExpenseBase, 0);
      eq('S20 行39(仅列示)', LN(a.rows, '39'), 50000);
      eq('S20 行40', LN(a.rows, '40'), 0);
    }

    sec('S21 委托项目(form=entrust_domestic_org)');
    {
      await clear(); await comp(); const p = await proj({ form: 'entrust_domestic_org', techContractNo: 'T001' });
      await exp(p.id, 'entrust_domestic_org', 100000);
      const { d, a } = await getSummary(Y);
      eq('S21 ×80%', d.entrustDomesticOrg, 80000);
      eq('S21 行40', LN(a.rows, '40'), 80000);
      converge(d, a, 'S21');
    }

    sec('S22 合作研发');
    {
      await clear(); await comp(); const p = await proj({ form: 'cooperation' });
      await exp(p.id, 'personnel', 80000);
      const { d, a } = await getSummary(Y);
      eq('S22 基数', d.totalExpenseBase, 80000);
      eq('S22 行2', LN(a.rows, '2'), 80000);
      converge(d, a, 'S22');
    }
  });

  const chk = await j('/api/expenses');
  console.log('\n[数据恢复校验] 费用条数 =', chk.length, '(应为 14)');
})();
