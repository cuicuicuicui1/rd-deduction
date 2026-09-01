// 前端 UI 渲染测试(jsdom):逐个切换全部功能页,捕获 JS 运行时错误与渲染异常
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const BASE = 'http://127.0.0.1:8765';
const errors = [];
const warns = [];

const TABS = [
  ['dashboard', '概览'],
  ['company', '企业设置'],
  ['projects', '研发项目'],
  ['staff', '人员与工时'],
  ['expenses', '费用归集'],
  ['assets', '共用资源'],
  ['import', 'Excel导入'],
  ['ledger', '辅助账'],
  ['summary', '申报汇总'],
  ['risks', '风险自检'],
  ['checklist', '备查清单'],
  ['policy', '政策库'],
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const appjs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push('[jsdomError] ' + (e.detail ? e.detail.message + '\n' + (e.detail.stack || '').split('\n').slice(0, 4).join('\n') : e.message)));
  vc.on('error', (...a) => errors.push('[console.error] ' + a.map(String).join(' ').slice(0, 300)));
  vc.on('warn', (...a) => warns.push('[console.warn] ' + a.map(String).join(' ').slice(0, 200)));

  const dom = new JSDOM(html, {
    url: BASE + '/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const win = dom.window;

  // 注入网络层:把相对路径解析到真实服务
  win.fetch = (p, opts) => fetch(new URL(p, BASE), opts);
  win.Headers = Headers; win.Request = Request; win.Response = Response;
  // 交互类 API 兜底
  win.confirm = () => true;
  win.alert = () => {};
  win.prompt = () => null;
  win.open = () => null;
  if (!win.URL.createObjectURL) win.URL.createObjectURL = () => 'blob:mock';
  if (!win.URL.revokeObjectURL) win.URL.revokeObjectURL = () => {};

  win.addEventListener('error', e => errors.push('[window.error] ' + (e.message || '') + ' @ ' + (e.filename || '') + ':' + (e.lineno || '')));
  win.addEventListener('unhandledrejection', e => errors.push('[unhandledrejection] ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason))));

  // 执行 app.js
  const s = win.document.createElement('script');
  s.textContent = appjs;
  win.document.body.appendChild(s);

  await sleep(2500); // 等首屏加载(loadAll + dashboard)

  const content = () => win.document.getElementById('content');
  const txt = () => (content() ? content().textContent : '');

  console.log('===== 首屏(dashboard) =====');
  const t0 = txt();
  console.log('内容长度 =', t0.length);
  if (/初始化失败/.test(t0)) { console.log('!! 首屏初始化失败'); errors.push('首屏初始化失败: ' + t0.slice(0, 200)); }
  // 首页卡片数字
  const nums = (t0.match(/[\d,]+\.\d{2}/g) || []).slice(0, 12);
  console.log('页面数字样本:', nums.join(' | '));

  console.log('\n===== 逐页切换 =====');
  let pass = 0, fail = 0; const pageIssues = [];
  for (const [tab, name] of TABS) {
    const before = errors.length;
    const link = win.document.querySelector(`#nav a[data-tab="${tab}"]`);
    if (!link) { console.log(`[FAIL] ${name}: 找不到导航项`); fail++; continue; }
    win.eval(`showTab('${tab}')`);
    await sleep(900);
    const t = txt();
    const newErr = errors.slice(before);
    const bad = [];
    if (!t || t.length < 50) bad.push('页面无内容');
    if (/undefined/.test(t)) bad.push('文本含 undefined');
    if (/\bNaN\b/.test(t)) bad.push('文本含 NaN');
    if (/\bnull\b/.test(t)) bad.push('文本含 null');
    if (/初始化失败|加载失败|出错/.test(t)) bad.push('文本含失败提示');
    if (newErr.length) bad.push('JS错误:' + newErr[0].slice(0, 120));
    if (bad.length) { fail++; pageIssues.push(`${name}(${tab}): ${bad.join('; ')}`); console.log(`[FAIL] ${name} -> ${bad.join('; ')}`); }
    else { pass++; console.log(`[PASS] ${name} (${t.length} 字符)`); }
  }

  console.log('\n===== 关键页内容抽样 =====');
  // 申报汇总页:核对 A107012 关键行
  win.eval(`showTab('summary')`); await sleep(1200);
  const st = txt();
  const grab = re => { const m = re.exec(st.replace(/[\s\u00a0]+/g, ' ')); return m ? m[1] : '(未找到)'; };
  console.log('  加计扣除额相关文本片段:', st.replace(/[\s\u00a0]+/g, ' ').slice(0, 400));

  win.eval(`showTab('risks')`); await sleep(1200);
  const rt = txt().replace(/[\s\u00a0]+/g, ' ');
  console.log('\n  风险自检页片段:', rt.slice(0, 500));

  win.eval(`showTab('expenses')`); await sleep(1200);
  const et = txt().replace(/[\s\u00a0]+/g, ' ');
  console.log('\n  费用归集页片段:', et.slice(0, 400));

  console.log('\n===== 年度切换(2025 空年度) =====');
  const ysel = win.document.getElementById('yearSel');
  if (ysel) {
    ysel.value = '2025';
    ysel.dispatchEvent(new win.Event('change'));
    await sleep(1500);
    const t = txt();
    console.log('  切换到 2025 后内容长度 =', t.length);
    if (/undefined|\bNaN\b/.test(t)) { errors.push('2025空年度渲染含 undefined/NaN'); console.log('  !! 空年度渲染异常'); }
    else console.log('  [PASS] 空年度正常渲染');
  }

  console.log('\n########## UI 测试汇总 ##########');
  console.log(`页面渲染: 通过 ${pass} / 失败 ${fail}`);
  if (pageIssues.length) { console.log('\n页面问题:'); pageIssues.forEach(p => console.log('  - ' + p)); }
  console.log(`\nJS 运行时错误 ${errors.length} 条`);
  errors.slice(0, 25).forEach(e => console.log('  * ' + e));
  console.log(`\n警告 ${warns.length} 条`);
  warns.slice(0, 8).forEach(w => console.log('  * ' + w));

  dom.window.close();
})().catch(e => { console.error('测试脚本异常:', e); process.exit(1); });
