// A107012 申报参考汇总:10%限额、委托80%、境外2/3、资本化摊销加计
// 扩展:受托开发/委托境外个人整项目剔除、特殊收入冲减、不征税收入对应支出剔除、IC企业120%(44号)、预缴口径(periodEnd)、三套口径对照
const { POLICIES, BASE_FIVE, CATEGORY_MAP, NEGATIVE_INDUSTRIES } = require('./constants');
const { allocateExpense, round2, expenseTypeOf, allocationType } = require('./ledger');
const { buildLedger97 } = require('./ledger97');
const { annualPolicy } = require('./policy');

const ALL_KEYS = ['personnel', 'direct', 'depreciation', 'amortization', 'design', 'other',
  'entrust_domestic_org', 'entrust_domestic_person', 'entrust_overseas', 'entrust_overseas_person'];

function seedPool() {
  const s = {};
  ALL_KEYS.forEach(k => (s[k] = 0));
  return { expense: { ...s }, capitalize: { ...s } };
}

// 年度/期间内是否属于该口径
function inScope(e, yearStr, periodEnd) {
  const raw = String(e.period || e.date || '');
  if (!raw.startsWith(yearStr)) return false;
  if (periodEnd) {
    const p = raw.slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(p) && p > periodEnd) return false;
  }
  return true;
}

// 不得加计项目集合:受托开发(成果归客户) + 委托境外个人
function excludedProjectIds(projects) {
  const set = new Set();
  (projects || []).forEach(p => {
    if (p.resultOwner === 'client' || p.form === 'entrust_overseas_person') set.add(p.id);
  });
  return set;
}

// 资本化"已形成无形资产"项目集合:该项目存在 year <= 当前年 的摊销记录,首个摊销年度即形成年度。
// 依据 2021年第28号公告第三条:资本化项目未形成无形资产的年度,其支出不计入当年可加计基数与限额基数;
// 形成无形资产年度起(含当年度及以前年度累计)统一纳入。此处对限额基数做年度化简化:仅统计当年发生且项目已形成的资本化支出。
function formedCapProjects(amortizations, yearStr) {
  const set = new Set();
  (amortizations || []).forEach(a => {
    if (String(a.year) <= yearStr) set.add(a.projectId);
  });
  return set;
}

// P2-2(审计):资本化项目"形成无形资产年度"。优先级:摊销记录显式 formationYear 字段 → 该项目最早摊销年度。
// 用于 A107012 行43(本年形成)/行44(以前年度形成)分流。fallback 取 yearStr(仅当项目无任何摊销记录时)。
function capFormationYearOf(amortizations, projectId, fallback) {
  const recs = (amortizations || []).filter(a => a.projectId === projectId);
  if (!recs.length) return fallback;
  const ys = recs.map(a => {
    const fy = Number(a.formationYear);
    return Number.isFinite(fy) && fy >= 2000 && fy <= 2100 ? fy : Number(a.year);
  }).filter(y => Number.isFinite(y) && y >= 2000 && y <= 2100);
  return ys.length ? Math.min(...ys) : fallback;
}

/**
 * 企业级加计扣除资格闸门(财税〔2015〕119号 + 2023年7号延续):
 *   - 核定征收:不得加计(须查账征收)
 *   - 负面清单行业(行业命中):
 *       已填报负面收入占比且 <50% → 可加计;
 *       占比 ≥50% → 不得加计;
 *       未填报占比 → 按不得加计处理(留白即视为不满足,需企业确认)
 * @returns {{eligible:boolean, reason:string}}
 */
function enterpriseGate(company) {
  if (!company) return { eligible: true, reason: '' };
  if (company.levyType === '核定征收') {
    return { eligible: false, reason: '核定征收企业不得享受研发费用加计扣除(须查账征收)' };
  }
  const neg = (NEGATIVE_INDUSTRIES || []).find(i => String(company.industry || '').includes(i));
  if (neg) {
    const share = company.negativeRevenueShare !== undefined && company.negativeRevenueShare !== null && company.negativeRevenueShare !== ''
      ? Number(company.negativeRevenueShare) : null;
    if (share !== null && share >= 50) {
      return { eligible: false, reason: `负面清单行业收入占比 ${share}%(≥50%),不得享受加计扣除` };
    }
    if (share === null) {
      return { eligible: false, reason: `所属行业「${company.industry}」命中负面清单「${neg}」且未填报负面收入占比,按不得加计处理(若实际占比<50%请在企业信息中填报确认)` };
    }
    // share < 50 → 可加计
  }
  return { eligible: true, reason: '' };
}

/**
 * 计算某年度加计扣除汇总(A107012 参考口径,2021年28号)
 * @param {object} opts { company, projects, expenses, timesheets, amortizations, specialIncomes, year, periodEnd? }
 *   periodEnd: 预缴口径,如 '2026-06'(7月预缴上半年) / '2026-09'(10月预缴前三季度),缺省=全年
 */
