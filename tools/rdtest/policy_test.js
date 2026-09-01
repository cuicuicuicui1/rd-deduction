// 政策口径正确性测试:直接调用计算内核,构造独立数据集验证加计扣除规则
// 依据:财税〔2015〕119号 / 2015年97号 / 2017年40号 / 财税〔2018〕64号 / 2021年28号 / 2023年7号 / 2023年44号
const R = p => require('../../' + p);
const { computeSummary, computeCalibers, buildA107012 } = R('src/summary');
const { computeTaxSaving, computeRefundScenarios } = R('src/tax');
const { runRiskCheck } = R('src/risk');

let pass = 0, fail = 0; const fails = [];
function check(name, actual, expected, tol = 0.01) {
  let ok = (typeof expected === 'number' && typeof actual === 'number')
    ? Math.abs(actual - expected) <= tol : String(actual) === String(expected);
  if (ok) { pass++; console.log(`[PASS] ${name} = ${fmt(actual)}`); }
  else { fail++; fails.push(`${name}: 实际=${fmt(actual)} 预期=${fmt(expected)}`); console.log(`[FAIL] ${name}: 实际=${fmt(actual)} 预期=${fmt(expected)}`); }
  return ok;
}
function fmt(v) { return typeof v === 'number' ? v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(v); }
const sec = t => console.log('\n===== ' + t + ' =====');

const Y = '2026';
// 基础工厂
const proj = (id, code, extra = {}) => ({
  id, code, name: '项目' + code, form: 'self', resultOwner: 'self',
  startDate: '2026-01-01', endDate: '2026-12-31', status: '进行中',
  capitalization: 'expense', hasApprovalDoc: true, hasPlanDoc: true,
  approvalDate: '2025-12-01', ...extra,
});
const exp = (id, projectId, category, amount, extra = {}) => ({
  id, projectId, category, amount, date: '2026-06-15', period: '2026-06',
  capitalization: 'expense', allocMethod: 'direct', isShared: false, alloc: {},
  voucherNo: '记-001', invoiceNo: 'FP-001', paymentMethod: '银行转账', ...extra,
});
const run = (projects, expenses, opts = {}) => computeSummary({
  company: opts.company || { name: '测试企业', industry: '制造业', levyType: '查账征收' },
  projects, expenses, timesheets: opts.timesheets || [], amortizations: opts.amortizations || [],
  specialIncomes: opts.specialIncomes || [], year: Y,
});

sec('1. 其他相关费用 10% 限额(2017年40号:限额=前5类×10%÷90%)');
{
  const p = proj('p1', 'RD-1');
  // 前5类 900,000(人员)+其他 120,000 → 限额 = 900000×10%÷90% = 100,000;剔除 20,000
  const s = run([p], [
    exp('e1', 'p1', 'personnel', 900000),
    exp('e2', 'p1', 'other', 120000),
  ]);
  check('1.1 其他费用限额', s.detail.otherLimit, 100000);
  check('1.2 其他费用可扣除(限额内)', s.detail.otherDeductible, 100000);
  check('1.3 超限剔除额', s.detail.otherExcess, 20000);
  check('1.4 加计基数(900000+100000)', s.detail.totalExpenseBase, 1000000);
  check('1.5 加计扣除额(×100%)', s.detail.totalAdd, 1000000);
}

sec('2. 委托境内研发按 80% 计入(财税〔2015〕119号)');
{
  const p = proj('p1', 'RD-1');
  const s = run([p], [
    exp('e1', 'p1', 'personnel', 1000000),
    exp('e2', 'p1', 'entrust_domestic_org', 500000),
    exp('e3', 'p1', 'entrust_domestic_person', 100000),
  ]);
  check('2.1 委托境内机构×80%', s.detail.entrustDomesticOrg, 400000);
  check('2.2 委托境内个人×80%', s.detail.entrustDomesticPerson, 80000);
  check('2.3 加计基数', s.detail.totalExpenseBase, 1480000);
}

sec('3. 委托境外:80% 且不超过境内符合条件研发费用 2/3(财税〔2018〕64号)');
{
  const p = proj('p1', 'RD-1');
  // 境内:前5类 1,000,000 + 委托境内 500,000×80%=400,000 → 境内基数 1,400,000
  // 境外 2/3 上限 = 1,400,000×2/3 = 933,333.33
  // 境外发生 2,000,000 ×80% = 1,600,000 > 933,333.33 → 取 933,333.33
  const s = run([p], [
    exp('e1', 'p1', 'personnel', 1000000),
    exp('e2', 'p1', 'entrust_domestic_org', 500000),
    exp('e3', 'p1', 'entrust_overseas', 2000000),
  ]);
  check('3.1 境外×80%(原始)', s.detail.entrustOverseasRaw, 1600000);
  check('3.2 境外 2/3 限额', s.detail.entrustOverseasCap, 933333.33);
  check('3.3 境外可加计(取孰小)', s.detail.entrustOverseas, 933333.33);
  check('3.4 境外超限剔除', s.detail.entrustOverseasExcess, 666666.67);
  check('3.5 加计基数', s.detail.totalExpenseBase, 2333333.33);
}

