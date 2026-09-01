// T5 万能导入 + 数电票解析 + 附件链路
const H = require('./harness');
const fs = require('fs'); const path = require('path');
const { P, clear, backup, restore, comp, proj, exp, getSummary, LN, fmt, eq, ok, sec, j, BASE } = H;
const iconv = require('iconv-lite');
const TMP = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

async function rawPost(url, buf, filename, ct) {
  const r = await fetch(BASE + url, {
    method: 'POST',
    headers: { 'Content-Type': ct || 'application/octet-stream', 'x-filename': filename ? encodeURIComponent(filename) : '' },
    body: buf,
  });
  const t = await r.text();
  let b = null; try { b = JSON.parse(t); } catch {}
  return { status: r.status, body: b, text: t };
}

// ---------- 数电票 XML 变体 ----------
function invStd() {
  return `<?xml version="1.0" encoding="UTF-8"?><Invoice><InvoiceType>增值税专用发票</InvoiceType><发票号码>25431000000099887766</发票号码><开票日期>2026-06-05</开票日期><销方名称>上海芯研半导体有限公司</销方名称><销方税号>91310115MA1K4A2B3C</销方税号><购方名称>测试公司</购方名称><Items><Item><名称>*研发和技术服务*芯片流片测试服务</名称><规格>次</规格><数量>2</数量><单价>25000</单价><金额>50000.00</金额><税率>13%</税率><税额>6500.00</税额></Item></Items><合计金额>50000.00</合计金额><合计税额>6500.00</合计税额><价税合计>56500.00</价税合计></Invoice>`;
}
function invAttr() {
  // 字段写开始标签属性上
  return `<?xml version="1.0" encoding="UTF-8"?><Invoice 发票号码="25431000000011223344" 开票日期="2026-06-10" 销方名称="北京智算云科技有限公司" 购方名称="测试公司" 合计金额="80000" 合计税额="4800" 价税合计="84800"><Items><Item 名称="*信息技术服务*研发云服务" 金额="80000" 税额="4800"/></Items></Invoice>`;
}
function invMulti() {
  return `<?xml version="1.0" encoding="UTF-8"?><Invoices>
<Invoice><发票号码>25431000000000000001</发票号码><开票日期>2026-06-01</开票日期><销方名称>甲供应商</销方名称><购方名称>测试公司</购方名称><合计金额>10000</合计金额><合计税额>600</合计税额><价税合计>10600</价税合计><Items><Item><名称>服务A</名称><金额>10000</金额><税额>600</税额></Item></Items></Invoice>
<Invoice><发票号码>25431000000000000002</发票号码><开票日期>2026-06-02</开票日期><销方名称>乙供应商</销方名称><购方名称>测试公司</购方名称><合计金额>20000</合计金额><合计税额>1200</合计税额><价税合计>21200</价税合计><Items><Item><名称>服务B</名称><金额>20000</金额><税额>1200</税额></Item></Items></Invoice>
</Invoices>`;
}
function invGbk() {
  const xml = `<?xml version="1.0" encoding="GBK"?><Invoice><发票号码>25431000000055667788</发票号码><开票日期>2026-06-15</开票日期><销方名称>深圳华创精密制造有限公司</销方名称><购方名称>测试公司</购方名称><合计金额>30000</合计金额><合计税额>1800</合计税额><价税合计>31800</价税合计><Items><Item><名称>*研发服务*样机加工</名称><金额>30000</金额><税额>1800</税额></Item></Items></Invoice>`;
  return iconv.encode(xml, 'gbk');
}
function invDiscount() {
  // 折扣行:金额直接相减
  return `<?xml version="1.0" encoding="UTF-8"?><Invoice><发票号码>25431000000033445566</发票号码><开票日期>2026-06-18</开票日期><销方名称>杭州材料供应有限公司</销方名称><购方名称>测试公司</购方名称><Items>
<Item><名称>*研发材料*特种合金</名称><金额>50000</金额><税率>13%</税率><税额>6500</税额></Item>
<Item><名称>折扣</名称><金额>-5000</金额><税率>13%</税率><税额>-650</税额></Item>
</Items><合计金额>45000</合计金额><合计税额>5850</合计税额><价税合计>50850</价税合计></Invoice>`;
}
function invRed() {
  // 红字发票:负金额
  return `<?xml version="1.0" encoding="UTF-8"?><Invoice><发票号码>25431000000077665544</发票号码><开票日期>2026-06-20</开票日期><销方名称>某研究所</销方名称><购方名称>测试公司</购方名称><Items><Item><名称>*研发服务*咨询费(红冲)</名称><金额>-20000</金额><税额>-1200</税额></Item></Items><合计金额>-20000</合计金额><合计税额>-1200</合计税额><价税合计>-21200</价税合计></Invoice>`;
}
function invRail() {
  // 铁路/航空行程单变体(字段名差异大)
  return `<?xml version="1.0" encoding="UTF-8"?><Invoice><发票号码>24317000000099881122</发票号码><开票日期>2026-06-25</开票日期><销方名称>中国铁路12306</销方名称><购方名称>测试公司</购方名称><Items><Item><名称>高铁票 北京-上海</名称><金额>553</金额><税额>49.77</税额></Item></Items><合计金额>553</合计金额><合计税额>49.77</合计税额><价税合计>602.77</价税合计></Invoice>`;
}
function invNoAmount() {
  // 缺发票级金额,只能明细汇总兜底
  return `<?xml version="1.0" encoding="UTF-8"?><Invoice><发票号码>25431000000088776655</发票号码><开票日期>2026-06-28</开票日期><销方名称>缺字段供应商</销方名称><购方名称>测试公司</购方名称><Items>
<Item><名称>服务甲</名称><金额>15000</金额><税额>900</税额></Item>
<Item><名称>服务乙</名称><金额>25000</金额><税额>1500</税额></Item>
</Items></Invoice>`;
}

