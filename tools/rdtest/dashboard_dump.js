// 导出概览页渲染文本,核对驾驶舱每个卡片数字
const fs = require('fs'); const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const ROOT = path.join(__dirname, '..', '..'); const BASE = 'http://127.0.0.1:8765';
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => console.log('[jsdomError]', e.detail ? e.detail.message : e.message));
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8'),
    { url: BASE + '/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc });
  const win = dom.window;
  win.fetch = (p, o) => fetch(new URL(p, BASE), o);
  win.confirm = () => true;
  const s = win.document.createElement('script');
  s.textContent = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  win.document.body.appendChild(s);
  await sleep(2500);
  win.eval(`showTab('dashboard')`);
  await sleep(1500);
  const nodes = win.document.querySelectorAll('#content .card, #content .kpi, #content section, #content div');
  const seen = new Set();
  console.log('===== 概览页逐块文本 =====');
  nodes.forEach(n => {
    if (n.children.length > 3) return;
    const t = n.textContent.replace(/[\s\u00a0]+/g, ' ').trim();
    if (t && t.length < 300 && !seen.has(t)) { seen.add(t); console.log('  • ' + t); }
  });
  const full = win.document.getElementById('content').textContent.replace(/[\s\u00a0]+/g, ' ');
  console.log('\n===== 全文 =====\n' + full);
  dom.window.close();
})();
