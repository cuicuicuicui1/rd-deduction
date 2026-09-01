// Excel/CSV 导入 + 数电票解析 场景测试
const BASE = process.env.BASE || 'http://127.0.0.1:8765';
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const iconv = require('iconv-lite');

const TMP = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

let pass = 0, fail = 0; const fails = [];
function expect(name, got, want, extra) {
  const ok = Array.isArray(want) ? want.includes(got) : got === want;
  if (ok) { pass++; console.log(`[PASS] ${name} -> ${got}`); }
  else { fail++; fails.push(`${name}: 实际=${JSON.stringify(got)} 预期=${JSON.stringify(want)} ${extra || ''}`); console.log(`[FAIL] ${name} -> 实际=${JSON.stringify(got)} 预期=${JSON.stringify(want)} ${extra || ''}`); }
  return ok;
}
const sec = t => console.log('\n===== ' + t + ' =====');

async function api(method, p, body, isRaw) {
  const opt = { method, headers: {} };
  if (body !== undefined) { opt.headers['Content-Type'] = isRaw ? 'application/octet-stream' : 'application/json'; opt.body = isRaw ? body : JSON.stringify(body); }
  const res = await fetch(BASE + p, opt);
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { __raw: text.slice(0, 200) }; }
  return { status: res.status, body: json, text };
}

// ---------- 构造测试文件 ----------
async function makeExpenseXlsx() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('费用明细');
  ws.addRow(['项目名称', '费用类别', '金额', '摘要', '发生日期', '归属期间', '凭证号', '发票号', '支出类型', '付款方式']);
  ws.addRow(['智能焊接机器人控制系统研发', '直接投入费用', '￥12,345.67', '伺服驱动器采购', '2026/7/5', '2026-07', '记-2026-090', 'FP-2026-0901', '费用化', '银行转账']);
  ws.addRow(['智能焊接机器人控制系统研发', '人员人工费用', 88000, '研发人员7月工资', '2026-07-20', '2026-07', '记-2026-091', '', '费用化', '银行转账']);
  ws.addRow(['高精度伺服电机试制', '直接投入费用', 66000, '漆包线与硅钢片', '2026-07-12', '2026-07', '记-2026-092', 'FP-2026-0902', '资本化', '银行转账']);
  ws.addRow(['智能焊接机器人控制系统研发', '其他相关费用', 3000, '研发人员培训费', '2026-07-25', '2026-07', '记-2026-093', 'FP-2026-0903', '费用化', '银行转账']); // 应被关键词拦截
  ws.addRow(['不存在的项目', '直接投入费用', 5000, '错误项目引用', '2026-07-25', '2026-07', '记-2026-094', '', '费用化', '银行转账']); // 应报错
  ws.addRow(['智能焊接机器人控制系统研发', '折旧费用', 8000, '共用设备折旧', '2026-07-30', '2026-07', '记-2026-095', '', '费用化', '银行转账']);
  const f = path.join(TMP, '费用导入测试.xlsx');
  await wb.xlsx.writeFile(f);
  return f;
}

function makeStaffCsvGbk() {
  // 模拟国内 ERP 导出的 GBK 编码 CSV
  const rows = [
    ['姓名', '部门', '岗位', '入职日期', '是否直接研发'],
    ['张三', '研发部', '嵌入式工程师', '2024/3/1', '是'],
    ['李四', '生产部', '车间主任', '2020-01-15', '否'],
  ];
  const csv = rows.map(r => r.join(',')).join('\r\n');
  const f = path.join(TMP, '人员导入测试_GBK.csv');
  fs.writeFileSync(f, iconv.encode(csv, 'gbk'));
  return f;
}

async function makeTimesheetXlsx() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('工时');
  ws.addRow(['姓名', '项目编号', '月份', '研发工时', '总工时']);
  ws.addRow(['陈伟', '2026-RD-01', '2026-07', 160, 176]);
  ws.addRow(['林芳', '2026-RD-01', '2026年7月', 168, 176]); // 中文月份格式
  const f = path.join(TMP, '工时导入测试.xlsx');
  await wb.xlsx.writeFile(f);
  return f;
}

