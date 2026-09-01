// 分摊引擎 + 研发支出辅助账生成(2021年版样式核心)
const { CATEGORY_MAP, BASE_FIVE } = require('./constants');

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * 对一条费用做分摊,返回 [{projectId, amount}]。
 * direct: 全额归入项目;ratioHours: 按该期间研发工时占比分摊;ratioCustom: 按自定义权重。
 */
function allocateExpense(exp, timesheets) {
  if (!exp || !exp.amount) return [];
  const isShared = exp.isShared === true || exp.allocMethod === 'ratioHours' || exp.allocMethod === 'ratioCustom';
  if (!isShared || exp.allocMethod === 'direct') {
    return exp.projectId ? [{ projectId: exp.projectId, amount: round2(exp.amount) }] : [];
  }
  if (exp.allocMethod === 'ratioHours') {
    const period = exp.period || '';
    const rows = (timesheets || []).filter(t => t.period === period);
    const byProject = {};
    rows.forEach(t => {
      byProject[t.projectId] = (byProject[t.projectId] || 0) + (Number(t.rdHours) || 0);
    });
    const total = Object.values(byProject).reduce((a, b) => a + b, 0);
    if (!total) return exp.projectId ? [{ projectId: exp.projectId, amount: round2(exp.amount) }] : [];
    let assigned = 0;
    const allocs = Object.entries(byProject).map(([pid, h]) => {
      const amt = round2(exp.amount * h / total);
      assigned += amt;
      return { projectId: pid, amount: amt };
    });
    // 四舍五入差额修正到第一个项目,保证合计=原值
    const diff = round2(exp.amount - assigned);
    if (diff !== 0 && allocs.length) allocs[0].amount = round2(allocs[0].amount + diff);
    return allocs;
  }
  if (exp.allocMethod === 'ratioCustom') {
    const weights = exp.alloc || {};
    const totalW = Object.values(weights).reduce((a, b) => a + (Number(b) || 0), 0);
    if (!totalW) return exp.projectId ? [{ projectId: exp.projectId, amount: round2(exp.amount) }] : [];
    let assigned = 0;
    const allocs = Object.entries(weights).map(([pid, w]) => {
      const amt = round2(exp.amount * (Number(w) || 0) / totalW);
      assigned += amt;
      return { projectId: pid, amount: amt };
    });
    const diff = round2(exp.amount - assigned);
    if (diff !== 0 && allocs.length) allocs[0].amount = round2(allocs[0].amount + diff);
    return allocs;
  }
  return [];
}

function expenseTypeOf(exp, project) {
  return exp.capitalization === 'capitalize' ? 'capitalize' : 'expense';
}

/**
 * 分摊到目标项目的费用定型(P0-2 修复):
 *  直接费用(非共享)→ 按费用自身资本化标记(与项目一致);
 *  共享费用(工时分摊/自定义权重)→ 按分摊目标项目的资本化属性定型——
 *    分摊到资本化项目 → capitalize(进入该项目无形资产形成成本,可摊销);
 *    分摊到费用化项目 → expense(当期费用化,可直接加计,不产生"无法摊销"的悬空资本化)。
 */
function allocationType(exp, targetProject) {
  const shared = exp.isShared === true || exp.allocMethod === 'ratioHours' || exp.allocMethod === 'ratioCustom';
  if (!shared) return exp.capitalization === 'capitalize' ? 'capitalize' : 'expense';
  return targetProject && targetProject.capitalization === 'capitalize' ? 'capitalize' : 'expense';
}

/**
 * 生成辅助账(分项目),并附带分类/分月合计。
 * @returns {{projects: Array<{project, rows, monthlyTotals, categoryTotals, total}>, year: string}}
 */