function computeSummary({ company, projects, expenses, timesheets, amortizations, specialIncomes, year, periodEnd }) {
  const yearStr = String(year);
  const gate = enterpriseGate(company);
  if (!gate.eligible) {
    // 企业级资格闸门:核定征收/负面清单行业 → 加计口径整体归零(会计口径不受影响,见 computeCalibers)
    const z = seedPool();
    const zeroRows = [
      { line: 1, name: '人员人工费用', amount: 0, note: '—' },
      { line: 2, name: '直接投入费用', amount: 0, note: '—' },
      { line: 3, name: '折旧费用', amount: 0, note: '—' },
      { line: 4, name: '无形资产摊销', amount: 0, note: '—' },
      { line: 5, name: '新产品设计费等', amount: 0, note: '—' },
      { line: 6, name: '其他相关费用(实际)', amount: 0, note: '—' },
      { line: 10, name: '费用化研发费用合计(加计基数)', amount: 0, note: gate.reason },
      { line: 11, name: '本年费用化加计扣除额', amount: 0, note: gate.reason },
      { line: 12, name: '资本化项目本年摊销额', amount: 0, note: '—' },
      { line: 13, name: '本年摊销加计扣除额', amount: 0, note: gate.reason },
      { line: 14, name: '加计扣除额合计', amount: 0, note: gate.reason },
    ];
    return {
      year: yearStr,
      detail: {
        eligible: false, ineligibleReason: gate.reason,
        base5: 0, otherActual: 0, otherLimit: 0, otherDeductible: 0, otherDeductibleAll: 0, otherExcess: 0,
        entrustDomesticOrg: 0, entrustDomesticPerson: 0, entrustOverseasRaw: 0,
        entrustOverseasCap: 0, entrustOverseas: 0, entrustOverseasExcess: 0,
        domesticTotal: 0, totalExpenseBase: 0, expenseAdd: 0,
        capitalFormed: 0, capitalByProject: {}, amortAmount: 0, amortAdd: 0, totalAdd: 0,
        specialIncomeTotal: 0, specialIncomeDeducted: 0, specialIncomeUnused: 0,
        exemptRelated: 0, exemptExcluded: 0, icActive: false, deductRatio: 0, amortRatio: 0,
        excludedProjectCount: 0, categoryActual: z.expense, categoryActualCap: z.capitalize,
      },
      rows: zeroRows,
      eligible: false, ineligibleReason: gate.reason,
    };
  }
  const projMap = {};
  (projects || []).forEach(p => (projMap[p.id] = p));
  const excluded = excludedProjectIds(projects);

  // 归集(含分摊,剔除不得加计项目)
  // P0-3:孤儿费用(项目已删除,projMap 无对应)一律不计入——与 buildA107012 的 `if (!proj) return` 口径一致,避免两口径打架
  const pool = seedPool();
  (expenses || [])
    .filter(e => !excluded.has(e.projectId) && projMap[e.projectId])
    .filter(e => inScope(e, yearStr, periodEnd))
    .forEach(exp => {
      const allocs = allocateExpense(exp, timesheets);
      allocs.forEach(a => {
        // P0-2:按分摊目标项目的资本化属性定型(共享费用分摊到资本化项目→capitalize、费用化项目→expense)
        const eType = allocationType(exp, projMap[a.projectId]);
        pool[eType][exp.category] = round2(pool[eType][exp.category] + a.amount);
      });
    });

  // 特殊收入(下脚料/残次品/试制品销售):总额登记,冲减处理在费用化基数与本年摊销计算之后
  // (与A107012表式一致:行46减特殊收入、行47=行45-行46;冲减范围=费用化加计基数+本年摊销,不冲资本化形成成本)
  const specialTotal = round2((specialIncomes || [])
    .filter(si => projMap[si.projectId] && !excluded.has(si.projectId) && inScope({ period: si.period, date: si.date }, yearStr, periodEnd))
    .reduce((s, si) => s + (Number(si.amount) || 0), 0));

  const cap = pool.capitalize;
  const f = pool.expense;

  // 加计比例按年度政策(历史年度:2016-17 50%、2018-20 75%、2021 制造业100%、2022 制造业/科技型100%、2023起100%、IC 120%;境外委托2018起)
  const ap = annualPolicy(year, company);
  const deductRatio = ap.deductRatio;
  const amortRatio = ap.amortRatio;

  // 费用化部分(其他费用限额与境外2/3基准按 2021年28号公告第三条口径:
  //  行2=前5类(费用化 + 已形成无形资产的资本化支出) + 其他限额内;境内基数=行2+行36×80%;
  //  未形成无形资产的资本化项目当年支出不计入当年限额基数与可加计基数)
  const base5 = round2(BASE_FIVE.reduce((s, k) => s + f[k], 0));
  // 已形成无形资产的资本化项目:该项目存在 year<=当前年 的摊销记录
  const formed = formedCapProjects(amortizations, yearStr);
  // 计入限额基数的资本化支出(仅已形成项目;未形成项目资本化支出不进限额基数,也不进可加计基数)
  const capIn = { expense: { ...seedPool().expense }, capitalize: { ...seedPool().capitalize } };
  (expenses || [])
    .filter(e => !excluded.has(e.projectId) && projMap[e.projectId] && inScope(e, yearStr, periodEnd))
    .forEach(exp => {
      const allocs = allocateExpense(exp, timesheets);
      allocs.forEach(a => {
        // P0-2:仅分摊到"已形成无形资产"的资本化项目的份额计入限额基数(未形成项目不计入)
        if (!projMap[a.projectId] || projMap[a.projectId].capitalization !== 'capitalize') return;
        if (!formed.has(a.projectId)) return;
        capIn.capitalize[exp.category] = round2(capIn.capitalize[exp.category] + a.amount);
      });
    });
  const base5CapF = round2(BASE_FIVE.reduce((s, k) => s + capIn.capitalize[k], 0));
  const otherActual = f.other;
  const otherActualAll = round2(otherActual + capIn.capitalize.other);   // 含已形成资本化的 other
  const otherLimit = round2((base5 + base5CapF) * POLICIES.otherLimitRatio / (1 - POLICIES.otherLimitRatio));
  const otherDeductibleAll = round2(Math.min(otherActualAll, otherLimit));  // 行34:费+资共享限额内(行2/境外2/3基准用)
  const otherDeductible = round2(Math.min(otherActual, otherLimit));        // 费用化其他费用可扣(加计基数用,与A107012行41一致)
  const otherExcess = round2(otherActual - otherDeductible);

  const entrustDomesticOrg = round2(f.entrust_domestic_org * POLICIES.entrustDomesticRatio);
  const entrustDomesticPerson = round2(f.entrust_domestic_person * POLICIES.entrustDomesticRatio);
  const entrustDomCap80 = round2((capIn.capitalize.entrust_domestic_org + capIn.capitalize.entrust_domestic_person) * POLICIES.entrustDomesticRatio);
  const domesticTotal = round2(base5 + base5CapF + otherDeductibleAll + entrustDomesticOrg + entrustDomesticPerson + entrustDomCap80);

  // 委托境外:按80%计入,且不超过境内可加计基数×2/3(2018年起方可加计,财税〔2018〕64号)
  const entrustOverseasRaw = round2(f.entrust_overseas * POLICIES.entrustOverseasRatio);
  const entrustOverseasCap = round2(domesticTotal * POLICIES.overseasCap);
  const entrustOverseas = ap.overseasAllowed ? round2(Math.min(entrustOverseasRaw, entrustOverseasCap)) : 0;
  const entrustOverseasExcess = round2((ap.overseasAllowed ? entrustOverseasRaw : 0) - entrustOverseas);

  // 加计基数(费用化部分):前5类费用化 + 其他费用化(限额内) + 境内委托×80% + 境外委托限额内
  // 注意:base5 是费用化前5类(特殊收入冲减在基数层处理,见下)
  let totalExpenseBase = round2(base5 + otherDeductible + entrustDomesticOrg + entrustDomesticPerson + entrustOverseas);

  // 不征税收入对应支出剔除(政府补助/软件即征即退按不征税收入处理时,对应研发支出不得扣除加计)
  const exemptRelated = round2(company && company.nonTaxRelated ? Number(company.nonTaxRelated[yearStr]) || 0 : 0);
  const exemptExcluded = round2(Math.min(exemptRelated, totalExpenseBase));
  totalExpenseBase = round2(totalExpenseBase - exemptExcluded);

  // 加计比例按年度政策(见上方 ap 定义)
  const icActive = ap.deductRatio === POLICIES.icDeductRatio;

  // 资本化:本年形成无形资产成本(按项目) + 本年摊销加计
  const capitalFormed = round2(BASE_FIVE.concat('other').reduce((s, k) => s + cap[k], 0)
    + cap.entrust_domestic_org + cap.entrust_domestic_person + cap.entrust_overseas);
  const capitalByProject = {};
  (projects || []).forEach(p => { if (p.capitalization === 'capitalize') capitalByProject[p.id] = 0; });
  (expenses || [])
    .filter(e => !excluded.has(e.projectId) && projMap[e.projectId] && inScope(e, yearStr, periodEnd))
    .forEach(e => {
      const allocs = allocateExpense(e, timesheets);
      allocs.forEach(a => {
        // P0-2:按分摊目标项目资本化属性归集(费用化项目分摊到的份额不计入资本化形成成本)
        if (!projMap[a.projectId] || projMap[a.projectId].capitalization !== 'capitalize') return;
        if (capitalByProject[a.projectId] !== undefined) capitalByProject[a.projectId] = round2(capitalByProject[a.projectId] + a.amount);
      });
    });

  let amortAmount = round2((amortizations || [])
    .filter(a => projMap[a.projectId] && !excluded.has(a.projectId) && String(a.year) === yearStr)
    .reduce((s, a) => s + (Number(a.amount) || 0), 0));

  // 特殊收入冲减:先费用化加计基数(totalExpenseBase 已剔不征税收入),再本年摊销
  // 与 A107012 行47 = max(0, 行45-行46) 口径一致;不冲减资本化形成成本(会计口径不变)
  let specialDeducted = 0, specialUnused = 0;
  if (specialTotal > 0) {
    const t1 = Math.min(specialTotal, totalExpenseBase);
    totalExpenseBase = round2(totalExpenseBase - t1);
    specialDeducted = round2(t1);
    let left = round2(specialTotal - t1);
    if (left > 0 && amortAmount > 0) {
      const t2 = Math.min(left, amortAmount);
      amortAmount = round2(amortAmount - t2);
      specialDeducted = round2(specialDeducted + t2);
      left = round2(left - t2);
    }
    specialUnused = left;
  }

  const amortAdd = round2(amortAmount * amortRatio);
  const expenseAdd = round2(totalExpenseBase * deductRatio);
  const totalAdd = round2(expenseAdd + amortAdd);

  const ratioLabel = ap.label;
  const amortLabel = amortRatio >= 1.2 ? '220%摊销(44号)' : (amortRatio >= 1 ? '200%摊销(7号)' : (amortRatio >= 0.75 ? '175%摊销' : '150%摊销'));

  // A107012 参考表行
  const rows = [
    { line: 1, name: '人员人工费用', amount: f.personnel, note: CATEGORY_MAP.personnel },
    { line: 2, name: '直接投入费用', amount: f.direct, note: CATEGORY_MAP.direct },
    { line: 3, name: '折旧费用', amount: f.depreciation, note: CATEGORY_MAP.depreciation },
    { line: 4, name: '无形资产摊销', amount: f.amortization, note: CATEGORY_MAP.amortization },
    { line: 5, name: '新产品设计费等', amount: f.design, note: CATEGORY_MAP.design },
    { line: 6, name: '其他相关费用(实际)', amount: otherActual, note: '受10%限额' },
    { line: 6.1, name: '其他相关费用(限额)', amount: otherLimit, note: `前5类(费+已形成资)合计 ×10%÷90% = ${round2(base5 + base5CapF)}×10%÷90%` },
    { line: 6.2, name: '其他相关费用(可扣除)', amount: otherDeductible, note: otherExcess > 0 ? `超限剔除 ${otherExcess}` : '未超限' },
    { line: 7, name: '委托境内机构研发(×80%)', amount: entrustDomesticOrg, note: `实际发生额 ${f.entrust_domestic_org} × 80%` },
    { line: 8, name: '委托境内个人研发(×80%)', amount: entrustDomesticPerson, note: `实际发生额 ${f.entrust_domestic_person} × 80%` },
    { line: 9, name: '委托境外研发(×80%且≤境内2/3)', amount: entrustOverseas,
      note: `实际发生额 ${f.entrust_overseas} × 80% = ${entrustOverseasRaw};境内2/3限额=${entrustOverseasCap}` },    ...(specialTotal > 0 ? [{ line: 9.1, name: '减:特殊收入冲减(下脚料/残次品/试制品)', amount: -specialDeducted,
      note: `本年特殊收入 ${specialTotal} 元,冲减 ${specialDeducted} 元${specialUnused > 0 ? `;超出可加计费用 ${specialUnused} 元未冲减` : ''}` }] : []),
    ...(exemptExcluded > 0 ? [{ line: 9.2, name: '减:不征税收入对应支出(不得加计)', amount: -exemptExcluded,
      note: '政府补助/软件即征即退按不征税收入处理时,对应研发支出不得税前扣除及加计' }] : []),
    { line: 10, name: '费用化研发费用合计(加计基数)', amount: totalExpenseBase, note: '行1~9合计(含冲减)' },
    { line: 11, name: `本年费用化加计扣除额(×${(deductRatio * 100).toFixed(0)}%)`, amount: expenseAdd, note: ratioLabel },
    { line: 12, name: '资本化项目本年摊销额', amount: amortAmount, note: `形成无形资产后按${amortLabel}` },
    { line: 13, name: `本年摊销加计扣除额(×${(amortRatio * 100).toFixed(0)}%)`, amount: amortAdd, note: `摊销额×${amortRatio}` },
    { line: 14, name: '加计扣除额合计', amount: totalAdd, note: '行11+行13' },
  ];

  return {
    year: yearStr,
    detail: {
      base5, otherActual, otherLimit, otherDeductible, otherDeductibleAll, otherExcess,
      entrustDomesticOrg, entrustDomesticPerson, entrustOverseasRaw,
      entrustOverseasCap, entrustOverseas, entrustOverseasExcess,
      domesticTotal, totalExpenseBase, expenseAdd,
      capitalFormed, capitalByProject, amortAmount, amortAdd, totalAdd,
      specialIncomeTotal: specialTotal, specialIncomeDeducted: specialDeducted, specialIncomeUnused: specialUnused,
      exemptRelated, exemptExcluded, icActive, deductRatio, amortRatio,
      excludedProjectCount: excluded.size,
      categoryActual: f,
      categoryActualCap: cap,
      eligible: true, ineligibleReason: '',
      ratioLabel: ap.label,
    },
    rows,
    // 与闸门归零分支一致:顶层也暴露 eligible(正常分支此前缺失,导致 /api/summary 顶层 eligible 在
    // 正常/闸门两态下结构不一致)
    eligible: true, ineligibleReason: '',
  };
}