sec('4. 委托境外个人:不得加计(税前可正常扣除)');
{
  const p = proj('p1', 'RD-1');
  const s = run([p], [
    exp('e1', 'p1', 'personnel', 500000),
    exp('e2', 'p1', 'entrust_overseas_person', 300000),
  ]);
  check('4.1 境外个人委托不计入加计基数', s.detail.totalExpenseBase, 500000);
}

sec('5. 受托开发(成果归客户)整项目剔除');
{
  const p = proj('p1', 'RD-1', { resultOwner: 'client' });
  const s = run([p], [exp('e1', 'p1', 'personnel', 800000)]);
  check('5.1 受托开发项目费用不计入', s.detail.totalExpenseBase, 0);
  check('5.2 剔除项目计数', s.detail.excludedProjectCount, 1);
}

sec('6. 资本化:形成无形资产 + 按 200% 摊销(2023年7号)');
{
  const p = proj('p1', 'RD-1', { capitalization: 'capitalize' });
  // 本年资本化支出 1,000,000 → 形成无形资产成本 1,000,000(本年不摊销则当年不加计)
  const s1 = run([p], [exp('e1', 'p1', 'personnel', 1000000, { capitalization: 'capitalize' })]);
  check('6.1 本年形成无形资产成本', s1.detail.capitalFormed, 1000000);
  check('6.2 未摊销时当年加计基数', s1.detail.totalExpenseBase, 0);
  // 假设分 10 年摊销,每年会计摊销额 100,000 → 加计按摊销额×100% = 100,000
  const s2 = run([p], [exp('e1', 'p1', 'personnel', 1000000, { capitalization: 'capitalize' })], {
    amortizations: [{ id: 'a1', projectId: 'p1', year: 2026, amount: 100000 }],
  });
  check('6.3 摊销额', s2.detail.amortAmount, 100000);
  check('6.4 摊销加计(摊销额×100%,即按200%摊销的加计部分)', s2.detail.amortAdd, 100000);
  check('6.5 加计合计', s2.detail.totalAdd, 100000);
}

sec('7. 特殊收入冲减(下脚料/残次品/试制品销售)');
{
  const p = proj('p1', 'RD-1');
  // 加计基数 500,000;特殊收入 120,000 → 冲减后 380,000
  const s = run([p], [exp('e1', 'p1', 'personnel', 500000)], {
    specialIncomes: [{ id: 'si1', projectId: 'p1', amount: 120000, date: '2026-06-01', period: '2026-06' }],
  });
  check('7.1 特殊收入总额', s.detail.specialIncomeTotal, 120000);
  check('7.2 冲减额', s.detail.specialIncomeDeducted, 120000);
  check('7.3 冲减后加计基数', s.detail.totalExpenseBase, 380000);
  // 特殊收入超过加计基数:只冲到 0,超出部分不冲资本化成本
  const s2 = run([p], [exp('e1', 'p1', 'personnel', 100000)], {
    specialIncomes: [{ id: 'si1', projectId: 'p1', amount: 500000, date: '2026-06-01', period: '2026-06' }],
  });
  check('7.4 超额特殊收入:加计基数不为负', s2.detail.totalExpenseBase, 0);
  check('7.5 未冲减部分', s2.detail.specialIncomeUnused, 400000);
}

sec('8. 不征税收入对应研发支出不得加计(政府补助/软件即征即退)');
{
  const p = proj('p1', 'RD-1');
  const s = run([p], [exp('e1', 'p1', 'personnel', 1000000)], {
    company: { name: '测试企业', industry: '制造业', levyType: '查账征收', nonTaxRelated: { 2026: 300000 } },
  });
  check('8.1 不征税收入对应支出剔除', s.detail.exemptExcluded, 300000);
  check('8.2 剔除后加计基数', s.detail.totalExpenseBase, 700000);
}

