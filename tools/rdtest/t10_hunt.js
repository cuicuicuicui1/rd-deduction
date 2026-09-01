// 自主挖掘漏洞(测试计划之外):幂等性 / 误报 / 口径边界 / 级联
const H = require('./harness');
const fs = require('fs'); const path = require('path');
const { P, PUT, DEL, clear, comp, proj, exp, staff, ts, getSummary, getLedger97, getRisks, LN, fmt, eq, ok, sec, suite, j, BASE } = H;

(async () => {
  await suite('自主挖掘漏洞', 'hunt', async () => {
    const Y = '2026';

    sec('H1 双击"保存费用"→ 重复记账(无幂等)');
    {
      await clear(); await comp(); const p = await proj();
      const body = { projectId: p.id, category: 'other', amount: 5000, date: '2026-06-30', summary: '会议费' };
      const r1 = await P('/api/expenses', body);
      const r2 = await P('/api/expenses', body); // 会计双击
      const all = await j('/api/expenses');
      const dup = all.filter(e => e.summary === '会议费' && e.amount === 5000);
      console.log(`      两次 POST 同一条费用 → 库里 ${dup.length} 笔(id不同:${r1.id !== r2.id})`);
      if (dup.length > 1) console.log('      ⚠ 确认:无幂等/防重,双击会产生重复费用,虚增加计基数');
    }

    sec('H2 重复生成摊销计划 → 摊销额翻倍 → 加计翻倍');
    {
      await clear(); await comp();
      const p = await proj({ capitalization: 'capitalize' });
      await exp(p.id, 'personnel', 150000, { capitalization: 'capitalize' });
      await P('/api/amortization/plan', { projectId: p.id, startYear: 2026, years: 10 });
      await P('/api/amortization/plan', { projectId: p.id, startYear: 2026, years: 10 }); // 再点一次
      const ams = (await j('/api/amortizations')).filter(a => a.projectId === p.id && String(a.year) === '2026');
      const { d } = await getSummary(Y);
      console.log(`      生成 2 次摊销计划 → 2026 摊销记录 ${ams.length} 条,合计 ${fmt(ams.reduce((s, a) => s + a.amount, 0))}`);
      console.log(`      amortAmount=${fmt(d.amortAmount)} amortAdd=${fmt(d.amortAdd)} totalAdd=${fmt(d.totalAdd)}`);
      if (ams.length > 1) console.log('      ⚠ 确认:摊销计划无防重,重复生成导致摊销加计翻倍');
    }

    sec('H3 全委托研发企业(完全合规)误报 R34');
    {
      await clear(); await comp();
      const p = await proj({ form: 'entrust_domestic_org', techContractNo: 'T1' });
      await exp(p.id, 'entrust_domestic_org', 100000);
      const { risks } = await getRisks(Y);
      const r34 = risks.find(r => r.code === 'R34');
      console.log(`      会计口径=加计口径差异:委托100,000×80%=80,000,差异20,000(20%)`);
      if (r34) console.log(`      ⚠ 确认:R34 触发(${r34.level})——但委托×80%的20%差额是完全合规的,属误报`);
      else console.log('      R34 未触发(已剔除委托差额,合理)');
      ok(!r34, 'H3 全委托企业不应触发 R34(委托×80%差额是合规差异)');
    }

    sec('H4 受托开发项目的费用是否还显示在辅助账(易误导)');
    {
      await clear(); await comp();
      const p = await proj({ resultOwner: 'client', code: 'RD-CLIENT', name: '受托开发项目' });
      await exp(p.id, 'personnel', 100000);
      const led = await j(`/api/ledger?year=${Y}`);
      const l97 = await getLedger97(Y);
      const { d, col } = await getSummary(Y);
      const inLedger = led.projects.some(x => x.project.code === 'RD-CLIENT');
      const in97 = [...(l97.self || [])].some(x => x.project.code === 'RD-CLIENT');
      console.log(`      受托开发项目: 辅助账显示=${inLedger} ledger97显示=${in97} 加计基数=${fmt(d.totalExpenseBase)} 汇总表含该项目=${col.rows.some(r => r.code === 'RD-CLIENT')}`);
      console.log('      说明:费用化基数正确剔除(0),但辅助账仍展示该项目(用户需自行理解"受托开发不得加计")');
    }

    sec('H5 删除企业后 company=undefined 各接口是否崩');
    {
      await clear(); // 无任何 company
      const p = await proj();
      await exp(p.id, 'personnel', 100000);
      for (const u of ['/api/summary?year=2026', '/api/risks?year=2026', '/api/tax-saving?year=2026', '/api/calibers?year=2026', '/api/dashboard?year=2026']) {
        const r = await fetch(BASE + u);
        const t = await r.text();
        ok(r.status === 200, `H5 无企业 GET ${u} → ${r.status}${r.status !== 200 ? ' ' + t.slice(0, 100) : ''}`);
      }
    }

    sec('H6 高企口径其他费用限额:含资本化时 hiTech 是否也受 P0-1 影响');
    {
      await clear(); await comp({ isHiTech: true });
      const p = await proj();
      await exp(p.id, 'personnel', 100000);
      await exp(p.id, 'other', 50000);
      await exp(p.id, 'direct', 50000, { capitalization: 'capitalize', materialNo: 'L' });
      const cal = await j(`/api/calibers?year=${Y}`);
      // 系统:base5All=100,000+50,000(资)=150,000 → otherLimitHt=150,000×0.2/0.8=37,500;other 50,000→取37,500
      // 高企口径 hiTech = 150,000 + 37,500 = 187,500
      console.log(`      hiTech=${fmt(cal.hiTech)} otherLimitHt=${fmt(cal.otherLimitHt)} accounting=${fmt(cal.accounting)}`);
      console.log('      注:高企口径研发费用含资本化是符合国科发火〔2016〕32号的,此处与P0-1(加计扣除口径)不同');
    }

    sec('H7 委托境外研发挂"委托境外项目"时 2/3 限额基数');
    {
      await clear(); await comp();
      const pSelf = await proj({ code: 'RD-SELF' });
      const pOvs = await proj({ code: 'RD-OVS', form: 'entrust_overseas', techContractNo: 'T9' });
      await exp(pSelf.id, 'personnel', 100000);
      await exp(pOvs.id, 'entrust_overseas', 100000);
      const { d, a } = await getSummary(Y);
      const l97 = await getLedger97(Y);
      console.log(`      domesticTotal=${fmt(d.domesticTotal)} cap=${fmt(d.entrustOverseasCap)} 可扣=${fmt(d.entrustOverseas)}`);
      console.log(`      l97.domesticBase=${fmt(l97.domesticBase)} cap2of3=${fmt(l97.cap2of3)}`);
      // 境内基准应=100,000(只有自研) → 2/3=66,666.67 → 境外80,000超限
      eq('H7 境内基准(不含境外委托)', d.domesticTotal, 100000);
      eq('H7 境外可扣', d.entrustOverseas, 66666.67);
    }

    sec('H8 期间格式 ' + '2026/06 与 202606 的费用能否被年度归集');
    {
      await clear(); await comp(); const p = await proj();
      // 直接写文件构造非标准 period
      const e1 = await exp(p.id, 'personnel', 10000, { period: '2026-06' });
      const fp = path.join(__dirname, '..', '..', 'data', 'expenses.json');
      const arr = JSON.parse(fs.readFileSync(fp, 'utf8'));
      arr.push({ id: 'e_p1', projectId: p.id, category: 'personnel', amount: 20000, date: '2026-06-30', period: '2026/06', capitalization: 'expense', allocMethod: 'direct' });
      arr.push({ id: 'e_p2', projectId: p.id, category: 'personnel', amount: 30000, date: '2026-06-30', period: '202606', capitalization: 'expense', allocMethod: 'direct' });
      arr.push({ id: 'e_p3', projectId: p.id, category: 'personnel', amount: 40000, date: '2026-06-30', period: '', capitalization: 'expense', allocMethod: 'direct' });
      fs.writeFileSync(fp, JSON.stringify(arr, null, 2), 'utf8');
      const { d } = await getSummary(Y);
      console.log(`      四笔(标准/斜杠/紧凑/空period)归集后 totalExpenseBase=${fmt(d.totalExpenseBase)}`);
      console.log('      期望 100,000(全部计入2026);实际差异说明 period 过滤对非标准格式漏计');
      eq('H8 非标准 period 归集', d.totalExpenseBase, 100000);
    }

    sec('H9 金额精度:多笔小数分摊后合计是否=原值(对平)');
    {
      await clear(); await comp();
      const p1 = await proj({ code: 'RD-P1' }); const p2 = await proj({ code: 'RD-P2' });
      const s1 = await staff('分1'); const s2 = await staff('分2');
      await ts(s1.id, p1.id, '2026-06', 100, 160); // 100/140
      await ts(s2.id, p2.id, '2026-06', 40, 160);
      // 9999.99 按 100:40 分摊
      await exp(p1.id, 'depreciation', 9999.99, { allocMethod: 'ratioHours', isShared: true, period: '2026-06' });
      const led = await j(`/api/ledger?year=${Y}`);
      const tot = led.grand.total;
      console.log(`      9999.99 分摊后合计=${fmt(tot)} (期望 9,999.99,四舍五入差额修正)`);
      eq('H9 分摊对平', tot, 9999.99);
    }

    sec('H10 跨年费用 date 与 period 不一致时以谁为准');
    {
      await clear(); await comp(); const p = await proj();
      // date 2026-01 但 period 2025-12(年底计提,次年入账的常见情况)
      const e = await exp(p.id, 'personnel', 100000, { date: '2026-01-20', period: '2025-12' });
      const d25 = await getSummary('2025'); const d26 = await getSummary('2026');
      console.log(`      date=2026-01-20 period=2025-12 → 2025基数=${fmt(d25.d.totalExpenseBase)} 2026基数=${fmt(d26.d.totalExpenseBase)}`);
      console.log('      系统按 period 归属(2025)。会计上"计提年度"应为2025,口径合理;但date与period跨年可能误导');
      eq('H10 以 period 归属 2025', d25.d.totalExpenseBase, 100000);
      eq('H10 2026 不含', d26.d.totalExpenseBase, 0);
    }

    sec('H11 风险报告对"孤儿项目"费用是否崩溃(深度)');
    {
      await clear(); await comp();
      const p = await proj({ code: 'RD-GONE' });
      const e = await exp(p.id, 'personnel', 100000);
      await DEL('/api/projects/' + p.id);
      // 触发所有计算型接口
      for (const u of ['/api/summary?year=2026', '/api/ledger?year=2026', '/api/ledger97?year=2026', '/api/risks?year=2026', '/api/calibers?year=2026', '/api/dashboard?year=2026', '/api/export/archive.zip?year=2026']) {
        const r = await fetch(BASE + u);
        ok(r.status === 200, `H11 孤儿费用下 GET ${u} → ${r.status}`);
      }
      const { d, a } = await getSummary(Y);
      const gap = Math.abs(d.totalExpenseBase - LN(a.rows, '47'));
      console.log(`      孤儿费用 100,000: totalExpenseBase=${fmt(d.totalExpenseBase)} 行47=${fmt(LN(a.rows, '47'))} 差=${fmt(gap)}`);
      if (gap > 1) console.log('      ⚠ 确认:孤儿费用导致 加计基数≠行47(P0-3 再现)');
    }

    sec('H12 重复 POST /api/demo/load 幂等性');
    {
      await clear();
      await P('/api/demo/load', {});
      const n1 = (await j('/api/expenses')).length;
      await P('/api/demo/load', {});
      const n2 = (await j('/api/expenses')).length;
      eq('H12 demo/load 重复调用费用数不变(覆盖而非追加)', n2, n1);
    }
  });

  const chk = await j('/api/expenses');
  console.log('\n[数据恢复校验] 费用条数 =', chk.length, '(应为 14)');
})();