/**
 * 三套口径对照:会计口径 / 加计口径 / 高企口径(近似)
 * 高企口径:国科发火〔2016〕32号 — 委托外部(境内+境外)按80%计入、其他费用一般不超过研发总费用20%,不设境外2/3
 */
function computeCalibers({ company, projects, expenses, timesheets, amortizations, specialIncomes, year }) {
  const s = computeSummary({ company, projects, expenses, timesheets, amortizations, specialIncomes, year });
  const d = s.detail;
  const yearStr = String(year);
  // 会计口径:本年研发支出账面合计(费用化+资本化,含分摊,含不得加计项目——会计照实入账)
  const accounting = round2((expenses || [])
    .filter(e => String(e.period || e.date || '').startsWith(yearStr))
    .reduce((sum, e) => sum + allocateExpense(e, timesheets).reduce((a, x) => a + x.amount, 0), 0));
  const raw = d.categoryActual || {};
  const rawCap = d.categoryActualCap || {};
  // 高企口径:研发费用含资本化支出(形成无形资产前仍属研发费用),前5类为费用化+资本化合计
  const base5Cap = BASE_FIVE.reduce((s, k) => s + (rawCap[k] || 0), 0);
  const base5All = round2(d.base5 + base5Cap);
  const otherActualAll = round2(d.otherActual + (rawCap.other || 0));
  const otherLimitHt = round2(base5All * 0.2 / 0.8);
  const otherHt = round2(Math.min(otherActualAll, otherLimitHt));
  const entrustHt = round2((raw.entrust_domestic_org + raw.entrust_domestic_person + raw.entrust_overseas) * 0.8);
  const hiTech = round2(base5All + otherHt + entrustHt);
  // 发现5:加计口径应与 A107012 行45/行47 对齐——含本年摊销(行43);accounting 不含摊销、仅当年支出,
  // 故 deductionFull(费用化基数+本年摊销)才是与行47 可比的口径
  const deductionFull = round2(d.totalExpenseBase + d.amortAmount);
  return {
    year: yearStr,
    accounting,
    deduction: d.totalExpenseBase,
    deductionFull,
    amortAmount: d.amortAmount,
    totalAdd: d.totalAdd,
    hiTech,
    diffAccountingDeduction: round2(accounting - d.totalExpenseBase),
    diffDeductionHt: round2(d.totalExpenseBase - hiTech),
    otherLimitHt,
    eligible: d.eligible !== false,
    ineligibleReason: d.ineligibleReason || '',
    note: '高企口径为近似测算(国科发火〔2016〕32号:委托外部按80%计入、其他费用限额20%、无境外2/3限制;不含人员占比等认定条件),最终以专项审计报告为准。',
  };
}

