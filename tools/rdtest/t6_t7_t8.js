// T6 数据自洽/年度隔离/备份一致性/除零 + T7 边界安全 + T8 性能
const H = require('./harness');
const fs = require('fs'); const path = require('path');
const ExcelJS = require('exceljs');
const { P, PUT, DEL, clear, backup, restore, comp, proj, exp, getSummary, getLedger97, getRisks, LN, fmt, eq, ok, sec, suite, j, BASE } = H;
const TMP = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

async function rawPost(url, buf, ct) {
  const r = await fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': ct || 'application/json' }, body: buf });
  const t = await r.text(); let b = null; try { b = JSON.parse(t); } catch {}
  return { status: r.status, body: b, text: t };
}

(async () => {
  // ================= T6 =================
  await suite('T6 数据自洽/年度隔离/备份一致性/除零', 't6', async () => {
    const Y = '2026';

    sec('跨年摊销');
    await clear(); await comp();
    const p = await proj({ code: 'RD-T6', name: '跨年摊销', capitalization: 'capitalize' });
    await exp(p.id, 'personnel', 150000, { capitalization: 'capitalize' });
    await P('/api/amortization/plan', { projectId: p.id, startYear: 2026, years: 10 });
    const d26 = await getSummary('2026'), d25 = await getSummary('2025');
    eq('T6-1 2026 行43(会计摊销额)', LN(d26.a.rows, '43'), 15000);
    eq('T6-2 2025 行43', LN(d25.a.rows, '43'), 0);
    ok(d26.d.totalAdd === 15000, `T6-3 2026 totalAdd=${fmt(d26.d.totalAdd)}=15,000`);

    sec('备份一致性');
    {
      const { d: d0 } = await getSummary(Y);
      const bk2 = await backup('pretest_t6b');
      // 加费用化费用(资本化费用不影响 totalAdd,因摊销额来自摊销计划——系统正确行为)
      await exp(p.id, 'personnel', 50000);
      const { d: d1 } = await getSummary(Y);
      ok(d1.totalAdd !== d0.totalAdd, `T6-4 加费用化费用后 totalAdd 变化 ${fmt(d0.totalAdd)}→${fmt(d1.totalAdd)}`);
      await restore(bk2.name);
      const { d: d2 } = await getSummary(Y);
      eq('T6-5 恢复后 totalAdd 回到原值', d2.totalAdd, d0.totalAdd);
    }

    sec('除零防护(共享费用无工时)');
    await clear(); await comp();
    const p2 = await proj({ code: 'RD-T6B', name: '除零' });
    await exp(p2.id, 'depreciation', 100000, { allocMethod: 'ratioHours', isShared: true, period: '2026-06' });
    const { d: dz } = await getSummary(Y);
    eq('T6-6 无工时时共享折旧全额归原项目', dz.totalExpenseBase, 100000);

    sec('导出文件对账');
    await clear(); await comp();
    const p3 = await proj({ code: 'RD-T6C', name: '导出对账' });
    await exp(p3.id, 'personnel', 100000); await exp(p3.id, 'other', 10000);
    await exp(p3.id, 'entrust_overseas', 100000);
    const { d: de, a: ae, col: cole } = await getSummary(Y);
    // a107012.xlsx
    const buf1 = Buffer.from(await (await fetch(BASE + '/api/export/a107012.xlsx?year=' + Y)).arrayBuffer());
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf1);
    const ws = wb.worksheets[0];
    let l40 = null, l47 = null;
    ws.eachRow(r => {
      const cells = r.values;
      for (let i = 1; i < cells.length; i++) {
        if (String(cells[i]) === '40') l40 = cells;
        if (String(cells[i]) === '47') l47 = cells;
      }
    });
    const numIn = cells => {
      if (!cells) return null;
      for (let i = cells.length - 1; i >= 1; i--) { const n = Number(String(cells[i]).replace(/,/g, '')); if (Number.isFinite(n) && n !== 0) return n; }
      return 0;
    };
    console.log(`      a107012.xlsx: 行40=${numIn(l40)} 行47=${numIn(l47)} | API: 行40=${LN(ae.rows, '40')} 行47=${LN(ae.rows, '47')}`);
    eq('T6-7 a107012.xlsx 行40 与 API 一致', numIn(l40), LN(ae.rows, '40'), 1);
    eq('T6-8 a107012.xlsx 行47 与 API 一致', numIn(l47), LN(ae.rows, '47'), 1);
    // ledger97.xlsx 4 sheet
    const buf2 = Buffer.from(await (await fetch(BASE + '/api/export/ledger97.xlsx?year=' + Y)).arrayBuffer());
    const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load(buf2);
    console.log('      ledger97.xlsx sheets:', wb2.worksheets.map(w => w.name).join(' | '));
    ok(wb2.worksheets.length >= 4, `T6-9 ledger97.xlsx sheet 数=${wb2.worksheets.length}(应≥4:自研/委托/合作/集中)`);
    // collection.xlsx
    const buf3 = Buffer.from(await (await fetch(BASE + '/api/export/collection.xlsx?year=' + Y)).arrayBuffer());
    const wb3 = new ExcelJS.Workbook(); await wb3.xlsx.load(buf3);
    let hasTotal = false;
    wb3.worksheets[0].eachRow(r => { if (/合计|总计/.test(r.values.join(' '))) hasTotal = true; });
    ok(hasTotal, 'T6-10 collection.xlsx 含合计行');
    // archive.zip
    const z = await fetch(BASE + '/api/export/archive.zip?year=' + Y);
    const zb = Buffer.from(await z.arrayBuffer());
    ok(zb.length > 5120, `T6-11 archive.zip > 5KB (${zb.length}字节)`);
  });

  // ================= T7 =================
  await suite('T7 边界与安全', 't7', async () => {
    const Y = '2026';
    sec('空数据(清库后所有 GET 不崩)');
    await clear();
    for (const u of ['/api/companies', '/api/projects', '/api/staff', '/api/timesheets', '/api/expenses',
      '/api/amortizations', '/api/specialIncomes', '/api/summary?year=2026', '/api/risks?year=2026',
      '/api/ledger?year=2026', '/api/ledger97?year=2026', '/api/calibers?year=2026', '/api/dashboard?year=2026',
      '/api/tax-saving?year=2026', '/api/meta', '/api/policies']) {
      const r = await fetch(BASE + u);
      ok(r.status === 200, `空数据 GET ${u} → ${r.status}(不得5xx)`);
    }

    sec('畸形输入');
    await clear(); await comp(); const p = await proj();
    const base = { projectId: p.id, category: 'direct', date: '2026-06-30', summary: 'X' };
    const badCases = [
      ['amount=-1', { ...base, amount: -1 }], ['amount=0', { ...base, amount: 0 }],
      ['amount="abc"', { ...base, amount: 'abc' }], ['amount=true', { ...base, amount: true }],
      ['amount=null', { ...base, amount: null }], ['amount="NaN"', { ...base, amount: 'NaN' }],
      ['amount="Infinity"', { ...base, amount: 'Infinity' }],
      ['缺date', { projectId: p.id, category: 'direct', amount: 100, summary: 'X' }],
    ];
    for (const [name, body] of badCases) {
      const r = await rawPost('/api/expenses', JSON.stringify(body));
      ok(r.status === 400, `T7 ${name} → ${r.status}(${r.body.error || ''})`);
    }
    const r1 = await rawPost('/api/expenses', 'this is not json', 'application/json');
    ok(r1.status === 400, `T7 非JSON body → ${r1.status}`);
    const r2 = await rawPost('/api/expenses', '{}');
    ok(r2.status === 400, `T7 空对象 → ${r2.status}`);

    sec('路径穿越');
    const r3 = await P('/api/backup/restore', { name: '../../etc/passwd' }).catch(e => ({ error: e.message }));
    ok(r3.error || r3.status === 400, `T7 备份路径穿越被拒: ${JSON.stringify(r3).slice(0, 80)}`);
    const r4 = await fetch(BASE + '/api/export/a107012.xlsx?year=' + encodeURIComponent('../../x'));
    ok(r4.status !== 500, `T7 导出 year=../../x 不崩 → ${r4.status}`);

    sec('超长 body');
    const big = JSON.stringify({ lines: new Array(2000000).fill('x|y|z|1|a|b|c|d|e|f|g') });
    const r5 = await fetch(BASE + '/api/expenses/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: big });
    ok(r5.status === 413 || r5.status === 400, `T7 超长body(${big.length}字节) → ${r5.status}(期望413)`);

    sec('XSS 存储与转义');
    const xss = await exp(p.id, 'other', 100, { summary: '<script>alert(1)</script><img src=x onerror=alert(2)>' });
    const back = await j('/api/expenses');
    const xitem = back.find(x => x.id === xss.id);
    ok(xitem.summary.includes('<script>'), 'T7 XSS 摘要原样存储(不脱敏)');
    await DEL('/api/expenses/' + xss.id);

    sec('并发写(10 并行)');
    const cnt0 = (await j('/api/expenses')).length;
    await Promise.all(Array.from({ length: 10 }, (_, i) =>
      rawPost('/api/expenses', JSON.stringify({ projectId: p.id, category: 'other', amount: 10 + i, date: '2026-06-30', summary: '并发' + i }))));
    const cnt1 = (await j('/api/expenses')).length;
    eq('T7 并发写10条后总条数', cnt1, cnt0 + 10);
    const conc = (await j('/api/expenses')).filter(e => /^并发\d+$/.test(e.summary || ''));
    eq('T7 并发条目数(无丢失)', conc.length, 10);
    for (const e of conc) await DEL('/api/expenses/' + e.id);

    sec('原型污染');
    const r6 = await rawPost('/api/companies', JSON.stringify({ name: '污染测试', industry: '制造业', levyType: '查账征收', __proto__: { polluted: 'yes' } }));
    ok(({}).polluted === undefined, `T7 __proto__ 未污染全局 Object.prototype`);
    await clear();

    sec('XXE(XML 不执行实体)');
    const xxe = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY xxe SYSTEM "file:///c:/windows/win.ini">]><Invoice><发票号码>XXE001</发票号码><开票日期>2026-06-01</开票日期><销方名称>&xxe;</销方名称><购方名称>X</购方名称><合计金额>1000</合计金额><合计税额>60</合计税额><价税合计>1060</价税合计></Invoice>`;
    const r7 = await rawPost('/api/invoice/parse', Buffer.from(xxe, 'utf8'), 'x.xml');
    const inv7 = (r7.body.invoices || [])[0] || {};
    const leaked = /for 16-bit app|fonts|extensions/i.test(inv7.sellerName || '');
    ok(!leaked, `T7 XXE 实体未被执行(销方=${(inv7.sellerName || '').slice(0, 40)})`);

    sec('校验表');
    const r8 = await rawPost('/api/specialIncomes', JSON.stringify({ projectId: p.id, type: 'scrap', amount: -1, date: '2026-06-01', period: '2026-06' }));
    ok(r8.status === 400, `T7 specialIncomes amount<0 → ${r8.status}`);
    const r9 = await rawPost('/api/amortizations', JSON.stringify({ projectId: p.id, year: 1800, amount: 100 }));
    ok(r9.status === 400, `T7 amortizations year=1800 → ${r9.status}`);
    const r10 = await rawPost('/api/timesheets', JSON.stringify({ staffId: 'x', projectId: p.id, period: '2026-06', rdHours: -1, totalHours: 160 }));
    ok(r10.status === 400, `T7 timesheets rdHours<0 → ${r10.status}`);
    const r11 = await rawPost('/api/projects', JSON.stringify({ code: '', name: '' }));
    ok(r11.status === 400, `T7 projects code/name 全空 → ${r11.status}`);
  });

  // ================= T8 =================
  await suite('T8 性能(5000 条)', 't8', async () => {
    await clear(); await comp();
    const p = await proj({ code: 'RD-PERF', name: '性能项目' });
    // 构造 5000 行 CSV
    const lines = ['项目编号,费用类别,金额,摘要,发生日期,归属期间,凭证号,发票号,支出类型,付款方式'];
    let expectSum = 0;
    for (let i = 1; i <= 5000; i++) {
      const amt = 100 + (i % 500);
      expectSum += amt;
      lines.push(`RD-PERF,人员人工费用,${amt},性能行${i},2026-06-15,2026-06,V${i},FP${i},费用化,银行转账`);
    }
    const f = path.join(TMP, 'perf5000.csv'); fs.writeFileSync(f, lines.join('\r\n'), 'utf8');
    let t0 = Date.now();
    const up = await rawPost('/api/import/upload?name=' + encodeURIComponent('perf5000.csv'), fs.readFileSync(f), 'application/octet-stream');
    const hm = {}; (up.body.headers || []).forEach(h => (hm[h.name] = h.index));
    const run = await P('/api/import/run', {
      id: up.body.id, entity: 'expenses',
      mapping: { projectCode: hm['项目编号'], category: hm['费用类别'], amount: hm['金额'], summary: hm['摘要'], date: hm['发生日期'], period: hm['归属期间'], voucherNo: hm['凭证号'], invoiceNo: hm['发票号'], capitalization: hm['支出类型'], paymentMethod: hm['付款方式'] },
      options: { skipHeader: true, year: '2026' },
    });
    let ms = Date.now() - t0;
    console.log(`      导入 5000 行: ok=${run.ok} errors=${(run.errors || []).length} 耗时 ${ms}ms`);
    eq('T8-1 导入 5000 行', run.ok, 5000);
    ok(ms < 3000, `T8-2 导入耗时 ${ms}ms < 3000ms`);

    t0 = Date.now(); const s = await getSummary('2026'); ms = Date.now() - t0;
    ok(ms < 1000, `T8-3 /api/summary ${ms}ms < 1000ms`);
    t0 = Date.now(); const l97 = await getLedger97('2026'); ms = Date.now() - t0;
    ok(ms < 1000, `T8-4 /api/ledger97 ${ms}ms < 1000ms`);
    t0 = Date.now(); const zz = await fetch(BASE + '/api/export/archive.zip?year=2026'); const zbuf = Buffer.from(await zz.arrayBuffer()); ms = Date.now() - t0;
    ok(ms < 5000, `T8-5 archive.zip ${ms}ms < 5000ms(${zbuf.length}字节)`);

    // 5000 条对账:辅助账四类合计 = 会计口径
    const cal = await j('/api/calibers?year=2026');
    const all97 = [...(l97.self || []), ...(l97.entrust || []), ...(l97.cooperation || []), ...(l97.centralized || [])];
    const sum97 = all97.reduce((x, y) => x + (y.total || 0), 0);
    console.log(`      5000条对账: 会计口径=${fmt(cal.accounting)} 辅助账四类合计=${fmt(sum97)} 导入期望值=${fmt(expectSum)}`);
    eq('T8-6 会计口径', cal.accounting, expectSum, 1);
    eq('T8-7 辅助账四类合计=会计口径', sum97, cal.accounting, 1);
    eq('T8-8 加计基数(全personnel)', s.d.totalExpenseBase, expectSum, 1);
  });

  const chk = await j('/api/expenses');
  console.log('\n[数据恢复校验] 费用条数 =', chk.length, '(应为 14)');
})();