sec('9. 集成电路/工业母机企业加计 120%(2023年44号)');
{
  const p = proj('p1', 'RD-1');
  const s = run([p], [exp('e1', 'p1', 'personnel', 1000000)], {
    company: { name: 'IC企业', industry: '制造业', levyType: '查账征收', icIndustrial: true },
  });
  check('9.1 加计比例 120%', s.detail.deductRatio, 1.2);
  check('9.2 加计扣除额', s.detail.totalAdd, 1200000);
  // 2028 年超出 44 号公告适用期(2023-01-01~2027-12-31)→ 回落 100%
  const s2 = computeSummary({
    company: { name: 'IC企业', icIndustrial: true },
    projects: [p], expenses: [exp('e1', 'p1', 'personnel', 1000000)],
    timesheets: [], amortizations: [], specialIncomes: [], year: '2028',
  });
  check('9.3 2028年超适用期回落100%', s2.detail.deductRatio, 1.0);
}

sec('10. 亏损结转年限(高企/科技型中小企业 10 年 vs 一般企业 5 年)');
{
  const p = proj('p1', 'RD-1');
  const base = { projects: [p], expenses: [exp('e1', 'p1', 'personnel', 1000000)], timesheets: [], amortizations: [], specialIncomes: [], year: Y };
  const t1 = computeTaxSaving({ ...base, company: { isHiTech: false, taxableIncome: { 2026: 100000 } } });
  check('10.1 一般企业结转年限', t1.carryYears, 5);
  const t2 = computeTaxSaving({ ...base, company: { isHiTech: true, taxableIncome: { 2026: 100000 } } });
  check('10.2 高企结转年限', t2.carryYears, 10);
}

sec('11. 税率模型(小微5% / 高企15% / 标准25%)');
{
  const p = proj('p1', 'RD-1');
  const base = { projects: [p], expenses: [exp('e1', 'p1', 'personnel', 1000000)], timesheets: [], amortizations: [], specialIncomes: [], year: Y };
  const t1 = computeTaxSaving({ ...base, company: { taxableIncome: { 2026: 2000000 } } });
  check('11.1 所得额200万→小微5%', t1.rate, 0.05);
  check('11.2 节税额(100万加计×5%)', t1.saving, 50000);
  const t2 = computeTaxSaving({ ...base, company: { taxableIncome: { 2026: 5000000 } } });
  check('11.3 所得额500万→标准25%', t2.rate, 0.25);
  const t3 = computeTaxSaving({ ...base, company: { isHiTech: true, taxableIncome: { 2026: 5000000 } } });
  check('11.4 高企(超300万)→15%', t3.rate, 0.15);
  const t4 = computeTaxSaving({ ...base, company: { isHiTech: true, taxableIncome: { 2026: 2000000 } } });
  check('11.5 高企且≤300万→孰低5%', t4.rate, 0.05);
  const t5 = computeTaxSaving({ ...base, company: { taxableIncome: { 2026: 300000 } } });
  check('11.6 加计后亏损(30万-100万)', t5.incomeAfter, -700000);
  check('11.7 新增亏损可结转额', t5.createsLoss, 700000);
  check('11.8 亏损时当年节税额', t5.saving, 15000);
}

sec('12. 三套口径对照(会计 / 加计 / 高企)');
{
  const p = proj('p1', 'RD-1');
  const expenses = [
    exp('e1', 'p1', 'personnel', 1000000),
    exp('e2', 'p1', 'other', 200000),
    exp('e3', 'p1', 'personnel', 500000, { capitalization: 'capitalize' }),
  ];
  const c = computeCalibers({
    company: { name: '测试企业' }, projects: [p], expenses, timesheets: [], amortizations: [], specialIncomes: [], year: Y,
  });
  check('12.1 会计口径(费+资全额)', c.accounting, 1700000);
  // 加计:前5类费用化 1,000,000;限额=(1,000,000+500,000)×10%÷90%=166,666.67;其他 200,000 → 取 166,666.67
  check('12.2 加计口径', c.deduction, 1166666.67);
  // 高企:含资本化;前5类 1,500,000;其他限额 20%:1,500,000×0.2/0.8=375,000;其他 200,000 全取
  check('12.3 高企口径(其他费用限额20%)', c.hiTech, 1700000);
  check('12.4 高企其他费用限额', c.otherLimitHt, 375000);
}

sec('13. 分摊:按工时比例(ratioHours)');
{
  const p1 = proj('p1', 'RD-1'); const p2 = proj('p2', 'RD-2');
  const timesheets = [
    { id: 't1', staffId: 's1', projectId: 'p1', period: '2026-06', rdHours: 120, totalHours: 176 },
    { id: 't2', staffId: 's1', projectId: 'p2', period: '2026-06', rdHours: 40, totalHours: 176 },
  ];
  const s = run([p1, p2], [
    exp('e1', 'p1', 'depreciation', 100000, { allocMethod: 'ratioHours', isShared: true }),
  ], { timesheets });
  check('13.1 分摊后费用化前5类(100000全部分摊)', s.detail.base5, 100000);
  const capBy = s.detail.capitalByProject;
  console.log('      · 分摊结果:', JSON.stringify(capBy));
}