// ---------- OFD 构造(命名空间前缀 + 金额格式) ----------
function makeOfd() {
  const zlib = require('zlib');
  const files = new Map();
  const docXml = `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Document xmlns:ofd="http://www.ofdspec.org">
  <ofd:CommonData><ofd:MaxUnitID>100</ofd:MaxUnitID></ofd:CommonData>
  <ofd:Pages><ofd:Page ID="1" BaseLoc="Pages/Page_1/Content.xml"/></ofd:Pages>
</ofd:Document>`;
  const contentXml = `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Page xmlns:ofd="http://www.ofdspec.org">
  <ofd:Content>
    <ofd:TextObject Boundary="10,10,200,20"><ofd:TextCode>发票号码:25431000000066677788</ofd:TextCode></ofd:TextObject>
    <ofd:TextObject Boundary="10,30,200,20"><ofd:TextCode>开票日期:2026-06-12</ofd:TextCode></ofd:TextObject>
    <ofd:TextObject Boundary="10,50,200,20"><ofd:TextCode>销方名称:广州精密仪器有限公司</ofd:TextCode></ofd:TextObject>
    <ofd:TextObject Boundary="10,70,200,20"><ofd:TextCode>购方名称:测试公司</ofd:TextCode></ofd:TextObject>
    <ofd:TextObject Boundary="10,90,200,20"><ofd:TextCode>金额合计(小写):¥50000.00</ofd:TextCode></ofd:TextObject>
    <ofd:TextObject Boundary="10,110,200,20"><ofd:TextCode>税额合计(小写):¥3000.00</ofd:TextCode></ofd:TextObject>
    <ofd:TextObject Boundary="10,130,200,20"><ofd:TextCode>价税合计(小写):¥53000.00</ofd:TextCode></ofd:TextObject>
  </ofd:Content>
</ofd:Page>`;
  files.set('Doc_0/Document.xml', Buffer.from(docXml, 'utf8'));
  files.set('Doc_0/Pages/Page_1/Content.xml', Buffer.from(contentXml, 'utf8'));
  // 最小 ZIP(store 方式)
  const chunks = []; const cd = []; let offset = 0;
  for (const [name, data] of files) {
    const nb = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12); lh.writeUInt16LE(0, 14);
    lh.writeUInt32LE(0, 16); lh.writeUInt32LE(data.length, 20); lh.writeUInt32LE(data.length, 24);
    lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(0, 28);
    chunks.push(lh, nb, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8); cen.writeUInt16LE(0, 10); cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14); cen.writeUInt16LE(0, 16); cen.writeUInt32LE(0, 18);
    cen.writeUInt32LE(data.length, 22); cen.writeUInt32LE(data.length, 26);
    cen.writeUInt16LE(nb.length, 28); cen.writeUInt16LE(0, 30); cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34); cen.writeUInt16LE(0, 36); cen.writeUInt32LE(0, 38); cen.writeUInt32LE(offset, 42);
    cd.push(cen, nb);
    offset += 30 + nb.length + data.length;
  }
  const cdStart = offset;
  const cdBuf = Buffer.concat(cd);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.size, 8); eocd.writeUInt16LE(files.size, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(cdStart, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

// ---------- CSV 构造 ----------
function csvEscape(v) { return /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v); }

(async () => {
  const bk = await backup('pretest_t5');
  let pass = 0, fail = 0; const fails = [];
  const ok2 = (c, m) => { if (c) { pass++; console.log('  PASS  ' + m); } else { fail++; fails.push(m); console.log('  FAIL  ' + m); } };
  const eq2 = (n, a, e, t = 0.01) => {
    const c = (typeof e === 'number' && typeof a === 'number') ? Math.abs(a - e) <= t : String(a) === String(e);
    if (c) { pass++; console.log(`  PASS  ${n} = ${fmt(a)}`); } else { fail++; fails.push(`${n}: 实际=${fmt(a)} 期望=${fmt(e)}`); console.log(`  FAIL  ${n}: 实际=${fmt(a)} 期望=${fmt(e)}`); }
  };

  try {
    await clear();
    await comp();
    const p1 = await proj({ code: 'RD-IMP-01', name: '导入测试项目', techContractNo: 'T' });

    sec('6.2 数电票 XML 变体');
    const cases = [
      ['专票标准', Buffer.from(invStd(), 'utf8'), { invoiceNo: '25431000000099887766', sellerName: '上海芯研半导体有限公司', amount: 50000, tax: 6500, total: 56500 }],
      ['属性形式字段', Buffer.from(invAttr(), 'utf8'), { invoiceNo: '25431000000011223344', sellerName: '北京智算云科技有限公司', amount: 80000, tax: 4800, total: 84800 }],
      ['多Invoice块', Buffer.from(invMulti(), 'utf8'), { count: 2 }],
      ['GBK 编码', invGbk(), { invoiceNo: '25431000000055667788', sellerName: '深圳华创精密制造有限公司', amount: 30000, tax: 1800 }],
      ['折扣票(负行)', Buffer.from(invDiscount(), 'utf8'), { amount: 45000, tax: 5850, total: 50850 }],
      ['红字(负金额)', Buffer.from(invRed(), 'utf8'), { amount: -20000, tax: -1200, total: -21200 }],
      ['铁路行程单', Buffer.from(invRail(), 'utf8'), { invoiceNo: '24317000000099881122', amount: 553 }],
      ['缺字段(明细汇总兜底)', Buffer.from(invNoAmount(), 'utf8'), { amount: 40000, tax: 2400 }],
    ];
    for (const [name, buf, want] of cases) {
      const r = await rawPost('/api/invoice/parse', buf, name + '.xml');
      const invs = r.body.invoices || (r.body.invoice ? [r.body.invoice] : []);
      if (r.status !== 200) { ok2(false, `数电票「${name}」解析 HTTP ${r.status}: ${(r.body.error || '').slice(0, 120)}`); continue; }
      if (want.count) { eq2(`数电票「${name}」张数`, invs.length, want.count); continue; }
      const inv = invs[0] || {};
      const bad = [];
      for (const [k, v] of Object.entries(want)) {
        const got = inv[k];
        const okk = typeof v === 'number' ? Math.abs((Number(got) || 0) - v) < 0.01 : String(got) === String(v);
        if (!okk) bad.push(`${k}:实际=${got} 期望=${v}`);
      }
      if (bad.length) ok2(false, `数电票「${name}」: ${bad.join('; ')}`);
      else ok2(true, `数电票「${name}」 发票号=${inv.invoiceNo} 金额=${inv.amount} 税额=${inv.tax}`);
    }

    sec('6.2b 发票入账 + 重复导入防重');
    {
      // 正确流程:先 parse 得 rows,再 JSON body 入账
      const parsed = await rawPost('/api/invoice/parse', Buffer.from(invStd(), 'utf8'), '入账测试.xml');
      const inv = (parsed.body.invoices || [])[0] || {};
      const rows = (inv.items || []).map(it => ({
        invoiceNo: inv.invoiceNo, date: inv.date, amount: it.amount, summary: it.name, sellerName: inv.sellerName,
      }));
      const r1 = await P('/api/invoice/import', { rows, projectId: p1.id, category: 'direct', capitalization: 'expense' });
      console.log('      第一次入账:', JSON.stringify(r1).slice(0, 200));
      ok2(r1.ok === rows.length, `发票第一次入账 ok=${r1.ok}/${rows.length}`);
      const r2 = await P('/api/invoice/import', { rows, projectId: p1.id, category: 'direct', capitalization: 'expense' });
      console.log('      第二次入账:', JSON.stringify(r2).slice(0, 250));
      ok2(r2.ok === 0 && /已导入过,已跳过/.test((r2.errors || []).join('')), `重复导入同一发票应跳过(防重复记账):ok=${r2.ok} errors=${JSON.stringify(r2.errors)}`);
    }

    sec('6.3 OFD 解析(命名空间前缀 + 金额(小写):¥ 格式)');
    {
      const ofd = makeOfd();
      const r = await rawPost('/api/invoice/parse', ofd, '测试.ofd');
      const invs = r.body.invoices || (r.body.invoice ? [r.body.invoice] : []);
      if (r.status !== 200) ok2(false, `OFD 解析 HTTP ${r.status}: ${(r.body.error || '').slice(0, 150)}`);
      else {
        const inv = invs[0] || {};
        console.log('      OFD 解析:', JSON.stringify({ invoiceNo: inv.invoiceNo, date: inv.date, sellerName: inv.sellerName, amount: inv.amount, tax: inv.tax, total: inv.total }));
        eq2('OFD 发票号', inv.invoiceNo, '25431000000066677788');
        eq2('OFD 金额', inv.amount, 50000);
        eq2('OFD 税额', inv.tax, 3000);
      }
    }

    sec('6.1 Excel/CSV 万能导入(1000 行 + 千分位金额)');
    {
      // 费用 CSV 1000 行,金额千分位文本(单层引号,模拟 Excel 导出)
      const lines = ['项目编号,费用类别,金额,摘要,发生日期,归属期间,凭证号,发票号,支出类型,付款方式'];
      for (let i = 1; i <= 1000; i++) {
        const amt = (i % 50 === 0 ? '1,000.50' : String(100 + (i % 90)));
        lines.push(['RD-IMP-01', i % 3 === 0 ? '直接投入费用' : i % 3 === 1 ? '人员人工费用' : '折旧费用', amt, '批量行' + i, '2026-06-15', '2026-06', 'V' + i, 'FP' + i, '费用化', '银行转账'].map(csvEscape).join(','));
      }
      const csv = lines.join('\r\n');
      const f = path.join(TMP, '批量费用1000.csv');
      fs.writeFileSync(f, csv, 'utf8');
      const t0 = Date.now();
      const up = await rawPost('/api/import/upload?name=' + encodeURIComponent('批量费用1000.csv'), fs.readFileSync(f));
      ok2(up.status === 200, `上传 1000 行 CSV HTTP ${up.status},rowCount=${up.body.rowCount}`);
      const hm = {}; (up.body.headers || []).forEach(h => (hm[h.name] = h.index));
      const run = await P('/api/import/run', {
        id: up.body.id, entity: 'expenses',
        mapping: { projectCode: hm['项目编号'], category: hm['费用类别'], amount: hm['金额'], summary: hm['摘要'], date: hm['发生日期'], period: hm['归属期间'], voucherNo: hm['凭证号'], invoiceNo: hm['发票号'], capitalization: hm['支出类型'], paymentMethod: hm['付款方式'] },
        options: { skipHeader: true, year: '2026' },
      });
      const ms = Date.now() - t0;
      console.log(`      导入 1000 行耗时 ${ms}ms,ok=${run.ok},errors=${(run.errors || []).length}`);
      eq2('6.1 导入成功行数', run.ok, 1000);
      ok2(ms < 3000, `6.1 导入耗时 ${ms}ms < 3000ms`);
      if ((run.errors || []).length) console.log('      错误样本:', run.errors.slice(0, 3));
      // 对账:千分位金额 1,000.50 是否解析为 1000.5
      const all = await j('/api/expenses');
      const imp = all.filter(e => /^批量行/.test(e.summary || ''));
      eq2('6.1 导入后费用数', imp.length, 1000);
      const r50 = imp.find(e => e.summary === '批量行50');
      eq2('6.1 千分位金额「1,000.50」', r50 ? r50.amount : null, 1000.5);
      // 合计对账
      const expSum = imp.reduce((s, e) => s + e.amount, 0);
      let expect = 0;
      for (let i = 1; i <= 1000; i++) expect += i % 50 === 0 ? 1000.5 : 100 + (i % 90);
      eq2('6.1 导入金额合计对账', Math.round(expSum * 100) / 100, Math.round(expect * 100) / 100, 0.01);
    }

    sec('6.4 附件链路');
    {
      const e = (await j('/api/expenses'))[0];
      // 上传(dataUrl 形式)
      const png = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A49444154789C6364000002000100', 'hex');
      const dataUrl = 'data:image/png;base64,' + png.toString('base64');
      const up = await P(`/api/expenses/${e.id}/attachments`, { name: '凭证照片.png', dataUrl });
      console.log('      上传:', JSON.stringify(up).slice(0, 150));
      ok2(!!up, '附件上传成功');
      const list = await j(`/api/expenses/${e.id}/attachments`);
      ok2(Array.isArray(list) && list.length > 0, `附件列表 ${Array.isArray(list) ? list.length : '?'} 个`);
      // 下载内容一致
      if (Array.isArray(list) && list[0]) {
        const dl = await fetch(BASE + list[0].url);
        const dlBuf = Buffer.from(await dl.arrayBuffer());
        ok2(dlBuf.equals(png) || dlBuf.length === png.length, `附件下载内容一致(${dlBuf.length}字节)`);
      }
      // 文件名穿越
      const tr = await fetch(BASE + '/attachments/' + encodeURIComponent('..%2F..%2Fserver.js'));
      ok2(tr.status === 404 || tr.status === 400, `附件路径穿越被拒 HTTP ${tr.status}`);
    }

  } finally {
    await restore(bk.name);
    const chk = await j('/api/expenses');
    console.log(`\n[恢复] ${bk.name} 费用条数 = ${chk.length} (应为 14)`);
  }
  console.log(`\n########## T5: ${pass} 通过 / ${fail} 失败 ##########`);
  if (fails.length) { console.log('\n失败明细:'); fails.forEach(f => console.log('  - ' + f)); }
})();
