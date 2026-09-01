// 2015版(国家税务总局公告2015年第97号)研发支出辅助账:自主研发/委托研发/合作研发/集中研发
// 样式依据: 97号公告附件1-4 —— 每类辅助账按项目设置,凭证级记录,六大类费用明细分列,
//          委托研发区分境内机构/境内个人/境外机构/境外个人,境外参考2021版加计口径(80%,且≤境内×2/3)
const { CATEGORY_MAP } = require('./constants');
const { allocateExpense, round2, allocationType } = require('./ledger');
// 加计口径单一口径来源:备查辅助账的境内可加计基数/境外2/3限额必须与申报口径(A107012/summary)一致,
// 否则"辅助账显示限额 493,333.33、申报表却按 357,037.04"脱节,经不起税务核查。
const { computeDeductionCaliber } = require('./caliber');

// 97号公告六大类费用(自主研发/合作/集中辅助账的费用明细列)
const SIX_CLASS = [
  ['personnel', '一、人员人工费用'],
  ['direct', '二、直接投入费用'],
  ['depreciation', '三、折旧费用'],
  ['amortization', '四、无形资产摊销'],
  ['design', '五、新产品设计费等'],
  ['other', '六、其他相关费用'],
];

const ENTRUST_TYPES = {
  entrust_domestic_org: '委托境内机构',
  entrust_domestic_person: '委托境内个人',
  entrust_overseas: '委托境外机构',
  entrust_overseas_person: '委托境外个人',
};

// 委托研发类别(不计入六大类列;金额在委托列/委托辅助账列示,避免污染"其他相关费用"列)
const ENTRUST_KEYS_97 = ['entrust_domestic_org', 'entrust_domestic_person', 'entrust_overseas', 'entrust_overseas_person'];

function projectRows(project, expenses, timesheets, hasExp) {
  return (expenses || [])
    .filter(hasExp)
    .map(exp => allocateExpense(exp, timesheets)
      .filter(a => a.projectId === project.id) // 按分摊后归属取份额(共享费用可能记在别的项目下)
      .map(a => ({
        date: exp.date || '',
        voucherNo: exp.voucherNo || '',
        summary: exp.summary || '',
        category: exp.category,
        categoryName: CATEGORY_MAP[exp.category] || exp.category,
        expenseType: allocationType(exp, project), // P0-2:按目标项目资本化属性定型
        amount: a.amount,
        originalAmount: exp.amount,
        isAllocated: allocateExpense(exp, timesheets).length > 1,
        allocNote: exp.allocNote || '',
        invoiceNo: exp.invoiceNo || '',
      })))
    .flat();
}

/**
 * 生成四类辅助账。
 * @returns {{year, self, entrust, cooperation, centralized, domesticBase, cap2of3, overseasTotalBase, overseasExcess}}
 */