function makeInvoiceXml() {
  // 模拟电子税务局数电票 XML(中文标签)
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice>
  <InvoiceType>电子发票(普通发票)</InvoiceType>
  <发票号码>25422000000012345678</发票号码>
  <开票日期>2026-07-08</开票日期>
  <销方名称>苏州精工自动化设备有限公司</销方名称>
  <销方税号>91320500MA1MOCK23X</销方税号>
  <购方名称>恒达精密机械制造有限公司</购方名称>
  <购方税号>91330100MA26G0DEM1</购方税号>
  <Items>
    <Item>
      <名称>*研发和技术服务*嵌入式控制系统开发服务</名称>
      <规格>项</规格>
      <数量>1</数量>
      <单价>100000</单价>
      <金额>100000.00</金额>
      <税率>6%</税率>
      <税额>6000.00</税额>
    </Item>
  </Items>
  <合计金额>100000.00</合计金额>
  <合计税额>6000.00</合计税额>
  <价税合计>106000.00</价税合计>
  <备注>研发项目:2026-RD-01</备注>
</Invoice>`;
  const f = path.join(TMP, '数电票测试.xml');
  fs.writeFileSync(f, xml, 'utf8');
  return f;
}

(async () => {
  const projects = (await api('GET', '/api/projects')).body;
  const P1 = projects.find(p => p.code === '2026-RD-01');
  const P2 = projects.find(p => p.code === '2026-RD-02');

  sec('A. Excel 费用导入(中文类别名 / 2026\/7\/5 日期 / ￥12,345.67 金额)');
  const f1 = await makeExpenseXlsx();
  let r = await api('POST', '/api/import/upload?name=' + encodeURIComponent('费用导入测试.xlsx'), fs.readFileSync(f1), true);
  expect('A1 xlsx 上传解析', r.status, 200, r.body.error);
  if (r.status !== 200) { console.log(JSON.stringify(r.body)); process.exit(1); }
  console.log('      识别列:', r.body.headers.map(h => h.name).join(' | '));
  const id1 = r.body.id;
  const hmap = {}; r.body.headers.forEach(h => (hmap[h.name] = h.index));
  r = await api('POST', '/api/import/run', {
    id: id1, entity: 'expenses',
    mapping: {
      projectCode: hmap['项目名称'], category: hmap['费用类别'], amount: hmap['金额'],
      summary: hmap['摘要'], date: hmap['发生日期'], period: hmap['归属期间'],
      voucherNo: hmap['凭证号'], invoiceNo: hmap['发票号'], capitalization: hmap['支出类型'],
      paymentMethod: hmap['付款方式'],
    },
    options: { skipHeader: true, year: '2026' },
  });
  console.log('      导入结果:', JSON.stringify(r.body));
  expect('A2 导入成功行数(7行中3行合法)', r.body.ok, 5, JSON.stringify(r.body.errors));
  console.log('      报错行:', JSON.stringify(r.body.errors));

  // 校验金额与日期解析
  const all = (await api('GET', '/api/expenses')).body;
  const e1 = all.find(e => e.summary === '伺服驱动器采购');
  const e2 = all.find(e => e.summary === '研发人员7月工资');
  const e3 = all.find(e => e.summary === '漆包线与硅钢片');
  expect('A3 「￥12,345.67」金额解析', e1 ? e1.amount : null, 12345.67);
  expect('A4 「2026/7/5」日期规范化', e1 ? e1.date : null, '2026-07-05');
  expect('A5 中文类别名「直接投入费用」映射', e1 ? e1.category : null, 'direct');
  expect('A6 数字金额(88000)解析', e2 ? e2.amount : null, 88000);
  expect('A7 资本化识别', e3 ? e3.capitalization : null, 'capitalize');

  sec('B. GBK 编码 CSV 人员导入(国内 ERP 常见)');
  const f2 = makeStaffCsvGbk();
  r = await api('POST', '/api/import/upload?name=' + encodeURIComponent('人员导入测试_GBK.csv'), fs.readFileSync(f2), true);
  expect('B1 GBK CSV 上传', r.status, 200, r.body.error);
  console.log('      识别列(应正常显示中文):', r.body.headers.map(h => h.name).join(' | '));
  console.log('      样例行:', JSON.stringify(r.body.sampleRows));
  expect('B2 GBK 中文未乱码(姓名列)', r.body.headers[0].name, '姓名');
  const id2 = r.body.id;
  const hm2 = {}; r.body.headers.forEach(h => (hm2[h.name] = h.index));
  r = await api('POST', '/api/import/run', {
    id: id2, entity: 'staff',
    mapping: { name: hm2['姓名'], dept: hm2['部门'], role: hm2['岗位'], joinDate: hm2['入职日期'], isDirect: hm2['是否直接研发'] },
    options: { skipHeader: true },
  });
  console.log('      导入结果:', JSON.stringify(r.body));
  const staff = (await api('GET', '/api/staff')).body;
  const zs = staff.find(s => s.name === '张三');
  const ls = staff.find(s => s.name === '李四');
  expect('B3 张三「是否直接研发=是」', zs ? zs.isDirect : null, true);
  expect('B4 李四「是否直接研发=否」', ls ? ls.isDirect : null, false);
  expect('B5 「2024/3/1」入职日期规范化', zs ? zs.joinDate : null, '2024-03-01');

  sec('C. Excel 工时导入(检查 staffName 是否写入)');
  const f3 = await makeTimesheetXlsx();
  r = await api('POST', '/api/import/upload?name=' + encodeURIComponent('工时导入测试.xlsx'), fs.readFileSync(f3), true);
  expect('C1 工时 xlsx 上传', r.status, 200, r.body.error);
  const id3 = r.body.id;
  const hm3 = {}; r.body.headers.forEach(h => (hm3[h.name] = h.index));
  r = await api('POST', '/api/import/run', {
    id: id3, entity: 'timesheets',
    mapping: { staffName: hm3['姓名'], projectCode: hm3['项目编号'], period: hm3['月份'], rdHours: hm3['研发工时'], totalHours: hm3['总工时'] },
    options: { skipHeader: true },
  });
  console.log('      导入结果:', JSON.stringify(r.body));
  const ts = (await api('GET', '/api/timesheets')).body;
  const july = ts.filter(t => t.period === '2026-07');
  console.log('      7月工时记录:', JSON.stringify(july.map(t => ({ staffId: t.staffId, staffName: t.staffName, rd: t.rdHours, total: t.totalHours }))));
  expect('C2 Excel 导入的工时是否写了 staffName', july.length && july[0].staffName ? '有' : '缺失', '有');
  expect('C3 「2026年7月」月份格式是否被接受', july.length, 2, `实际导入 ${july.length} 条`);

  sec('D. 数电票 XML 解析');
  const f4 = makeInvoiceXml();
  r = await api('POST', '/api/invoice/parse', fs.readFileSync(f4), true);
  console.log('      解析结果:', JSON.stringify(r.body).slice(0, 600));
  expect('D1 数电票解析', r.status, 200, r.body.error);
  if (r.status === 200) {
    const inv = r.body.invoice || r.body.invoices && r.body.invoices[0] || r.body;
    console.log('      · 发票号 =', inv.invoiceNo, '| 销方 =', inv.sellerName, '| 金额 =', inv.amount, '| 税额 =', inv.tax, '| 价税合计 =', inv.total, '| 日期 =', inv.date);
    expect('D2 发票号码', inv.invoiceNo, '25422000000012345678');
    expect('D3 销方名称', inv.sellerName, '苏州精工自动化设备有限公司');
    expect('D4 不含税金额', inv.amount, 100000);
    expect('D5 税额', inv.tax, 6000);
  }

  sec('E. 清理测试数据');
  const delExp = all.filter(e => ['伺服驱动器采购', '研发人员7月工资', '漆包线与硅钢片', '共用设备折旧'].includes(e.summary));
  for (const e of delExp) await api('DELETE', '/api/expenses/' + e.id);
  for (const t of july) await api('DELETE', '/api/timesheets/' + t.id);
  if (zs) await api('DELETE', '/api/staff/' + zs.id);
  if (ls) await api('DELETE', '/api/staff/' + ls.id);
  console.log('      已清理临时数据');

  console.log('\n########## 导入测试汇总 ##########');
  console.log(`通过 ${pass} / 失败 ${fail}`);
  if (fails.length) { console.log('\n失败项:'); fails.forEach(f => console.log('  - ' + f)); }
})().catch(e => { console.error('脚本异常:', e); process.exit(1); });