/** 资本化项目形成无形资产成本(用于摊销计划自动生成;year 缺省=全部年度累计) */
function capitalFormedForProject({ project, expenses, timesheets, year }) {
  let total = 0;
  (expenses || []).forEach(e => {
    if (year && !String(e.period || e.date || '').startsWith(String(year))) return;
    // P0-2:按分摊落点计入——分摊到本资本化项目且按 allocationType 判定为 capitalize 的份额即本项目形成成本
    allocateExpense(e, timesheets).forEach(a => {
      if (a.projectId === project.id && allocationType(e, project) === 'capitalize') total += a.amount;
    });
  });
  return round2(total);
}

/**
 * A107012《研发费用加计扣除优惠明细表》(2023/2024/2025版行次)官方表单数据
 * 行1-34 自主研发/合作/集中(六大类+其他费用统一限额);行35-39 委托研发;行40-52 小计/资本化/抵减/加计比例
 */
function buildA107012({ company, projects, expenses, timesheets, amortizations, specialIncomes, year }) {
  const yearStr = String(year);
  const gate = enterpriseGate(company);
  const ap = annualPolicy(year, company);
  const zeroForm = () => {
    const Rz = (line, name, opt = {}) => ({ line, name, amount: 0, note: opt.note || '', indent: opt.indent || 0, bold: !!opt.bold });
    const rows = [
      Rz('1', '本年可享受研发费用加计扣除项目数量', { note: '单位:个;本企业不得享受' }),
      Rz('2', '一、自主研发、合作研发、集中研发(3+7+16+19+23+34)'),
      Rz('35', '二、委托研发(36+37+39)'),
      Rz('40', '三、年度研发费用小计(2+36×80%+38)'),
      Rz('45', '六、允许扣除的研发费用合计(41+43+44)'),
      Rz('47', '七、允许扣除的研发费用抵减特殊收入后的金额(45-46)'),
      Rz('50', '八、加计扣除比例及计算方法', { note: `${ap.label};本企业${gate.reason},不得享受加计扣除`, bold: true }),
      Rz('51', '九、本年研发费用加计扣除总额(47-48-49)×50', { note: gate.reason, bold: true }),
    ];
    return { year: yearStr, companyName: company ? company.name : '', rows, ratio: ap.label, line47: 0, line51: 0, eligible: false, ineligibleReason: gate.reason };
  };
  if (!gate.eligible) return zeroForm();
  const projMap = {};
  (projects || []).forEach(p => (projMap[p.id] = p));
  const excluded = excludedProjectIds(projects);
  const selfForms = new Set(['self', 'cooperation', 'centralized']);
  const ENTRUST_KEYS = ['entrust_domestic_org', 'entrust_domestic_person', 'entrust_overseas', 'entrust_overseas_person'];

  // 池:自研/合作/集中 六大类(费+资) 与 委托四类(费+资)
  // 资本化支出仅在项目已形成无形资产(存在 year<=当前年 摊销记录)时才计入当年基数(2021年28号公告第三条)
  const formed = formedCapProjects(amortizations, yearStr);
  const pool = seedPool();
  const entrust = { expense: {}, capitalize: {} };
  ENTRUST_KEYS.forEach(k => { entrust.expense[k] = 0; entrust.capitalize[k] = 0; });
  (expenses || [])
    .filter(e => !excluded.has(e.projectId) && inScope(e, yearStr, null))
    .forEach(exp => {
      const proj = projMap[exp.projectId];
      if (!proj) return; // P0-3:孤儿费用(项目已删除)不计入,与 computeSummary 口径一致
      const allocs = allocateExpense(exp, timesheets);
      allocs.forEach(a => {
        // P0-2:按分摊目标项目资本化属性定型(共享费用分摊到资本化项目→capitalize、费用化项目→expense)
        const target = projMap[a.projectId];
        const eType = allocationType(exp, target);
        // 未形成无形资产的资本化支出不计入当年基数(费用化支出始终计入)
        if (eType === 'capitalize' && !(target && formed.has(target.id))) return;
        const form = proj.form || 'self';
        // 先按类别路由:委托四类无论挂在何种项目(含自研项目)均计入委托池(与 computeSummary 口径一致)
        if (ENTRUST_KEYS.includes(exp.category)) {
          entrust[eType][exp.category] = round2(entrust[eType][exp.category] + a.amount);
        } else if (selfForms.has(form)) {
          pool[eType][exp.category] = round2(pool[eType][exp.category] + a.amount);
        }
      });
    });

  const sumKeys = ks => ks.reduce((s, k) => round2(s + pool.expense[k] + pool.capitalize[k]), 0);
  const five = ['personnel', 'direct', 'depreciation', 'amortization', 'design'];
  const fiveTotal = sumKeys(five);
  const otherTotal = round2(pool.expense.other + pool.capitalize.other);
  const otherLimit = round2(fiveTotal * POLICIES.otherLimitRatio / (1 - POLICIES.otherLimitRatio));
  const line34 = round2(Math.min(otherTotal, otherLimit));
  const line2 = round2(fiveTotal + line34);

  const sumEnt = (et, ks) => ks.reduce((s, k) => round2(s + entrust[et][k]), 0);
  const line36 = round2(sumEnt('expense', ['entrust_domestic_org', 'entrust_domestic_person']) + sumEnt('capitalize', ['entrust_domestic_org', 'entrust_domestic_person']));
  const line37 = round2(sumEnt('expense', ['entrust_overseas']) + sumEnt('capitalize', ['entrust_overseas']));
  const line39 = round2(sumEnt('expense', ['entrust_overseas_person']) + sumEnt('capitalize', ['entrust_overseas_person']));
  const domBase80 = round2(line36 * POLICIES.entrustDomesticRatio);
  const ovsRaw80 = round2(line37 * POLICIES.entrustOverseasRatio);
  const ovsCap = round2((line2 + domBase80) * POLICIES.overseasCap);
  const line38 = ap.overseasAllowed ? round2(Math.min(ovsRaw80, ovsCap)) : 0; // 境外委托2018年起方可加计(64号)
  const line40 = round2(line2 + domBase80 + line38);

  // 费用化金额(六大类费用化 + 其他费用化限额内 + 委托费用化80%/境外费用化限额)
  const fiveE = five.reduce((s, k) => round2(s + pool.expense[k]), 0);
  const otherE = pool.expense.other;
  const otherED = round2(Math.min(otherE, otherLimit));
  const domE80 = round2((entrust.expense.entrust_domestic_org + entrust.expense.entrust_domestic_person) * POLICIES.entrustDomesticRatio);
  const ovsE80 = round2(entrust.expense.entrust_overseas * POLICIES.entrustOverseasRatio);
  const ovsED = ap.overseasAllowed ? round2(Math.min(ovsE80, ovsCap)) : 0;
  const line41Raw = round2(fiveE + otherED + domE80 + ovsED);
  // 不征税收入对应支出(政府补助/软件即征即退按不征税收入处理时)不得加计,先行剔除(与 computeSummary 口径一致)
  const exemptRelated = round2(company && company.nonTaxRelated ? Number(company.nonTaxRelated[yearStr]) || 0 : 0);
  const line41Exempt = Math.min(exemptRelated, line41Raw);
  const line41 = round2(line41Raw - line41Exempt);
  const line42 = round2(line40 - line41);

  // P2-2(审计):摊销按"形成年度"分流行43(本年形成)/行44(以前年度形成)——
  // 形成年度=capFormationYearOf(显式 formationYear 或该项目最早摊销年度)。
  const curAmorts = (amortizations || [])
    .filter(a => projMap[a.projectId] && !excluded.has(a.projectId) && String(a.year) === yearStr);
  const amort43 = round2(curAmorts
    .filter(a => capFormationYearOf(amortizations, a.projectId, Number(yearStr)) === Number(yearStr))
    .reduce((s, a) => s + (Number(a.amount) || 0), 0));
  const amort44 = round2(curAmorts
    .filter(a => capFormationYearOf(amortizations, a.projectId, Number(yearStr)) < Number(yearStr))
    .reduce((s, a) => s + (Number(a.amount) || 0), 0));
  const amortAmount = round2(amort43 + amort44);
  const line45 = round2(line41 + amortAmount);
  const specialTotal = round2((specialIncomes || [])
    .filter(si => projMap[si.projectId] && !excluded.has(si.projectId) && inScope({ period: si.period, date: si.date }, yearStr, null))
    .reduce((s, si) => s + (Number(si.amount) || 0), 0));
  const line47 = Math.max(0, round2(line45 - specialTotal));

  const ratio = ap.deductRatio;
  const ratioLabel = ap.label;
  const line51 = round2(line47 * ratio);

  // 项目数量(可享受加计):剔除受托开发与委托境外个人;有"进入当年基数"的费用或有当年摊销的项目计入——
  // P3(审计):资本化项目未形成无形资产的当年资本化支出不计入基数,不属"本年享受",不计入数量。
  const projCount = (projects || []).filter(p => {
    if (excluded.has(p.id)) return false;
    const form = p.form || 'self';
    if (!selfForms.has(form) && !['entrust_domestic_org', 'entrust_domestic_person', 'entrust_overseas'].includes(form)) return false;
    const hasAmort = (amortizations || []).some(a => a.projectId === p.id && String(a.year) === yearStr);
    const hasExp = (expenses || []).some(e => {
      if (e.projectId !== p.id || !inScope(e, yearStr, null)) return false;
      // 资本化未形成项目:资本化支出当年不进基数(2021年28号第三条),仅费用化支出计入"享受"
      if (p.capitalization === 'capitalize' && !formed.has(p.id)) {
        const et = allocationType(e, projMap[e.projectId]);
        if (et === 'capitalize') return false;
      }
      return true;
    });
    return hasExp || hasAmort;
  }).length;

  const note0 = '本项目未细分该明细科目,可按大类金额填报或按实际辅助账细分后填报';
  const R = (line, name, amount, opt = {}) => ({ line, name, amount: amount === '' ? '' : round2(Number(amount) || 0), note: opt.note || '', indent: opt.indent || 0, bold: !!opt.bold });
  const rows = [
    R('1', '本年可享受研发费用加计扣除项目数量', projCount, { note: '单位:个', bold: true }),
    R('2', '一、自主研发、合作研发、集中研发(3+7+16+19+23+34)', line2, { bold: true }),
    R('3', '(一)人员人工费用(4+5+6)', sumKeys(['personnel'])),
    R('4', '1.直接从事研发活动人员工资薪金', 0, { note: note0, indent: 1 }),
    R('5', '2.直接从事研发活动人员五险一金', 0, { note: note0, indent: 1 }),
    R('6', '3.外聘研发人员的劳务费用', 0, { note: note0, indent: 1 }),
    R('7', '(二)直接投入费用(8+9+10+11+12+13+14+15)', sumKeys(['direct'])),
    R('8', '1.研发活动直接消耗材料费用', 0, { note: note0, indent: 1 }),
    R('9', '2.研发活动直接消耗燃料费用', 0, { note: note0, indent: 1 }),
    R('10', '3.研发活动直接消耗动力费用', 0, { note: note0, indent: 1 }),
    R('11', '4.用于中间试验和产品试制的模具、工艺装备开发及制造费', 0, { note: note0, indent: 1 }),
    R('12', '5.用于不构成固定资产的样品、样机及一般测试手段购置费', 0, { note: note0, indent: 1 }),
    R('13', '6.用于试制产品的检验费', 0, { note: note0, indent: 1 }),
    R('14', '7.用于研发活动的仪器、设备的运行维护、调整、检验、维修等费用', 0, { note: note0, indent: 1 }),
    R('15', '8.通过经营租赁方式租入的用于研发活动的仪器、设备租赁费', 0, { note: note0, indent: 1 }),
    R('16', '(三)折旧费用(17+18)', sumKeys(['depreciation'])),
    R('17', '1.用于研发活动的仪器的折旧费', 0, { note: note0, indent: 1 }),
    R('18', '2.用于研发活动的设备的折旧费', 0, { note: note0, indent: 1 }),
    R('19', '(四)无形资产摊销(20+21+22)', sumKeys(['amortization'])),
    R('20', '1.用于研发活动的软件的摊销费用', 0, { note: note0, indent: 1 }),
    R('21', '2.用于研发活动的专利权的摊销费用', 0, { note: note0, indent: 1 }),
    R('22', '3.用于研发活动的非专利技术(包括许可证、专有技术、设计和计算方法等)的摊销费用', 0, { note: note0, indent: 1 }),
    R('23', '(五)新产品设计费等(24+25+26+27)', sumKeys(['design'])),
    R('24', '1.新产品设计费', 0, { note: note0, indent: 1 }),
    R('25', '2.新工艺规程制定费', 0, { note: note0, indent: 1 }),
    R('26', '3.新药研制的临床试验费', 0, { note: note0, indent: 1 }),
    R('27', '4.勘探开发技术的现场试验费', 0, { note: note0, indent: 1 }),
    R('28', '(六)其他相关费用(29+30+31+32+33)', otherTotal),
    R('29', '1.技术图书资料费、资料翻译费、专家咨询费、高新科技研发保险费', 0, { note: note0, indent: 1 }),
    R('30', '2.研发成果的检索、分析、评审、鉴定、评估、验收费用', 0, { note: note0, indent: 1 }),
    R('31', '3.知识产权的申请费、注册费、代理费', 0, { note: note0, indent: 1 }),
    R('32', '4.职工福利费、补充养老保险费、补充医疗保险费', 0, { note: note0, indent: 1 }),
    R('33', '5.差旅费、会议费', 0, { note: note0, indent: 1 }),
    R('34', '(七)经限额调整后的其他相关费用', line34, { note: `其他相关费用限额 = 前5类合计 ${fmt0(fiveTotal)} × 10% ÷ 90% = ${fmt0(otherLimit)};取 min(实际 ${fmt0(otherTotal)}, 限额)`, bold: true }),
    R('35', '二、委托研发(36+37+39)', round2(line36 + line37 + line39), { bold: true }),
    R('36', '(一)委托境内机构或个人进行研发活动所发生的费用', line36, { note: '加计基数按 80% 计入(第40行公式)' }),
    R('37', '(二)委托境外机构进行研发活动发生的费用', line37, { note: '加计基数按 80% 且不超过境内×2/3(第38行)' }),
    R('38', '其中:允许加计扣除的委托境外机构进行研发活动发生的费用', line38, { note: `min(发生额×80% = ${fmt0(ovsRaw80)}, 境内可加计基数×2/3 = ${fmt0(ovsCap)})(财税〔2018〕64号)` }),
    R('39', '(三)委托境外个人进行研发活动发生的费用', line39, { note: '不得加计' }),
    R('40', '三、年度研发费用小计(2+36×80%+38)', line40, { bold: true }),
    R('41', '(一)本年费用化金额', line41, { note: '前5类费用化 + 其他费用化(限额内) + 委托境内×80% + 委托境外限额内' }),
    R('42', '(二)本年资本化金额(40-41)', line42, { note: line41Exempt > 0 ? `含不征税收入对应支出剔除 ${fmt0(line41Exempt)} 元(行41已剔、行40未剔所致);真实资本化支出 ${fmt0(line42 - line41Exempt)} 元` : '' }),
    R('43', '四、本年形成无形资产摊销额', amort43, { note: '形成年度=本年度(当年形成无形资产的本年摊销)' }),
    R('44', '五、以前年度形成无形资产本年摊销额', amort44, { note: '形成年度早于本年度、本年仍摊销的部分;按摊销台账「形成年度」字段或该项目最早摊销年度自动分流' }),
    R('45', '六、允许扣除的研发费用合计(41+43+44)', line45, { bold: true }),
    R('46', '减:特殊收入部分', specialTotal, { note: '下脚料、残次品、试制品销售收入,应冲减研发费用' }),
    R('47', '七、允许扣除的研发费用抵减特殊收入后的金额(45-46)', line47, { bold: true }),
    R('48', '减:当年销售研发活动直接形成产品(包括组成部分)对应的材料部分', 0, { note: '如当年销售研发形成的产品,对应材料部分需扣减,请按实际填报' }),
    R('49', '减:以前年度销售研发活动直接形成产品(包括组成部分)对应材料部分结转金额', 0, { note: '同上,按实际填报' }),
    R('50', '八、加计扣除比例及计算方法', '', { note: ratioLabel, bold: true }),
    R('L1', '本年允许加计扣除的研发费用总额(47-48-49)', line47),
    R('51', '九、本年研发费用加计扣除总额(47-48-49)×50', line51, { note: `${fmt0(line47)} × ${(ratio * 100).toFixed(0)}%`, bold: true }),
    R('52', '十、销售研发活动直接形成产品(包括组成部分)对应材料部分结转以后年度扣减金额', 0, { note: '当 47-48-49 ≥ 0 时本行填 0' }),
  ];
  return { year: yearStr, companyName: company ? company.name : '', rows, ratio: ratioLabel, line47, line51, eligible: true, ineligibleReason: '' };
}