function buildLedger97({ projects, expenses, timesheets, amortizations, year }) {
  const yearStr = String(year);
  const hasExp = e => String(e.period || e.date || '').startsWith(yearStr);
  // 池:当年费用分摊到达的项目(含共享费用被分摊到的项目)
  const pool = (projects || []).filter(p =>
    (expenses || []).some(e => hasExp(e) && allocateExpense(e, timesheets).some(a => a.projectId === p.id)));
  const section = { self: [], entrust: [], cooperation: [], centralized: [] };

  // F3:仅含本年摊销、当年无费用分摊到达的资本化项目,也必须出现在辅助账中(否则 A107012 行43 的摊销
  // 在五件套内无载体,辅助账对不平申报表)。为此类项目生成"摊销区块"条目(isAmortOnly),解列本年摊销额。
  const amortOnlyIds = new Set();
  (amortizations || []).forEach(a => {
    if (String(a.year) !== yearStr) return;
    if ((projects || []).some(p => p.id === a.projectId)) {
      const p = (projects || []).find(x => x.id === a.projectId);
      if (p.capitalization !== 'capitalize') return;
      if (pool.some(x => x.id === a.projectId)) return; // 已有费用区块
      amortOnlyIds.add(a.projectId);
    }
  });

  // 合并:先有费用项目,再补仅摊销项目
  const allProjects = [...pool];
  amortOnlyIds.forEach(pid => {
    const p = (projects || []).find(x => x.id === pid);
    if (p) allProjects.push(p);
  });

  allProjects.forEach(project => {
    let rows = projectRows(project, expenses, timesheets, hasExp);
    // F3:仅有本年摊销、无当年费用的资本化项目 → 生成一条摊销区块行(计入"无形资产摊销"列)
    let isAmortOnly = false;
    if (!rows.length && amortOnlyIds.has(project.id)) {
      isAmortOnly = true;
      const amortAmt = (amortizations || [])
        .filter(a => a.projectId === project.id && String(a.year) === yearStr)
        .reduce((s, a) => s + (Number(a.amount) || 0), 0);
      rows = [{
        date: `${yearStr}-12-31`,
        voucherNo: '',
        summary: '本年形成无形资产摊销(业务合并填列,详见摊销台账)',
        category: 'amortization',
        categoryName: '无形资产摊销',
        expenseType: 'capitalize', // 摊销属资本化部分
        amount: round2(amortAmt),
        originalAmount: round2(amortAmt),
        isAllocated: false,
        allocNote: '',
        invoiceNo: '',
        isAmortOnly: true,
      }];
    }
    if (!rows.length) return;
    rows.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    let balance = 0;
    rows.forEach((r, i) => {
      r.seq = i + 1;
      balance = round2(balance + r.amount);
      r.balance = balance; // 辅助账"余额"列(期初为0,逐笔累计)
    });
    const six = {};
    SIX_CLASS.forEach(([k]) => (six[k] = 0));
    let entrustDom = 0, entrustOvr = 0;
    rows.forEach(r => {
      if (ENTRUST_KEYS_97.includes(r.category)) {
        r.isEntrust = true; // 委托费用:不进六类列,归入委托列(×80%)
        if (r.category === 'entrust_overseas' || r.category === 'entrust_overseas_person') entrustOvr = round2(entrustOvr + r.amount);
        else entrustDom = round2(entrustDom + r.amount);
        return;
      }
      const key = six[r.category] !== undefined ? r.category : 'other';
      six[key] = round2(six[key] + r.amount);
    });
    const expenseSum = round2(rows.filter(r => r.expenseType === 'expense').reduce((s, r) => s + r.amount, 0));
    const capitalizeSum = round2(rows.filter(r => r.expenseType === 'capitalize').reduce((s, r) => s + r.amount, 0));
    const total = round2(rows.reduce((s, r) => s + r.amount, 0));
    const item = {
      project, rows, six, expenseSum, capitalizeSum, total, entrustType: '',
      isAmortOnly: !!isAmortOnly,
      // 项目级委托加计基数(×80%):境内机构+境内个人 / 境外机构+境外个人(供汇总表委托列)
      entrustDomestic: round2(entrustDom * 0.8),
      entrustOverseas: round2(entrustOvr * 0.8),
    };
    const form = project.form || 'self';
    if (form === 'self') section.self.push(item);
    else if (form.startsWith('entrust_')) { item.entrustType = form; section.entrust.push(item); }
    else if (form === 'cooperation') section.cooperation.push(item);
    else if (form === 'centralized') section.centralized.push(item);
  });

  // 委托研发:加计基数=发生额×80%(委托个人须凭发票等合法凭证);境外另有境内×2/3 限额
  section.entrust.forEach(item => {
    item.isOverseas = item.entrustType === 'entrust_overseas' || item.entrustType === 'entrust_overseas_person';
    item.dedBase = round2(item.total * 0.8);
    item.rows.forEach(r => (r.dedBase = round2(r.amount * 0.8)));
  });

  // 境内可加计基数 / 境外2/3限额:使用与申报口径(A107012/summary)完全一致的共享计算(computeDeductionCaliber),
  // 不再从辅助账六类列(会计口径)推算——六类列含未形成资本化支出与未限额的其他费用,会造成辅助账与申报表脱节。
  // caliber 输出:domesticTotal(境内可加计基数)=行2+行36×80%、entrustOverseasCap(境外2/3限额)、
  //            entrustOverseasRaw(境外实际×80%)、entrustOverseasExcess(境外超限)。
  const cal = computeDeductionCaliber({ projects, expenses, timesheets, amortizations, year });
  const domesticBase = cal.domesticTotal;
  const cap2of3 = cal.entrustOverseasCap;
  const overseasTotalBase = cal.entrustOverseasRaw;
  const overseasExcess = cal.entrustOverseasExcess;

  // 合作/集中:本企业分摊金额即加计基数
  section.cooperation.forEach(it => (it.dedBase = it.total));
  section.centralized.forEach(it => (it.dedBase = it.total));

  return {
    year: yearStr,
    self: section.self,
    entrust: section.entrust,
    cooperation: section.cooperation,
    centralized: section.centralized,
    entrustTypeNames: ENTRUST_TYPES,
    domesticBase,
    cap2of3,
    overseasTotalBase,
    overseasExcess,
  };
}

module.exports = { buildLedger97, SIX_CLASS, ENTRUST_TYPES };
