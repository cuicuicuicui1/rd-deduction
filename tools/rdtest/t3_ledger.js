// T3 辅助账六类列 + 委托列对账
const H = require('./harness');
const { P, clear, comp, proj, exp, staff, ts, getSummary, getLedger97, LN, fmt, eq, ok, sec, suite, j } = H;

(async () => {
  await suite('T3 辅助账六类列+委托列对账', 't3', async () => {
    const Y = '2026';

    sec('场景 A:无共享、六类全列');
    {
      await clear(); await comp();
      const p1 = await proj({ code: 'RD-A1', name: '项目A1', capitalization: 'expense' });
      const p2 = await proj({ code: 'RD-A2', name: '项目A2', capitalization: 'capitalize' });
      await exp(p1.id, 'personnel', 100000); await exp(p1.id, 'direct', 50000, { materialNo: 'L' });
      await exp(p1.id, 'depreciation', 20000); await exp(p1.id, 'amortization', 10000);
      await exp(p1.id, 'design', 15000); await exp(p1.id, 'other', 5000);
      await exp(p2.id, 'personnel', 80000, { capitalization: 'capitalize' });
      await exp(p2.id, 'direct', 30000, { capitalization: 'capitalize', materialNo: 'L' });
      const l97 = await getLedger97(Y);
      const { col } = await getSummary(Y);
      const p1i = l97.self.find(x => x.project.code === 'RD-A1');
      const p2i = l97.self.find(x => x.project.code === 'RD-A2');
      console.log('      P1:', JSON.stringify(p1i.six), '费=' + p1i.expenseSum + ' 资=' + p1i.capitalizeSum + ' total=' + p1i.total);
      console.log('      P2:', JSON.stringify(p2i.six), '费=' + p2i.expenseSum + ' 资=' + p2i.capitalizeSum + ' total=' + p2i.total);
      const sixTotal = k => (p1i.six[k] || 0) + (p2i.six[k] || 0);
      eq('A personnel 合计', sixTotal('personnel'), 180000);
      eq('A direct 合计', sixTotal('direct'), 80000);
      eq('A depreciation 合计', sixTotal('depreciation'), 20000);
      eq('A amortization 合计', sixTotal('amortization'), 10000);
      eq('A design 合计', sixTotal('design'), 15000);
      eq('A other 合计', sixTotal('other'), 5000);
      eq('A P1 expenseSum=total', p1i.expenseSum, 200000); eq('A P1 total', p1i.total, 200000);
      eq('A P2 capitalizeSum=total', p2i.capitalizeSum, 110000); eq('A P2 total', p2i.total, 110000);
      const sixSum = ['personnel', 'direct', 'depreciation', 'amortization', 'design', 'other'].reduce((s, k) => s + sixTotal(k), 0);
      eq('A 六列合计', sixSum, 310000);
      eq('A 汇总表 totals.total', col.totals.total, 310000);
    }

    sec('场景 B:共享折旧工时分摊 + 委托项目');
    {
      await clear(); await comp();
      const p1 = await proj({ code: 'RD-B1', name: '项目B1', capitalization: 'expense' });
      const p2 = await proj({ code: 'RD-B2', name: '项目B2', capitalization: 'capitalize' });
      const p3 = await proj({ code: 'RD-B3', name: '项目B3', form: 'entrust_domestic_org', techContractNo: 'T3' });
      await exp(p1.id, 'personnel', 300000); await exp(p1.id, 'direct', 60000, { materialNo: 'L' });
      await exp(p1.id, 'depreciation', 20000, { allocMethod: 'ratioHours', isShared: true, period: '2026-06' });
      await exp(p1.id, 'other', 13000);
      await exp(p2.id, 'personnel', 200000, { capitalization: 'capitalize' });
      await exp(p2.id, 'direct', 12000, { capitalization: 'capitalize', materialNo: 'L' });
      await exp(p3.id, 'entrust_domestic_org', 100000);
      const s1 = await staff('甲'); const s2 = await staff('乙');
      await ts(s1.id, p1.id, '2026-06', 160, 160);
      await ts(s2.id, p2.id, '2026-06', 80, 160);
      const l97 = await getLedger97(Y);
      const { col } = await getSummary(Y);
      const p1i = l97.self.find(x => x.project.code === 'RD-B1');
      const p2i = l97.self.find(x => x.project.code === 'RD-B2');
      const p3i = l97.entrust.find(x => x.project.code === 'RD-B3');
      console.log('      P1.six.depreciation =', p1i.six.depreciation, ' P2.six.depreciation =', p2i.six.depreciation);
      console.log('      P3:', 'total=' + p3i.total, 'dedBase=' + p3i.dedBase, 'entrustDomestic=' + p3i.entrustDomestic);
      console.log('      l97.domesticBase =', l97.domesticBase);
      eq('B P1 分摊折旧', p1i.six.depreciation, 13333.33);
      eq('B P2 分摊折旧', p2i.six.depreciation, 6666.67);
      const selfSix = ['personnel', 'direct', 'depreciation', 'amortization', 'design', 'other'].reduce((s, k) => s + (p1i.six[k] || 0) + (p2i.six[k] || 0), 0);
      eq('B 自研六列合计', selfSix, 605000);
      eq('B P3 total', p3i.total, 100000);
      eq('B P3 dedBase', p3i.dedBase, 80000);
      eq('B P3 entrustDomestic', p3i.entrustDomestic, 80000);
      eq('B l97.domesticBase', l97.domesticBase, 685000);
      eq('B 汇总表 entrustDomestic', col.totals.entrustDomestic, 80000);
      eq('B 汇总表 six.depreciation', col.totals.six.depreciation, 20000);
      eq('B 汇总表 total', col.totals.total, 705000);
    }

    sec('场景 C:自研项目挂委托类别(核心回归)');
    {
      await clear(); await comp();
      const p = await proj({ code: 'RD-C1', name: '项目C1' });
      await exp(p.id, 'personnel', 100000);
      await exp(p.id, 'entrust_domestic_org', 100000);
      await exp(p.id, 'entrust_overseas', 500000);
      const l97 = await getLedger97(Y);
      const { d, a, col } = await getSummary(Y);
      const pi = l97.self.find(x => x.project.code === 'RD-C1');
      console.log('      six=', JSON.stringify(pi.six), 'entrustDomestic=' + pi.entrustDomestic, 'entrustOverseas=' + pi.entrustOverseas, 'total=' + pi.total);
      console.log('      l97: domesticBase=' + l97.domesticBase, 'cap2of3=' + l97.cap2of3, 'overseasTotalBase=' + l97.overseasTotalBase, 'overseasExcess=' + l97.overseasExcess);
      eq('C six.other=0(委托不得进其他列)', pi.six.other, 0);
      eq('C entrustDomestic', pi.entrustDomestic, 80000);
      eq('C entrustOverseas', pi.entrustOverseas, 400000);
      eq('C total', pi.total, 700000);
      eq('C l97.domesticBase(不含境外委托)', l97.domesticBase, 180000);
      eq('C l97.cap2of3', l97.cap2of3, 120000);
      eq('C l97.overseasTotalBase', l97.overseasTotalBase, 400000);
      eq('C l97.overseasExcess', l97.overseasExcess, 280000);
      eq('C 汇总表 six.other', col.totals.six.other, 0);
      eq('C 汇总表 entrustDomestic', col.totals.entrustDomestic, 80000);
      eq('C 汇总表 entrustOverseas', col.totals.entrustOverseas, 400000);
      eq('C 汇总表合计', col.totals.total, 700000);
      eq('C 加计基数(100,000+80,000+120,000)', d.totalExpenseBase, 300000);
      eq('C 行47', LN(a.rows, '47'), 300000);
    }

    sec('场景 D:委托境外个人(不得加计)');
    {
      await clear(); await comp();
      const p = await proj({ code: 'RD-D1', name: '项目D1' });
      await exp(p.id, 'personnel', 100000);
      await exp(p.id, 'entrust_overseas_person', 50000);
      const l97 = await getLedger97(Y);
      const { d, col } = await getSummary(Y);
      const pi = l97.self.find(x => x.project.code === 'RD-D1');
      console.log('      six.other=' + pi.six.other, 'entrustOverseas=' + pi.entrustOverseas, 'total=' + pi.total);
      eq('D six.other=0', pi.six.other, 0);
      eq('D entrustOverseas(×80%列示)', pi.entrustOverseas, 40000);
      eq('D total', pi.total, 150000);
      eq('D 加计基数(境外个人不计入)', d.totalExpenseBase, 100000);
    }
  });

  const chk = await j('/api/expenses');
  console.log('\n[数据恢复校验] 费用条数 =', chk.length, '(应为 14)');
})();