function fmt0(n) { return (Math.round(Number(n) * 100) / 100).toLocaleString('zh-CN'); }

/** 年度研发支出归集汇总表(97号公告附件5《"研发支出"辅助账汇总表》样式,留存备查):项目行 × 六大类+委托+费用化/资本化 */
function buildYearlyCollection({ projects, expenses, timesheets, amortizations, year }) {
  const yearStr = String(year);
  const l97 = buildLedger97({ projects, expenses, timesheets, amortizations, year });
  const SIX = [['personnel', '人员人工'], ['direct', '直接投入'], ['depreciation', '折旧'], ['amortization', '摊销'], ['design', '设计费'], ['other', '其他相关']];
  const rows = [];
  const all = [...l97.self, ...l97.entrust, ...l97.cooperation, ...l97.centralized]
    .sort((a, b) => (a.project.code || '').localeCompare(b.project.code || ''));
  all.forEach(it => {
    const p = it.project;
    rows.push({
      code: p.code || '', name: p.name || '',
      form: p.form || 'self', capitalization: p.capitalization || 'expense', status: p.status || '',
      six: { ...it.six },
      // 委托列:项目级委托加计基数(×80%),自研项目挂委托类别同样计入(ledger97 已按类别汇总)
      entrustDomestic: it.entrustDomestic || 0,
      entrustOverseas: it.entrustOverseas || 0,
      expenseSum: it.expenseSum, capitalizeSum: it.capitalizeSum, total: it.total,
      note: p.resultOwner === 'client' ? '受托开发(不得加计)' : (it.isOverseas ? '境外委托(受境内×2/3限额)' : ''),
    });
  });
  const sum = k => round2(rows.reduce((s, r) => s + (k(r) || 0), 0));
  const totals = { six: {}, entrustDomestic: sum(r => r.entrustDomestic), entrustOverseas: sum(r => r.entrustOverseas), expenseSum: sum(r => r.expenseSum), capitalizeSum: sum(r => r.capitalizeSum), total: sum(r => r.total) };
  SIX.forEach(([k]) => (totals.six[k] = sum(r => r.six[k] || 0)));
  return {
    year: yearStr, six: SIX, rows, totals,
    domesticBase: l97.domesticBase, cap2of3: l97.cap2of3, overseasTotalBase: l97.overseasTotalBase,
  };
}

module.exports = { computeSummary, computeCalibers, capitalFormedForProject, excludedProjectIds, buildA107012, buildYearlyCollection, enterpriseGate };
