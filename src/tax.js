// 节税测算:把加计扣除额换算成"省了多少税",给老板看决策数字
// 税率模型:高企15%(企业所得税法28条)/小型微利5%(财税〔2023〕12号,≤300万)/软件企业两免三减半(25%×50%=12.5%或0)/标准25%
// 即征即退互斥测算:作不征税收入(退税免税但对应研发支出不得加计) vs 作应税收入(全额加计但退税并入所得缴税)
const { POLICIES } = require('./constants');
const { round2 } = require('./ledger');
const { computeSummary } = require('./summary');

const RATE_LABELS = {
  [POLICIES.standardRate]: '企业所得税法定税率25%',
  [POLICIES.smallMicroRate]: '小型微利企业(年应纳税所得额≤300万)实际税负5%',
  [POLICIES.hiTechRate]: '高新技术企业优惠税率15%',
  [POLICIES.halfRate]: '软件企业"两免三减半"减半期(25%×50%=12.5%)',
  [POLICIES.zeroRate]: '软件企业"两免三减半"免税期(0%)',
};

/**
 * 节税测算
 * @param {object} opts { company, projects, expenses, timesheets, amortizations, specialIncomes, year, periodEnd?, projectedIncome?, rate? }
 * @returns {object} 加计额、税率、税负前后、节税额、新增亏损、结转年限
 */
function computeTaxSaving({ company, projects, expenses, timesheets, amortizations, specialIncomes, year, periodEnd, projectedIncome, rate }) {
  const yearStr = String(year);
  const s = computeSummary({ company, projects, expenses, timesheets, amortizations, specialIncomes, year, periodEnd });
  const totalAdd = s.detail.totalAdd;
  const hiTech = !!(company && company.isHiTech);

  // 应纳税所得额(未考虑加计):优先用户输入,否则取企业档案
  let income = Number.isFinite(projectedIncome) && projectedIncome !== null
    ? projectedIncome
    : (company && company.taxableIncome ? Number(company.taxableIncome[yearStr]) || 0 : 0);

  // 税率:显式传入优先;否则 高企15% > 小型微利5%(≤300万且从业≤300人且资产≤5000万) > 标准25%
  let useRate, rateNote;
  const smeIncome = income > 0 && income <= POLICIES.smeIncomeCap;
  // 小微三条件(财政部 税务总局公告2023年第12号):应纳税所得额≤300万 且 从业人数≤300 且 资产总额≤5000万
  // 从业/资产未填报时按收入口径近似判定并提示补录,避免临界企业误判
  const headcount = company && company.headcount != null ? Number(company.headcount) : null;
  const totalAssets = company && company.totalAssets != null ? Number(company.totalAssets) : null;
  const smeHead = headcount === null || headcount <= 300;
  const smeAssets = totalAssets === null || totalAssets <= 5000;
  const smeEligible = smeIncome && smeHead && smeAssets;
  const sizeNote = (headcount === null || totalAssets === null)
    ? '(未填报从业人数/资产总额,仅按收入判定;若实际超过小微规模请在企业信息补录)'
    : (smeHead && smeAssets ? '' : `(从业${headcount}人/资产${totalAssets}万超过小微标准,不适用5%)`);
  if (Number.isFinite(rate) && rate !== null) {
    useRate = rate;
    rateNote = RATE_LABELS[useRate] || `自定义税率 ${(useRate * 100).toFixed(0)}%`;
  } else if (hiTech) {
    useRate = smeEligible ? POLICIES.smallMicroRate : POLICIES.hiTechRate;
    rateNote = smeEligible
      ? RATE_LABELS[POLICIES.smallMicroRate] + '(高企优惠与小微优惠取孰低,按5%计)' + sizeNote
      : RATE_LABELS[POLICIES.hiTechRate];
  } else {
    useRate = smeEligible ? POLICIES.smallMicroRate : POLICIES.standardRate;
    rateNote = RATE_LABELS[useRate] + (smeIncome && !smeEligible ? sizeNote : '');
  }

  const incomeAfter = income - totalAdd;
  const taxBefore = income > 0 ? income * useRate : 0;
  const taxAfter = incomeAfter > 0 ? incomeAfter * useRate : 0;
  const saving = Math.max(0, round2(taxBefore - taxAfter));
  const createsLoss = incomeAfter < 0 ? round2(-incomeAfter) : 0;

  return {
    year: yearStr,
    periodEnd: periodEnd || null,
    totalAdd: round2(totalAdd),
    rate: useRate,
    rateNote,
    income: round2(income),
    incomeAfter: round2(incomeAfter),
    taxBefore: round2(taxBefore),
    taxAfter: round2(taxAfter),
    saving,
    createsLoss,
    carryYears: hiTech ? 10 : 5,
    carryNote: hiTech
      ? '高新技术企业/科技型中小企业亏损可结转10年(财税〔2018〕76号)'
      : '一般企业亏损结转5年(企业所得税法第十八条)',
    note: `加计扣除额 ${round2(totalAdd).toLocaleString('zh-CN')} 元,按${(useRate * 100).toFixed(0)}%税负测算,预计节税 ${saving.toLocaleString('zh-CN')} 元。`,
  };
}

/**
 * 软件企业增值税即征即退 与 加计扣除 互斥测算
 * 场景A 不征税收入:退税款不计入应税所得(免所得税),但对应研发支出(related)不得税前扣除及加计
 * 场景B 应税收入:退税款并入应税所得缴税,研发支出全额加计
 * @param {object} opts { company, totalAdd, refund, related, rate }
 * @returns {object} 两场景净收益对比与结论
 */
function computeRefundScenarios({ company, totalAdd, refund, related, rate }) {
  const r = Math.max(0, Number(refund) || 0);
  const rel = Math.max(0, Number(related) || 0);
  const add = Math.max(0, Number(totalAdd) || 0);
  const useRate = Number.isFinite(rate) && rate !== null && rate !== undefined ? rate : POLICIES.standardRate;

  // 相对"无退税、无加计"基线的净收益
  const planA = round2(Math.max(0, (add - Math.min(rel, add)) * useRate));      // 退税免税,对应支出不得加计
  const planB = round2(Math.max(0, add * useRate - r * useRate));               // 退税应税,全额加计
  const better = planA >= planB ? 'A' : 'B';
  const betterName = better === 'A' ? '作不征税收入' : '作应税收入';

  return {
    refund: r, related: rel, rate: useRate,
    rateNote: RATE_LABELS[useRate] || `税率 ${(useRate * 100).toFixed(0)}%`,
    planA, planB,
    better, betterName,
    decision: `当不征税收入对应研发支出(${rel.toLocaleString('zh-CN')}元) ${rel > r ? '>' : rel < r ? '<' : '='} 退税额(${r.toLocaleString('zh-CN')}元)时,${rel > r ? '作应税收入更优' : rel < r ? '作不征税收入更优' : '两方案等价'};即"对应研发支出 ≥ 退税额"时应税方案严格更优。`,
    note: '若软件增值税即征即退选择作不征税收入处理:退税款免所得税,但对应研发支出不得加计;作应税收入处理:退税款并入应纳税所得额缴税,研发支出可全额加计。两者不可兼得。',
  };
}

module.exports = { computeTaxSaving, computeRefundScenarios, RATE_LABELS };