function buildLedger({ projects, expenses, timesheets, amortizations, year }) {
  const yearStr = String(year);
  const projMap = {};
  projects.forEach(p => (projMap[p.id] = p));

  // 按项目收集行
  const byProject = {};
  (expenses || [])
    .filter(e => String(e.period || e.date || '').startsWith(yearStr))
    .forEach(exp => {
      const allocs = allocateExpense(exp, timesheets);
      allocs.forEach(a => {
        if (!byProject[a.projectId]) byProject[a.projectId] = [];
        byProject[a.projectId].push({
          date: exp.date || '',
          voucherNo: exp.voucherNo || '',
          summary: exp.summary || '',
          category: exp.category,
          categoryName: CATEGORY_MAP[exp.category] || exp.category,
          expenseType: allocationType(exp, projMap[a.projectId]), // P0-2:按分摊目标项目定型
          amount: a.amount,
          originalAmount: exp.amount,
          isAllocated: allocs.length > 1,
          allocNote: exp.allocNote || '',
        });
      });
    });

  // F3:仅有本年摊销、当年无费用分摊到达的资本化项目,也纳入辅助账(否则 A107012 行43 摊销在五件套内无载体)
  const amortOnlyIds = new Set();
  (amortizations || []).forEach(a => {
    if (String(a.year) !== yearStr) return;
    const p = projMap[a.projectId];
    if (!p || p.capitalization !== 'capitalize') return;
    if (byProject[a.projectId]) return; // 已有费用区块
    amortOnlyIds.add(a.projectId);
  });
  amortOnlyIds.forEach(pid => {
    if (!byProject[pid]) byProject[pid] = [];
  });

  const result = [];
  for (const [pid, rows] of Object.entries(byProject)) {
    // F3:仅摊销项目(当年无费用)→ 注入一条摊销行,使辅助账对平 A107012 行43
    if (!rows.length && amortOnlyIds.has(pid)) {
      const amortAmt = (amortizations || [])
        .filter(a => a.projectId === pid && String(a.year) === yearStr)
        .reduce((s, a) => s + (Number(a.amount) || 0), 0);
      rows.push({
        date: `${yearStr}-12-31`,
        voucherNo: '',
        summary: '本年形成无形资产摊销(业务合并填列,详见摊销台账)',
        category: 'amortization',
        categoryName: CATEGORY_MAP.amortization || '无形资产摊销',
        expenseType: 'capitalize', // 摊销属资本化部分
        amount: round2(amortAmt),
        originalAmount: round2(amortAmt),
        isAllocated: false,
        allocNote: '',
        isAmortOnly: true,
      });
    }
    rows.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const project = projMap[pid] || { id: pid, name: pid, code: '', form: 'self', status: '' };
    // 分月小计
    const monthlyTotals = {};
    rows.forEach(r => {
      const m = (r.date || '').slice(0, 7) || '未注明期间';
      monthlyTotals[m] = round2((monthlyTotals[m] || 0) + r.amount);
    });
    // 分类合计
    const categoryTotals = {};
    rows.forEach(r => {
      categoryTotals[r.categoryName] = round2((categoryTotals[r.categoryName] || 0) + r.amount);
    });
    // 费用化/资本化小计
    const expSum = rows.filter(r => r.expenseType === 'expense').reduce((s, r) => s + r.amount, 0);
    const capSum = rows.filter(r => r.expenseType === 'capitalize').reduce((s, r) => s + r.amount, 0);
    const total = round2(rows.reduce((s, r) => s + r.amount, 0));
    result.push({
      project,
      rows,
      monthlyTotals: Object.fromEntries(Object.entries(monthlyTotals).sort()),
      categoryTotals,
      expenseSum: round2(expSum),
      capitalizeSum: round2(capSum),
      total,
    });
  }
  return { projects: result, year: yearStr };
}

/** 仅用于导出与展示的辅助账汇总(全部项目合并) */
function ledgerGrandTotal(ledger) {
  return {
    expenseSum: round2(ledger.projects.reduce((s, p) => s + p.expenseSum, 0)),
    capitalizeSum: round2(ledger.projects.reduce((s, p) => s + p.capitalizeSum, 0)),
    total: round2(ledger.projects.reduce((s, p) => s + p.total, 0)),
  };
}

module.exports = { allocateExpense, buildLedger, ledgerGrandTotal, round2, expenseTypeOf, allocationType };
