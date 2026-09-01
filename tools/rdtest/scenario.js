// 研发费用加计扣除系统 —— 会计实操场景端到端测试
// 场景来源: docs/会计实操场景与测试数据.md (恒达精密机械制造有限公司 2026 年度)
// 用法: node tools/rdtest/scenario.js
const BASE = process.env.BASE || 'http://127.0.0.1:8765';

const RISK_LABEL = { error: '红', warning: '黄', info: '绿' };

async function api(method, path, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, opt);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = { __raw: text.slice(0, 300) }; }
  return { status: res.status, body: json };
}

// ---------- 断言工具 ----------
const results = [];
function check(name, actual, expected, tol = 0.01) {
  let pass;
  if (typeof expected === 'number' && typeof actual === 'number') pass = Math.abs(actual - expected) <= tol;
  else pass = String(actual) === String(expected);
  results.push({ name, actual, expected, pass });
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}  实际=${fmt(actual)} 预期=${fmt(expected)}`);
  return pass;
}
function info(name, val) { console.log(`      · ${name} = ${fmt(val)}`); }
function fmt(v) { return typeof v === 'number' ? v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(v); }
function section(t) { console.log('\n===== ' + t + ' ====='); }

// ---------- 场景数据 ----------
const COMPANY = {
  name: '恒达精密机械制造有限公司',
  creditCode: '91330100MA26G0DEM1',
  industry: '制造业',
  levyType: '查账征收',
  isHiTech: false,
  icIndustrial: false,
  headcount: 85,
  revenue: { 2025: 16000000, 2026: 20000000 },
  taxableIncome: { 2025: 800000, 2026: 1500000 },
  nonTaxRelated: {},
  hiTechIncome: {},
  note: '场景演练(虚构)',
};

const PROJECTS = [
  {
    code: '2026-RD-01', name: '智能焊接机器人控制系统研发',
    form: 'self', resultOwner: 'self', activityType: '',
    startDate: '2026-01-01', endDate: '2026-12-31',
    status: '进行中', capitalization: 'expense',
    hasApprovalDoc: true, hasPlanDoc: true, approvalDate: '2025-12-18',
    note: '自主研发,费用化',
  },
  {
    code: '2026-RD-02', name: '高精度伺服电机试制',
    form: 'self', resultOwner: 'self', activityType: '',
    startDate: '2026-03-01', endDate: '2026-12-31',
    status: '进行中', capitalization: 'capitalize',
    hasApprovalDoc: true, hasPlanDoc: true, approvalDate: '2026-02-10',
    note: '资本化,结题后转无形资产按200%摊销',
  },
];

const STAFF = [
  { name: '陈伟', dept: '硬件部', role: '硬件工程师', isDirect: true, joinDate: '2021-03-01' },
  { name: '林芳', dept: '软件部', role: '算法工程师', isDirect: true, joinDate: '2022-06-15' },
  { name: '周凯', dept: '结构部', role: '机械工程师', isDirect: true, joinDate: '2023-04-10' },
  { name: '刘洋', dept: '工艺部', role: '工艺工程师', isDirect: true, joinDate: '2020-05-01' },
  { name: '王丽', dept: '财务部', role: '会计', isDirect: false, joinDate: '2019-09-01' },
];

const TIMESHEET_LINES = `陈伟|2026-01|2026-RD-01|160|176
陈伟|2026-02|2026-RD-01|160|176
陈伟|2026-03|2026-RD-01|160|176
陈伟|2026-04|2026-RD-01|160|176
陈伟|2026-05|2026-RD-01|160|176
陈伟|2026-06|2026-RD-01|160|176
林芳|2026-01|2026-RD-01|168|176
林芳|2026-02|2026-RD-01|168|176
林芳|2026-03|2026-RD-01|168|176
林芳|2026-04|2026-RD-01|168|176
林芳|2026-05|2026-RD-01|168|176
林芳|2026-06|2026-RD-01|168|176
周凯|2026-01|2026-RD-01|160|176
周凯|2026-02|2026-RD-01|160|176
周凯|2026-03|2026-RD-01|96|176
周凯|2026-04|2026-RD-01|96|176
周凯|2026-05|2026-RD-01|96|176
周凯|2026-06|2026-RD-01|96|176
周凯|2026-03|2026-RD-02|64|176
周凯|2026-04|2026-RD-02|64|176
周凯|2026-05|2026-RD-02|64|176
周凯|2026-06|2026-RD-02|64|176
刘洋|2026-01|2026-RD-01|40|176
刘洋|2026-02|2026-RD-01|40|176
刘洋|2026-03|2026-RD-01|40|176
刘洋|2026-04|2026-RD-01|40|176
刘洋|2026-05|2026-RD-01|40|176
刘洋|2026-06|2026-RD-01|40|176
刘洋|2026-03|2026-RD-02|40|176
刘洋|2026-04|2026-RD-02|40|176
刘洋|2026-05|2026-RD-02|40|176
刘洋|2026-06|2026-RD-02|40|176`.split('\n');

const EXPENSE_LINES = `2026-01-20|2026-RD-01|personnel|110000|研发人员1月工资及社保|2026-01|direct|费用化|记-2026-001||银行转账
2026-02-20|2026-RD-01|personnel|112000|研发人员2月工资及社保|2026-02|direct|费用化|记-2026-013||银行转账
2026-03-20|2026-RD-01|personnel|115000|研发人员3月工资及社保|2026-03|direct|费用化|记-2026-026||银行转账
2026-04-20|2026-RD-01|personnel|118000|研发人员4月工资及社保|2026-04|direct|费用化|记-2026-041||银行转账
2026-05-20|2026-RD-01|personnel|120000|研发人员5月工资及社保|2026-05|direct|费用化|记-2026-058||银行转账
2026-06-20|2026-RD-01|personnel|122000|研发人员6月工资及社保|2026-06|direct|费用化|记-2026-075||银行转账
2026-03-10|2026-RD-01|direct|96000|电子元器件及PCB材料(研发专用)|2026-03|direct|费用化|记-2026-018|FP-2026-0301|银行转账
2026-05-15|2026-RD-01|direct|58000|焊接机器人样机试制材料(不构成固定资产)|2026-05|direct|费用化|记-2026-052|FP-2026-0550|银行转账
2026-06-18|2026-RD-01|direct|22000|焊接试件与耗材(无发票,教学风险点)|2026-06|direct|费用化|记-2026-070||银行转账
2026-04-12|2026-RD-01|depreciation|48000|共用研发测试设备折旧(按2026-04工时分摊)|2026-04|ratioHours|费用化|记-2026-035||银行转账
2026-04-20|2026-RD-01|design|65000|控制系统仿真设计费|2026-04|direct|费用化|记-2026-036|FP-2026-0360|银行转账
2026-01-30|2026-RD-01|other|20000|行业技术研讨会会议费|2026-01|direct|费用化|记-2026-005|FP-2026-0051|银行转账
2026-05-28|2026-RD-01|other|16000|技术交流差旅费(现金支付,教学风险点)|2026-05|direct|费用化|记-2026-060|FP-2026-0601|现金
2026-06-10|2026-RD-01|other|12000|专家咨询费(无凭证号,教学风险点)|2026-06|direct|费用化||FP-2026-0710|银行转账
2026-03-30|2026-RD-01|entrust_domestic_org|300000|委托XX工研院开发焊缝跟踪算法|2026-03|direct|费用化|记-2026-020|FP-2026-0309|银行转账
2026-03-20|2026-RD-02|personnel|85000|伺服电机项目研发人员3月工资|2026-03|direct|资本化|记-2026-028||银行转账
2026-04-20|2026-RD-02|personnel|88000|伺服电机项目研发人员4月工资|2026-04|direct|资本化|记-2026-043||银行转账
2026-05-20|2026-RD-02|personnel|90000|伺服电机项目研发人员5月工资|2026-05|direct|资本化|记-2026-061||银行转账
2026-06-20|2026-RD-02|personnel|92000|伺服电机项目研发人员6月工资|2026-06|direct|资本化|记-2026-078||银行转账
2026-04-08|2026-RD-02|direct|160000|伺服电机试制材料与模具|2026-04|direct|资本化|记-2026-040|FP-2026-0410|银行转账
2026-05-22|2026-RD-02|direct|45000|样机检测与试验费|2026-05|direct|资本化|记-2026-063|FP-2026-0630|银行转账
2026-06-15|2026-RD-02|depreciation|35000|共用试验台折旧(按2026-06工时分摊)|2026-06|ratioHours|资本化|记-2026-082||银行转账`.split('\n');

(async () => {
  section('第0步 清空数据');
  let r = await api('POST', '/api/demo/clear');
  console.log('clear ->', r.status, JSON.stringify(r.body).slice(0, 120));

  section('第1步 企业设置');
  r = await api('POST', '/api/companies', COMPANY);
  if (r.status !== 201) { console.log('!! 企业创建失败', r.status, JSON.stringify(r.body)); process.exit(1); }
  const companyId = r.body.id;
  console.log('企业创建 OK, id =', companyId);

  section('第2步 研发项目');
  const projIds = {};
  for (const p of PROJECTS) {
    const rr = await api('POST', '/api/projects', p);
    if (rr.status !== 201) { console.log('!! 项目创建失败', rr.status, JSON.stringify(rr.body)); process.exit(1); }
    projIds[p.code] = rr.body.id;
    console.log(`项目 ${p.code} 创建 OK`);
  }

  section('第3步 人员名单');
  for (const s of STAFF) {
    const rr = await api('POST', '/api/staff', s);
    if (rr.status !== 201) { console.log('!! 人员创建失败', rr.status, JSON.stringify(rr.body)); }
  }
  const staffList = await api('GET', '/api/staff');
  console.log('人员数 =', staffList.body.length);

  section('第4步 工时台账批量导入(32行)');
  r = await api('POST', '/api/timesheets/batch', { lines: TIMESHEET_LINES });
  console.log('工时导入 ->', JSON.stringify(r.body));
  check('工时导入成功条数', r.body.ok, 32);
  if (r.body.errors && r.body.errors.length) console.log('工时导入错误:', r.body.errors);

  section('第5步 费用批量导入(22笔)');
  r = await api('POST', '/api/expenses/batch', { lines: EXPENSE_LINES });
  console.log('费用导入 ->', JSON.stringify(r.body));
  check('费用导入成功笔数', r.body.ok, 22);
  if (r.body.errors && r.body.errors.length) console.log('费用导入错误:', r.body.errors);

  const Y = '2026';

  section('第6.1步 辅助账校验');
  const ledger = (await api('GET', `/api/ledger?year=${Y}`)).body;
  const p1 = ledger.projects.find(x => x.project.code === '2026-RD-01');
  const p2 = ledger.projects.find(x => x.project.code === '2026-RD-02');
  check('辅助账 P1 合计', p1 ? p1.total : null, 1353802.82);
  check('辅助账 P1 费用化', p1 ? p1.expenseSum : null, 1325211.27);
  check('辅助账 P1 资本化', p1 ? p1.capitalizeSum : null, 28591.55);
  check('辅助账 P2 合计', p2 ? p2.total : null, 575197.18);
  check('辅助账 P2 费用化', p2 ? p2.expenseSum : null, 8788.73);
  check('辅助账 P2 资本化', p2 ? p2.capitalizeSum : null, 566408.45);
  check('辅助账分摊后总计(=原始22笔合计)', ledger.grand.total, 1929000.00);

  section('第6.2步 申报汇总(A107012 参考口径)校验');
  const sum = (await api('GET', `/api/summary?year=${Y}`)).body;
  const d = sum.detail;
  info('前5类费用化 base5', d.base5);
  info('其他费用实际/限额/可扣', `${d.otherActual} / ${d.otherLimit} / ${d.otherDeductible}`);
  info('委托境内×80%', d.entrustDomesticOrg);
  info('资本化形成 capitalFormed', d.capitalFormed);
  check('其他费用限额', d.otherLimit, 109555.56);
  check('委托境内计入(300000×80%)', d.entrustDomesticOrg, 240000.00);
  check('费用化加计基数 totalExpenseBase', d.totalExpenseBase, 1274000.00);
  check('加计扣除合计 totalAdd', d.totalAdd, 1274000.00);
  check('资本化形成资产', d.capitalFormed, 595000.00);

  section('第6.3步 A107012 官方表单');
  const a = sum.a107012;
  const rowOf = l => (a.rows.find(x => String(x.line) === String(l)) || {}).amount;
  info('行1 项目数量', rowOf('1'));
  info('行2 自研合作集中(3+7+16+19+23+34)', rowOf('2'));
  info('行34 限额调整后其他相关费用', rowOf('34'));
  info('行36 委托境内机构或个人', rowOf('36'));
  info('行40 年度研发费用小计', rowOf('40'));
  info('行41 本年费用化金额', rowOf('41'));
  info('行42 本年资本化金额', rowOf('42'));
  info('行45 允许扣除合计', rowOf('45'));
  info('行47 抵减特殊收入后', rowOf('47'));
  info('行51 加计扣除总额', rowOf('51'));
  check('A107012 行41 费用化金额', rowOf('41'), 1274000.00);
  check('A107012 行42 资本化金额', rowOf('42'), 595000.00);
  check('A107012 行40 小计', rowOf('40'), 1869000.00);
  check('A107012 行51 加计总额', rowOf('51'), 1274000.00);

  section('第6.4步 三套口径');
  const cal = (await api('GET', `/api/calibers?year=${Y}`)).body;
  info('会计口径', cal.accounting);
  info('加计口径', cal.deduction);
  info('高企口径', cal.hiTech);
  info('会计-加计差异', cal.diffAccountingDeduction);
  info('加计-高企差异', cal.diffDeductionHt);

  section('第6.5步 风险自检');
  const risk = (await api('GET', `/api/risks?year=${Y}`)).body;
  check('风险 红(error)', risk.counts.error, 0);
  check('风险 黄(warning)', risk.counts.warning, 3);
  check('风险 绿(info)', risk.counts.info, 7);
  console.log('      实际风险清单:');
  risk.risks.forEach(x => console.log(`        [${RISK_LABEL[x.level] || x.level}] ${x.code || ''} ${x.title || x.name || ''}`));

  section('第6.6步 节税测算');
  const tax = (await api('GET', `/api/tax-saving?year=${Y}`)).body;
  info('加计扣除额 totalAdd', tax.totalAdd);
  info('应纳税所得额 income', tax.income);
  info('税率 rate', tax.rate);
  info('税率说明', tax.rateNote);
  info('节税前/后', `${tax.taxBefore} / ${tax.taxAfter}`);
  check('预计节税', tax.saving, 63700.00);

  section('结果统计');
  const fail = results.filter(x => !x.pass);
  console.log(`总断言 ${results.length} 项,通过 ${results.length - fail.length},失败 ${fail.length}`);
  if (fail.length) {
    console.log('\n失败明细:');
    fail.forEach(f => console.log(`  - ${f.name}: 实际=${fmt(f.actual)} 预期=${fmt(f.expected)}`));
  }
})().catch(e => { console.error('测试脚本异常:', e); process.exit(1); });