sec('14. 分摊:无工时数据时的兜底(共用折旧不会丢失)');
{
  const p1 = proj('p1', 'RD-1'); const p2 = proj('p2', 'RD-2');
  // 共用折旧 2026-06,但工时台账无 6 月数据 → 应全额落回原项目
  const s = run([p1, p2], [
    exp('e1', 'p1', 'depreciation', 100000, { allocMethod: 'ratioHours', isShared: true }),
  ], { timesheets: [{ id: 't1', staffId: 's1', projectId: 'p1', period: '2026-05', rdHours: 100, totalHours: 176 }] });
  check('14.1 无对应期间工时时全额归原项目', s.detail.base5, 100000);
}

sec('15. 跨年度归集(费用 period 决定归属年度)');
{
  const p = proj('p1', 'RD-1');
  const s = run([p], [
    exp('e1', 'p1', 'personnel', 100000, { date: '2025-12-20', period: '2025-12' }),
    exp('e2', 'p1', 'personnel', 200000, { date: '2026-01-20', period: '2026-01' }),
  ]);
  check('15.1 2026年度只归集2026期间费用', s.detail.totalExpenseBase, 200000);
}

sec('16. 预缴口径(periodEnd 截断)');
{
  const p = proj('p1', 'RD-1');
  const mk = periodEnd => computeSummary({
    company: { name: 'T' }, projects: [p],
    expenses: [
      exp('e1', 'p1', 'personnel', 100000, { date: '2026-03-20', period: '2026-03' }),
      exp('e2', 'p1', 'personnel', 200000, { date: '2026-09-20', period: '2026-09' }),
    ],
    timesheets: [], amortizations: [], specialIncomes: [], year: Y, periodEnd,
  });
  check('16.1 上半年预缴(periodEnd=2026-06)', mk('2026-06').detail.totalExpenseBase, 100000);
  check('16.2 前三季度预缴(periodEnd=2026-09)', mk('2026-09').detail.totalExpenseBase, 300000);
  check('16.3 全年', mk(null).detail.totalExpenseBase, 300000);
}

sec('17. 负面行业 / 负面活动(财税〔2015〕119号)');
{
  const p = proj('p1', 'RD-1');
  const riskOf = (company, projects) => runRiskCheck({
    company, projects, expenses: [exp('e1', 'p1', 'personnel', 100000)],
    staff: [], timesheets: [], amortizations: [], specialIncomes: [], taxroll: [], assets: [], year: Y,
  });
  const r1 = riskOf({ name: '烟草公司', industry: '烟草制品业', levyType: '查账征收' }, [p]);
  const hasNeg = r1.some(x => /负面清单行业|不适用加计/.test(x.title || ''));
  check('17.1 烟草制品业触发负面行业红线', hasNeg ? '触发' : '未触发', '触发');
  const r2 = riskOf({ name: '核定征收企业', industry: '制造业', levyType: '核定征收' }, [p]);
  const hasLevy = r2.some(x => /核定征收/.test(x.title || ''));
  check('17.2 核定征收企业触发红线', hasLevy ? '触发' : '未触发', '触发');
  const r3 = riskOf({ name: '常规升级', industry: '制造业', levyType: '查账征收' },
    [proj('p1', 'RD-1', { activityType: '产品(服务)常规性升级' })]);
  const hasAct = r3.some(x => x.code === 'R05');
  check('17.3 负面活动触发提示', hasAct ? '触发' : '未触发', '触发');
}

sec('18. 事后立项检测(费用早于立项决议日)');
{
  const p = proj('p1', 'RD-1', { approvalDate: '2026-06-01', hasApprovalDoc: true });
  const r = runRiskCheck({
    company: { name: 'T', industry: '制造业', levyType: '查账征收' }, projects: [p],
    expenses: [exp('e1', 'p1', 'direct', 100000, { date: '2026-01-10', period: '2026-01' })],
    staff: [], timesheets: [], amortizations: [], specialIncomes: [], taxroll: [], assets: [], year: Y,
  });
  const has = r.some(x => /事后立项|立项决议/.test((x.title || '') + (x.desc || '')));
  check('18.1 费用早于立项决议触发预警', has ? '触发' : '未触发', '触发');
}

console.log('\n########## 政策口径测试汇总 ##########');
console.log(`通过 ${pass} / 失败 ${fail}`);
if (fails.length) { console.log('\n失败项:'); fails.forEach(f => console.log('  - ' + f)); }
