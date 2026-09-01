// 全行业场景对账:预期值均为【人工手工推导后硬编码】,脚本只负责录入+取数+比对
// 推导过程见 docs/全行业场景对账报告_20260901.md
const H = require('./harness');
const { P, clear, backup, restore, j, getSummary, LN, fmt, sec, BASE } = H;

// ---------- 断言(全部与硬编码预期比) ----------
let pass = 0, fail = 0; const fails = [];
function eq(name, actual, expected, tol = 0.01) {
  const c = (typeof expected === 'number' && typeof actual === 'number')
    ? Math.abs(actual - expected) <= tol : String(actual) === String(expected);
  if (c) { pass++; console.log(`  PASS  ${name} = ${fmt(actual)}`); }
  else { fail++; fails.push(`[${name}] 实际=${fmt(actual)} 预期=${fmt(expected)}`); console.log(`  FAIL  ${name}: 实际=${fmt(actual)} 预期=${fmt(expected)}`); }
}
function ok(c, m) {
  if (c) { pass++; console.log(`  PASS  ${m}`); }
  else { fail++; fails.push(m); console.log(`  FAIL  ${m}`); }
}

const mkComp = (o) => P('/api/companies', { name: 'X', industry: '制造业', levyType: '查账征收', ...o });
const mkProj = (o) => P('/api/projects', {
  form: 'self', resultOwner: 'self', capitalization: 'expense',
  startDate: '2026-01-01', endDate: '2026-12-31', hasApprovalDoc: true, hasPlanDoc: true,
  approvalDate: '2025-12-01', ...o,
});
const mkExp = (pid, cat, amt, o = {}) => P('/api/expenses', {
  projectId: pid, category: cat, amount: amt, date: '2026-06-30', period: '2026-06',
  capitalization: 'expense', summary: cat + '-' + amt, voucherNo: 'V1', invoiceNo: 'INV1',
  paymentMethod: '银行转账', materialNo: cat === 'direct' ? 'LL-1' : undefined, ...o,
});
const mkTs = (pid, period, rd, total = 176) => P('/api/staff', { name: 'S' + Math.random().toString(36).slice(2, 7), dept: '研发部', role: '工程师', isDirect: true })
  .then(s => P('/api/timesheets', { staffId: s.id, projectId: pid, period, rdHours: rd, totalHours: total }));

