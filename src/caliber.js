// 加计扣除口径共享计算(单一口径来源)
// 目的:备查辅助账(ledger97)与申报口径(A107012/summary)必须使用同一套加计基数与境外2/3限额,
//       否则出现"辅助账显示限额 493,333.33、申报表却按 357,037.04"的脱节,经不起税务核查。
// 本函数精确镜像 src/summary.js computeSummary 的加计口径(2021年第28号公告第三条):
//   - 行2 = 前5类(费用化 + 已形成无形资产的资本化支出) + 其他费用限额内
//   - 未形成无形资产的资本化项目当年支出不计入当年限额基数与可加计基数
//   - 其他费用限额 = 前5类(费+已形成资) × 10% ÷ 90%
//   - 委托境外按 80% 计入,且不超过 境内可加计基数 × 2/3
// 交叉验证:tmp_final_recalc.js 会断言 ledger97.domesticBase === summary.domesticTotal、
//          cap2of3 === summary.entrustOverseasCap,防止两处口径再次漂移。
const { POLICIES, BASE_FIVE } = require('./constants');
const { allocateExpense, round2, allocationType } = require('./ledger');

function inScope(e, yearStr) {
  return String(e.period || e.date || '').startsWith(yearStr);
}

function excludedProjectIds(projects) {
  const set = new Set();
  (projects || []).forEach(p => {
    if (p.resultOwner === 'client' || p.form === 'entrust_overseas_person') set.add(p.id);
  });
  return set;
}

function formedCapProjects(amortizations, yearStr) {
  const set = new Set();
  (amortizations || []).forEach(a => {
    if (String(a.year) <= yearStr) set.add(a.projectId);
  });
  return set;
}

/**
 * 计算加计口径的境内可加计基数与境外2/3限额(供 ledger97 与 summary 共用)。
 * @returns {{ base5, base5CapF, otherActual, otherActualAll, otherLimit, otherDeductibleAll,
 *             otherDeductible, otherExcess, entrustDomesticOrg, entrustDomesticPerson, entrustDomCap80,
 *             domesticTotal, entrustOverseasRaw, entrustOverseasCap, entrustOverseas, entrustOverseasExcess }}
 */
function computeDeductionCaliber({ projects, expenses, timesheets, amortizations, year }) {
  const yearStr = String(year);
  const projMap = {};
  (projects || []).forEach(p => (projMap[p.id] = p));
  const excluded = excludedProjectIds(projects);

  // 归集池:费用化/资本化(资本化池含未形成项目,限额判定在 capIn 层做)
  const pool = { expense: {}, capitalize: {} };
  ['personnel', 'direct', 'depreciation', 'amortization', 'design', 'other',
    'entrust_domestic_org', 'entrust_domestic_person', 'entrust_overseas', 'entrust_overseas_person'].forEach(k => {
    pool.expense[k] = 0; pool.capitalize[k] = 0;
  });
  (expenses || [])
    .filter(e => !excluded.has(e.projectId) && projMap[e.projectId] && inScope(e, yearStr))
    .forEach(exp => {
      allocateExpense(exp, timesheets).forEach(a => {
        const eType = allocationType(exp, projMap[a.projectId]);
        pool[eType][exp.category] = round2((pool[eType][exp.category] || 0) + a.amount);
      });
    });

  const f = pool.expense;
  const base5 = round2(BASE_FIVE.reduce((s, k) => s + f[k], 0));
  // 已形成无形资产的资本化项目(存在 year<=当前年 摊销记录)
  const formed = formedCapProjects(amortizations, yearStr);
  // 计入限额基数的资本化支出:仅"已形成无形资产"资本化项目
  const capIn = { capitalize: {} };
  Object.keys(pool.capitalize).forEach(k => (capIn.capitalize[k] = 0));
  (expenses || [])
    .filter(e => !excluded.has(e.projectId) && projMap[e.projectId] && inScope(e, yearStr))
    .forEach(exp => {
      allocateExpense(exp, timesheets).forEach(a => {
        if (!projMap[a.projectId] || projMap[a.projectId].capitalization !== 'capitalize') return;
        if (!formed.has(a.projectId)) return;
        capIn.capitalize[exp.category] = round2(capIn.capitalize[exp.category] + a.amount);
      });
    });
  const base5CapF = round2(BASE_FIVE.reduce((s, k) => s + (capIn.capitalize[k] || 0), 0));
  const otherActual = f.other || 0;
  const otherActualAll = round2(otherActual + (capIn.capitalize.other || 0));
  const otherLimit = round2((base5 + base5CapF) * POLICIES.otherLimitRatio / (1 - POLICIES.otherLimitRatio));
  const otherDeductibleAll = round2(Math.min(otherActualAll, otherLimit));
  const otherDeductible = round2(Math.min(otherActual, otherLimit));
  const otherExcess = round2(otherActual - otherDeductible);

  const entrustDomesticOrg = round2((f.entrust_domestic_org || 0) * POLICIES.entrustDomesticRatio);
  const entrustDomesticPerson = round2((f.entrust_domestic_person || 0) * POLICIES.entrustDomesticRatio);
  const entrustDomCap80 = round2(((capIn.capitalize.entrust_domestic_org || 0) + (capIn.capitalize.entrust_domestic_person || 0)) * POLICIES.entrustDomesticRatio);
  const domesticTotal = round2(base5 + base5CapF + otherDeductibleAll + entrustDomesticOrg + entrustDomesticPerson + entrustDomCap80);

  const entrustOverseasRaw = round2((f.entrust_overseas || 0) * POLICIES.entrustOverseasRatio);
  const entrustOverseasCap = round2(domesticTotal * POLICIES.overseasCap);
  const entrustOverseas = round2(Math.min(entrustOverseasRaw, entrustOverseasCap));
  const entrustOverseasExcess = round2(entrustOverseasRaw - entrustOverseas);

  return {
    base5, base5CapF, otherActual, otherActualAll, otherLimit, otherDeductibleAll,
    otherDeductible, otherExcess, entrustDomesticOrg, entrustDomesticPerson, entrustDomCap80,
    domesticTotal, entrustOverseasRaw, entrustOverseasCap, entrustOverseas, entrustOverseasExcess,
  };
}

module.exports = { computeDeductionCaliber };
