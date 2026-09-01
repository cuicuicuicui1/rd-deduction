// 报告与数据文件生成:风险自检报告 HTML(可打印)、CSV 数据文件
// 供「备查资料包 zip」与「/api/export/risks.html」复用
const { CATEGORY_MAP, POLICIES } = require('./constants');

const LEVEL_TEXT = { error: '红', warning: '黄', info: '绿' };
const LEVEL_CLS = { error: 'red', warning: 'yellow', info: 'green' };

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmt(n) {
  return (Number(n) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * 风险自检报告(完整 HTML 文档,可直接打印/存 PDF)
 * @param {object} opts { company, year, risks, counts, snapshot }
 * snapshot 可选字段(均可不传,自动降级为 '-'):
 *   accounting 研发费用合计(会计口径)、deductionBase 费用化加计扣除基数、amortAmount 资本化本年摊销、
 *   totalAdd 加计扣除额合计、taxSaving 预计节税额、taxRateNote 税率说明、
 *   entrustDomestic 委托境内×80%计入、entrustOverseas 委托境外(限额内)、
 *   otherDeductible 其他相关费用(限额内)、otherLimit 其他相关费用限额、specialIncome 特殊收入冲减、
 *   categoryTable [{ name, amount }] 六大类费用构成(附录)
 */
function riskReportHtml({ company, year, risks, counts, snapshot }) {
  const c = company || {};
  const total = counts.error + counts.warning + counts.info;
  const snap = snapshot || {};
  const f = v => (v === undefined || v === null || v === '') ? '-' : fmt(v);

  // ---- 关键指标快照 ----
  const kpiCells = [
    ['研发费用合计(会计口径)', f(snap.accounting)],
    ['费用化加计扣除基数', f(snap.deductionBase)],
    ['资本化本年摊销额', f(snap.amortAmount)],
    ['加计扣除额合计', f(snap.totalAdd)],
  ].map(([k, v]) => `<div class="kpi"><div class="kpi-k">${esc(k)}</div><div class="kpi-v">${v}</div></div>`).join('');
  const taxCell = snap.taxSaving !== undefined && snap.taxSaving !== null && snap.taxSaving !== ''
    ? `<div class="kpi tax"><div class="kpi-k">预计节税额(按${esc(snap.taxRateNote || '25%')})</div><div class="kpi-v">${fmt(snap.taxSaving)}</div></div>`
    : '';
  const snapHtml = (snap.accounting !== undefined || snap.totalAdd !== undefined)
    ? `${snap.eligible === false ? `<div class="warn">⚠ 本年度不得享受研发费用加计扣除 — ${esc(snap.ineligibleReason || '')}。以下加计口径均按 0 填报;会计口径与辅助账仍正常留档。</div>` : ''}
  <h2>关键指标快照(${year}年度)</h2>
  <div class="kpis">${kpiCells}${taxCell}</div>
  <table class="lim">
    <tr><th>口径明细</th><th>金额(元)</th><th>说明</th></tr>
    <tr><td>其他相关费用(限额内计入)</td><td>${f(snap.otherDeductible)}</td><td>不超过前5类×10%÷90%</td></tr>
    <tr><td>其他相关费用限额</td><td>${f(snap.otherLimit)}</td><td>前5类费用×10%÷90%</td></tr>
    <tr><td>委托境内机构/个人研发</td><td>${f(snap.entrustDomestic)}</td><td>按实际发生额80%计入</td></tr>
    <tr><td>委托境外研发(限额内)</td><td>${f(snap.entrustOverseas)}</td><td>×80%且≤境内研发×2/3</td></tr>
    <tr><td>特殊收入冲减</td><td>${f(snap.specialIncome)}</td><td>下脚料/残次品/试制品收入,冲减可加计费用</td></tr>
  </table>`
    : '';

  // ---- 按红/黄/绿分级分组 ----
  const groups = [
    ['error', '红 · 阻断项', '必须整改,否则本年度不得享受加计扣除'],
    ['warning', '黄 · 预警项', '存在合规风险,建议尽快整改并留存证据'],
    ['info', '绿 · 提示项', '提示信息,用于完善备查资料'],
  ];
  const groupHtml = groups.map(([lvl, title, sub]) => {
    const list = (risks || []).filter(r => r.level === lvl).map(r => `
    <div class="item ${LEVEL_CLS[lvl]}">
      <div class="head"><span class="tag ${LEVEL_CLS[lvl]}">${LEVEL_TEXT[lvl]}</span>
        <b>${esc(r.title)}</b><span class="code">${esc(r.code)}</span></div>
      <div class="detail">${esc(r.detail)}</div>
      <div class="sug">建议:${esc(r.suggestion)}</div>
      <div class="basis">政策依据:${esc(r.basis)}</div>
    </div>`).join('');
    return `<h2>${title}<span class="cnt">${counts[lvl] || 0}</span></h2>
  <div class="gsub">${sub}</div>
  ${list || '<div class="empty">未检测到该项风险 ✓</div>'}`;
  }).join('');

  // ---- 附录:研发费用构成(六大类 + 委托,会计口径) ----
  const cats = snap.categoryTable || [];
  const catRows = [...cats];
  if (snap.entrustDomesticRaw !== undefined && Number(snap.entrustDomesticRaw) !== 0) {
    catRows.push({ name: '委托境内机构/个人研发(实际发生额)', amount: Number(snap.entrustDomesticRaw) || 0 });
  }
  if (snap.entrustOverseasRaw !== undefined && Number(snap.entrustOverseasRaw) !== 0) {
    catRows.push({ name: '委托境外研发(实际发生额)', amount: Number(snap.entrustOverseasRaw) || 0 });
  }
  const catTotal = catRows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const catHtml = cats.length ? `
  <h2>附录:研发费用构成(会计口径)</h2>
  <table class="cat">
    <tr><th>费用类别</th><th>金额(元)</th><th>占比</th></tr>
    ${catRows.map(r => `<tr><td>${esc(r.name)}</td><td>${fmt(r.amount)}</td><td>${catTotal ? ((Number(r.amount) || 0) / catTotal * 100).toFixed(1) + '%' : '-'}</td></tr>`).join('')}
    <tr class="tot"><td>合计(六类+委托实际发生额)</td><td>${fmt(catTotal)}</td><td>100%</td></tr>
  </table>
  <div class="meta">注:本表为会计口径构成(自主研发/合作/集中六大类 + 委托,含分摊、已冲减特殊收入);委托按实际发生额列示,加计口径的×80%与境外2/3限额另见上方「口径明细」表。若合计与「研发费用合计(会计口径)」不一致,差额为特殊收入冲减额(共 ${f(snap.specialIncome)} 元)。</div>` : '';

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<title>研发费用加计扣除风险自检报告 ${year}年度</title>
<style>
  body{font-family:"Microsoft YaHei",sans-serif;margin:32px;color:#1e293b;font-size:14px}
  h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;border-left:4px solid #4472c4;padding-left:8px;margin:22px 0 6px}
  h2 .cnt{color:#94a3b8;font-size:13px;margin-left:6px}
  .gsub{color:#64748b;font-size:12px;margin:0 0 8px}
  .meta{color:#64748b;font-size:12px;margin:6px 0}
  .summary{display:flex;gap:12px;margin:14px 0;flex-wrap:wrap}
  .pill{border:1px solid #cbd5e1;border-radius:99px;padding:4px 14px;font-size:13px}
  .pill.red{color:#b91c1c;border-color:#fecaca;background:#fef2f2}
  .pill.yellow{color:#a16207;border-color:#fde68a;background:#fffbeb}
  .pill.green{color:#15803d;border-color:#bbf7d0;background:#f0fdf4}
  .item{border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px;margin:8px 0;page-break-inside:avoid}
  .item.red{border-left:4px solid #dc2626}.item.yellow{border-left:4px solid #eab308}.item.green{border-left:4px solid #16a34a}
  .head{display:flex;align-items:center;gap:8px}
  .tag{font-size:12px;padding:1px 8px;border-radius:99px;color:#fff}
  .tag.red{background:#dc2626}.tag.yellow{background:#eab308}.tag.green{background:#16a34a}
  .code{color:#94a3b8;font-size:11px}
  .detail{margin:6px 0 4px}.sug{color:#475569}.basis{color:#94a3b8;font-size:12px;margin-top:4px}
  .empty{color:#94a3b8;font-size:13px;padding:6px 0}
  .warn{background:#fef2f2;border:1px solid #fca5a5;border-left:4px solid #dc2626;color:#991b1b;padding:10px 14px;border-radius:8px;margin:10px 0;font-size:13px}
  .kpis{display:flex;gap:12px;flex-wrap:wrap;margin:10px 0}
  .kpi{border:1px solid #cbd5e1;border-radius:10px;padding:10px 16px;min-width:150px;background:#f8fafc}
  .kpi .kpi-k{color:#64748b;font-size:12px}.kpi .kpi-v{font-size:20px;font-weight:700;margin-top:4px}
  .kpi.tax{border-color:#86efac;background:#f0fdf4}.kpi.tax .kpi-v{color:#15803d}
  table{width:100%;border-collapse:collapse;margin:8px 0 14px;font-size:13px}
  th,td{border:1px solid #e2e8f0;padding:6px 10px;text-align:left}
  th{background:#f1f5f9}
  table.lim td:nth-child(2),table.cat td:nth-child(2),table.cat td:nth-child(3){text-align:right;font-variant-numeric:tabular-nums}
  table.cat tr.tot td{font-weight:700;background:#f8fafc}
  .foot{margin-top:26px;color:#94a3b8;font-size:11px;border-top:1px solid #e2e8f0;padding-top:8px}
  @media print{body{margin:12px}.item,.kpi{page-break-inside:avoid}}
</style></head><body>
  <h1>研发费用加计扣除风险自检报告</h1>
  <div class="meta">企业:${esc(c.name || '未设置')} · 行业:${esc(c.industry || '-')} · 征收方式:${esc(c.levyType || '-')} · 年度:${year} · 生成时间:${new Date().toLocaleString('zh-CN')}</div>
  <div class="summary">
    <span class="pill red">红 ${counts.error} · 阻断</span>
    <span class="pill yellow">黄 ${counts.warning} · 预警</span>
    <span class="pill green">绿 ${counts.info} · 提示</span>
    <span class="pill">共 ${total} 项</span>
  </div>
  <div class="meta">说明:本报告由系统按现行政策(财税〔2015〕119号、2015年97号、2017年40号、财税〔2018〕64号、2023年7号公告)自动检测,仅供内部自检参考。</div>
  ${snapHtml}
  <h2>风险明细</h2>
  ${groupHtml}
  ${catHtml}
  <div class="foot">本报告由「研发费用加计扣除合规管理系统」生成 · 留存备查期限 ${POLICIES.retentionYears} 年</div>
</body></html>`;
}

/** 通用 CSV(带 BOM,Excel 直接打开中文不乱码) */
function csvRows(header, rows) {
  const q = v => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return '\uFEFF' + [header, ...rows].map(r => r.map(q).join(',')).join('\r\n');
}

/** 费用明细 CSV(按年度过滤) */
function expensesCsv(expenses, projects) {
  const proj = Object.fromEntries((projects || []).map(p => [p.id, p]));
  const rows = (expenses || []).map(e => [
    e.date || '', proj[e.projectId]?.code || '', proj[e.projectId]?.name || '',
    CATEGORY_MAP[e.category] || e.category, e.summary || '', e.amount,
    e.capitalization === 'capitalize' ? '资本化' : '费用化',
    e.voucherNo || '', e.invoiceNo || '', e.contractNo || '', e.paymentMethod || '', e.period || '',
  ]);
  return csvRows(['日期', '项目编号', '项目名称', '费用类别', '摘要', '金额(元)', '支出类型', '凭证号', '发票号', '合同号', '付款方式', '归属期间'], rows);
}

function staffCsv(staff) {
  const rows = (staff || []).map(s => [s.name || '', s.dept || '', s.role || '', s.joinDate || '', s.isDirect ? '直接从事研发' : '非直接']);
  return csvRows(['姓名', '部门', '岗位', '入职日期', '研发属性'], rows);
}

function timesheetsCsv(timesheets, staff, projects) {
  const sm = Object.fromEntries((staff || []).map(s => [s.id, s]));
  const pm = Object.fromEntries((projects || []).map(p => [p.id, p]));
  const rows = (timesheets || []).map(t => [
    t.period || '', sm[t.staffId]?.name || t.staffName || '', sm[t.staffId]?.dept || '',
    pm[t.projectId]?.code || '', pm[t.projectId]?.name || '', t.rdHours ?? '', t.totalHours ?? '',
  ]);
  return csvRows(['月份', '人员', '部门', '项目编号', '项目名称', '研发工时(小时)', '总工时(小时)'], rows);
}

/** 特殊收入冲减 CSV(按年度过滤) */
function specialIncomesCsv(specialIncomes, projects) {
  const pm = Object.fromEntries((projects || []).map(p => [p.id, p]));
  const rows = (specialIncomes || []).map(si => [
    si.date || '', si.period || '', pm[si.projectId]?.code || '', pm[si.projectId]?.name || '',
    si.type === 'scrap' ? '下脚料' : si.type === 'defective' ? '残次品' : si.type === 'trial' ? '试制品' : si.type || '',
    si.amount ?? '', si.summary || si.note || '',
  ]);
  return csvRows(['日期', '归属期间', '项目编号', '项目名称', '类型', '金额(元)', '说明'], rows);
}

/** 个税申报名单 CSV(按年度过滤) */
function taxrollCsv(taxroll, staff) {
  const sm = Object.fromEntries((staff || []).map(s => [s.id, s]));
  const rows = (taxroll || []).map(t => [t.year || '', sm[t.staffId]?.name || t.staffName || '', sm[t.staffId]?.dept || '']);
  return csvRows(['年度', '姓名', '部门'], rows);
}

/** 共用资源分摊台账 CSV(备查:共用设备/厂房/云服务按工时分摊依据) */
const ASSET_TYPE = { equipment: '设备', cloud: '云服务/软件', building: '厂房/场地', utility: '水电燃气', other: '其他' };
function assetsCsv(assets) {
  const rows = (assets || []).map(a => {
    const rd = Number(a.rdHours) || 0;
    const tot = Number(a.totalHours) || 0;
    const ratio = tot > 0 ? rd / tot : 0;
    const cost = Number(a.depreciation) || 0;
    return [
      a.name || '', ASSET_TYPE[a.type] || a.type || '', cost, rd, tot,
      (ratio * 100).toFixed(1) + '%', Math.round(cost * ratio * 100) / 100, a.note || '',
    ];
  });
  return csvRows(
    ['资源名称', '类型', '年度费用(折旧/租金/使用费,元)', '研发使用工时(小时)', '总使用工时(小时)', '研发占比', '计入研发费用分摊额(元)', '备注'],
    rows);
}

module.exports = { riskReportHtml, expensesCsv, staffCsv, timesheetsCsv, specialIncomesCsv, taxrollCsv, assetsCsv };