(async () => {
  const bk = await backup('pretest_t11');
  try {

    // ============================================================
    sec('场景1 中型制造业(费用化+资本化+委托境内+共用设备工时分摊)');
    // 手工推导(关键:分摊额按【目标项目】资本化属性定型,而非继承源费用):
    // 会计口径 = 800k+300k+120k+60k+90k+150k+400k+500k+350k = 2,770,000
    // 共用折旧 120k 按工时 4:1 → P1(费用化)96,000 定型费用化 ; P2(资本化)24,000 定型资本化
    // base5 = 800k+300k+96k+60k+90k = 1,346,000  (P2 的 24k 进资本化池,不进 base5)
    // RD-02 无摊销 → 未形成无形资产 → base5CapF=0
    // otherLimit = 1,346,000/9 = 149,555.56 ; other 150,000 → 超限444.44,可扣149,555.56
    // 加计基数 = 1,346,000+149,555.56+400,000×80% = 1,815,555.56
    // capitalFormed = 500k+350k+24k(分摊到资本化项目) = 874,000
    // 辅助账 P1 = 800k+300k+96k+60k+90k+150k+400k = 1,896,000 ; P2 = 500k+350k+24k = 874,000
    // 节税 = 1,815,555.56 × 5% = 90,777.78
    {
      await clear(); await mkComp({ name: '恒力智能装备制造有限公司' });
      const p1 = await mkProj({ code: 'M1-01', name: '智能装配线研发', capitalization: 'expense' });
      const p2 = await mkProj({ code: 'M1-02', name: '精密减速机试制', capitalization: 'capitalize' });
      await mkExp(p1.id, 'personnel', 800000); await mkExp(p1.id, 'direct', 300000);
      await mkExp(p1.id, 'depreciation', 120000, { allocMethod: 'ratioHours', isShared: true, period: '2026-06' });
      await mkExp(p1.id, 'amortization', 60000); await mkExp(p1.id, 'design', 90000);
      await mkExp(p1.id, 'other', 150000); await mkExp(p1.id, 'entrust_domestic_org', 400000, { contractNo: 'HT1' });
      await mkExp(p2.id, 'personnel', 500000, { capitalization: 'capitalize' });
      await mkExp(p2.id, 'direct', 350000, { capitalization: 'capitalize' });
      await mkTs(p1.id, '2026-06', 160); await mkTs(p2.id, '2026-06', 40);
      const { d, a, col } = await getSummary('2026');
      const cal = await j('/api/calibers?year=2026');
      eq('1-1 会计口径', cal.accounting, 2770000);
      eq('1-2 base5(分摊到P2的24k转资本化,不计入)', d.base5, 1346000);
      eq('1-3 其他费用限额', d.otherLimit, 149555.56);
      eq('1-4 其他费用可扣(超限444.44)', d.otherDeductible, 149555.56);
      eq('1-5 委托境内×80%', d.entrustDomesticOrg, 320000);
      eq('1-6 加计基数', d.totalExpenseBase, 1815555.56);
      eq('1-7 加计扣除额', d.totalAdd, 1815555.56);
      eq('1-8 资本化形成成本(含分摊24k)', d.capitalFormed, 874000);
      eq('1-9 行40', LN(a.rows, '40'), 1815555.56);
      eq('1-10 行42(未结转无形资产)', LN(a.rows, '42'), 0);
      eq('1-11 行47', LN(a.rows, '47'), 1815555.56);
      eq('1-12 高企口径(含资本化)', cal.hiTech, 2690000);
      const led = await j('/api/ledger?year=2026');
      const g1 = led.projects.find(x => x.project.code === 'M1-01');
      const g2 = led.projects.find(x => x.project.code === 'M1-02');
      eq('1-13 辅助账 P1(含分摊折旧96k)', g1.total, 1896000);
      eq('1-14 辅助账 P2(含分摊折旧24k+资本化85万)', g2.total, 874000);
      eq('1-15 辅助账合计=会计口径', led.grand.total, 2770000);
      // 节税:应纳税所得额 3,000,000 → 小微5%
      const t = await j('/api/tax-saving?year=2026&income=3000000');
      eq('1-16 税率(小微5%)', t.rate, 0.05);
      eq('1-17 节税额(181.56万×5%)', t.saving, 90777.78);
    }

    // ============================================================
    sec('场景2 软件企业(高企 + 委托境外2/3未超限 + 其他费用超限)');
    // 手工推导:
    // 会计口径 = 1200k+180k+150k+200k+900k+300k = 2,930,000
    // base5 = 1200k+180k+150k = 1,530,000
    // otherLimit = 1,530,000/9 = 170,000 ; other 200,000 → 超限,可扣170,000,剔除30,000
    // 委托境内 300k×80% = 240,000 ; 委托境外 900k×80% = 720,000
    // 境内基数 = 1,530,000+170,000+240,000 = 1,940,000 ; 2/3限额 = 1,293,333.33
    // 720,000 < 1,293,333.33 → 全额
    // 加计基数 = 1,530,000+170,000+240,000+720,000 = 2,660,000
    {
      await clear(); await mkComp({ name: '云启软件技术有限公司', industry: '软件和信息技术服务业', isHiTech: true });
      const p1 = await mkProj({ code: 'S2-01', name: '工业软件平台研发' });
      await mkExp(p1.id, 'personnel', 1200000); await mkExp(p1.id, 'direct', 180000);
      await mkExp(p1.id, 'depreciation', 150000); await mkExp(p1.id, 'other', 200000);
      await mkExp(p1.id, 'entrust_overseas', 900000, { contractNo: 'HT-OVS' });
      await mkExp(p1.id, 'entrust_domestic_org', 300000, { contractNo: 'HT-DOM' });
      const { d, a } = await getSummary('2026');
      const cal = await j('/api/calibers?year=2026');
      eq('2-1 会计口径', cal.accounting, 2930000);
      eq('2-2 base5', d.base5, 1530000);
      eq('2-3 其他费用限额', d.otherLimit, 170000);
      eq('2-4 其他费用超限剔除', d.otherExcess, 30000);
      eq('2-5 境外×80%', d.entrustOverseasRaw, 720000);
      eq('2-6 境内2/3限额基数', d.domesticTotal, 1940000);
      eq('2-7 境外2/3限额', d.entrustOverseasCap, 1293333.33);
      eq('2-8 境外可加计(未超限)', d.entrustOverseas, 720000);
      eq('2-9 加计基数', d.totalExpenseBase, 2660000);
      eq('2-10 行40', LN(a.rows, '40'), 2660000);
      eq('2-11 行47=行51', LN(a.rows, '51'), 2660000);
      eq('2-12 高企口径(其他费用限额20%未超)', cal.hiTech, 2690000);
      // 税率:高企,应税 8,000,000 > 300万 → 15%
      const t = await j('/api/tax-saving?year=2026&income=8000000');
      eq('2-13 税率(高企15%)', t.rate, 0.15);
      eq('2-14 节税额(266万×15%)', t.saving, 399000);
      eq('2-15 高企亏损结转10年', t.carryYears, 10);
    }

    // ============================================================
    sec('场景3 生物医药(已形成无形资产 + 本年摊销 + 特殊收入冲减)');
    // 手工推导:
    // 会计口径 = 2000k+800k+300k = 3,100,000
    // base5 = 2000k+800k = 2,800,000 ; 资本化项目已形成(有2026摊销)但本年无新增支出→base5CapF=0
    // otherLimit = 2,800,000/9 = 311,111.11 ; other 300,000 未超限
    // 费用化基数 = 2,800,000+300,000 = 3,100,000 ; 特殊收入冲减150,000 → 2,950,000
    // 摊销 300,000 ×100% = 300,000
    // totalAdd = 2,950,000+300,000 = 3,250,000
    // 行45 = 行41(3,100,000)+行43(300,000) = 3,400,000 ; 行46=150,000 ; 行47=3,250,000
    {
      await clear(); await mkComp({ name: '济世生物医药有限公司', industry: '生物医药制造业' });
      const p1 = await mkProj({ code: 'B3-01', name: '一类新药临床研究' });
      const p2 = await mkProj({ code: 'B3-02', name: '缓释制剂技术(已转无形资产)', capitalization: 'capitalize' });
      await mkExp(p1.id, 'personnel', 2000000); await mkExp(p1.id, 'direct', 800000);
      await mkExp(p1.id, 'other', 300000);
      await P('/api/amortizations', { projectId: p2.id, year: 2026, amount: 300000, note: '2025年形成无形资产,本年摊销' });
      await P('/api/specialIncomes', { projectId: p1.id, type: 'trial', amount: 150000, date: '2026-06-20', period: '2026-06' });
      const { d, a } = await getSummary('2026');
      eq('3-1 会计口径', (await j('/api/calibers?year=2026')).accounting, 3100000);
      eq('3-2 base5', d.base5, 2800000);
      eq('3-3 其他费用限额', d.otherLimit, 311111.11);
      eq('3-4 其他费用可扣(未超限)', d.otherDeductible, 300000);
      eq('3-5 特殊收入冲减', d.specialIncomeDeducted, 150000);
      eq('3-6 冲减后费用化基数', d.totalExpenseBase, 2950000);
      eq('3-7 本年摊销额', d.amortAmount, 300000);
      eq('3-8 摊销加计(×100%)', d.amortAdd, 300000);
      eq('3-9 加计扣除额合计', d.totalAdd, 3250000);
      eq('3-10 行43 本年摊销', LN(a.rows, '43'), 300000);
      eq('3-11 行45', LN(a.rows, '45'), 3400000);
      eq('3-12 行46 特殊收入', LN(a.rows, '46'), 150000);
      eq('3-13 行47', LN(a.rows, '47'), 3250000);
      eq('3-14 行51=totalAdd', LN(a.rows, '51'), 3250000);
    }

    // ============================================================
    sec('场景4 集成电路企业(IC 120%费用化 + 220%摊销)');
    // 手工推导:
    // base5 = 5000k+2000k = 7,000,000 ; otherLimit = 7,000,000/9 = 777,777.78 ; other 700,000 未超限
    // 费用化基数 = 7,000,000+700,000 = 7,700,000
    // expenseAdd = 7,700,000×120% = 9,240,000
    // 摊销 400,000 ×120% = 480,000
    // totalAdd = 9,720,000 ; 行51 = (7,700,000+400,000)×1.2 = 9,720,000
    {
      await clear(); await mkComp({ name: '芯原微电子有限公司', industry: '制造业', icIndustrial: true });
      const p1 = await mkProj({ code: 'I4-01', name: '车规级MCU研发' });
      const p2 = await mkProj({ code: 'I4-02', name: '工艺IP(已转无形资产)', capitalization: 'capitalize' });
      await mkExp(p1.id, 'personnel', 5000000); await mkExp(p1.id, 'direct', 2000000);
      await mkExp(p1.id, 'other', 700000);
      await P('/api/amortizations', { projectId: p2.id, year: 2026, amount: 400000, note: '本年摊销' });
      const { d, a } = await getSummary('2026');
      eq('4-1 加计比例 120%', d.deductRatio, 1.2);
      eq('4-2 其他费用限额', d.otherLimit, 777777.78);
      eq('4-3 费用化基数', d.totalExpenseBase, 7700000);
      eq('4-4 费用化加计(×120%)', d.expenseAdd, 9240000);
      eq('4-5 摊销加计(×120%)', d.amortAdd, 480000);
      eq('4-6 加计扣除额合计', d.totalAdd, 9720000);
      eq('4-7 行51', LN(a.rows, '51'), 9720000);
      // 2028年超出44号公告适用期 → 回落100%
      const s28 = await getSummary('2028');
      eq('4-8 2028年加计比例回落100%', s28.d.deductRatio, 1.0);
    }

    // ============================================================
    sec('场景5 负面清单行业(批发零售业)—— 应红牌阻断但数字照算');
    // 手工推导:
    // base5 = 500k+200k = 700,000 ; otherLimit = 700,000/9 = 77,777.78
    // other 80,000 > 77,777.78 → 可扣 77,777.78,剔除 2,222.22
    // 加计基数 = 700,000+77,777.78 = 777,777.78
    {
      await clear(); await mkComp({ name: '宏发商贸批发有限公司', industry: '批发业' });
      const p1 = await mkProj({ code: 'N5-01', name: '供应链系统研发' });
      await mkExp(p1.id, 'personnel', 500000); await mkExp(p1.id, 'direct', 200000);
      await mkExp(p1.id, 'other', 80000);
      const { d } = await getSummary('2026');
      const { risks, counts } = await H.getRisks('2026');
      eq('5-1 base5', d.base5, 700000);
      eq('5-2 其他费用限额', d.otherLimit, 77777.78);
      eq('5-3 其他费用超限剔除', d.otherExcess, 2222.22);
      eq('5-4 加计基数', d.totalExpenseBase, 777777.78);
      ok(counts.error >= 1, `5-5 负面清单行业触发红牌(error=${counts.error})`);
      ok(risks.some(r => r.code === 'R01'), '5-6 R01 负面行业规则命中');
    }

    // ============================================================
    sec('场景6 受托开发 + 委托境外个人(不得加计组合)');
    // 手工推导:
    // RD-01 受托开发(成果归客户)整项目剔除 600,000
    // RD-02 自研 base5 = 400,000 ; entrust_overseas_person 200,000 不得加计
    // 会计口径 = 600,000+400,000+200,000 = 1,200,000
    // 加计基数 = 400,000 ; 差异 800,000 = 受托600,000 + 境外个人200,000
    {
      await clear(); await mkComp({ name: '远东工程技术有限公司' });
      const p1 = await mkProj({ code: 'E6-01', name: '客户定制产线开发(受托)', resultOwner: 'client' });
      const p2 = await mkProj({ code: 'E6-02', name: '自主焊接工艺研发' });
      await mkExp(p1.id, 'personnel', 600000);
      await mkExp(p2.id, 'personnel', 400000);
      await mkExp(p2.id, 'entrust_overseas_person', 200000);
      const { d, a } = await getSummary('2026');
      const { risks } = await H.getRisks('2026');
      eq('6-1 会计口径', (await j('/api/calibers?year=2026')).accounting, 1200000);
      eq('6-2 受托开发整项目剔除后加计基数', d.totalExpenseBase, 400000);
      eq('6-3 剔除项目计数', d.excludedProjectCount, 1);
      eq('6-4 行39 境外个人(仅列示)', LN(a.rows, '39'), 200000);
      eq('6-5 行40', LN(a.rows, '40'), 400000);
      eq('6-6 行47', LN(a.rows, '47'), 400000);
      ok(risks.some(r => r.code === 'R24' && r.level === 'error'), '6-7 R24 受托开发红牌');
    }

    // ============================================================
    sec('场景7 其他费用大幅超限 + 共用设备工时分摊(传统制造业)');
    // 手工推导:
    // 共用折旧 240,000 按 300:100 → P1 180,000 / P2 60,000
    // base5 = (500k+300k) + (180k+60k) = 1,040,000
    // otherLimit = 1,040,000/9 = 115,555.56 ; other 200,000 → 可扣115,555.56,剔除84,444.44
    // 加计基数 = 1,040,000+115,555.56 = 1,155,555.56
    // 辅助账 P1 = 500k+180k+200k = 880,000 ; P2 = 300k+60k = 360,000 ; 合计 1,240,000
    {
      await clear(); await mkComp({ name: '华兴重工机械有限公司' });
      const p1 = await mkProj({ code: 'T7-01', name: '大型结构件焊接工艺' });
      const p2 = await mkProj({ code: 'T7-02', name: '热处理工艺改进' });
      await mkExp(p1.id, 'personnel', 500000);
      await mkExp(p1.id, 'depreciation', 240000, { allocMethod: 'ratioHours', isShared: true, period: '2026-06' });
      await mkExp(p1.id, 'other', 200000);
      await mkExp(p2.id, 'personnel', 300000);
      await mkTs(p1.id, '2026-06', 132); await mkTs(p2.id, '2026-06', 44);
      const { d, a } = await getSummary('2026');
      const led = await j('/api/ledger?year=2026');
      eq('7-1 base5(含分摊折旧)', d.base5, 1040000);
      eq('7-2 其他费用限额', d.otherLimit, 115555.56);
      eq('7-3 其他费用可扣', d.otherDeductible, 115555.56);
      eq('7-4 超限剔除', d.otherExcess, 84444.44);
      eq('7-5 加计基数', d.totalExpenseBase, 1155555.56);
      eq('7-6 行47', LN(a.rows, '47'), 1155555.56);
      const g1 = led.projects.find(x => x.project.code === 'T7-01');
      const g2 = led.projects.find(x => x.project.code === 'T7-02');
      eq('7-7 辅助账 P1(折旧分摊18万)', g1.total, 880000);
      eq('7-8 辅助账 P2(折旧分摊6万)', g2.total, 360000);
      eq('7-9 辅助账合计=会计口径', led.grand.total, 1240000);
    }

    // ============================================================
    sec('场景8 集团集中研发 + 合作研发');
    // 手工推导:
    // centralized / cooperation 均计入自研池
    // base5 = 1,000,000(coop? 集中) + 600,000 + 400,000 = 2,000,000
    // 加计基数 = 2,000,000 ; 行2 = 2,000,000
    {
      await clear(); await mkComp({ name: '中联重工集团', headcount: 800 });
      const p1 = await mkProj({ code: 'C8-01', name: '集团共性技术平台(集中研发)', form: 'centralized' });
      const p2 = await mkProj({ code: 'C8-02', name: '校企联合攻关(合作研发)', form: 'cooperation' });
      await mkExp(p1.id, 'personnel', 1000000);
      await mkExp(p2.id, 'personnel', 600000); await mkExp(p2.id, 'direct', 400000);
      const { d, a } = await getSummary('2026');
      const { risks } = await H.getRisks('2026');
      eq('8-1 base5(集中+合作均入池)', d.base5, 2000000);
      eq('8-2 加计基数', d.totalExpenseBase, 2000000);
      eq('8-3 行2', LN(a.rows, '2'), 2000000);
      eq('8-4 行47', LN(a.rows, '47'), 2000000);
      ok(risks.some(r => r.code === 'R29'), '8-5 R29 集中研发需决算表');
      ok(risks.some(r => r.code === 'R28'), '8-6 R28 合作研发需合同');
    }

  } finally {
    await restore(bk.name);
    const chk = await j('/api/expenses');
    console.log(`\n[恢复] ${bk.name} 费用条数 = ${chk.length} (应为 14)`);
  }
  console.log(`\n########## 全行业场景对账: ${pass} 通过 / ${fail} 失败 ##########`);
  if (fails.length) { console.log('\n失败明细:'); fails.forEach(f => console.log('  - ' + f)); }
})();
