// 边界 / 异常 / 脏数据 场景测试
const BASE = process.env.BASE || 'http://127.0.0.1:8765';
let pass = 0, fail = 0;
const fails = [];

async function api(method, path, body, raw) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers['Content-Type'] = raw || 'application/json';
    opt.body = raw ? body : JSON.stringify(body);
  }
  const res = await fetch(BASE + path, opt);
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { __raw: text.slice(0, 200) }; }
  return { status: res.status, body: json, text, headers: res.headers };
}
function expect(name, got, want, extra) {
  const ok = Array.isArray(want) ? want.includes(got) : got === want;
  if (ok) { pass++; console.log(`[PASS] ${name} -> ${got}`); }
  else { fail++; fails.push(`${name}: 实际=${JSON.stringify(got)} 预期=${JSON.stringify(want)}${extra ? ' | ' + extra : ''}`); console.log(`[FAIL] ${name} -> 实际=${JSON.stringify(got)} 预期=${JSON.stringify(want)} ${extra || ''}`); }
  return ok;
}
function sec(t) { console.log('\n===== ' + t + ' ====='); }

(async () => {
  // 取得当前基础数据
  const projects = (await api('GET', '/api/projects')).body;
  const staff = (await api('GET', '/api/staff')).body;
  const P1 = projects.find(p => p.code === '2026-RD-01');
  const S1 = staff[0];

  sec('A. 费用录入校验(会计日常最容易录错的地方)');
  const base = { projectId: P1.id, category: 'direct', amount: 1000, date: '2026-07-10', summary: '测试材料' };
  let r;
  r = await api('POST', '/api/expenses', { ...base, amount: -5000, summary: '红字冲销测试' });
  expect('A1 负金额(红字冲销)应被拒绝', r.status, 400, r.body.error);

  r = await api('POST', '/api/expenses', { ...base, amount: 0 });
  expect('A2 零金额应被拒绝', r.status, 400, r.body.error);

  r = await api('POST', '/api/expenses', { ...base, amount: 'abc' });
  expect('A3 非数字金额应被拒绝', r.status, 400, r.body.error);

  r = await api('POST', '/api/expenses', { ...base, amount: null });
  expect('A4 null 金额应被拒绝', r.status, 400, r.body.error);

  r = await api('POST', '/api/expenses', { ...base, amount: true });
  expect('A5 布尔金额应被拒绝', r.status, 400, r.body.error);

  r = await api('POST', '/api/expenses', { ...base, category: '差旅费' });
  expect('A6 非法类别应被拒绝', r.status, 400, r.body.error);

  r = await api('POST', '/api/expenses', { ...base, summary: '研发人员外部培训费' });
  expect('A7 摘要含「培训」应被拦截', r.status, 400, r.body.error);

  r = await api('POST', '/api/expenses', { ...base, summary: '客户业务招待费' });
  expect('A8 摘要含「业务招待」应被拦截', r.status, 400, r.body.error);

  r = await api('POST', '/api/expenses', { ...base, summary: '研发厂房房租' });
  expect('A9 摘要含「房租」应被拦截', r.status, 400, r.body.error);

  r = await api('POST', '/api/expenses', { ...base, date: undefined });
  expect('A10 缺日期应被拒绝', r.status, 400, r.body.error);

  r = await api('POST', '/api/expenses', { ...base, date: '2026-13-45' });
  expect('A11 非法日期应被拒绝', r.status, 400, r.body.error);

  r = await api('POST', '/api/expenses', { ...base, date: '2026/07/10' });
  expect('A12 斜杠日期(常见录入习惯)', r.status, [201, 400], JSON.stringify(r.body).slice(0, 120));

  r = await api('POST', '/api/expenses', { ...base, projectId: 'not_exist' });
  expect('A13 不存在的项目ID', r.status, [201, 400], JSON.stringify(r.body).slice(0, 120));

  r = await api('POST', '/api/expenses', { ...base, period: undefined, summary: '自动补期间测试' });
  expect('A14 不传 period 应自动补 YYYY-MM', r.status, 201, JSON.stringify(r.body).slice(0, 150));
  if (r.status === 201) {
    expect('A14b 自动补的 period 正确', r.body.period, '2026-07');
    await api('DELETE', '/api/expenses/' + r.body.id);
  }

  r = await api('POST', '/api/expenses', { ...base, amount: 1e21, summary: '超大金额' });
  expect('A15 超大金额(1e21)', r.status, [201, 400], JSON.stringify(r.body).slice(0, 120));
  if (r.status === 201) await api('DELETE', '/api/expenses/' + r.body.id);

  sec('B. 工时台账校验');
  r = await api('POST', '/api/timesheets', { staffId: S1.id, staffName: S1.name, projectId: P1.id, period: '2026-07', rdHours: 200, totalHours: 176 });
  expect('B1 研发工时>总工时应被拒绝', r.status, [201, 400], JSON.stringify(r.body).slice(0, 150));
  if (r.status === 201) await api('DELETE', '/api/timesheets/' + r.body.id);

  r = await api('POST', '/api/timesheets', { staffId: S1.id, projectId: P1.id, period: '2026-07', rdHours: -10, totalHours: 176 });
  expect('B2 负工时', r.status, [201, 400], JSON.stringify(r.body).slice(0, 150));
  if (r.status === 201) await api('DELETE', '/api/timesheets/' + r.body.id);

  r = await api('POST', '/api/timesheets/batch', { lines: ['陈伟|2026-01|2026-RD-01|160|176'] });
  expect('B3 重复导入同一条工时(无去重)', r.body.ok, [1], JSON.stringify(r.body));
  if (r.body.ok === 1) {
    const ts = (await api('GET', '/api/timesheets')).body;
    const dup = ts.filter(t => t.staffName === '陈伟' && t.period === '2026-01');
    console.log('      · 陈伟 2026-01 现有工时分录数 =', dup.length, dup.length > 1 ? '<< 重复数据,会放大工时分摊比例' : '');
  }

  sec('C. 脏数据/孤儿记录(删除主数据后计算是否崩)');
  // 建一个临时项目+费用,然后删项目
  let tp = await api('POST', '/api/projects', { code: 'TMP-RD-99', name: '临时项目', form: 'self', capitalization: 'expense', startDate: '2026-01-01', endDate: '2026-12-31' });
  let te = await api('POST', '/api/expenses', { projectId: tp.body.id, category: 'direct', amount: 5000, date: '2026-07-01', summary: '临时费用' });
  await api('DELETE', '/api/projects/' + tp.body.id);
  r = await api('GET', '/api/summary?year=2026');
  expect('C1 删除项目后(费用成孤儿)汇总接口', r.status, 200, (r.body.error || '').slice(0, 150));
  r = await api('GET', '/api/ledger?year=2026');
  expect('C2 删除项目后辅助账接口', r.status, 200, (r.body.error || '').slice(0, 150));
  r = await api('GET', '/api/risks?year=2026');
  expect('C3 删除项目后风险接口', r.status, 200, (r.body.error || '').slice(0, 150));
  await api('DELETE', '/api/expenses/' + te.body.id);

  sec('D. 空年度 / 不存在年度');
  r = await api('GET', '/api/summary?year=2019');
  expect('D1 无数据年度 summary', r.status, 200);
  r = await api('GET', '/api/risks?year=2019');
  expect('D2 无数据年度 risks', r.status, 200);
  r = await api('GET', '/api/tax-saving?year=2019');
  expect('D3 无数据年度 tax-saving', r.status, 200);
  r = await api('GET', '/api/summary?year=abc');
  expect('D4 非法年度参数', r.status, 200, JSON.stringify(r.body).slice(0, 80));
  r = await api('GET', '/api/tax-saving?year=2026&income=abc');
  expect('D5 节税传入非数字所得额', r.status, 400, JSON.stringify(r.body).slice(0, 120));
  r = await api('GET', '/api/tax-saving?year=2026&income=-100');
  expect('D6 节税传入负所得额(亏损企业)', r.status, 200, JSON.stringify(r.body).slice(0, 150));

  sec('E. 导出接口(年底五件套)');
  const exports = [
    ['/api/export/ledger.xlsx?year=2026', '辅助账'],
    ['/api/export/summary.xlsx?year=2026', '申报参考'],
    ['/api/export/a107012.xlsx?year=2026', 'A107012'],
    ['/api/export/ledger97.xlsx?year=2026', '97号辅助账'],
    ['/api/export/collection.xlsx?year=2026', '年度归集汇总表'],
    ['/api/export/risks.html?year=2026', '风险报告'],
    ['/api/export/assets.csv?year=2026', '共用资源台账'],
  ];
  for (const [p, n] of exports) {
    const rr = await api('GET', p);
    const len = rr.text ? rr.text.length : 0;
    expect(`E 导出「${n}」`, rr.status, 200, `bytes=${len} ${(rr.body.error || '').slice(0, 100)}`);
  }
  const zip = await api('GET', '/api/export/archive.zip?year=2026');
  expect('E 备查资料包 zip', zip.status, 200, `bytes=${zip.text.length} ${(zip.body.error || '').slice(0, 100)}`);

  sec('F. 模板下载 / 元数据');
  for (const k of ['timesheets', 'expenses', 'staff']) {
    const rr = await api('GET', `/api/template/${k}?year=2026`);
    expect(`F 模板下载 ${k}`, rr.status, 200, `len=${rr.text.length}`);
  }
  r = await api('GET', '/api/meta');
  expect('F meta 接口', r.status, 200);
  r = await api('GET', '/api/policies');
  expect('F 政策库接口', r.status, 200);
  r = await api('GET', '/api/backups');
  expect('F 备份列表接口', r.status, 200);

  sec('G. 数值健壮性(直接写脏 JSON 入库后)');
  // 直接往 expenses.json 塞脏数据,看计算层会不会崩
  const fs = require('fs');
  const path = require('path');
  const DATA = path.join(__dirname, '..', '..', 'data');
  const ef = path.join(DATA, 'expenses.json');
  const orig = fs.readFileSync(ef, 'utf8');
  const arr = JSON.parse(orig);
  arr.push({ id: 'e_dirty1', projectId: P1.id, category: 'direct', amount: Number.NaN, date: '2026-08-01', period: '2026-08', capitalization: 'expense', allocMethod: 'direct' });
  arr.push({ id: 'e_dirty2', projectId: P1.id, category: 'direct', amount: 'not-a-number', date: '2026-08-02', period: '2026-08', capitalization: 'expense', allocMethod: 'direct' });
  arr.push({ id: 'e_dirty3', projectId: P1.id, category: 'unknown_cat', amount: 100, date: '2026-08-03', period: '2026-08', capitalization: 'expense', allocMethod: 'direct' });
  arr.push({ id: 'e_dirty4', projectId: P1.id, category: 'depreciation', amount: 1000, date: '2026-08-04', period: '2026-08', capitalization: 'expense', allocMethod: 'ratioHours' });
  fs.writeFileSync(ef, JSON.stringify(arr, null, 2), 'utf8');
  r = await api('GET', '/api/summary?year=2026');
  expect('G1 脏数据下 summary 不崩', r.status, 200, (r.body.error || '').slice(0, 150));
  if (r.status === 200) console.log('      · 加计基数 =', r.body.detail.totalExpenseBase);
  r = await api('GET', '/api/risks?year=2026');
  expect('G2 脏数据下 risks 不崩', r.status, 200, (r.body.error || '').slice(0, 150));
  fs.writeFileSync(ef, orig, 'utf8');

  console.log('\n########## 边界测试汇总 ##########');
  console.log(`通过 ${pass} / 失败 ${fail}`);
  if (fails.length) { console.log('\n失败项:'); fails.forEach(f => console.log('  - ' + f)); }
})().catch(e => { console.error('脚本异常:', e); process.exit(1); });
