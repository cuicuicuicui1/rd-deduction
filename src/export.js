// Excel 导出:2021版研发支出辅助账 + A107012申报参考汇总表
const ExcelJS = require('exceljs');
const { CATEGORY_MAP, PROJECT_FORMS } = require('./constants');
const { buildLedger, round2 } = require('./ledger');

const FORM_NAMES = Object.fromEntries(PROJECT_FORMS.map(f => [f.key, f.name]));
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
const SUB_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E2F3' } };
const WARN_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };

function thinBorder() {
  return {
    top: { style: 'thin' }, left: { style: 'thin' },
    bottom: { style: 'thin' }, right: { style: 'thin' },
  };
}

/** 导出研发支出辅助账(每个项目一个sheet,2021版样式要素) */
async function exportLedger({ projects, expenses, timesheets, amortizations, year }) {
  const ledger = buildLedger({ projects, expenses, timesheets, amortizations, year });
  const wb = new ExcelJS.Workbook();
  wb.creator = '研发费用加计扣除合规管理系统';
  wb.created = new Date();

  if (!ledger.projects.length) {
    const ws = wb.addWorksheet('空账');
    ws.addRow([`${year}年无费用数据`]);
    return wb;
  }

  for (const item of ledger.projects) {
    const p = item.project;
    const ws = wb.addWorksheet((p.code || p.id).replace(/[\\/:*?"<>|]/g, '_').slice(0, 28));
    ws.columns = [
      { width: 8 }, { width: 12 }, { width: 12 }, { width: 40 },
      { width: 18 }, { width: 10 }, { width: 14 }, { width: 24 },
    ];
    // 表头区
    ws.mergeCells('A1:H1');
    ws.getCell('A1').value = `研发支出辅助账(2021年版样式) — ${p.name}`;
    ws.getCell('A1').font = { bold: true, size: 14 };
    ws.getCell('A1').alignment = { horizontal: 'center' };
    ws.mergeCells('A2:H2');
    ws.getCell('A2').value = `项目编号:${p.code || '-'}   研发形式:${FORM_NAMES[p.form] || p.form}   项目期间:${p.startDate || '-'} ~ ${p.endDate || '-'}   年度:${year}`;
    ws.getCell('A2').font = { size: 10 };
    ws.mergeCells('A3:H3');
    ws.getCell('A3').value = `归集口径:费用化 ${item.expenseSum} 元 / 资本化 ${item.capitalizeSum} 元 / 合计 ${item.total} 元`;
    ws.getCell('A3').font = { size: 10, color: { argb: 'FF444444' } };

    const header = ['序号', '日期', '凭证号', '摘要', '费用类别', '支出类型', '金额(元)', '备注'];
    const hr = ws.addRow(header);
    hr.eachCell(c => {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      c.fill = HEADER_FILL;
      c.alignment = { horizontal: 'center', vertical: 'middle' };
      c.border = thinBorder();
    });

    let idx = 1;
    let lastMonth = '';
    for (const r of item.rows) {
      const m = (r.date || '').slice(0, 7);
      if (lastMonth && m !== lastMonth) {
        ws.addRow([]);
      }
      lastMonth = m;
      const row = ws.addRow([
        idx++, r.date || '', r.voucherNo || '', r.summary || '',
        r.categoryName, r.expenseType === 'capitalize' ? '资本化' : '费用化',
        r.amount, r.isAllocated ? `分摊后金额(原值${r.originalAmount})` : (r.allocNote || ''),
      ]);
      row.eachCell(c => {
        c.border = thinBorder();
        c.alignment = { vertical: 'middle' };
      });
      row.getCell(7).numFmt = '#,##0.00';
      if (r.expenseType === 'capitalize') {
        row.getCell(6).font = { color: { argb: 'FFC00000' } };
      }
    }

    // 分类合计
    ws.addRow([]);
    const catTitle = ws.addRow(['', '', '', '分类合计', '', '', '', '']);
    catTitle.eachCell(c => { c.fill = SUB_FILL; c.font = { bold: true }; });
    for (const [cat, amt] of Object.entries(item.categoryTotals)) {
      const row = ws.addRow(['', '', '', `  ${cat}`, '', '', amt, '']);
      row.eachCell(c => c.border = thinBorder());
      row.getCell(7).numFmt = '#,##0.00';
    }
    const totalRow = ws.addRow(['', '', '', '  合计', '', '', item.total, '']);
    totalRow.eachCell(c => { c.border = thinBorder(); c.font = { bold: true }; });
    totalRow.getCell(7).numFmt = '#,##0.00';
  }

  return wb;
}

/** 导出 A107012 申报参考汇总表(含限额计算明细) */
async function exportSummary({ company, projects, expenses, timesheets, amortizations, year, summary }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '研发费用加计扣除合规管理系统';

  // Sheet1: 参考表
  const ws = wb.addWorksheet('A107012参考');
  ws.columns = [{ width: 8 }, { width: 36 }, { width: 18 }, { width: 60 }];
  ws.mergeCells('A1:D1');
  ws.getCell('A1').value = `研发费用加计扣除优惠明细表(A107012)填报参考 — ${year}年度`;
  ws.getCell('A1').font = { bold: true, size: 13 };
  ws.getCell('A1').alignment = { horizontal: 'center' };
  if (company) {
    ws.mergeCells('A2:D2');
    ws.getCell('A2').value = `企业:${company.name}(${company.creditCode || '-'})  行业:${company.industry || '-'}  加计比例:100%(2023年7号公告)`;
    ws.getCell('A2').font = { size: 10 };
  }
  ws.addRow([]);
  const hr = ws.addRow(['行次', '项目', '金额(元)', '计算说明']);
  hr.eachCell(c => {
    c.fill = HEADER_FILL; c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.border = thinBorder(); c.alignment = { horizontal: 'center' };
  });
  for (const r of summary.rows) {
    const row = ws.addRow([r.line, r.name, r.amount, r.note]);
    row.eachCell(c => { c.border = thinBorder(); });
    row.getCell(3).numFmt = '#,##0.00';
  }
  ws.addRow([]);
  ws.addRow(['', '说明:本表为系统按现行政策自动计算,用于申报参考,最终以主管税务机关审核为准。']);

  // Sheet2: 计算明细
  const ws2 = wb.addWorksheet('限额计算明细');
  ws2.columns = [{ width: 42 }, { width: 18 }, { width: 60 }];
  const d = summary.detail;
  const items = [
    ['前5类费用合计(人员人工+直接投入+折旧+摊销+设计费)', d.base5, '加计基数'],
    ['其他相关费用实际发生额', d.otherActual, '受10%限额约束'],
    ['其他相关费用限额', d.otherLimit, `前5类合计 ${d.base5} × 10% ÷ 90%(2017年40号公告,全部项目合并计算)`],
    ['其他相关费用可扣除', d.otherDeductible, d.otherExcess > 0 ? `超限剔除 ${d.otherExcess}` : '未超限'],
    ['委托境内机构(×80%)', d.entrustDomesticOrg, '实际发生额 × 80%'],
    ['委托境内个人(×80%)', d.entrustDomesticPerson, '实际发生额 × 80%'],
    ['境内符合条件研发费用合计', d.domesticTotal, '前5类+其他可扣+委托境内'],
    ['委托境外按80%计入', d.entrustOverseasRaw, '实际发生额 × 80%'],
    ['委托境外2/3限额', d.entrustOverseasCap, `境内合计 ${d.domesticTotal} × 2/3`],
    ['委托境外可扣除', d.entrustOverseas, d.entrustOverseasExcess > 0 ? `超限剔除 ${d.entrustOverseasExcess}` : '未超限'],
    ['费用化加计基数合计', d.totalExpenseBase, '汇算清缴填报A107012'],
    ['费用化加计扣除额(×100%)', d.expenseAdd, '2023年7号公告'],
    ['资本化项目本年摊销额', d.amortAmount, '形成无形资产后按200%摊销'],
    ['本年摊销加计扣除额(×100%)', d.amortAdd, '摊销额 × 100%'],
    ['加计扣除额合计', d.totalAdd, '费用化加计 + 摊销加计'],
    ['本年资本化形成无形资产成本', d.capitalFormed, '计入无形资产,按200%摊销'],
  ];
  const hr2 = ws2.addRow(['项目', '金额(元)', '计算说明']);
  hr2.eachCell(c => { c.fill = HEADER_FILL; c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.border = thinBorder(); });
  for (const [name, amt, note] of items) {
    const row = ws2.addRow([name, amt, note]);
    row.eachCell(c => c.border = thinBorder());
    row.getCell(2).numFmt = '#,##0.00';
    if (name.includes('合计') || name.includes('加计扣除额合计')) {
      row.eachCell(c => c.font = { bold: true });
      row.getCell(1).fill = SUB_FILL;
    }
  }

  return wb;
}

/** 导出 A107012《研发费用加计扣除优惠明细表》官方表单 */
async function exportA107012({ company, year, a }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '研发费用加计扣除合规管理系统';
  wb.created = new Date();
  const ws = wb.addWorksheet('A107012');
  ws.columns = [{ width: 8 }, { width: 78 }, { width: 18 }, { width: 46 }];
  ws.mergeCells('A1:D1');
  ws.getCell('A1').value = 'A107012 研发费用加计扣除优惠明细表';
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.getCell('A1').alignment = { horizontal: 'center' };
  ws.mergeCells('A2:D2');
  ws.getCell('A2').value = `${company ? company.name : ''}    所属年度:${year}年    金额单位:元(列至角分)`;
  ws.getCell('A2').font = { size: 10 };
  ws.getCell('A2').alignment = { horizontal: 'center' };
  const hr = ws.addRow(['行次', '项目', '金额(数量)', '计算说明']);
  hr.eachCell(c => { c.fill = HEADER_FILL; c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.border = thinBorder(); c.alignment = { horizontal: 'center', vertical: 'middle' }; });
  for (const r of a.rows) {
    const row = ws.addRow([r.line, r.name, r.amount === '' ? '' : r.amount, r.note || '']);
    row.eachCell(c => { c.border = thinBorder(); c.alignment = { vertical: 'middle', wrapText: true }; });
    if (r.indent) row.getCell(2).alignment = { vertical: 'middle', wrapText: true, indent: r.indent };
    row.getCell(3).numFmt = '#,##0.00';
    if (r.bold) row.eachCell(c => { c.font = { bold: true }; c.fill = SUB_FILL; });
    if (r.amount === '') row.getCell(3).value = r.line === '50' ? a.ratio : '';
  }
  return wb;
}

/** 导出年度研发支出归集汇总表(97号公告附件5《"研发支出"辅助账汇总表》样式) */
async function exportYearlyCollection({ company, year, c }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '研发费用加计扣除合规管理系统';
  wb.created = new Date();
  const ws = wb.addWorksheet('辅助账汇总表');
  ws.columns = [
    { width: 6 }, { width: 16 }, { width: 26 }, { width: 12 }, { width: 10 }, { width: 8 },
    ...c.six.map(() => ({ width: 12 })), { width: 12 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 14 }, { width: 24 },
  ];
  ws.mergeCells('A1:M1');
  ws.getCell('A1').value = `"研发支出"辅助账汇总表(${year}年度)`;
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.getCell('A1').alignment = { horizontal: 'center' };
  ws.mergeCells('A2:M2');
  ws.getCell('A2').value = `${company ? company.name : ''}    金额单位:元(列至角分)    本表由企业留存备查`;
  ws.getCell('A2').font = { size: 10 };
  ws.getCell('A2').alignment = { horizontal: 'center' };
  const header = ['序号', '项目编号', '项目名称', '研发形式', '支出类型', '状态']
    .concat(c.six.map(s => s[1]), ['委托境内(×80%)', '委托境外(限额内)', '费用化合计', '资本化合计', '合计', '备注']);
  const hr = ws.addRow(header);
  hr.eachCell(cell => { cell.fill = HEADER_FILL; cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }; cell.border = thinBorder(); cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; });
  const FORM_NAMES_97 = { self: '自主研发', entrust_domestic_org: '委托境内机构', entrust_domestic_person: '委托境内个人', entrust_overseas: '委托境外机构', entrust_overseas_person: '委托境外个人', cooperation: '合作研发', centralized: '集中研发' };
  c.rows.forEach((r, i) => {
    const row = ws.addRow([i + 1, r.code, r.name, FORM_NAMES_97[r.form] || r.form, r.capitalization === 'capitalize' ? '资本化' : '费用化', r.status]
      .concat(c.six.map(s => r.six[s[0]]), [r.entrustDomestic, r.entrustOverseas, r.expenseSum, r.capitalizeSum, r.total, r.note]));
    row.eachCell(cell => { cell.border = thinBorder(); cell.alignment = { vertical: 'middle', wrapText: true }; });
    [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17].forEach(ci => { const cell = row.getCell(ci); cell.numFmt = '#,##0.00'; });
  });
  const t = ws.addRow(['', '', '合计', '', '', ''].concat(c.six.map(s => c.totals.six[s[0]]), [c.totals.entrustDomestic, c.totals.entrustOverseas, c.totals.expenseSum, c.totals.capitalizeSum, c.totals.total, '']));
  t.eachCell(cell => { cell.font = { bold: true }; cell.fill = SUB_FILL; cell.border = thinBorder(); });
  [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17].forEach(ci => t.getCell(ci).numFmt = '#,##0.00');
  ws.mergeCells('A3:W3');
  ws.getCell('A3').value = `口径说明:委托境内按发生额×80%计入;委托境外按发生额×80%且不超过境内可加计基数×2/3(${c.cap2of3})计入;其他相关费用按实际发生列示,10%限额调整见 A107012 第34行;境外委托合计加计基数 ${c.overseasTotalBase}${c.overseasTotalBase > c.cap2of3 ? ',超过限额,超出部分不得加计' : ',未超限额'}。`;
  ws.getCell('A3').font = { size: 9, color: { argb: 'FF444444' } };
  return wb;
}

/** 导出 97号公告四类辅助账(自主研发/委托/合作/集中,每类一个sheet,每项目一个区块) */
async function exportLedger97Workbook({ projects, expenses, timesheets, amortizations, year }) {
  const { buildLedger97 } = require('./ledger97');
  const l97 = buildLedger97({ projects, expenses, timesheets, amortizations, year });
  const wb = new ExcelJS.Workbook();
  wb.creator = '研发费用加计扣除合规管理系统';
  wb.created = new Date();
  const FORM97 = { self: '自主研发', entrust_domestic_org: '委托境内机构', entrust_domestic_person: '委托境内个人', entrust_overseas: '委托境外机构', entrust_overseas_person: '委托境外个人', cooperation: '合作研发', centralized: '集中研发' };
  const SIX6 = [['personnel', '一、人员人工'], ['direct', '二、直接投入'], ['depreciation', '三、折旧费用'], ['amortization', '四、无形资产摊销'], ['design', '五、新产品设计费等'], ['other', '六、其他相关']];

  const blockTitle = (ws, span, text) => {
    const r = ws.addRow([text]);
    ws.mergeCells(r.getCell(1).address + ':' + r.getCell(span).address);
    r.eachCell(c => { c.font = { bold: true, size: 11 }; c.fill = SUB_FILL; });
    return r;
  };
  const headerRow = (ws, cols) => {
    const r = ws.addRow(cols);
    r.eachCell(c => { c.fill = HEADER_FILL; c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.border = thinBorder(); c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; });
  };

  // 自主研发
  const ws1 = wb.addWorksheet('自主研发');
  ws1.columns = [{ width: 6 }, { width: 12 }, { width: 14 }, { width: 36 }, { width: 14 }, { width: 14 }, { width: 8 }, { width: 14 }]
    .concat(SIX6.map(() => ({ width: 13 })), [{ width: 20 }]);
  if (!l97.self.length) { ws1.addRow([`${year}年无自主研发项目数据`]); }
  l97.self.forEach(it => {
    blockTitle(ws1, 15, `${it.project.name}(${it.project.code || ''}) — 自主研发"研发支出"辅助账   支出类型:${it.project.capitalization === 'capitalize' ? '资本化' : '费用化'}   状态:${it.project.status || ''}`);
    headerRow(ws1, ['序号', '日期', '凭证种类及号数', '摘要', '借方金额', '贷方金额', '借或贷', '余额'].concat(SIX6.map(s => s[1]), ['备注']));
    it.rows.forEach(r => {
      const row = ws1.addRow([r.seq, r.date, r.voucherNo, r.summary, r.amount, '', '借', r.balance].concat(SIX6.map(s => (r.category === s[0] ? r.amount : '')), [r.isAllocated ? `分摊(原值${r.originalAmount})` : r.allocNote]));
      row.eachCell(c => { c.border = thinBorder(); c.alignment = { vertical: 'middle' }; });
      [5, 8, 9, 10, 11, 12, 13, 14].forEach(ci => row.getCell(ci).numFmt = '#,##0.00');
    });
    const tr = ws1.addRow(['', '', '', '借方合计', it.total, '', '', it.rows.length ? it.rows[it.rows.length - 1].balance : 0].concat(SIX6.map(s => it.six[s[0]]), ['']));
    tr.eachCell(c => { c.font = { bold: true }; c.fill = SUB_FILL; c.border = thinBorder(); });
    [5, 8, 9, 10, 11, 12, 13, 14].forEach(ci => tr.getCell(ci).numFmt = '#,##0.00');
    ws1.addRow(['']);
  });

  // 委托研发
  const ws2 = wb.addWorksheet('委托研发');
  ws2.columns = [{ width: 6 }, { width: 12 }, { width: 14 }, { width: 36 }, { width: 14 }, { width: 14 }, { width: 16 }, { width: 20 }];
  ws2.addRow(['委托研发加计口径:境内委托按实际发生额×80%计入;境外机构按×80%且不超过境内可加计基数×2/3计入;境外个人不得加计。']);
  if (!l97.entrust.length) { ws2.addRow([`${year}年无委托研发项目数据`]); }
  l97.entrust.forEach(it => {
    blockTitle(ws2, 8, `${it.project.name}(${it.project.code || ''}) — ${FORM97[it.entrustType] || it.entrustType}   状态:${it.project.status || ''}`);
    headerRow(ws2, ['序号', '日期', '凭证号', '摘要', '委托类型', '实际发生金额', '加计扣除基数(×80%)', '备注']);
    it.rows.forEach(r => {
      const row = ws2.addRow([r.seq, r.date, r.voucherNo, r.summary, FORM97[it.entrustType] || it.entrustType, r.amount, r.dedBase, r.isAllocated ? `分摊(原值${r.originalAmount})` : r.allocNote]);
      row.eachCell(c => { c.border = thinBorder(); c.alignment = { vertical: 'middle' }; });
      row.getCell(6).numFmt = '#,##0.00'; row.getCell(7).numFmt = '#,##0.00';
    });
    const tr = ws2.addRow(['', '', '', '合计', '', it.total, it.dedBase, it.isOverseas ? '境外委托(受境内×2/3限额)' : '']);
    tr.eachCell(c => { c.font = { bold: true }; c.fill = SUB_FILL; c.border = thinBorder(); });
    tr.getCell(6).numFmt = '#,##0.00'; tr.getCell(7).numFmt = '#,##0.00';
    ws2.addRow(['']);
  });

  // 合作/集中
  const shareSheet = (name, items, kind, label) => {
    const ws = wb.addWorksheet(name);
    ws.columns = [{ width: 6 }, { width: 12 }, { width: 14 }, { width: 36 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 20 }];
    ws.addRow([`${kind}:企业与合作方/集团成员共同投入,本企业分摊金额即本企业可加计金额。`]);
    if (!items.length) { ws.addRow([`${year}年无${kind}项目数据`]); }
    items.forEach(it => {
      blockTitle(ws, 8, `${it.project.name}(${it.project.code || ''}) — ${FORM97[it.project.form] || it.project.form}   状态:${it.project.status || ''}`);
      headerRow(ws, ['序号', '日期', '凭证号', '摘要', `${label}发生额`, '本企业分摊金额', '加计扣除基数', '备注']);
      it.rows.forEach(r => {
        const row = ws.addRow([r.seq, r.date, r.voucherNo, r.summary, r.isAllocated ? r.originalAmount : r.amount, r.amount, r.dedBase ?? r.amount, r.isAllocated ? `分摊(原值${r.originalAmount})` : r.allocNote]);
        row.eachCell(c => { c.border = thinBorder(); c.alignment = { vertical: 'middle' }; });
        [5, 6, 7].forEach(ci => row.getCell(ci).numFmt = '#,##0.00');
      });
      const tr = ws.addRow(['', '', '', '合计', it.total, it.total, it.dedBase ?? it.total, '']);
      tr.eachCell(c => { c.font = { bold: true }; c.fill = SUB_FILL; c.border = thinBorder(); });
      [5, 6, 7].forEach(ci => tr.getCell(ci).numFmt = '#,##0.00');
      ws.addRow(['']);
    });
  };
  shareSheet('合作研发', l97.cooperation, '合作研发', '合作研发费用');
  shareSheet('集中研发', l97.centralized, '集中研发', '集中研发费用');
  return wb;
}

async function toBuffer(wb) {
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

module.exports = { exportLedger, exportSummary, exportA107012, exportYearlyCollection, exportLedger97Workbook, toBuffer };
