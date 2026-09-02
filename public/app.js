/* 研发费用加计扣除辅助软件 —— 前端逻辑(原生JS,无构建,完全免费) */
'use strict';

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

const state = {
  meta: null,
  companies: [],
  projects: [],
  staff: [],
  timesheets: [],
  expenses: [],
  amortizations: [],
  specialIncomes: [],
  taxroll: [],
  attachMap: {},   // expenseId -> [{name,size,url}]
  year: localStorage.getItem('rd_year') || String(new Date().getFullYear()),
  tab: 'dashboard',
};

/* ---------------- 基础工具 ---------------- */
const fmt = n => Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

let toastTimer = null;
function toast(msg, type = 'ok') {
  const box = $('#toast');
  const el = document.createElement('div');
  el.className = 'toast-item ' + (type === 'err' ? 'err' : 'ok');
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

const catName = k => (state.meta?.categories.find(c => c.key === k) || {}).name || k;
const formName = k => (state.meta?.forms.find(f => f.key === k) || {}).name || k;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function projOf(id) { return state.projects.find(p => p.id === id) || { code: '', name: id }; }
function staffName(id) { return (state.staff.find(s => s.id === id) || {}).name || id; }

function select(name, options, value, extra = '') {
  const opts = options.map(o => {
    const v = o.value ?? o.key ?? o;
    const label = o.label ?? o.name ?? o;
    return `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(label)}</option>`;
  }).join('');
  return `<select name="${name}" ${extra}>${opts}</select>`;
}

/* 月份下拉(替代 <input type=month> 逐格滑动,覆盖近6年×12月) */
function monthOptions() {
  const base = new Date().getFullYear();
  const opts = [];
  for (let y = base - 2; y <= base + 3; y++) {
    for (let m = 1; m <= 12; m++) {
      const v = `${y}-${String(m).padStart(2, '0')}`;
      opts.push({ key: v, label: `${y}年${m}月` });
    }
  }
  return opts;
}
function monthSelect(name, value) { return select(name, monthOptions(), value); }

/* 日期快捷按钮:年 月 今 月 年(给所有 input[type=date] 追加) */
function enhanceDates(root) {
  (root || document).querySelectorAll('input[type="date"]').forEach(inp => {
    if (inp.dataset.enhanced) return;
    inp.dataset.enhanced = '1';
    const shift = (d, dy, dm) => {
      const y = d.getFullYear() + dy, m = d.getMonth() + dm;
      const last = new Date(y, m + 1, 0).getDate();
      return new Date(y, m, Math.min(d.getDate(), last));
    };
    const wrap = document.createElement('span');
    wrap.className = 'date-quick';
    const mk = (label, fn) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn-mini'; b.textContent = label;
      b.title = label === '今' ? '今天' : label;
      b.onclick = () => {
        const d = inp.value ? new Date(inp.value + 'T00:00:00') : new Date();
        inp.value = fn(d).toISOString().slice(0, 10);
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      };
      return b;
    };
    wrap.appendChild(mk('年', d => shift(d, -1, 0)));
    wrap.appendChild(mk('月', d => shift(d, 0, -1)));
    wrap.appendChild(mk('今', d => new Date()));
    wrap.appendChild(mk('月', d => shift(d, 0, 1)));
    wrap.appendChild(mk('年', d => shift(d, 1, 0)));
    inp.parentNode.insertBefore(wrap, inp.nextSibling);
  });
}

/* 模板下载按钮:fetch 取内容 → Blob 下载(不依赖新标签页,失败有提示) */
function bindTemplateDownload(btnId, kind, fmt) {
  const btn = $('#' + btnId); // 注意:id 需加 # 前缀,否则 querySelector 按标签名查找会落空
  if (!btn) return;
  btn.onclick = async () => {
    btn.disabled = true; btn.dataset.orig = btn.textContent; btn.textContent = '下载中…';
    try {
      const res = await fetch(`/api/template/${kind}?year=${state.year}${fmt ? '&format=xlsx' : ''}`);
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `下载失败(HTTP ${res.status})`); }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const m = /filename\*=UTF-8''([^;]+)/.exec(cd);
      const fname = m ? decodeURIComponent(m[1]) : (kind + (fmt ? '模板.xlsx' : '模板.csv'));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = fname;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast('模板已下载:' + fname);
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = btn.dataset.orig || '下载模板';
    }
  };
}

/* 通用下载:fetch → Blob → <a download> 点击(兼容 filename*=UTF-8'' 与旧式 filename= 两种响应头) */
async function downloadUrl(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `下载失败(HTTP ${res.status})`); }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    let fname = '';
    const m1 = /filename\*=UTF-8''([^;]+)/.exec(cd);
    const m2 = /filename="?([^";]+)"?/.exec(cd);
    fname = m1 ? decodeURIComponent(m1[1]) : (m2 ? m2[1] : (url.split('/').pop() || '导出文件'));
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u; a.download = fname;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 4000);
    toast('已开始下载:' + fname);
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* 文件导入按钮:选择 .tsv/.csv/.txt → 读入指定 textarea */
function bindFileImport(btnId, taId) {
  const btn = $(btnId);
  if (!btn) return;
  const file = document.createElement('input');
  file.type = 'file'; file.accept = '.tsv,.csv,.txt,.xlsx';
  file.style.display = 'none';
  document.body.appendChild(file);
  btn.onclick = () => file.click();
  file.onchange = () => {
    const f = file.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { $(taId).value = rd.result; toast('已读入文件,请核对内容后点击导入'); };
    rd.readAsText(f, 'utf-8');
    file.value = '';
  };
}

/* ---------------- 数据加载 ---------------- */
async function loadAll() {
  const [companies, projects, staff, timesheets, expenses, amortizations, specialIncomes, taxroll, assets, attachMap] = await Promise.all([
    api('/api/companies'), api('/api/projects'), api('/api/staff'),
    api('/api/timesheets'), api('/api/expenses'), api('/api/amortizations'),
    api('/api/specialIncomes'), api('/api/taxroll'), api('/api/assets'),
    api('/api/attachments'),
  ]);
  state.companies = companies; state.projects = projects; state.staff = staff;
  state.timesheets = timesheets; state.expenses = expenses; state.amortizations = amortizations;
  state.specialIncomes = specialIncomes || []; state.taxroll = taxroll || [];
  state.assets = assets || [];
  state.attachMap = attachMap || {};
  const c = companies[0];
  $('#companyBadge').textContent = c ? `${c.name} · ${c.industry || ''}` : '未设置企业';
}

/* ---------------- 页面渲染 ---------------- */
const PAGES = {
  dashboard: { title: '概览', render: renderDashboard, bind: bindDashboard },
  company: { title: '企业设置', render: renderCompany, bind: bindCompany },
  projects: { title: '研发项目', render: renderProjects, bind: bindProjects },
  staff: { title: '人员与工时', render: renderStaff, bind: bindStaff },
  expenses: { title: '费用归集', render: renderExpenses, bind: bindExpenses },
  assets: { title: '共用资源', render: renderAssets, bind: bindAssets },
  import: { title: 'Excel导入', render: renderImport, bind: bindImport },
  ledger: { title: '辅助账', render: renderLedger, bind: bindLedger },
  summary: { title: '申报汇总', render: renderSummary, bind: bindSummary },
  risks: { title: '风险自检', render: renderRisks, bind: bindRisks },
  checklist: { title: '备查清单', render: renderChecklist, bind: bindChecklist },
  policy: { title: '政策库', render: renderPolicy, bind: bindPolicy },
};

async function showTab(tab) {
  state.tab = tab;
  $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
  $('#pageTitle').textContent = PAGES[tab].title;
  await PAGES[tab].render();
  PAGES[tab].bind();
  enhanceDates($('#content'));
}

/* ---------- 概览 ---------- */
async function renderDashboard() {
  const d = await api('/api/dashboard?year=' + state.year);
  const s = d.summary;
  let tax = null;
  try { tax = await api('/api/tax-saving?year=' + state.year); } catch {}
  const guide = [
    { tab: 'company', label: '企业设置', done: state.companies.length > 0 },
    { tab: 'projects', label: '研发项目', done: state.projects.length > 0 },
    { tab: 'staff', label: '人员与工时', done: state.staff.length > 0 && state.timesheets.length > 0 },
    { tab: 'expenses', label: '费用归集', done: state.expenses.length > 0 },
    { tab: 'risks', label: '风险自检', done: state.expenses.length > 0 && d.counts.error === 0 },
  ];
  const doneCount = guide.filter(g => g.done).length;
  const nextStep = guide.find(g => !g.done);
  $('#content').innerHTML = `
    <div class="welcome-banner">
      <div class="wb-head">
        <div class="wb-title">研发费用加计扣除辅助软件</div>
        <div class="wb-sub">完全免费 · 单机本地 · 数据不出电脑 · 让研发费用加计「合规、经得起查」</div>
      </div>
      <div class="guide-steps">
        ${guide.map(g => `<button class="guide-step ${g.done ? 'done' : ''}" data-tab="${g.tab}">${g.done ? '' : ''} ${g.label}</button>`).join('')}
        <span class="guide-progress">已完成 ${doneCount}/5</span>
      </div>
    </div>
    ${nextStep
      ? `<div class="next-step">下一步:完成「${nextStep.label}」${nextStep.tab === 'company' && doneCount === 0 ? '(首次使用,请先填写企业信息,系统才能自动判断优惠与负面清单)' : ''}<button class="btn btn-primary btn-sm next-step-btn" data-tab="${nextStep.tab}">去完成 →</button></div>`
      : '<div class="next-step ok"> 五项基础配置已全部完成。年底到「备查清单」可生成辅助账、申报表与备查资料五件套。</div>'}
    <div class="grid-cards">
      <div class="stat"><div class="k">费用化加计基数</div><div class="v">${fmt(s.totalExpenseBase)}</div></div>
      <div class="stat green"><div class="k">${state.year}年加计扣除额</div><div class="v">${fmt(s.totalAdd)}</div></div>
      <div class="stat ${d.counts.error ? 'red' : d.counts.warning ? 'yellow' : 'green'}">
        <div class="k">风险项(红${d.counts.error}/黄${d.counts.warning}/绿${d.counts.info})</div><div class="v">${d.counts.error + d.counts.warning + d.counts.info}</div></div>
      <div class="stat"><div class="k">研发项目数</div><div class="v">${d.projectCount}</div></div>
      <div class="stat"><div class="k">${state.year}年费用笔数</div><div class="v">${d.expenseCount}</div></div>
      ${tax ? `<div class="stat blue"><div class="k">预计节税(按${(tax.rate * 100).toFixed(0)}%税负)</div><div class="v">${fmt(tax.saving)}</div></div>` : ''}
    </div>
    ${d.counts.error ? `<div class="warn-box">⚠ 存在 ${d.counts.error} 项红色风险(阻断级),请到「风险自检」页处理后再申报。</div>` : ''}
    <div class="card">
      <h3>主要风险提示</h3>
      ${d.topRisks.length ? d.topRisks.map(r => `
        <div class="risk-item ${r.level}">
          <div class="rt"><span class="tag tag-${r.level === 'error' ? 'red' : r.level === 'warning' ? 'yellow' : 'green'}">${r.level === 'error' ? '红' : r.level === 'warning' ? '黄' : '绿'}</span>${esc(r.title)}</div>
          <div class="rd">${esc(r.detail)}</div>
          <div class="rs">建议:${esc(r.suggestion)}</div>
        </div>`).join('') : '<div class="empty">暂无风险提示</div>'}
    </div>
    <div class="card"><h3>节税测算 <span class="sub">给老板看的数字:今年研发投入能省多少税(支持预缴口径)</span></h3>
      <div class="form-grid" id="taxForm">
        <label>测算口径${select('period', [{ key: '', label: '全年(汇算清缴)' }, { key: '7', label: '7月预缴(上半年)' }, { key: '10', label: '10月预缴(前三季度)' }], '')}</label>
        <label>预计应纳税所得额(元)<input type="number" name="income" value="${tax ? tax.income || '' : ''}" placeholder="未考虑加计扣除前的利润,负数=亏损"></label>
        <label>税率${select('rate', [{ key: '', label: '自动(高企15% / 小微5% / 标准25%)' }, { key: 0.25, label: '25%(标准)' }, { key: 0.05, label: '5%(小型微利)' }, { key: 0.15, label: '15%(高企)' }, { key: 0.125, label: '12.5%(软件减半期)' }, { key: 0, label: '0%(软件免税期)' }], '')}</label>
      </div>
      ${state.meta?.policies?.smePeriodEnd ? `<div class="hint" style="margin-top:8px"> 小型微利企业 5% 实际税负优惠(财税〔2023〕12号)执行至 <b>${state.meta.policies.smePeriodEnd} 年 12 月 31 日</b>;如政策届时延续,按新公告执行,本系统将同步更新口径。</div>` : ''}
      <div class="flex"><button class="btn btn-primary" id="calcTax">测算节税</button></div>
      <div id="taxResult"></div>
    </div>
    <div class="card"><h3>软件即征即退 vs 加计扣除 <span class="sub">两者互斥:退税款作不征税收入(对应支出不得加计)还是作应税收入(全额加计)?</span></h3>
      <div class="form-grid" id="refundForm">
        <label>即征即退退税额(元)<input type="number" name="refund" placeholder="如 1000000"></label>
        <label>其中用于研发的支出(元)<input type="number" name="related" placeholder="退税款对应研发支出,通常=退税额"></label>
        <label>税率${select('rate', [{ key: '', label: '自动(高企15% / 25%)' }, { key: 0.25, label: '25%(标准)' }, { key: 0.15, label: '15%(高企)' }], '')}</label>
      </div>
      <div class="flex"><button class="btn btn-primary" id="calcRefund">测算两方案</button></div>
      <div id="refundResult"></div>
    </div>
    <div class="card"><h3>限额与结构(快照)</h3>
      <div class="table-wrap"><table>
        <tr><th>项目</th><th class="num">金额(元)</th><th>说明</th></tr>
        <tr><td>其他相关费用 实际/限额</td><td class="num">${fmt(s.otherActual)} / ${fmt(s.otherLimit)}</td><td>${s.otherExcess > 0 ? `超限 ${fmt(s.otherExcess)} 已自动剔除` : '未超限'}</td></tr>
        <tr><td>委托境外研发 计入/限额</td><td class="num">${fmt(s.entrustOverseas)} / ${fmt(s.entrustOverseasCap)}</td><td>${s.entrustOverseasExcess > 0 ? `超限 ${fmt(s.entrustOverseasExcess)} 已剔除` : '未超限'}</td></tr>
        <tr><td>资本化形成无形资产成本</td><td class="num">${fmt(s.capitalFormed)}</td><td>按200%摊销</td></tr>
        <tr><td>本年摊销加计</td><td class="num">${fmt(s.amortAdd)}</td><td>摊销额 × 100%</td></tr>
      </table></div>
    </div>`;
}
async function bindDashboard() {
  document.querySelectorAll('#content .guide-step, #content .next-step-btn').forEach(b => {
    b.onclick = () => showTab(b.dataset.tab);
  });
  const btn = $('#calcTax');
  if (!btn) return;
  btn.onclick = async () => {
    const f = $('#taxForm');
    const g = n => f.querySelector(`[name="${n}"]`)?.value.trim();
    const income = g('income');
    const rate = g('rate');
    const period = g('period');
    const qs = new URLSearchParams({ year: state.year });
    if (income !== '') qs.set('income', income);
    if (rate !== '') qs.set('rate', rate);
    if (period !== '') qs.set('period', period);
    try {
      const r = await api('/api/tax-saving?' + qs.toString());
      $('#taxResult').innerHTML = `
        <div class="table-wrap mt"><table>
          <tr><td>加计扣除额</td><td class="num"><b>${fmt(r.totalAdd)}</b></td><td class="muted">费用化加计 + 摊销加计${r.periodEnd ? `(${r.periodEnd.slice(5)}月口径)` : ''}</td></tr>
          <tr><td>适用税负</td><td class="num">${(r.rate * 100).toFixed(0)}%</td><td class="muted">${esc(r.rateNote)}</td></tr>
          <tr><td>预计节税额</td><td class="num"><b class="green">${fmt(r.saving)}</b></td><td class="muted">加计扣除后少缴的企业所得税</td></tr>
          ${r.createsLoss > 0 ? `<tr><td>新增亏损(可结转)</td><td class="num">${fmt(r.createsLoss)}</td><td class="muted">${esc(r.carryNote)}</td></tr>` : ''}
        </table></div>`;
    } catch (e) { toast(e.message, 'err'); }
  };
  const rb = $('#calcRefund');
  if (rb) {
    rb.onclick = async () => {
      const f = $('#refundForm');
      const g = n => f.querySelector(`[name="${n}"]`)?.value.trim();
      const refund = g('refund');
      const related = g('related');
      const rate = g('rate');
      if (refund === '') return toast('请填写退税额', 'err');
      const qs = new URLSearchParams({ year: state.year, refund, related: related || '0' });
      if (rate !== '') qs.set('rate', rate);
      try {
        const r = await api('/api/tax-refund?' + qs.toString());
        $('#refundResult').innerHTML = `
          <div class="table-wrap mt"><table>
            <tr><th>方案</th><th class="num">净收益(相对无退税无加计)</th><th>逻辑</th></tr>
            <tr><td>A 退税款作不征税收入</td><td class="num">${fmt(r.planA)}</td><td class="muted">退税款免所得税,但对应研发支出 ${fmt(r.related)} 不得加计</td></tr>
            <tr><td>B 退税款作应税收入</td><td class="num">${fmt(r.planB)}</td><td class="muted">退税款并入所得缴税,研发费 ${fmt(r.totalAdd)} 全额加计</td></tr>
            <tr><td colspan="3" class="muted" style="font-size:12px">结论:<b>${esc(r.decision)}</b></td></tr>
          </table></div>
          <div class="muted" style="font-size:12px;margin-top:6px">${esc(r.note)}</div>`;
      } catch (e) { toast(e.message, 'err'); }
    };
  }
}

/* ---------- 企业设置 ---------- */
async function renderCompany() {
  const c = state.companies[0] || {};
  const neg = (state.meta?.negativeIndustries || []).find(i => String(c.industry || '').includes(i));
  let backups = [];
  let backupKeep = 10;
  try { const br = await api('/api/backups'); backups = br.backups || []; backupKeep = br.keep || 10; } catch {}
  const fmtSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(0) + ' KB' : n + ' B';
  $('#content').innerHTML = `
    ${neg ? `<div class="warn-box">⚠ 所属行业「${c.industry}」命中负面清单行业「${neg}」,不得享受加计扣除优惠!</div>` : ''}
    <div class="card"><h3>企业信息</h3>
      <div class="form-grid" id="companyForm">
        <label>企业名称<input name="name" value="${esc(c.name || '')}" placeholder="与营业执照一致"></label>
        <label>统一社会信用代码<input name="creditCode" value="${esc(c.creditCode || '')}"></label>
        <label>所属行业${select('industry', state.meta?.industries || [], c.industry)}</label>
        <label>征收方式${select('levyType', state.meta?.levyTypes || [], c.levyType || '查账征收')}</label>
        <label>从业人数<input type="number" name="headcount" value="${c.headcount ?? ''}"></label>
        <label>资产总额(万元,小微判定:≤5000万)<input type="number" name="totalAssets" value="${c.totalAssets ?? ''}" placeholder="小型微利需从业≤300人且资产≤5000万(2023年12号)"></label>
        <label>科技人员数(高企,占从业人数≥10%)<input type="number" name="techStaff" value="${c.techStaff ?? ''}" placeholder="高新技术企业必填"></label>
        <label><input type="checkbox" name="isHiTech" ${c.isHiTech ? 'checked' : ''}> 高新技术企业(需双口径对照)</label>
        <label><input type="checkbox" name="isTechSme" ${c.isTechSme ? 'checked' : ''}> 科技型中小企业(2022年16号,当年按100%加计)</label>
        <label><input type="checkbox" name="icIndustrial" ${c.icIndustrial ? 'checked' : ''}> 集成电路/工业母机清单企业(44号,加计120%)</label>
        <label>负面清单行业收入占比(%)<input type="number" name="negativeRevenueShare" min="0" max="100" value="${c.negativeRevenueShare ?? ''}" placeholder="主营收入中负面行业占比,≥50%不得加计"></label>
        <label>${state.year}年高新产品(服务)收入(元)<input type="number" name="htIncome_cur" value="${c.hiTechIncome?.[state.year] ?? ''}" placeholder="高企:高新收入占收入比≥60%"></label>
        <label>${state.year}年不征税收入对应研发支出(元)<input type="number" name="exempt_cur" value="${c.nonTaxRelated?.[state.year] ?? ''}" placeholder="政府补助/软件即征即退按不征税收入处理时,对应支出不得加计"></label>
        <label>${state.year}年营业收入(元)<input type="number" name="revenue_cur" value="${c.revenue?.[state.year] ?? ''}"></label>
        <label>${Number(state.year) - 1}年营业收入(元)<input type="number" name="revenue_prev" value="${c.revenue?.[Number(state.year) - 1] ?? ''}"></label>
        <label>${state.year}年应纳税所得额(元,负数为亏损)<input type="number" name="tax_cur" value="${c.taxableIncome?.[state.year] ?? ''}"></label>
        <label>${Number(state.year) - 1}年应纳税所得额(元)<input type="number" name="tax_prev" value="${c.taxableIncome?.[Number(state.year) - 1] ?? ''}"></label>
        <label>${state.year}年电费(元)<input type="number" name="elec_cur" value="${c.electricity?.[state.year] ?? ''}" placeholder="年度总电费,用于能耗-产量合理性校验(金税四期'以电倒推')"></label>
        <label>${Number(state.year) - 1}年电费(元)<input type="number" name="elec_prev" value="${c.electricity?.[Number(state.year) - 1] ?? ''}"></label>
        <label>${state.year}年产量(件/吨/台)<input type="number" name="output_cur" value="${c.output?.[state.year] ?? ''}" placeholder="年度主营产品产量,与电费匹配校验"></label>
        <label>${Number(state.year) - 1}年产量(件/吨/台)<input type="number" name="output_prev" value="${c.output?.[Number(state.year) - 1] ?? ''}"></label>
        <label class="wide">备注<textarea name="note">${esc(c.note || '')}</textarea></label>
      </div>
      <div class="flex"><button class="btn btn-primary" id="saveCompany">保存企业信息</button></div>
    </div>
    <div class="hint">提示:行业字段用于负面清单自动判定;营业收入/应纳税所得额用于占比与税负率分析;电费与产量用于金税四期"能耗-产出倒推"(虚报动力电费、材料费异常案例的核查模型)。</div>
    <div class="card"><h3>数据备份与恢复 <span class="sub">数据仅存本机,建议定期备份</span></h3>
      <div class="hint"> 每次启动时自动备份,保留最近 ${backupKeep} 份;也可手动备份,或从历史备份恢复(恢复将覆盖当前全部数据)。</div>
      <div class="flex"><button class="btn btn-primary" id="btnBackupNow"> 立即备份</button></div>
      <div class="table-wrap mt"><table>
        <tr><th>备份时间</th><th>类型</th><th>大小</th><th>操作</th></tr>
        ${backups.length ? backups.map(b => `<tr>
          <td>${esc(b.time)}</td>
          <td>${b.tag === 'auto' ? '<span class="tag tag-green">自动</span>' : '<span class="tag">手动</span>'}</td>
          <td>${fmtSize(b.size)}</td>
          <td><button class="btn btn-mini btn-restore" data-name="${esc(b.name)}">恢复</button></td>
        </tr>`).join('') : '<tr><td colspan="4" class="muted">暂无备份(启动时如有数据会自动创建)</td></tr>'}
      </table></div>
    </div>`;
}
function bindCompany() {
  $('#saveCompany').onclick = async () => {
    const f = $('#companyForm');
    const g = n => f.querySelector(`[name="${n}"]`)?.value.trim();
    const body = {
      name: g('name'), creditCode: g('creditCode'), industry: g('industry'), levyType: g('levyType'),
      headcount: Number(g('headcount')) || 0,
      totalAssets: g('totalAssets') !== '' && g('totalAssets') != null ? Number(g('totalAssets')) : null,
      techStaff: Number(g('techStaff')) || 0,
      isHiTech: f.querySelector('[name="isHiTech"]').checked,
      isTechSme: f.querySelector('[name="isTechSme"]').checked,
      icIndustrial: f.querySelector('[name="icIndustrial"]').checked,
      negativeRevenueShare: g('negativeRevenueShare') !== '' ? Number(g('negativeRevenueShare')) : null,
      revenue: {}, taxableIncome: {}, nonTaxRelated: {}, hiTechIncome: {}, note: g('note'),
    };
    body.revenue[state.year] = Number(g('revenue_cur')) || 0;
    body.revenue[Number(state.year) - 1] = Number(g('revenue_prev')) || 0;
    body.taxableIncome[state.year] = Number(g('tax_cur')) || 0;
    body.taxableIncome[Number(state.year) - 1] = Number(g('tax_prev')) || 0;
    body.nonTaxRelated[state.year] = Number(g('exempt_cur')) || 0;
    body.hiTechIncome[state.year] = Number(g('htIncome_cur')) || 0;
    body.electricity = {};
    body.output = {};
    body.electricity[state.year] = Number(g('elec_cur')) || 0;
    body.electricity[Number(state.year) - 1] = Number(g('elec_prev')) || 0;
    body.output[state.year] = Number(g('output_cur')) || 0;
    body.output[Number(state.year) - 1] = Number(g('output_prev')) || 0;
    try {
      if (state.companies[0]) await api('/api/companies/' + state.companies[0].id, { method: 'PUT', body });
      else await api('/api/companies', { method: 'POST', body });
      toast('企业信息已保存'); await loadAll(); await showTab('company');
    } catch (e) { toast(e.message, 'err'); }
  };
  const bb = $('#btnBackupNow');
  if (bb) {
    bb.onclick = async () => {
      try {
        const r = await api('/api/backup/create', { method: 'POST', body: {} });
        toast('已创建备份 ' + r.name); await renderCompany();
      } catch (e) { toast(e.message, 'err'); }
    };
  }
  document.querySelectorAll('#content .btn-restore').forEach(b => {
    b.onclick = async () => {
      if (!confirm(`确定用「${b.dataset.name}」覆盖当前全部数据吗?此操作不可撤销,建议先手动备份一次。`)) return;
      try {
        const r = await api('/api/backup/restore', { method: 'POST', body: { name: b.dataset.name } });
        toast('已恢复: ' + r.restored); await loadAll(); await showTab('company');
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

/* ---------- 研发项目 ---------- */
async function renderProjects() {
  $('#content').innerHTML = `
    <div class="flex mb">
      <a class="btn" href="/templates/立项书模板.md" download="研发项目立项书模板.md"> 下载立项书模板</a>
      <span class="muted">立项决议文件、项目计划书为必备备查资料,请同步线下归档。</span>
    </div>
    <div class="card"><h3>新增/编辑项目</h3>
      <div class="form-grid" id="projForm">
        <input type="hidden" name="id">
        <label>项目编号<input name="code" placeholder="如 2025-RD-01"></label>
        <label>项目名称<input name="name"></label>
        <label>研发形式${select('form', state.meta?.forms || [], 'self')}</label>
        <label>成果归属${select('resultOwner', state.meta?.resultOwners || [{ key: 'self', label: '成果归本企业' }], 'self')} <span class="muted" style="font-size:11px">受托开发(归客户)整项目不得加计</span></label>
        <label>活动类型${select('activityType', [{ key: '', label: '(实质性研发)' }, ...(state.meta?.negativeActivities || []).map(a => ({ key: a, label: a }))], '')}</label>
        <label>开始日期<input type="date" name="startDate"></label>
        <label>结束日期<input type="date" name="endDate"></label>
        <label>状态${select('status', ['进行中', '已结题', '终止'], '进行中')}</label>
        <label>支出政策${select('capitalization', [{ key: 'expense', label: '费用化' }, { key: 'capitalize', label: '资本化' }], 'expense')}</label>
        <label>立项决议日期<input type="date" name="approvalDate"></label>
        <label>委托研发技术合同认定登记编号<input name="techContractNo" placeholder="委托项目必填(科技部门登记)" title="委托境内/境外机构的研发合同需经科技部门认定登记,未登记不得加计"></label>
        <label class="flex"><input type="checkbox" name="hasApprovalDoc"> 已有立项决议文件</label>
        <label class="flex"><input type="checkbox" name="hasPlanDoc"> 已有项目计划书</label>
        <label class="flex"><input type="checkbox" name="hasProcessDocs"> 已有过程文档/实验记录(研发日志/测试报告)</label>
        <label class="flex"><input type="checkbox" name="hasResultDocs"> 已有成果证明(专利/软著/成果报告)</label>
        <label class="wide">备注<textarea name="note"></textarea></label>
      </div>
      <div class="flex">
        <button class="btn btn-primary" id="saveProj">保存项目</button>
        <button class="btn" id="resetProj">清空表单</button>
      </div>
    </div>
    <div class="card"><h3>项目列表</h3>
      <div class="table-wrap"><table>
        <tr><th>编号</th><th>名称</th><th>形式</th><th>活动类型</th><th>期间</th><th>状态</th><th>支出政策</th><th>证据链</th><th>操作</th></tr>
        ${state.projects.map(p => {
          const ev = [['决议', p.hasApprovalDoc], ['计划书', p.hasPlanDoc], ['过程', p.hasProcessDocs], ['成果', p.hasResultDocs]];
          const evCount = ev.filter(([, v]) => v).length;
          const evTitle = ev.filter(([, v]) => !v).map(([k]) => '缺' + k).join('、') || '完整';
          return `<tr>
          <td>${esc(p.code)}</td><td>${esc(p.name)}</td><td>${formName(p.form)}${p.resultOwner === 'client' ? ' <span class="tag tag-red">受托开发</span>' : ''}</td>
          <td>${p.activityType ? `<span class="tag tag-yellow">${esc(p.activityType)}</span>` : '<span class="muted">实质性研发</span>'}</td>
          <td>${esc(p.startDate)} ~ ${esc(p.endDate)}</td>
          <td>${esc(p.status)}</td>
          <td>${p.capitalization === 'capitalize' ? '<span class="tag tag-blue">资本化</span>' : '费用化'}</td>
          <td title="${esc(evTitle)}">${evCount === 4 ? '<span class="tag tag-green">完整</span>' : `<span class="tag ${evCount === 0 ? 'tag-red' : 'tag-yellow'}">${evCount}/4</span>`}</td>
          <td><button class="btn-link" data-edit="${p.id}">编辑</button><button class="btn-link danger" data-del="${p.id}">删除</button></td>
        </tr>`; }).join('') || '<tr><td colspan="9" class="empty">暂无项目</td></tr>'}
      </table></div>
      <div class="muted" style="font-size:12px;margin-top:6px">证据链=立项决议/计划书/过程文档(实验记录、研发日志、测试报告)/成果证明(专利、软著、成果报告)。仅有立项书、无过程与成果 = "证据不足"(稽查重点),请按项目补齐。</div>
    </div>`;
}
function bindProjects() {
  $('#saveProj').onclick = async () => {
    const f = $('#projForm');
    const g = n => f.querySelector(`[name="${n}"]`)?.value.trim();
    const id = g('id');
    const body = {
      code: g('code'), name: g('name'), form: g('form'), resultOwner: g('resultOwner') || 'self', activityType: g('activityType'),
      startDate: g('startDate'), endDate: g('endDate'), status: g('status'),
      capitalization: g('capitalization'), approvalDate: g('approvalDate'),
      techContractNo: g('techContractNo'),
      hasApprovalDoc: f.querySelector('[name="hasApprovalDoc"]').checked,
      hasPlanDoc: f.querySelector('[name="hasPlanDoc"]').checked,
      hasProcessDocs: f.querySelector('[name="hasProcessDocs"]').checked,
      hasResultDocs: f.querySelector('[name="hasResultDocs"]').checked,
      note: g('note'),
    };
    if (!body.code || !body.name) return toast('项目编号与名称为必填', 'err');
    try {
      if (id) await api('/api/projects/' + id, { method: 'PUT', body });
      else await api('/api/projects', { method: 'POST', body });
      toast('项目已保存'); await loadAll(); await showTab('projects');
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#resetProj').onclick = () => showTab('projects');
  $$('#projForm').forEach(el => {});
  $('#content').querySelectorAll('[data-edit]').forEach(btn => btn.onclick = () => {
    const p = state.projects.find(x => x.id === btn.dataset.edit);
    const f = $('#projForm');
    Object.entries({ code: p.code, name: p.name, form: p.form, resultOwner: p.resultOwner || 'self', activityType: p.activityType,
      startDate: p.startDate, endDate: p.endDate, status: p.status, capitalization: p.capitalization,
      approvalDate: p.approvalDate || '', techContractNo: p.techContractNo || '', note: p.note || '', id: p.id }).forEach(([k, v]) => {
      const el = f.querySelector(`[name="${k}"]`);
      if (el) el.value = v ?? '';
    });
    f.querySelector('[name="hasApprovalDoc"]').checked = !!p.hasApprovalDoc;
    f.querySelector('[name="hasPlanDoc"]').checked = !!p.hasPlanDoc;
    f.querySelector('[name="hasProcessDocs"]').checked = !!p.hasProcessDocs;
    f.querySelector('[name="hasResultDocs"]').checked = !!p.hasResultDocs;
  });
  $('#content').querySelectorAll('[data-del]').forEach(btn => btn.onclick = async () => {
    if (!confirm('删除该项目?相关费用记录仍在,请确认。')) return;
    await api('/api/projects/' + btn.dataset.del, { method: 'DELETE' });
    toast('已删除'); await loadAll(); await showTab('projects');
  });
}

/* ---------- 人员与工时 ---------- */
async function renderStaff() {
  $('#content').innerHTML = `
    <div class="card"><h3>新增/编辑研发人员</h3>
      <div class="form-grid" id="staffForm">
        <input type="hidden" name="id">
        <label>姓名<input name="name"></label>
        <label>部门<input name="dept" placeholder="如 硬件部"></label>
        <label>岗位<input name="role"></label>
        <label>入职日期<input type="date" name="joinDate"></label>
        <label class="flex"><input type="checkbox" name="isDirect"> 直接从事研发活动</label>
      </div>
      <div class="flex">
        <button class="btn btn-primary" id="saveStaff">保存人员</button>
        <button class="btn" id="resetStaff">清空</button>
      </div>
    </div>
    <div class="card"><h3>人员名单</h3>
      <div class="table-wrap"><table data-kind="staff">
        <tr><th>姓名</th><th>部门</th><th>岗位</th><th>入职日期</th><th>研发属性</th><th>操作</th></tr>
        ${state.staff.map(s => `<tr>
          <td>${esc(s.name)}</td><td>${esc(s.dept)}</td><td>${esc(s.role)}</td><td>${esc(s.joinDate)}</td>
          <td>${s.isDirect ? '<span class="tag tag-blue">直接研发</span>' : '<span class="tag tag-gray">非直接</span>'}</td>
          <td><button class="btn-link" data-edit="${s.id}">编辑</button><button class="btn-link danger" data-del="${s.id}">删除</button></td>
        </tr>`).join('') || '<tr><td colspan="6" class="empty">暂无人员</td></tr>'}
      </table></div>
    </div>
    <div class="card"><h3>批量导入研发人员 <span class="sub">一次性导入名单,每行:姓名|部门|岗位|入职日期|是否直接研发</span></h3>
      <div class="flex" style="flex-wrap:wrap;gap:6px;margin-bottom:6px">
        <button class="btn" id="staffTmplBtn">下载人员模板(CSV)</button>
        <button class="btn" id="staffFileBtn">从文件导入到文本框</button>
      </div>
      <textarea id="staffBatch" rows="3" style="width:100%;font-family:ui-monospace,monospace;font-size:12px" placeholder="张三|研发部|软件工程师|2025-03-01|是&#10;李四|测试部|测试工程师|2025-01-15|否"></textarea>
      <div class="flex"><button class="btn" id="staffBatchBtn">导入人员</button></div>
    </div>
    <div class="card"><h3>个税申报名单 <span class="sub">研发人员名单须与个税/社保申报名单一致,防止"名单虚挂"被预警比对</span></h3>
      <div class="form-grid" id="taxrollForm">
        <label>人员${select('staffId', state.staff.map(s => ({ key: s.id, label: `${s.name}(${s.dept || ''})` })), '')}</label>
        <label>申报年度<input type="number" name="year" value="${state.year}"></label>
      </div>
      <div class="flex">
        <button class="btn btn-primary" id="addTaxroll">登记申报</button>
        <button class="btn" id="compareTaxroll">比对研发名单</button>
        <div id="taxrollResult" class="muted" style="font-size:12px;align-self:center"></div>
      </div>
      <div class="table-wrap mt"><table data-kind="taxroll">
        <tr><th>年度</th><th>人员</th><th>部门</th><th>操作</th></tr>
        ${state.taxroll.slice().sort((a, b) => String(b.year || '').localeCompare(String(a.year || ''))).map(t => `<tr>
          <td>${esc(t.year)}</td><td>${esc(staffName(t.staffId))}</td><td>${esc((state.staff.find(s => s.id === t.staffId) || {}).dept || '')}</td>
          <td><button class="btn-link danger" data-del="${t.id}">删除</button></td>
        </tr>`).join('') || '<tr><td colspan="4" class="empty">暂无个税申报登记</td></tr>'}
      </table></div>
    </div>
    <div class="card"><h3>工时台账 <span class="sub">人员×项目×月份,用于共用费用分摊与人员费用佐证</span></h3>
      <div class="form-grid" id="tsForm">
        <input type="hidden" name="id">
        <label>人员${select('staffId', state.staff.map(s => ({ key: s.id, label: `${s.name}(${s.dept || ''})` })), '')}</label>
        <label>项目${select('projectId', state.projects.map(p => ({ key: p.id, label: `${p.code} ${p.name}` })), '')}</label>
        <label>月份${monthSelect('period', state.year + '-01')}</label>
        <label>研发工时<input type="number" name="rdHours" step="1" placeholder="小时"></label>
        <label>总工时<input type="number" name="totalHours" step="1" placeholder="小时"></label>
      </div>
      <div class="flex">
        <button class="btn btn-primary" id="saveTs">保存工时</button>
        <button class="btn" id="resetTs">清空</button>
      </div>
      <div class="mt" style="background:#f8fafc;border:1px dashed #cbd5e1;border-radius:8px;padding:10px 12px">
        <div style="font-weight:600;font-size:13px">批量粘贴导入(每周/月底一次,10 秒完成)</div>
        <div class="muted" style="font-size:12px;margin:4px 0 6px">
          ① 矩阵式(推荐,Excel 直贴):点「 下载矩阵模板」→ 在 Excel 里按月填研发工时 → 复制表格粘到这里;表头识别「姓名+月份列」,总工时缺省 160。<br>
          ② 竖排式:每行 <b>人员姓名|月份(YYYY-MM)|项目编号|研发工时|总工时</b>。示例:<code>张伟|2025-01|2025-RD-01|160|160</code>
        </div>
        <div class="flex" style="flex-wrap:wrap;gap:6px;margin-bottom:6px">
          <button class="btn" id="tsTmplBtn">下载工时矩阵模板(TSV)</button>
          <button class="btn" id="tsFileBtn">从文件导入到文本框</button>
          <span class="muted" style="font-size:12px;align-self:center">支持 .tsv/.csv(Excel 另存为 CSV)</span>
        </div>
        <textarea id="tsBatch" rows="3" style="width:100%;font-family:ui-monospace,monospace;font-size:12px" placeholder="矩阵粘贴(姓名|部门|项目编号|2025-01…2025-12|总工时)或竖排(张伟|2025-01|2025-RD-01|160|160)"></textarea>
        <div class="flex"><button class="btn" id="tsBatchBtn">导入工时</button></div>
      </div>
      <div class="table-wrap mt"><table data-kind="ts">
        <tr><th>月份</th><th>人员</th><th>项目</th><th class="num">研发工时</th><th class="num">总工时</th><th class="num">占比</th><th>操作</th></tr>
        ${state.timesheets.slice().sort((a, b) => (b.period || '').localeCompare(a.period || '')).map(t => `<tr>
          <td>${esc(t.period)}</td><td>${esc(staffName(t.staffId))}</td><td>${esc(projOf(t.projectId).code)} ${esc(projOf(t.projectId).name)}</td>
          <td class="num">${t.rdHours}</td><td class="num">${t.totalHours}</td>
          <td class="num">${t.totalHours ? ((t.rdHours / t.totalHours) * 100).toFixed(0) + '%' : '-'}</td>
          <td><button class="btn-link" data-edit="${t.id}">编辑</button><button class="btn-link danger" data-del="${t.id}">删除</button></td>
        </tr>`).join('') || '<tr><td colspan="7" class="empty">暂无工时记录</td></tr>'}
      </table></div>
    </div>`;
}
function bindStaff() {
  const fill = (id, data) => {
    const f = $('#' + id);
    if (!data) {
      f.querySelectorAll('input,select').forEach(el => { if (el.type !== 'checkbox') el.value = ''; });
      return;
    }
    Object.entries(data).forEach(([k, v]) => {
      const el = f.querySelector(`[name="${k}"]`);
      if (el) {
        if (el.type === 'checkbox') el.checked = !!v;
        else el.value = v ?? '';
      }
    });
  };
  $('#saveStaff').onclick = async () => {
    const f = $('#staffForm');
    const g = n => f.querySelector(`[name="${n}"]`)?.value.trim();
    const body = { name: g('name'), dept: g('dept'), role: g('role'), joinDate: g('joinDate'), isDirect: f.querySelector('[name="isDirect"]').checked };
    if (!body.name) return toast('姓名为必填', 'err');
    try {
      if (g('id')) await api('/api/staff/' + g('id'), { method: 'PUT', body });
      else await api('/api/staff', { method: 'POST', body });
      toast('人员已保存'); await loadAll(); await showTab('staff');
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#resetStaff').onclick = () => { fill('staffForm', null); };
  $('#saveTs').onclick = async () => {
    const f = $('#tsForm');
    const g = n => f.querySelector(`[name="${n}"]`)?.value.trim();
    const body = {
      staffId: g('staffId'), projectId: g('projectId'), period: g('period'),
      rdHours: Number(g('rdHours')) || 0, totalHours: Number(g('totalHours')) || 0,
      staffName: staffName(g('staffId')),
    };
    if (!body.staffId || !body.period) return toast('人员与月份必填', 'err');
    try {
      if (g('id')) await api('/api/timesheets/' + g('id'), { method: 'PUT', body });
      else await api('/api/timesheets', { method: 'POST', body });
      toast('工时已保存'); await loadAll(); await showTab('staff');
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#resetTs').onclick = () => { fill('tsForm', null); };
  $('#tsBatchBtn').onclick = async () => {
    const ta = $('#tsBatch');
    const lines = ta.value.split('\n').map(s => s.trim()).filter(Boolean);
    if (!lines.length) return toast('请先粘贴工时数据', 'err');
    try {
      const r = await api('/api/timesheets/batch', { method: 'POST', body: { lines } });
      const msg = r.errors && r.errors.length
        ? `成功 ${r.ok} 条;失败 ${r.errors.length} 条\n` + r.errors.slice(0, 5).join('\n')
        : `成功导入 ${r.ok} 条工时`;
      toast(msg, r.errors && r.errors.length ? 'err' : undefined);
      if (r.errors && r.errors.length) alert('失败明细:\n' + r.errors.slice(0, 15).join('\n'));
      ta.value = '';
      await loadAll(); await showTab('staff');
    } catch (e) { toast(e.message, 'err'); }
  };
  bindTemplateDownload('tsTmplBtn', 'timesheets');
  bindFileImport('tsFileBtn', 'tsBatch');
  $('#staffBatchBtn').onclick = async () => {
    const ta = $('#staffBatch');
    const lines = ta.value.split('\n').map(s => s.trim()).filter(Boolean);
    if (!lines.length) return toast('请先粘贴人员数据', 'err');
    try {
      const r = await api('/api/staff/batch', { method: 'POST', body: { lines } });
      const msg = r.errors && r.errors.length
        ? `成功 ${r.ok} 条;失败 ${r.errors.length} 条\n` + r.errors.slice(0, 5).join('\n')
        : `成功导入 ${r.ok} 名人员`;
      toast(msg, r.errors && r.errors.length ? 'err' : undefined);
      if (r.errors && r.errors.length) alert('失败明细:\n' + r.errors.slice(0, 15).join('\n'));
      ta.value = '';
      await loadAll(); await showTab('staff');
    } catch (e) { toast(e.message, 'err'); }
  };
  bindTemplateDownload('staffTmplBtn', 'staff');
  bindFileImport('staffFileBtn', 'staffBatch');
  $('#content').querySelectorAll('[data-edit]').forEach(btn => {
    btn.onclick = () => {
      const kind = btn.closest('table').dataset.kind;
      const type = kind === 'staff' || kind === 'ts' ? kind : (btn.closest('table').querySelector('th').textContent.includes('姓名') ? 'staff' : 'ts');
      const list = type === 'staff' ? state.staff : state.timesheets;
      const it = list.find(x => x.id === btn.dataset.edit);
      fill(type === 'staff' ? 'staffForm' : 'tsForm', it);
    };
  });
  $('#content').querySelectorAll('[data-del]').forEach(btn => {
    btn.onclick = async () => {
      const kind = btn.closest('table').dataset.kind;
      let type;
      if (kind === 'staff' || kind === 'ts') type = kind;
      else if (kind === 'taxroll') type = 'taxroll';
      else type = btn.closest('table').querySelector('th').textContent.includes('姓名') ? 'staff' : 'timesheets';
      if (!confirm('确认删除?')) return;
      await api(`/api/${type}/${btn.dataset.del}`, { method: 'DELETE' });
      toast('已删除'); await loadAll(); await showTab('staff');
    };
  });
  $('#addTaxroll').onclick = async () => {
    const f = $('#taxrollForm');
    const g = n => f.querySelector(`[name="${n}"]`)?.value.trim();
    const staffId = g('staffId'); const year = g('year');
    if (!staffId || !year) return toast('人员与年度必填', 'err');
    if (state.taxroll.some(t => t.staffId === staffId && String(t.year) === year)) return toast('该人员本年度已登记', 'err');
    try {
      await api('/api/taxroll', { method: 'POST', body: { staffId, staffName: staffName(staffId), year: Number(year) } });
      toast('已登记个税申报'); await loadAll(); await showTab('staff');
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#compareTaxroll').onclick = () => {
    const year = String($('#taxrollForm').querySelector('[name="year"]').value.trim() || state.year);
    const inTax = new Set(state.taxroll.filter(t => String(t.year) === year).map(t => t.staffId));
    const missing = state.staff.filter(pp => pp.isDirect === true && !inTax.has(pp.id));
    const box = $('#taxrollResult');
    if (!missing.length) box.innerHTML = `<span class="tag tag-green"> ${year}年直接研发人员已全部在个税名单</span>`;
    else box.innerHTML = `<span class="tag tag-red">⚠ ${year}年缺 ${missing.length} 人:${missing.map(m => m.name).join('、')}</span>`;
  };
}

/* ---------- 凭证附件 ---------- */
let curExpId = null;

async function refreshAttach() {
  if (!curExpId) return;
  const list = await api('/api/expenses/' + curExpId + '/attachments');
  const box = $('#attachList');
  if (!box) return;
  box.innerHTML = list.map(a => `
    <div class="att-item">
      <a href="${a.url}" target="_blank" rel="noopener"> ${esc(a.name.replace(/^f_[a-f0-9]+_/, ''))}</a>
      <span class="muted">${(a.size / 1024).toFixed(0)} KB</span>
      <button class="btn-link danger" data-del="${esc(a.name)}">删除</button>
    </div>`).join('') || '<div class="muted">暂无附件,上传发票/付款凭证照片留痕</div>';
  $('#attachList').querySelectorAll('[data-del]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('删除该附件?')) return;
      await api(`/api/expenses/${curExpId}/attachments/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' });
      await loadAll(); await refreshAttach();
    };
  });
}

function uploadFiles(expId, files) {
  Array.from(files).forEach(file => {
    if (file.size > 10 * 1024 * 1024) return toast('「' + file.name + '」超过 10MB,已跳过', 'err');
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await api(`/api/expenses/${expId}/attachments`, { method: 'POST', body: { name: file.name, dataUrl: reader.result } });
        toast('已上传 ' + file.name);
        await loadAll(); await refreshAttach();
      } catch (e) { toast(e.message, 'err'); }
    };
    reader.readAsDataURL(file);
  });
}

/* ---------- 费用归集 ---------- */
async function renderExpenses() {
  const yearExp = state.expenses.filter(e => String(e.period || '').startsWith(state.year));
  $('#content').innerHTML = `
    <div class="card"><h3>新增/编辑费用</h3>
      <div class="form-grid" id="expForm">
        <input type="hidden" name="id">
        <label>项目${select('projectId', state.projects.map(p => ({ key: p.id, label: `${p.code} ${p.name}` })), '')}</label>
        <label>费用类别${select('category', state.meta?.categories || [], 'personnel')}</label>
        <label>金额(元)<input type="number" name="amount" step="0.01"></label>
        <label>日期<input type="date" name="date" value="${state.year}-01-01"></label>
        <label>归属期间${monthSelect('period', state.year + '-01')}</label>
        <label>支出类型${select('capitalization', [{ key: 'expense', label: '费用化' }, { key: 'capitalize', label: '资本化' }], 'expense')}</label>
        <label>分摊方法${select('allocMethod', state.meta?.allocMethods || [], 'direct')}</label>
        <label class="wide" id="allocWrap"></label>
        <label>凭证号<input name="voucherNo" placeholder="如 记-2025-001"></label>
        <label>发票号<input name="invoiceNo"></label>
        <label>合同号<input name="contractNo"></label>
        <label>领料单号<input name="materialNo" placeholder="材料/直接投入类必填" title="研发领料必须留存领料单并标注项目编号(金税四期比对;无领料单的材料费易被剔除)"></label>
        <label>付款方式${select('paymentMethod', ['银行转账', '现金', '其他'], '银行转账')}</label>
        <label class="wide">摘要<input name="summary" placeholder="费用内容(建议注明研发用途)"></label>
      </div>
      <div class="flex">
        <button class="btn btn-primary" id="saveExp">保存费用</button>
        <button class="btn" id="resetExp">清空</button>
      </div>
    </div>
    <div class="card" id="attachCard" style="display:none">
      <h3>凭证附件 <span class="sub">发票/付款凭证照片或 PDF,费用发生时随手留痕,年底自动打包进备查资料(单文件≤10MB)</span></h3>
      <div id="attachList"></div>
      <div class="flex mt">
        <input type="file" id="attachFile" multiple accept="image/*,.pdf,.jpg,.jpeg,.png,.webp">
        <button class="btn btn-primary" id="uploadAttach">上传附件</button>
      </div>
    </div>
    <div class="card"><h3>批量粘贴导入 <span class="sub">格式:日期|项目编号|类别key|金额|摘要|期间|分摊方法|支出类型|凭证号|发票号|付款方式</span></h3>
      <div class="flex" style="flex-wrap:wrap;gap:6px;margin-bottom:6px">
        <button class="btn" id="expTmplBtn">下载费用导入模板(CSV)</button>
        <button class="btn" id="expFileBtn">从文件导入到文本框</button>
      </div>
      <textarea id="batchBox" placeholder="2025-03-05|2025-RD-01|direct|86000|电子元器件材料|2025-03|direct|费用化|记-2025-020|FP-2025-0301|银行转账&#10;一行一条,支持 # 注释行与表头行,类别key见下方说明"></textarea>
      <div class="flex mt">
        <button class="btn btn-primary" id="batchBtn">批量导入</button>
        <span class="muted">类别key: personnel人员人工 / direct直接投入 / depreciation折旧 / amortization摊销 / design设计试验 / other其他相关 / entrust_domestic_org委托境内机构 / entrust_overseas委托境外</span>
      </div>
    </div>
    <div class="card"><h3>特殊收入冲减 <span class="sub">研发过程中形成的下脚料/残次品/试制品销售收入,应冲减研发费用(2017年40号)</span></h3>
      <div class="form-grid" id="siForm">
        <input type="hidden" name="id">
        <label>项目${select('projectId', state.projects.map(p => ({ key: p.id, label: `${p.code} ${p.name}` })), '')}</label>
        <label>类型${select('type', state.meta?.specialIncomeTypes || [], 'scrap')}</label>
        <label>金额(元)<input type="number" name="amount" step="0.01"></label>
        <label>日期<input type="date" name="date" value="${state.year}-01-01"></label>
        <label>归属期间${monthSelect('period', state.year + '-01')}</label>
        <label class="wide">说明<input name="summary" placeholder="如:样机试制产生的下脚料销售"></label>
      </div>
      <div class="flex">
        <button class="btn btn-primary" id="saveSi">保存特殊收入</button>
        <button class="btn" id="resetSi">清空</button>
      </div>
      <div class="table-wrap mt"><table data-kind="specialIncomes">
        <tr><th>日期</th><th>项目</th><th>类型</th><th>说明</th><th class="num">金额(元)</th><th>操作</th></tr>
        ${state.specialIncomes.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')).map(si => `<tr>
          <td>${esc(si.date)}</td><td>${esc(projOf(si.projectId).code)}</td>
          <td>${esc((state.meta?.specialIncomeTypes || []).find(t => t.key === si.type)?.name || si.type)}</td>
          <td>${esc(si.summary || si.note || '')}</td><td class="num">${fmt(si.amount)}</td>
          <td><button class="btn-link" data-edit="${si.id}">编辑</button><button class="btn-link danger" data-del="${si.id}">删除</button></td>
        </tr>`).join('') || '<tr><td colspan="6" class="empty">暂无特殊收入记录</td></tr>'}
      </table></div>
    </div>
    <div class="card"><h3>资本化项目摊销台账 <span class="sub">形成无形资产后,按年度录入摊销额(加计=摊销额×100%;IC企业120%)</span></h3>
      <div class="hint">自动生成:成本 × 200% ÷ 年限(摊销年限不得低于10年,有约定按约定),每年摊销额 = 成本×2÷年限。</div>
      <div class="form-grid" id="planForm">
        <label>项目${select('planProjectId', state.projects.filter(p => p.capitalization === 'capitalize').map(p => ({ key: p.id, label: `${p.code} ${p.name}` })), '')}</label>
        <label>起始年度<input type="number" name="startYear" value="${Number(state.year) + 1}"></label>
        <label>摊销年限(≥10)<input type="number" name="years" value="10"></label>
        <label>成本(元,留空自动取资本化成本)<input type="number" name="cost" step="0.01" placeholder="自动取该项目资本化支出"></label>
      </div>
      <div class="flex">
        <button class="btn btn-primary" id="planAm">自动生成摊销计划</button>
        <div id="planResult" class="muted" style="font-size:12px;align-self:center"></div>
      </div>
      <div class="form-grid mt" id="amForm">
        <input type="hidden" name="id">
        <label>项目${select('projectId', state.projects.filter(p => p.capitalization === 'capitalize').map(p => ({ key: p.id, label: `${p.code} ${p.name}` })), '')}</label>
        <label>年度<input type="number" name="year" value="${Number(state.year) + 1}"></label>
        <label>形成年度<input type="number" name="formationYear" placeholder="留空=该项目最早摊销年度" title="该无形资产形成(达到预定可使用状态)的年度,用于A107012行43/44分流"></label>
        <label>本年摊销额(元)<input type="number" name="amount" step="0.01"></label>
        <label class="wide">说明<input name="note"></label>
      </div>
      <div class="flex"><button class="btn btn-primary" id="saveAm">保存摊销</button></div>
      <div class="table-wrap mt"><table data-kind="amortizations">
        <tr><th>项目</th><th class="num">年度</th><th class="num">形成年度</th><th class="num">摊销额</th><th>说明</th><th>操作</th></tr>
        ${state.amortizations.map(a => `<tr>
          <td>${esc(projOf(a.projectId).code)} ${esc(projOf(a.projectId).name)}</td><td class="num">${a.year}</td><td class="num">${a.formationYear || '—'}</td><td class="num">${fmt(a.amount)}</td>
          <td>${esc(a.note || '')}</td>
          <td><button class="btn-link" data-edit="${a.id}">编辑</button><button class="btn-link danger" data-del="${a.id}">删除</button></td>
        </tr>`).join('') || '<tr><td colspan="6" class="empty">暂无摊销记录</td></tr>'}
      </table></div>
    </div>
    <div class="card"><h3>${state.year}年费用明细</h3>
      <div class="table-wrap"><table data-kind="expenses">
        <tr><th>日期</th><th>项目</th><th>类别</th><th>摘要</th><th class="num">金额(元)</th><th>类型</th><th>分摊</th><th>凭证</th><th>发票</th><th>付款</th><th>附件</th><th>操作</th></tr>
        ${yearExp.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')).map(e => {
          const atts = state.attachMap[e.id] || [];
          return `<tr>
          <td>${esc(e.date)}</td><td>${esc(projOf(e.projectId).code)}</td><td>${esc(catName(e.category))}</td>
          <td>${esc(e.summary)}</td><td class="num">${fmt(e.amount)}</td>
          <td>${e.capitalization === 'capitalize' ? '<span class="tag tag-blue">资本化</span>' : '费用化'}</td>
          <td>${e.allocMethod === 'direct' ? '<span class="muted">直接归集</span>' : `<span class="tag tag-gray">${e.allocMethod === 'ratioHours' ? '按工时' : '按权重'}</span>`}</td>
          <td>${esc(e.voucherNo || '—')}</td><td>${esc(e.invoiceNo || '—')}</td><td>${esc(e.paymentMethod || '—')}</td>
          <td>${atts.length ? `<a class="btn-link" href="${atts[0].url}" target="_blank" rel="noopener" title="${atts.map(a => a.name).join(', ')}"> ${atts.length} 个</a>` : '<span class="muted">—</span>'}</td>
          <td><button class="btn-link" data-edit="${e.id}">编辑</button><button class="btn-link danger" data-del="${e.id}">删除</button></td>
        </tr>`;
        }).join('') || '<tr><td colspan="12" class="empty">暂无费用,可用上方批量导入或手工录入</td></tr>'}
      </table></div>
    </div>`;
  // 分摊方法联动
  const am = document.querySelector('#expForm [name="allocMethod"]');
  const wrap = $('#allocWrap');
  const syncAlloc = () => {
    if (am.value === 'ratioHours') {
      wrap.innerHTML = '<label class="wide">分摊说明<input name="allocNote" placeholder="如:按2025-03研发工时比例分摊(工时台账自动取数)"></label>';
    } else if (am.value === 'ratioCustom') {
      wrap.innerHTML = `<label class="wide">自定义权重(格式:项目id:权重,如 p1:0.6,p2:0.4)<input name="allocWeights" placeholder="p1:0.6,p2:0.4"></label>`;
    } else {
      wrap.innerHTML = '';
    }
  };
  am.onchange = syncAlloc;
  syncAlloc();
}
function bindExpenses() {
  $('#saveExp').onclick = async () => {
    const f = $('#expForm');
    const g = n => f.querySelector(`[name="${n}"]`)?.value.trim();
    const allocMethod = g('allocMethod');
    const alloc = {};
    if (allocMethod === 'ratioCustom') {
      (g('allocWeights') || '').split(/[,，;；]/).forEach(pair => {
        const [pid, w] = pair.split(':');
        if (pid && w) alloc[pid.trim()] = Number(w);
      });
    }
    const body = {
      projectId: g('projectId'), category: g('category'), amount: Number(g('amount')) || 0,
      date: g('date'), period: g('period') || (g('date') || '').slice(0, 7),
      capitalization: g('capitalization'), allocMethod,
      isShared: allocMethod !== 'direct', allocNote: g('allocNote') || '',
      alloc, voucherNo: g('voucherNo'), invoiceNo: g('invoiceNo'), contractNo: g('contractNo'), materialNo: g('materialNo'),
      paymentMethod: g('paymentMethod'), summary: g('summary'),
    };
    if (!body.projectId || !body.amount) return toast('项目与金额必填', 'err');
    // 不可计入项关键词拦截(培训/房屋折旧/物业水电/招待/商业保险)
    const hit = (state.meta?.nonDeductibleKeywords || []).find(k => String(body.summary || '').includes(k));
    if (hit) return toast(`摘要命中不可计入项关键词「${hit}」:培训费/房屋折旧/物业水电/业务招待费/商业保险等不属于可加计研发费用,请移出`, 'err');
    try {
      const saved = g('id')
        ? await api('/api/expenses/' + g('id'), { method: 'PUT', body })
        : await api('/api/expenses', { method: 'POST', body });
      curExpId = saved.id;
      toast('费用已保存'); await loadAll(); await showTab('expenses');
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#resetExp').onclick = () => { curExpId = null; showTab('expenses'); };
  $('#batchBtn').onclick = async () => {
    const text = $('#batchBox').value.trim();
    if (!text) return toast('请粘贴数据', 'err');
    const lines = text.split('\n').filter(l => l.trim());
    try {
      const r = await api('/api/expenses/batch', { method: 'POST', body: { lines } });
      toast(`导入成功 ${r.ok} 条${r.errors.length ? `,失败 ${r.errors.length} 条:${r.errors[0]}` : ''}`, r.errors.length ? 'err' : 'ok');
      if (r.errors.length) alert('失败明细:\n' + r.errors.join('\n'));
      await loadAll(); await showTab('expenses');
    } catch (e) { toast(e.message, 'err'); }
  };
  bindTemplateDownload('expTmplBtn', 'expenses');
  bindFileImport('expFileBtn', 'batchBox');
  $('#saveAm').onclick = async () => {
    const f = $('#amForm');
    const g = n => f.querySelector(`[name="${n}"]`)?.value.trim();
    const body = { projectId: g('projectId'), year: Number(g('year')), amount: Number(g('amount')) || 0, formationYear: g('formationYear') ? Number(g('formationYear')) : undefined, note: g('note') };
    if (!body.projectId || !body.year) return toast('项目与年度必填', 'err');
    try {
      if (g('id')) await api('/api/amortizations/' + g('id'), { method: 'PUT', body });
      else await api('/api/amortizations', { method: 'POST', body });
      toast('摊销已保存'); await loadAll(); await showTab('expenses');
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#content').querySelectorAll('[data-edit]').forEach(btn => {
    btn.onclick = async () => {
      const table = btn.closest('table');
      const kind = table.dataset.kind;
      if (kind === 'amortizations') {
        const it = state.amortizations.find(x => x.id === btn.dataset.edit);
        const f = $('#amForm');
        Object.entries(it).forEach(([k, v]) => { const el = f.querySelector(`[name="${k}"]`); if (el) el.value = v ?? ''; });
        return;
      }
      if (kind === 'specialIncomes') {
        const it = state.specialIncomes.find(x => x.id === btn.dataset.edit);
        const f = $('#siForm');
        Object.entries(it).forEach(([k, v]) => { const el = f.querySelector(`[name="${k}"]`); if (el) el.value = v ?? ''; });
        return;
      }
      const it = state.expenses.find(x => x.id === btn.dataset.edit);
      const f = $('#expForm');
      Object.entries(it).forEach(([k, v]) => { const el = f.querySelector(`[name="${k}"]`); if (el) el.value = v ?? ''; });
      if (it.allocMethod === 'ratioCustom' && it.alloc) {
        const w = Object.entries(it.alloc).map(([k, v]) => `${k}:${v}`).join(',');
        f.querySelector('[name="allocWeights"]').value = w;
      }
      document.querySelector('#expForm [name="allocMethod"]').dispatchEvent(new Event('change'));
      // 显示该费用的凭证附件
      curExpId = it.id;
      const ac = $('#attachCard');
      if (ac) { ac.style.display = ''; refreshAttach(); }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
  });
  // 附件上传
  const ac = $('#attachCard');
  if (ac) {
    $('#uploadAttach').onclick = () => {
      const file = $('#attachFile');
      if (!file.files.length) return toast('请先选择文件', 'err');
      if (!curExpId) return toast('请先保存费用,再上传附件', 'err');
      uploadFiles(curExpId, file.files);
      file.value = '';
    };
    if (curExpId) { ac.style.display = ''; refreshAttach(); }
  }
  $('#content').querySelectorAll('[data-del]').forEach(btn => {
    btn.onclick = async () => {
      const table = btn.closest('table');
      const kind = table.dataset.kind;
      const key = kind === 'amortizations' ? 'amortizations' : kind === 'specialIncomes' ? 'specialIncomes' : 'expenses';
      if (!confirm('确认删除?')) return;
      await api(`/api/${key}/${btn.dataset.del}`, { method: 'DELETE' });
      toast('已删除'); await loadAll(); await showTab('expenses');
    };
  });
  // 特殊收入
  $('#saveSi').onclick = async () => {
    const f = $('#siForm');
    const g = n => f.querySelector(`[name="${n}"]`)?.value.trim();
    const body = {
      projectId: g('projectId'), type: g('type'), amount: Number(g('amount')) || 0,
      date: g('date'), period: g('period') || (g('date') || '').slice(0, 7), summary: g('summary'),
    };
    if (!body.projectId || !body.amount) return toast('项目与金额必填', 'err');
    try {
      if (g('id')) await api('/api/specialIncomes/' + g('id'), { method: 'PUT', body });
      else await api('/api/specialIncomes', { method: 'POST', body });
      toast('特殊收入已保存'); await loadAll(); await showTab('expenses');
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#resetSi').onclick = () => { const f = $('#siForm'); f.querySelectorAll('input,select').forEach(el => el.value = ''); showTab('expenses'); };
  // 摊销计划自动生成
  $('#planAm').onclick = async () => {
    const f = $('#planForm');
    const g = n => f.querySelector(`[name="${n}"]`)?.value.trim();
    const body = {
      projectId: g('planProjectId'), startYear: Number(g('startYear')), years: Number(g('years')),
      cost: g('cost') !== '' ? Number(g('cost')) : undefined,
    };
    if (!body.projectId) return toast('请选择资本化项目', 'err');
    try {
      const r = await api('/api/amortization/plan', { method: 'POST', body });
      $('#planResult').innerHTML = `<span class="tag tag-green"> 已生成 ${r.count} 年摊销:成本 ${fmt(r.formed)} × 200% ÷ ${r.years} 年,每年 ${fmt(r.annual)}</span>`;
      toast(`已生成 ${r.count} 条摊销计划`);
      await loadAll(); await showTab('expenses');
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* ---------- 共用资源(设备/厂房/云服务台账:折旧分摊依据) ---------- */
const ASSET_TYPES = [
  ['equipment', '设备'],
  ['cloud', '云服务/软件'],
  ['building', '厂房/场地'],
  ['utility', '水电燃气'],
  ['other', '其他'],
];
const ASSET_TYPE_NAME = Object.fromEntries(ASSET_TYPES);

async function renderAssets() {
  const y = state.year;
  const yearAssets = (state.assets || []).filter(a => !a.period || String(a.period).startsWith(String(y)));
  const rows = yearAssets.map(a => {
    const rd = Number(a.rdHours) || 0, tot = Number(a.totalHours) || 0;
    const ratio = tot > 0 ? rd / tot : 0;
    const cost = Number(a.depreciation) || 0;
    return `<tr>
      <td>${esc(a.name)}</td><td>${ASSET_TYPE_NAME[a.type] || a.type || ''}</td>
      <td class="num">${fmt(cost)}</td><td class="num">${rd}</td><td class="num">${tot}</td>
      <td class="num">${(ratio * 100).toFixed(1)}%</td><td class="num"><b>${fmt(Math.round(cost * ratio * 100) / 100)}</b></td>
      <td><button class="btn-link" data-edit="${a.id}">编辑</button><button class="btn-link danger" data-del="${a.id}">删除</button></td>
    </tr>`;
  }).join('');
  $('#content').innerHTML = `
    <div class="hint"> 共用设备/厂房/云服务等资源若同时用于研发与生产,<b>必须留存使用工时台账</b>作为折旧/租金分摊依据(税局重点核查:共用设备无台账、折旧全额计入研发被调减的案例频发)。登记后系统自动计算<b>研发分摊额</b>,可导出分摊表(备查包 13)。</div>
    <div class="card"><h3>新增/编辑共用资源</h3>
      <div class="form-grid" id="assetForm">
        <input type="hidden" name="id">
        <label>资源名称<input name="name" placeholder="如:3D打印机 / 云服务器 / 研发车间"></label>
        <label>类型${select('type', ASSET_TYPES.map(([k, v]) => ({ key: k, label: v })), 'equipment')}</label>
        <label>归属年度<input type="number" name="period" value="${y}" min="2020" max="2035"></label>
        <label>年度费用(折旧/租金/使用费,元)<input type="number" name="depreciation" min="0" placeholder="该资源全年折旧或租金"></label>
        <label>年研发使用工时(小时)<input type="number" name="rdHours" min="0" placeholder="如:全年研发使用 1200 小时"></label>
        <label>年总使用工时(小时)<input type="number" name="totalHours" min="0" placeholder="研发+生产合计使用"></label>
        <label class="wide">备注<textarea name="note" placeholder="如:3台设备共用,按运行工时分摊;云服务器研发/运营各半"></textarea></label>
      </div>
      <div class="flex">
        <button class="btn btn-primary" id="saveAsset">保存资源</button>
        <button class="btn" id="resetAsset">清空表单</button>
      </div>
    </div>
    <div class="card"><h3>共用资源分摊台账(${y}年) <span class="sub">研发占比 × 年度费用 = 计入研发费用的分摊额</span></h3>
      <div class="flex mb"><button class="btn" id="exportAssets"> 导出分摊表 CSV(备查)</button></div>
      <div class="table-wrap"><table>
        <tr><th>名称</th><th>类型</th><th>年度费用(元)</th><th>研发工时</th><th>总工时</th><th>研发占比</th><th>研发分摊额(元)</th><th>操作</th></tr>
        ${rows || '<tr><td colspan="8" class="empty">暂无登记。共用设备/厂房/云服务请在此登记,否则相关折旧全额计入研发将被税务调减。</td></tr>'}
      </table></div>
      <div class="muted" style="font-size:12px;margin-top:6px">分摊表请与折旧/租金凭证、设备使用记录一并留存备查;研发分摊额应与「费用归集」中共用折旧的入账金额口径一致。</div>
    </div>`;
}
function bindAssets() {
  $('#saveAsset').onclick = async () => {
    const f = $('#assetForm');
    const g = n => f.querySelector(`[name="${n}"]`)?.value.trim();
    const id = g('id');
    const body = {
      name: g('name'), type: g('type'), period: g('period'),
      depreciation: Number(g('depreciation')) || 0,
      rdHours: Number(g('rdHours')) || 0,
      totalHours: Number(g('totalHours')) || 0,
      note: g('note'),
    };
    if (!body.name) return toast('资源名称为必填', 'err');
    if (body.totalHours > 0 && body.rdHours > body.totalHours) return toast('研发工时不能大于总工时', 'err');
    try {
      if (id) await api('/api/assets/' + id, { method: 'PUT', body });
      else await api('/api/assets', { method: 'POST', body });
      toast('资源已保存'); await loadAll(); await showTab('assets');
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#resetAsset').onclick = () => showTab('assets');
  const exp = $('#exportAssets');
  if (exp) exp.onclick = () => downloadUrl(`/api/export/assets.csv?year=${state.year}`);
  $('#content').querySelectorAll('[data-edit]').forEach(btn => btn.onclick = () => {
    const a = state.assets.find(x => x.id === btn.dataset.edit);
    const f = $('#assetForm');
    Object.entries({ name: a.name, type: a.type, period: a.period || String(state.year), depreciation: a.depreciation,
      rdHours: a.rdHours, totalHours: a.totalHours, note: a.note || '', id: a.id }).forEach(([k, v]) => {
      const el = f.querySelector(`[name="${k}"]`);
      if (el) el.value = v ?? '';
    });
  });
  $('#content').querySelectorAll('[data-del]').forEach(btn => btn.onclick = async () => {
    if (!confirm('删除该资源台账?')) return;
    await api('/api/assets/' + btn.dataset.del, { method: 'DELETE' });
    toast('已删除'); await loadAll(); await showTab('assets');
  });
}

/* ---------- 辅助账(97号公告:自主研发/委托/合作/集中 + 明细汇总) ---------- */
let ledgerTab = 'self';
const LEDGER_TABS = [
  { key: 'self', label: '自主研发' },
  { key: 'entrust', label: '委托研发' },
  { key: 'cooperation', label: '合作研发' },
  { key: 'centralized', label: '集中研发' },
  { key: 'detail', label: '明细汇总' },
];
const SIX_COLS = [
  ['personnel', '一、人员人工'],
  ['direct', '二、直接投入'],
  ['depreciation', '三、折旧费用'],
  ['amortization', '四、无形资产摊销'],
  ['design', '五、新产品设计费等'],
  ['other', '六、其他相关'],
];
const FORM_OF = { self: '自主研发', entrust_domestic_org: '委托境内机构', entrust_domestic_person: '委托境内个人', entrust_overseas: '委托境外机构', entrust_overseas_person: '委托境外个人', cooperation: '合作研发', centralized: '集中研发' };

function projCardHead(it) {
  return `<h3>${esc(it.project.code)} ${esc(it.project.name)} <span class="sub">${FORM_OF[it.project.form] || formName(it.project.form)}</span>
    ${it.project.capitalization === 'capitalize' ? '<span class="tag tag-blue">资本化支出</span>' : '<span class="tag">费用化支出</span>'}
    ${it.isAmortOnly ? '<span class="tag tag-blue">仅本年摊销(已形成无形资产)</span>' : ''}
    <span class="tag ${it.project.status === '进行中' ? 'tag-green' : ''}">${esc(it.project.status || '')}</span>
    ${it.project.resultOwner === 'client' ? '<span class="tag tag-red">受托开发(不得加计)</span>' : ''}</h3>`;
}

function empty97(kind) {
  return `<div class="card"><div class="empty">该年度没有「${kind}」项目费用数据。
    <br>适用情形:${kind === '自主研发' ? '企业依靠自己的资源、技术、人力独立研发,成果归本企业。' : kind === '委托研发' ? '企业委托外部机构/个人研发,加计基数为发生额×80%。' : kind === '合作研发' ? '企业与外部单位共同研发,按各自实际发生费用分别归集。' : '集团统一立项集中研发,再按比例分摊到各成员企业。'}
    <br>请在「研发项目」中把项目研发形式设为「${kind}」并录入费用。</div></div>`;
}

function selfHtml(l97) {
  if (!l97.self.length) return empty97('自主研发');
  return l97.self.map(it => `
    <div class="card">
      ${projCardHead(it)}
      <div class="table-wrap"><table class="l97">
        <tr><th>序号</th><th>日期</th><th>凭证种类及号数</th><th>摘要</th><th class="num">借方金额</th><th class="num">贷方金额</th><th>借或贷</th><th class="num">余额</th>
          ${SIX_COLS.map(c => `<th class="num">${c[1]}</th>`).join('')}<th>备注</th></tr>
        ${it.rows.map(r => `
          <tr>
            <td>${r.seq}</td><td>${esc(r.date)}</td><td>${esc(r.voucherNo)}</td><td>${esc(r.summary)}</td>
            <td class="num">${fmt(r.amount)}</td><td class="num"></td><td>借</td><td class="num">${fmt(r.balance)}</td>
            ${SIX_COLS.map(c => `<td class="num">${r.category === c[0] ? fmt(r.amount) : ''}</td>`).join('')}
            <td class="muted">${r.isEntrust ? '委托研发(见委托辅助账)' : (r.isAllocated ? `分摊(原值${fmt(r.originalAmount)})` : esc(r.allocNote || ''))}</td>
          </tr>`).join('')}
        <tr class="l97-total"><td colspan="4"><b>借方合计 / 期末余额</b></td><td class="num"><b>${fmt(it.total)}</b></td><td class="num"></td><td></td><td class="num"><b>${it.rows.length ? fmt(it.rows[it.rows.length - 1].balance) : '0.00'}</b></td>
          ${SIX_COLS.map(c => `<td class="num"><b>${it.six[c[0]] ? fmt(it.six[c[0]]) : ''}</b></td>`).join('')}<td></td></tr>
        <tr class="l97-total"><td colspan="4"><b>其中:费用化 / 资本化</b></td><td class="num">${fmt(it.expenseSum)}</td><td class="num"></td><td></td><td class="num">${fmt(it.capitalizeSum)}</td>
          <td colspan="${SIX_COLS.length}"></td><td></td></tr>
      </table></div>
      <div class="muted" style="font-size:12px;margin-top:6px">期初余额 0.00;贷方金额为结转分录(结转管理费用/无形资产)时填报,本系统按借方发生额归集。</div>
    </div>`).join('');
}

function entrustHtml(l97) {
  if (!l97.entrust.length) return empty97('委托研发');
  const warn = l97.overseasExcess > 0;
  return `
  <div class="card">
    <h3>委托研发加计基数说明 <span class="sub">委托境内/境外机构或个人研发</span></h3>
    <div class="muted" style="line-height:1.8">
      境内委托:加计基数 = 实际发生额 × 80%(委托个人须凭发票等合法有效凭证)。<br>
      境外委托:加计基数 = 实际发生额 × 80%,且不得超过 <b>境内可加计基数 × 2/3</b>。
      本年度境内可加计基数(自主研发 + 境内委托×80%)= <b>${fmt(l97.domesticBase)}</b>,境外限额 = <b>${fmt(l97.cap2of3)}</b>,
      境外委托加计基数合计 = <b>${fmt(l97.overseasTotalBase)}</b>
      ${warn ? `<span class="tag tag-red">超出限额 ${fmt(l97.overseasExcess)},超出部分不得加计,请核减</span>` : '<span class="tag tag-green">未超限额</span>'}。
    </div>
  </div>
  ${l97.entrust.map(it => `
    <div class="card">
      ${projCardHead(it)}
      <div class="table-wrap"><table class="l97">
        <tr><th>序号</th><th>日期</th><th>凭证号</th><th>摘要</th><th>委托类型</th><th class="num">实际发生金额</th><th class="num">加计扣除基数(×80%)</th><th>备注</th></tr>
        ${it.rows.map(r => `<tr>
          <td>${r.seq}</td><td>${esc(r.date)}</td><td>${esc(r.voucherNo)}</td><td>${esc(r.summary)}</td>
          <td>${FORM_OF[it.entrustType] || it.entrustType}</td>
          <td class="num">${fmt(r.amount)}</td><td class="num">${fmt(r.dedBase)}</td>
          <td class="muted">${r.isAllocated ? `分摊(原值${fmt(r.originalAmount)})` : esc(r.allocNote || '')}</td>
        </tr>`).join('')}
        <tr class="l97-total"><td colspan="5"><b>合计</b></td><td class="num"><b>${fmt(it.total)}</b></td><td class="num"><b>${fmt(it.dedBase)}</b></td><td></td></tr>
      </table></div>
      ${it.isOverseas ? `<div class="muted" style="font-size:12px;margin-top:4px">境外委托:若全部境外项目加计基数合计超过境内×2/3 限额,超出部分不得加计(见上方说明)。</div>` : ''}
    </div>`).join('')}`;
}

function shareHtml(l97, key, kind) {
  if (!l97[key].length) return empty97(kind);
  return l97[key].map(it => `
    <div class="card">
      ${projCardHead(it)}
      <div class="table-wrap"><table class="l97">
        <tr><th>序号</th><th>日期</th><th>凭证号</th><th>摘要</th><th class="num">${kind}费用发生额</th><th class="num">本企业分摊金额</th><th class="num">加计扣除基数</th><th>备注</th></tr>
        ${it.rows.map(r => `<tr>
          <td>${r.seq}</td><td>${esc(r.date)}</td><td>${esc(r.voucherNo)}</td><td>${esc(r.summary)}</td>
          <td class="num">${r.isAllocated ? fmt(r.originalAmount) : fmt(r.amount)}</td>
          <td class="num">${fmt(r.amount)}</td><td class="num">${fmt(r.dedBase ?? r.amount)}</td>
          <td class="muted">${r.isAllocated ? `分摊(原值${fmt(r.originalAmount)})` : esc(r.allocNote || '')}</td>
        </tr>`).join('')}
        <tr class="l97-total"><td colspan="4"><b>合计</b></td><td class="num"><b>${fmt(it.total)}</b></td><td class="num"><b>${fmt(it.total)}</b></td><td class="num"><b>${fmt(it.dedBase ?? it.total)}</b></td><td></td></tr>
      </table></div>
      <div class="muted" style="font-size:12px;margin-top:4px">${kind === '合作研发' ? '合作研发:企业与合作方共同投入,按各自实际发生费用分别归集核算,本企业份额即本企业可加计金额。' : '集中研发:集团统一立项,费用按合理比例分摊到各成员企业,本企业分摊金额即本企业可加计金额。'}</div>
    </div>`).join('');
}

function ledgerDetailHtml(ledger) {
  return `
    <div class="flex mb">
      <div class="grid-cards" style="flex:1; grid-template-columns:repeat(3,1fr); margin:0">
        <div class="stat"><div class="k">费用化合计</div><div class="v">${fmt(ledger.grand.expenseSum)}</div></div>
        <div class="stat"><div class="k">资本化合计</div><div class="v">${fmt(ledger.grand.capitalizeSum)}</div></div>
        <div class="stat"><div class="k">${state.year}年研发支出合计</div><div class="v">${fmt(ledger.grand.total)}</div></div>
      </div>
      <button class="btn btn-primary" id="exportLedger"> 导出辅助账 Excel</button>
    </div>
    ${ledger.projects.map(item => `
      <div class="card"><h3>${esc(item.project.code)} ${esc(item.project.name)} <span class="sub">${formName(item.project.form)} · ${esc(item.project.startDate)}~${esc(item.project.endDate)}</span></h3>
        <div class="table-wrap"><table>
          <tr><th>序号</th><th>日期</th><th>凭证号</th><th>摘要</th><th>费用类别</th><th>支出类型</th><th class="num">金额(元)</th><th>备注</th></tr>
          ${item.rows.map((r, i) => `<tr>
            <td>${i + 1}</td><td>${esc(r.date)}</td><td>${esc(r.voucherNo)}</td><td>${esc(r.summary)}</td>
            <td>${esc(r.categoryName)}</td>
            <td>${r.expenseType === 'capitalize' ? '<span class="tag tag-blue">资本化</span>' : '费用化'}</td>
            <td class="num">${fmt(r.amount)}</td>
            <td class="muted">${r.isAllocated ? `分摊(原值${fmt(r.originalAmount)})` : esc(r.allocNote || '')}</td>
          </tr>`).join('')}
          ${Object.entries(item.monthlyTotals).map(([m, v]) => `<tr><td colspan="6" class="muted">${m} 小计</td><td class="num"><b>${fmt(v)}</b></td><td></td></tr>`).join('')}
          ${Object.entries(item.categoryTotals).map(([c, v]) => `<tr><td colspan="5" class="muted">分类合计 · ${esc(c)}</td><td colspan="1"></td><td class="num">${fmt(v)}</td><td></td></tr>`).join('')}
          <tr><td colspan="6"><b>合计</b></td><td class="num"><b>${fmt(item.total)}</b></td><td></td></tr>
        </table></div>
      </div>`).join('') || '<div class="card"><div class="empty">该年度暂无辅助账数据</div></div>'}`;
}

async function renderLedger() {
  const [l97, ledger] = await Promise.all([
    api('/api/ledger97?year=' + state.year),
    api('/api/ledger?year=' + state.year),
  ]);
  // 防御:数据文件损坏/旧版本迁移时 rows 可能缺失,归一为数组避免白屏
  const normRows = a => (a || []).map(i => ({
    ...i,
    rows: Array.isArray(i.rows) ? i.rows : [],
    six: i.six && typeof i.six === 'object' ? i.six : {},
  }));
  l97.self = normRows(l97.self); l97.entrust = normRows(l97.entrust);
  l97.cooperation = normRows(l97.cooperation); l97.centralized = normRows(l97.centralized);
  if (ledger && Array.isArray(ledger.projects)) ledger.projects = normRows(ledger.projects);
  const tabs = LEDGER_TABS.map(t => `<button class="lt-btn ${ledgerTab === t.key ? 'active' : ''}" data-lt="${t.key}">${t.label}</button>`).join('');
  const body =
    ledgerTab === 'detail' ? ledgerDetailHtml(ledger) :
    ledgerTab === 'self' ? selfHtml(l97) :
    ledgerTab === 'entrust' ? entrustHtml(l97) :
    ledgerTab === 'cooperation' ? shareHtml(l97, 'cooperation', '合作研发') :
    shareHtml(l97, 'centralized', '集中研发');
  $('#content').innerHTML = `
    <div class="flex mb">
      <div class="sub-tabs">${tabs}</div>
      <button class="btn btn-primary" id="printLedger"> 打印${LEDGER_TABS.find(t => t.key === ledgerTab).label}</button>
    </div>
    <div class="muted" style="margin-bottom:10px;font-size:12px">
      ${ledgerTab === 'detail' ? '按项目汇总的研发支出明细(2021版简化样式)。' : `按《国家税务总局公告2015年第97号》附件样式编制 · ${LEDGER_TABS.find(t => t.key === ledgerTab).label}“研发支出”辅助账 · 金额单位:元(列至角分)`}
    </div>
    ${body}`;
}

function bindLedger() {
  $$('#content .lt-btn').forEach(b => b.onclick = async () => {
    ledgerTab = b.dataset.lt;
    await renderLedger();
    bindLedger();
  });
  const p = $('#printLedger');
  if (p) p.onclick = () => window.print();
  const exp = $('#exportLedger');
  if (exp) exp.onclick = () => downloadUrl(`/api/export/ledger.xlsx?year=${state.year}`);
}

/* ---------- 申报汇总 ---------- */
async function renderSummary() {
  const s = await api('/api/summary?year=' + state.year);
  const d = s.detail;
  let cal = null;
  try { cal = await api('/api/calibers?year=' + state.year); } catch {}
  const ineligible = (s.a107012 && s.a107012.eligible === false) || d.eligible === false;
  const ineligReason = (s.a107012 && s.a107012.ineligibleReason) || d.ineligibleReason || '';
  $('#content').innerHTML = `
    ${ineligible ? `<div class="warn-box" style="margin-bottom:12px">⚠ <b>本年度不得享受研发费用加计扣除</b> — ${esc(ineligReason)}。以下 A107012/加计口径按 0 填列,请先在企业信息中处理资格问题;会计口径与辅助账仍正常留档。</div>` : ''}
    <div class="flex mb">
      <button class="btn btn-primary" id="printA107012"> 打印A107012</button>
      <button class="btn" id="exportA107012"> 导出A107012 Excel</button>
      <button class="btn" id="exportSummary"> 导出申报汇总 Excel</button>
      <span class="muted">自行判别、申报享受、留存备查</span>
    </div>
    <div class="card"><h3>A107012《研发费用加计扣除优惠明细表》 <span class="sub">${esc(s.a107012.companyName)} · ${state.year}年度 · 金额单位:元(列至角分)</span></h3>
      <div class="table-wrap"><table class="l97">
        <tr><th>行次</th><th>项目</th><th class="num">金额(数量)</th><th>计算说明</th></tr>
        ${(s.a107012.rows || []).map(r => `<tr class="${r.bold ? 'l97-total' : ''}">
          <td>${esc(r.line)}</td>
          <td style="${r.indent ? 'padding-left:' + (20 + r.indent * 20) + 'px' : ''}">${esc(r.name)}</td>
          <td class="num">${r.amount === '' ? `<span class="muted">${esc(r.note)}</span>` : fmt(r.amount)}</td>
          <td class="muted" style="font-size:11px">${r.amount === '' ? '' : esc(r.note || '')}</td>
        </tr>`).join('')}
      </table></div>
      <div class="muted" style="font-size:12px;margin-top:6px">填报口径说明:第4~6、8~15、17~18、20~22、24~27、29~33行未细分科目时留空,请按实际辅助账细分后填报;第48、49行按当年销售研发产品对应材料情况填报;第44行需区分形成年度。</div>
    </div>
    <div class="card"><h3>研发支出辅助账汇总表 <span class="sub">《国家税务总局公告2015年第97号》附件5样式 · ${state.year}年度 · 留存备查(2023年起不再报送,由企业留存)</span>
      <button class="btn btn-sm btn-primary" id="exportCollection"> 导出 Excel</button></h3>
      <div class="table-wrap"><table class="l97">
        <tr><th>序号</th><th>项目编号</th><th>项目名称</th><th>研发形式</th><th>支出类型</th><th>状态</th>
          ${s.collection.six.map(c => `<th class="num">${c[1]}</th>`).join('')}
          <th class="num">委托境内(×80%)</th><th class="num">委托境外(限额内)</th><th class="num">费用化合计</th><th class="num">资本化合计</th><th class="num">合计</th><th>备注</th></tr>
        ${(s.collection.rows || []).map((r, i) => `<tr>
          <td>${i + 1}</td><td>${esc(r.code)}</td><td>${esc(r.name)}</td><td>${FORM_OF[r.form] || r.form}</td>
          <td>${r.capitalization === 'capitalize' ? '<span class="tag tag-blue">资本化</span>' : '费用化'}</td><td>${esc(r.status)}</td>
          ${s.collection.six.map(c => `<td class="num">${r.six[c[0]] ? fmt(r.six[c[0]]) : ''}</td>`).join('')}
          <td class="num">${r.entrustDomestic ? fmt(r.entrustDomestic) : ''}</td>
          <td class="num">${r.entrustOverseas ? fmt(r.entrustOverseas) : ''}</td>
          <td class="num">${fmt(r.expenseSum)}</td><td class="num">${fmt(r.capitalizeSum)}</td><td class="num"><b>${fmt(r.total)}</b></td>
          <td class="muted">${esc(r.note)}</td></tr>`).join('')}
        <tr class="l97-total"><td colspan="6"><b>合计</b></td>
          ${s.collection.six.map(c => `<td class="num"><b>${fmt(s.collection.totals.six[c[0]])}</b></td>`).join('')}
          <td class="num"><b>${fmt(s.collection.totals.entrustDomestic)}</b></td><td class="num"><b>${fmt(s.collection.totals.entrustOverseas)}</b></td>
          <td class="num"><b>${fmt(s.collection.totals.expenseSum)}</b></td><td class="num"><b>${fmt(s.collection.totals.capitalizeSum)}</b></td>
          <td class="num"><b>${fmt(s.collection.totals.total)}</b></td><td></td></tr>
      </table></div>
      <div class="muted" style="font-size:12px;margin-top:6px">口径说明:委托境内按发生额×80%计入;委托境外按×80%且不超过境内可加计基数×2/3(限额 <b>${fmt(s.collection.cap2of3)}</b>,境外委托加计基数合计 <b>${fmt(s.collection.overseasTotalBase)}</b>${s.collection.overseasTotalBase > s.collection.cap2of3 ? ',<b class="red">超出限额,超出部分不得加计</b>' : ''});其他相关费用按实际发生列示,10%限额调整见 A107012 第34行。</div>
    </div>
    ${cal ? `<div class="card"><h3>三套口径对照台账 <span class="sub">会计口径 / 加计口径 / 高企口径,跨部门比对防"口径打架"</span></h3>
      ${cal.eligible === false ? `<div class="warn-box">⚠ 本年度不得享受加计扣除:${esc(cal.ineligibleReason)}</div>` : ''}
      <div class="grid-cards" style="grid-template-columns:repeat(3,1fr)">
        <div class="stat"><div class="k">会计口径(账面研发支出)</div><div class="v">${fmt(cal.accounting)}</div></div>
        <div class="stat"><div class="k">加计口径(含本年摊销 ${fmt(cal.amortAmount)})</div><div class="v">${fmt(cal.deductionFull)}</div></div>
        <div class="stat ${cal.hiTech >= cal.deductionFull ? 'green' : 'yellow'}"><div class="k">高企口径(近似的研发费用)</div><div class="v">${fmt(cal.hiTech)}</div></div>
      </div>
      <div class="table-wrap mt"><table>
        <tr><th>对比项</th><th class="num">金额(元)</th><th>口径差异说明</th></tr>
        <tr><td>会计 − 加计(含摊销)</td><td class="num">${fmt(round2(cal.accounting - cal.deductionFull))}</td><td class="muted">差异来自:不得加计项目剔除、其他费用10%限额、委托80%、境外2/3、特殊收入冲减、不征税收入剔除等;加计口径已含资本化本年摊销 ${fmt(cal.amortAmount)} 元</td></tr>
        <tr><td>加计 − 高企</td><td class="num">${fmt(round2(cal.deductionFull - cal.hiTech))}</td><td class="muted">高企其他费用限额20%(${fmt(cal.otherLimitHt)}),委托外部(含境外)按80%计入、无境外2/3限制;高企含全部资本化支出</td></tr>
      </table></div>
      <div class="muted" style="font-size:12px">${esc(cal.note)}</div>
    </div>` : ''}
    <div class="card"><h3>A107012 填报参考</h3>
      <div class="table-wrap"><table>
        <tr><th>行次</th><th>项目</th><th class="num">金额(元)</th><th>计算说明</th></tr>
        ${(s.rows || []).map(r => `<tr>
          <td>${r.line}</td><td>${esc(r.name)}</td><td class="num">${fmt(r.amount)}</td><td class="muted">${esc(r.note)}</td>
        </tr>`).join('')}
      </table></div>
    </div>
    <div class="card"><h3>限额计算明细</h3>
      <div class="table-wrap"><table>
        <tr><th>项目</th><th class="num">金额(元)</th><th>说明</th></tr>
        <tr><td>其他相关费用限额</td><td class="num">${fmt(d.otherLimit)}</td><td>前5类合计 ${fmt(d.base5)} × 10% ÷ 90%(全部项目合并计算,2017年40号公告)</td></tr>
        <tr><td>其他相关费用 实际/可扣除</td><td class="num">${fmt(d.otherActual)} / ${fmt(d.otherDeductible)}</td><td>${d.otherExcess > 0 ? `超限剔除 <b class="muted">${fmt(d.otherExcess)}</b>` : '未超限'}</td></tr>
        <tr><td>委托境内研发(×80%)</td><td class="num">${fmt(d.entrustDomesticOrg + d.entrustDomesticPerson)}</td><td>机构 ${fmt(d.entrustDomesticOrg)} + 个人 ${fmt(d.entrustDomesticPerson)}</td></tr>
        <tr><td>委托境外 计入/2/3限额</td><td class="num">${fmt(d.entrustOverseas)} / ${fmt(d.entrustOverseasCap)}</td><td>${d.entrustOverseasExcess > 0 ? `超限剔除 ${fmt(d.entrustOverseasExcess)}` : '未超限'}(财税〔2018〕64号)</td></tr>
        <tr><td>资本化形成无形资产成本</td><td class="num">${fmt(d.capitalFormed)}</td><td>按成本200%摊销</td></tr>
        <tr><td>本年摊销额 / 摊销加计</td><td class="num">${fmt(d.amortAmount)} / ${fmt(d.amortAdd)}</td><td>摊销额 × 100%</td></tr>
      </table></div>
    </div>`;
}
function bindSummary() {
  const p = $('#printA107012');
  if (p) p.onclick = () => window.print();
  const ea = $('#exportA107012');
  if (ea) ea.onclick = () => downloadUrl(`/api/export/a107012.xlsx?year=${state.year}`);
  const es = $('#exportSummary');
  if (es) es.onclick = () => downloadUrl(`/api/export/summary.xlsx?year=${state.year}`);
  const ec = $('#exportCollection');
  if (ec) ec.onclick = () => downloadUrl(`/api/export/collection.xlsx?year=${state.year}`);
}

/* ---------- 风险自检 ---------- */
async function renderRisks() {
  const r = await api('/api/risks?year=' + state.year);
  const s = r.snapshot || {};
  const fixes = JSON.parse(localStorage.getItem(`rd_fix_${state.year}`) || '{}');
  const kpi = (k, v) => `<div class="stat"><div class="k">${k}</div><div class="v">${fmt(Number(v) || 0)}</div></div>`;
  const kpiHtml = (s.accounting !== undefined && s.accounting !== null)
    ? `<div class="card" style="margin-bottom:14px">
        ${s.eligible === false ? `<div class="warn-box">⚠ 本年度不得享受加计扣除:${esc(s.ineligibleReason || '')}</div>` : ''}
        <div class="card-h"><h3> 关键指标快照(${state.year}年度)</h3>
          <span class="muted" style="font-size:12px">节税按${esc(s.taxRateNote || '25%')}测算 · 其他费用限额 ${fmt(Number(s.otherLimit) || 0)} · 委托境内×80% ${fmt(Number(s.entrustDomestic) || 0)} · 委托境外(限额内) ${fmt(Number(s.entrustOverseas) || 0)} · 特殊收入冲减 ${fmt(Number(s.specialIncome) || 0)}</span></div>
        <div class="grid-cards">
          ${kpi('研发费用合计(会计口径)', s.accounting)}
          ${kpi('费用化加计扣除基数', s.deductionBase)}
          ${kpi('资本化本年摊销', s.amortAmount)}
          ${kpi('加计扣除额合计', s.totalAdd)}
          ${kpi('预计节税额', s.taxSaving)}
        </div>
      </div>`
    : '';
  const groups = [
    ['error', '红 · 阻断项', '必须整改,否则本年度不得享受加计扣除'],
    ['warning', '黄 · 预警项', '存在合规风险,建议尽快整改并留存证据'],
    ['info', '绿 · 提示项', '提示信息,用于完善备查资料'],
  ];
  const body = groups.map(([lvl, title, sub]) => {
    const items = (r.risks || []).filter(x => x.level === lvl).map(x => `
      <div class="risk-item ${x.level}${fixes[x.code] ? ' fixed' : ''}" id="risk-${x.code}">
        <div class="rt">
          <span class="tag tag-${lvl === 'error' ? 'red' : lvl === 'warning' ? 'yellow' : 'green'}">${lvl === 'error' ? '红' : lvl === 'warning' ? '黄' : '绿'}</span>
          <span>${esc(x.title)}</span><span class="muted" style="font-size:12px">${x.code}</span>
          <label class="fix" style="margin-left:auto"><input type="checkbox" data-code="${x.code}" ${fixes[x.code] ? 'checked' : ''}> 整改完成</label>
        </div>
        <div class="rd">${esc(x.detail)}</div>
        <div class="rs"> 建议:${esc(x.suggestion)}</div>
        <details class="basis"><summary>政策依据</summary><div>${esc(x.basis)}</div></details>
      </div>`).join('');
    return `<h3 class="risk-group ${lvl}">${title} <span class="muted" style="font-size:12px">${sub}</span></h3>
      ${items || '<div class="empty" style="margin:8px 0">未检测到该项风险 ✓</div>'}`;
  }).join('');
  $('#content').innerHTML = `
    <div class="flex mb">
      <button class="btn btn-primary" id="reRun">重新运行自检</button>
      <button class="btn" id="printReport"> 导出风险报告(打印/PDF)</button>
      <div class="flex">
        <span class="tag tag-red">红 ${r.counts.error} · 阻断</span>
        <span class="tag tag-yellow">黄 ${r.counts.warning} · 预警</span>
        <span class="tag tag-green">绿 ${r.counts.info} · 提示</span>
      </div>
    </div>
    ${kpiHtml}
    ${body}`;
}
function bindRisks() {
  $('#reRun').onclick = () => showTab('risks');
  $('#printReport').onclick = () => downloadUrl(`/api/export/risks.html?year=${state.year}`);
  // 整改完成跟踪(仅存本机,勾选后该风险项半透明,便于跟进)
  document.querySelectorAll('#content input[data-code]').forEach(cb => {
    cb.onchange = () => {
      const key = `rd_fix_${state.year}`;
      const fixes = JSON.parse(localStorage.getItem(key) || '{}');
      if (cb.checked) fixes[cb.dataset.code] = 1;
      else delete fixes[cb.dataset.code];
      localStorage.setItem(key, JSON.stringify(fixes));
      const item = document.getElementById('risk-' + cb.dataset.code);
      if (item) item.classList.toggle('fixed', cb.checked);
    };
  });
}

/* ---------- 备查清单 ---------- */
async function renderChecklist() {
  const key = `rd_check_${state.year}`;
  const done = JSON.parse(localStorage.getItem(key) || '{}');
  const list = state.meta?.checklist || [];
  const phases = state.meta?.checklistPhases || [];
  const hintText = localStorage.getItem(`rd_check_hint_${state.year}`) || '';
  const n = list.filter(i => done[i.key]).length;
  const actionUrl = a => a.api + (a.api.startsWith('/api/export') ? '?year=' + state.year : '');
  const itemHtml = i => `
    <div class="check-item ${done[i.key] ? 'done' : ''}">
      <input type="checkbox" data-key="${i.key}" ${done[i.key] ? 'checked' : ''}>
      <div style="flex:1;min-width:0">
        <div class="ci-name">${esc(i.name)} ${i.required ? '<span class="tag tag-red">必备</span>' : '<span class="tag tag-gray">视情况</span>'}</div>
        ${i.desc ? `<details class="ci-details"><summary> 要准备什么</summary><div>${esc(i.desc)}${i.how ? `<div class="ci-how">⚠ 实操提示:${esc(i.how)}</div>` : ''}</div></details>` : ''}
        ${i.action ? (i.action.download === true
          ? `<a class="btn btn-sm" href="${actionUrl(i.action)}" target="_blank" style="margin-top:6px">${esc(i.action.label)}</a>`
          : `<a class="btn btn-sm" href="${actionUrl(i.action)}" download="${esc(i.action.download || '')}" style="margin-top:6px">${esc(i.action.label)}</a>`) : ''}
      </div>
    </div>`;
  $('#content').innerHTML = `
    <div class="hint">留存备查资料保存期限为 <b>${state.meta?.policies?.retentionYears ?? 10} 年</b>(自年度汇算清缴结束之日起)。享受优惠的纳税人自行留存,税务机关核查时提供。<br>
    <b>使用方法:</b>① 先点「 自动检测已具备材料」,系统按你录入的数据自动勾掉已有材料;② 其余逐项展开「 要准备什么」按指引准备并手动勾选;③ 全部完成后点「 生成备查资料包」归档。</div>
    <div class="card">
      <h3> 年底备查五件套 <span class="sub">汇算清缴前归档 · HTML打印(页面「 打印」按钮)+ Excel 导出</span></h3>
      <div class="five-set">
        <div class="fs-item"><b>① 研发支出辅助账</b><span class="muted">97号公告四类(自研/委托/合作/集中)</span><a class="btn btn-sm" href="/api/export/ledger97.xlsx?year=${state.year}" download="ledger97_${state.year}.xlsx">Excel</a></div>
        <div class="fs-item"><b>② 研发支出辅助账汇总表</b><span class="muted">97号公告附件5样式,留存备查</span><a class="btn btn-sm" href="/api/export/collection.xlsx?year=${state.year}" download="collection_${state.year}.xlsx">Excel</a></div>
        <div class="fs-item"><b>③ A107012申报表</b><span class="muted">官方行次,含填报口径说明</span><a class="btn btn-sm" href="/api/export/a107012.xlsx?year=${state.year}" download="A107012_${state.year}.xlsx">Excel</a></div>
        <div class="fs-item"><b>④ 年度归集汇总</b><span class="muted">申报参考+限额计算明细(见「申报汇总」页)</span><a class="btn btn-sm" href="/api/export/summary.xlsx?year=${state.year}" download="summary_${state.year}.xlsx">Excel</a></div>
        <div class="fs-item"><b>⑤ 风险自检报告</b><span class="muted">红黄绿风险提示+整改建议,可打印</span><a class="btn btn-sm" href="/api/export/risks.html?year=${state.year}" target="_blank">打开</a></div>
      </div>
      <div class="flex" style="margin-top:10px;gap:8px">
        <button class="btn btn-primary" id="exportZip"> 打包五件套+明细(zip)</button>
        <span class="muted" style="font-size:12px">zip 内含 01-05 五件套 + 费用明细/人员/工时/立项模板/凭证附件/共用资源分摊表等辅助材料</span>
      </div>
    </div>
    <div class="card">
      <h3>按项目备查资料核对 <span class="sub">税局四类核查资料:立项 / 过程 / 成果 + 委托登记,缺失项请到「研发项目」页补录</span></h3>
      <div class="table-wrap"><table>
        <tr><th>项目编号</th><th>项目名称</th><th>证据链(立项决议/计划书/过程文档/成果证明)</th><th>委托技术合同登记</th></tr>
        ${state.projects.map(p => {
          const ev = [['立项决议', p.hasApprovalDoc], ['计划书', p.hasPlanDoc], ['过程文档', p.hasProcessDocs], ['成果证明', p.hasResultDocs]];
          const tags = ev.map(([k, v]) => v ? `<span class="tag tag-green">${k}</span>` : `<span class="tag tag-red">缺${k}</span>`).join(' ');
          const entrustCell = p.form && p.form.startsWith('entrust')
            ? (p.techContractNo ? `<span class="tag tag-green">已登记</span>` : '<span class="tag tag-red">缺登记号</span>')
            : '<span class="muted">—</span>';
          return `<tr><td>${esc(p.code)}</td><td>${esc(p.name)}</td><td>${tags}</td><td>${entrustCell}</td></tr>`;
        }).join('') || '<tr><td colspan="4" class="empty">暂无项目</td></tr>'}
      </table></div>
      <div class="muted" style="font-size:12px;margin-top:6px">「过程文档」= 研发日志/实验记录/测试报告;「成果证明」= 专利/软著/成果报告。仅有立项书、无过程与成果 = 证据不足(稽查剔除重点,如"嘉兴混凝土制品"案被全额调增),请按项目补齐并勾选。</div>
    </div>
    <div class="card">
      <div class="flex" style="justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <h3 style="margin:0">备查资料清单 <span class="sub">完成 ${n}/${list.length} 项 · 归档进度 ${Math.round(n / Math.max(list.length, 1) * 100)}%</span></h3>
        <div class="flex" style="gap:8px">
          <button class="btn" id="autoDetect"> 自动检测已具备材料</button>
        </div>
      </div>
      <div style="height:8px;background:#e2e8f0;border-radius:99px;margin-bottom:14px"><div style="height:8px;width:${n / Math.max(list.length, 1) * 100}%;background:var(--green);border-radius:99px"></div></div>
      <div id="autoHint" class="hint" style="display:${hintText ? 'block' : 'none'}">${hintText}</div>
      ${phases.map(ph => {
        const items = list.filter(i => (i.phase || 'filing') === ph.key);
        if (!items.length) return '';
        const dc = items.filter(i => done[i.key]).length;
        return `<div class="phase-card">
          <div class="phase-head">${esc(ph.name)} <span class="sub">${dc}/${items.length}</span></div>
          ${items.map(itemHtml).join('')}
        </div>`;
      }).join('')}
    </div>`;
}
function bindChecklist() {
  $('#exportZip').onclick = () => downloadUrl(`/api/export/archive.zip?year=${state.year}`);
  const key = `rd_check_${state.year}`;
  $('#content').querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.onchange = () => {
      const done = JSON.parse(localStorage.getItem(key) || '{}');
      done[cb.dataset.key] = cb.checked;
      localStorage.setItem(key, JSON.stringify(done));
      renderChecklist().then(() => bindChecklist()); // 重渲染后需重新绑定,否则按钮事件丢失
    };
  });
  const auto = $('#autoDetect');
  if (auto) auto.onclick = () => {
    const done = JSON.parse(localStorage.getItem(key) || '{}');
    const y = state.year;
    const yearExp = state.expenses.filter(e => String(e.date).startsWith(y));
    const entrustKeys = ['entrust_domestic_org', 'entrust_domestic_person', 'entrust_overseas'];
    const entrust = yearExp.filter(e => entrustKeys.includes(e.category));
    const detect = {
      plan: state.projects.length > 0 && state.projects.every(p => p.hasPlanDoc),
      approval: state.projects.length > 0 && state.projects.every(p => p.hasApprovalDoc),
      orgchart: state.staff.length > 0,
      allocNote: state.timesheets.length > 0,
      ledger: yearExp.length > 0,
      entrustContract: entrust.length > 0 && entrust.every(e => e.contractNo),
      overseasReg: entrust.some(e => e.category === 'entrust_overseas'),
      capitalNote: state.projects.some(p => p.capitalization === 'capitalize') && state.amortizations.length > 0,
    };
    const list = state.meta?.checklist || [];
    const newly = [], missing = [];
    list.forEach(i => {
      if (detect[i.key]) {
        if (!done[i.key]) newly.push(i.name);
        done[i.key] = true;
      } else if (!done[i.key]) {
        missing.push(i.name);
      }
    });
    localStorage.setItem(key, JSON.stringify(done));
    const lines = [];
    if (newly.length) lines.push(` 检测到已具备,自动勾选:${newly.join('、')}`);
    if (missing.length) lines.push(`⏳ 系统未检测到,请优先补齐:${missing.join('、')}`);
    if (!lines.length) lines.push(' 已具备材料均已勾选,请确认剩余未勾选项是否实际存在。');
    localStorage.setItem(`rd_check_hint_${state.year}`, lines.join('<br>'));
    renderChecklist().then(() => bindChecklist());
  };
}

/* ---------------- 首次打开强引导 ---------------- */
function renderFirstRun() {
  $('#firstrun').innerHTML = `
    <div class="overlay" id="frOverlay">
      <div class="modal firstrun">
        <button class="fr-close" id="frClose" title="关闭">✕</button>
        <span class="fr-badge">完全免费 · 单机本地 · 数据不出电脑</span>
        <h2>欢迎使用「研发费用加计扣除辅助软件」</h2>
        <p class="fr-sub">帮企业把研发费用加计扣除做「合规、经得起查」:日常随手记 → 随时风险自检 → 年底生成辅助账、申报表与备查资料,不再临时凑材料、经不起税务查账。</p>
        <div class="fr-steps">
          <div class="fr-step"><b>① 企业设置</b><span>填写企业信息,系统自动判断负面清单与高企/小微优惠</span></div>
          <div class="fr-step"><b>② 研发项目</b><span>立项登记,项目是归集费用的「筐」</span></div>
          <div class="fr-step"><b>③ 人员与工时</b><span>研发人员及其工时占比,可导入 Excel</span></div>
          <div class="fr-step"><b>④ 费用归集</b><span>把研发支出归集到项目,支持 Excel / 数电发票导入</span></div>
          <div class="fr-step"><b>⑤ 风险自检</b><span>红黄绿预警 + 整改建议,有问题先处理再申报</span></div>
        </div>
        <div class="fr-actions">
          <button class="btn btn-primary btn-lg" id="frDemo"> 快速体验:载入示例数据</button>
          <button class="btn btn-lg" id="frStart"> 从零开始:创建我的企业</button>
          <button class="btn-link" id="frRestore">已有数据?点此去「企业设置」恢复备份 →</button>
        </div>
      </div>
    </div>`;
  $('#frClose').onclick = hideFirstRun;
  $('#frOverlay').onclick = e => { if (e.target.id === 'frOverlay') hideFirstRun(); };
  $('#frDemo').onclick = async () => {
    hideFirstRun();
    try {
      await api('/api/demo/load', { method: 'POST' });
      toast('示例数据已载入:2个项目、6名人员、28笔费用,点上方任一步骤即可查看');
      await loadAll(); await showTab('dashboard');
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#frStart').onclick = () => { hideFirstRun(); showTab('company'); };
  $('#frRestore').onclick = () => { hideFirstRun(); showTab('company'); toast('在企业设置页底部「数据备份与恢复」中可恢复'); };
}
function showFirstRun() {
  // 首次打开(无任何数据)自动弹出;此后用户可随时用侧栏「操作指引」按钮打开
  if (!state.companies.length && !state.projects.length && !state.expenses.length) renderFirstRun();
}
function hideFirstRun() {
  const o = $('#frOverlay');
  if (o) o.remove();
}

/* ---------------- Excel 导入(万能列映射向导) ---------------- */
const IMPORT_ENTITIES = {
  expenses: {
    label: '费用明细', desc: '研发费用归集的核心:日期/项目/类别/金额/摘要',
    fields: [
      { key: 'projectCode', label: '项目编号', required: true, keywords: ['项目编号', '项目编码', '项目代码', '编号'] },
      { key: 'date', label: '日期', required: true, keywords: ['日期', '入账日期', '记账日期'] },
      { key: 'category', label: '费用类别', required: true, keywords: ['费用类别', '类别', '费用项目', '科目'] },
      { key: 'amount', label: '金额', required: true, keywords: ['金额', '发生额', '金额(元)', '不含税金额'] },
      { key: 'summary', label: '摘要', keywords: ['摘要', '用途', '说明', '事由'] },
      { key: 'period', label: '归属期间(YYYY-MM)', keywords: ['归属期间', '期间', '月份', '账期'] },
      { key: 'capitalization', label: '费用化/资本化', keywords: ['资本化', '费用化', '支出类型'] },
      { key: 'allocMethod', label: '分摊方式', keywords: ['分摊', '分配'] },
      { key: 'voucherNo', label: '凭证号', keywords: ['凭证号', '凭证字号'] },
      { key: 'invoiceNo', label: '发票号', keywords: ['发票号', '发票号码'] },
      { key: 'contractNo', label: '合同号', keywords: ['合同号', '合同编号'] },
      { key: 'paymentMethod', label: '支付方式', keywords: ['支付方式', '付款方式'] },
    ],
    hint: '费用类别用中文名(人员人工费用/直接投入费用/折旧费用/无形资产摊销/新产品设计费等);金额>0;摘要命中「培训/招待/罚款」等不可计入项将被拒绝。',
  },
  staff: {
    label: '人员', desc: '研发人员花名册:姓名/部门/岗位/入职日期/是否直接研发',
    fields: [
      { key: 'name', label: '姓名', required: true, keywords: ['姓名', '员工姓名', '人员姓名'] },
      { key: 'dept', label: '部门', keywords: ['部门', '所在部门'] },
      { key: 'role', label: '岗位', keywords: ['岗位', '职务', '职位'] },
      { key: 'joinDate', label: '入职日期', keywords: ['入职', '入职日期', '入司日期'] },
      { key: 'isDirect', label: '是否直接研发', keywords: ['直接', '研发属性', '是否研发'] },
    ],
    hint: '「是否直接研发」填:是/否/直接/非直接/true/false/1/0。',
  },
  projects: {
    label: '研发项目', desc: '项目台账:编号/名称/研发形式/起止日期/资本化/立项审批',
    fields: [
      { key: 'code', label: '项目编号', required: true, keywords: ['项目编号', '项目编码', '编号'] },
      { key: 'name', label: '项目名称', required: true, keywords: ['项目名称', '项目名', '名称'] },
      { key: 'form', label: '研发形式', keywords: ['研发形式', '形式', '研发类型'] },
      { key: 'resultOwner', label: '成果归属', keywords: ['成果', '归属', '知识产权'] },
      { key: 'activityType', label: '活动类型', keywords: ['活动', '技术领域'] },
      { key: 'startDate', label: '开始日期', keywords: ['开始日期', '起始日期', '立项日期'] },
      { key: 'endDate', label: '结束日期', keywords: ['结束日期', '完成日期', '终止日期'] },
      { key: 'status', label: '状态', keywords: ['状态'] },
      { key: 'capitalization', label: '费用化/资本化', keywords: ['资本化', '费用化', '支出类型'] },
      { key: 'approvalDate', label: '立项审批日期', keywords: ['审批日期', '批准日期'] },
      { key: 'hasApprovalDoc', label: '有立项决议', keywords: ['立项决议', '审批文件'] },
      { key: 'hasPlanDoc', label: '有研发计划书', keywords: ['计划书', '计划'] },
      { key: 'note', label: '备注', keywords: ['备注', '说明'] },
    ],
    hint: '研发形式填:自主研发/委托境内机构/委托境内个人/委托境外机构/合作研发/集中研发。',
  },
  timesheets: {
    label: '人员工时', desc: '工时台账:人员/项目/月份/研发工时/总工时',
    fields: [
      { key: 'staffName', label: '人员姓名', required: true, keywords: ['姓名', '人员', '员工'] },
      { key: 'projectCode', label: '项目编号', required: true, keywords: ['项目编号', '项目编码', '编号'] },
      { key: 'period', label: '月份(YYYY-MM)', required: true, keywords: ['月份', '期间', '归属月'] },
      { key: 'rdHours', label: '研发工时', required: true, keywords: ['研发工时', '工时', '研究工时'] },
      { key: 'totalHours', label: '总工时', keywords: ['总工时', '当月工时'] },
    ],
    hint: '研发工时为当月该人员投入该项目的工时;总工时缺省 160。',
  },
  specialIncomes: {
    label: '特殊收入', desc: '研发过程形成下脚料/残次品/试制品销售收入',
    fields: [
      { key: 'projectCode', label: '项目编号', required: true, keywords: ['项目编号', '项目编码', '编号'] },
      { key: 'type', label: '类型', keywords: ['类型', '收入类型'] },
      { key: 'amount', label: '金额', required: true, keywords: ['金额', '收入'] },
      { key: 'date', label: '日期', keywords: ['日期'] },
      { key: 'period', label: '归属期间(YYYY-MM)', keywords: ['期间', '月份'] },
      { key: 'summary', label: '摘要', keywords: ['摘要', '说明'] },
    ],
    hint: '类型填:下脚料销售/残次品销售/试制品销售。',
  },
  amortizations: {
    label: '资本化摊销', desc: '资本化项目无形资产摊销(年度分摊)',
    fields: [
      { key: 'projectCode', label: '项目编号', required: true, keywords: ['项目编号', '项目编码', '编号'] },
      { key: 'year', label: '年度', required: true, keywords: ['年度', '年份'] },
      { key: 'amount', label: '金额', required: true, keywords: ['金额', '摊销额'] },
      { key: 'formationYear', label: '形成年度', keywords: ['形成年度', '形成年'] },
      { key: 'note', label: '备注', keywords: ['备注', '说明'] },
    ],
    hint: '仅资本化项目需要;年度为摊销归属年(如 2025)。形成年度=无形资产达到预定可使用状态的年度(留空自动取该项目最早摊销年度),用于A107012行43/44分流。',
  },
  invoices: {
    label: '数电票发票', desc: '批量解析 XML/OFD 数电票,自动生成费用记录',
    fields: [],
    hint: '支持电子税务局下载的数电票 XML / OFD 文件,自动提取开票日期、销方、金额、发票号。',
  },
};

let impState = {
  entity: 'expenses', file: null, fileName: '',
  id: null, sheet: '', headers: [], sampleRows: [], rowCount: 0,
  mapping: {}, skipHeader: true, result: null,
};

function autoMap(headers) {
  const map = {};
  IMPORT_ENTITIES[impState.entity].fields.forEach(f => {
    for (const h of headers) {
      const hn = (h.name || '').toLowerCase();
      if (f.keywords.some(k => hn.includes(k))) { map[f.key] = h.index; break; }
    }
  });
  return map;
}

async function handleImportFile(f) {
  impState.file = f; impState.fileName = f.name;
  impState.result = null; impState.id = null; impState.headers = []; impState.mapping = {};
  try {
    const buf = await f.arrayBuffer();
    toast('正在解析文件…');
    const res = await fetch('/api/import/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(f.name) },
      body: buf,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '解析失败');
    impState.id = data.id; impState.sheet = data.sheet || '';
    impState.headers = data.headers; impState.sampleRows = data.sampleRows; impState.rowCount = data.rowCount;
    impState.mapping = autoMap(data.headers);
    renderImport(); bindImport();
    toast(`解析成功:${data.rowCount} 行,已自动匹配列映射`);
  } catch (e) {
    toast(e.message, 'err');
    impState.fileName = ''; impState.file = null;
    renderImport(); bindImport();
  }
}

async function renderImport() {
  if (impState.entity === 'invoices') return renderInvoicePanel();
  const ent = IMPORT_ENTITIES[impState.entity];
  const entCards = Object.entries(IMPORT_ENTITIES).map(([k, e]) => `
    <label class="imp-ent ${k === impState.entity ? 'active' : ''}">
      <input type="radio" name="impEntity" value="${k}" ${k === impState.entity ? 'checked' : ''}>
      <div class="imp-ent-name">${e.label}</div>
      <div class="imp-ent-desc">${e.desc}</div>
    </label>`).join('');
  const mappingRows = impState.headers.length ? IMPORT_ENTITIES[impState.entity].fields.map(f => {
    const sel = impState.mapping[f.key];
    const opts = ['<option value="-1">(不导入)</option>'].concat(impState.headers.map(h =>
      `<option value="${h.index}" ${sel === h.index ? 'selected' : ''}>${esc(h.name)}</option>`));
    const preview = sel >= 0 && impState.sampleRows[0] ? esc(impState.sampleRows[0][sel] ?? '') : '';
    return `<tr><td class="imp-f-label">${f.label}${f.required ? '<span class="tag tag-red">必填</span>' : ''}</td>
      <td><select class="imp-map" data-field="${f.key}">${opts.join('')}</select></td>
      <td class="imp-preview">${preview}</td></tr>`;
  }).join('') : '';

  $('#content').innerHTML = `
    <div class="card">
      <div class="card-h"><h3> Excel 批量导入</h3>
        <span class="muted">支持 .xlsx / .csv(.tsv .txt) · 自动识别 UTF-8 / GBK / UTF-16 编码 · 首行为表头 · 逐行校验,错误行不影响其他行</span></div>
      <div class="imp-grid">
        <div class="imp-step">
          <div class="imp-step-t">第 1 步:选择数据类型并上传文件</div>
          <div class="imp-ents">${entCards}</div>
          ${impState.entity !== 'invoices' ? `
          <div class="flex" style="margin-bottom:10px;gap:8px;align-items:center">
            <button class="btn" id="impTmplBtn">下载 ${ent.label} 模板(.xlsx)</button>
            <span class="muted" style="font-size:12px">Excel 模板含「填写说明」工作表;填好数据后直接拖入上方虚线框,系统按表头自动匹配</span>
          </div>` : '<div class="imp-hint" style="margin-bottom:10px">无需模板:数电票按「发票文件直接上传」即可,本页不支持 CSV 导入。</div>'}
          <div class="dropzone" id="dropzone">
            <div class="dz-t">点击选择文件,或将文件拖到这里</div>
            <div class="dz-sub">${impState.fileName ? `已选择:<b>${esc(impState.fileName)}</b>` : 'Excel(.xlsx) 或 CSV 文件'}</div>
            <input type="file" id="impFile" accept=".xlsx,.csv,.tsv,.txt" style="display:none">
          </div>
          <div class="imp-hint"> ${ent.hint}</div>
        </div>
        ${impState.headers.length ? `
        <div class="imp-step">
          <div class="imp-step-t">第 2 步:核对列映射(已按表头自动匹配,可手动调整)</div>
          <div class="imp-meta muted">${esc(impState.fileName)}${impState.sheet ? ' · 工作表「' + esc(impState.sheet) + '」' : ''} · 共 ${impState.rowCount} 行(含表头) · 数据预览:</div>
          <div class="imp-preview-table">
            <table><thead><tr>${impState.headers.map(h => `<th>${esc(h.name)}</th>`).join('')}</tr></thead>
            <tbody>${impState.sampleRows.map(r => `<tr>${impState.headers.map((h, i) => `<td>${esc(r[i] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>
          </div>
          <table class="imp-map-table"><thead><tr><th>导入字段</th><th>对应源列</th><th>首行示例</th></tr></thead><tbody>${mappingRows}</tbody></table>
          <label class="imp-opt"><input type="checkbox" id="impSkipHeader" ${impState.skipHeader ? 'checked' : ''}> 首行为表头(勾选则从第 2 行开始导入)</label>
          <button class="btn btn-primary" id="btnImpRun">开始导入 ✓</button>
        </div>` : ''}
      </div>
      ${impState.result ? `
      <div class="imp-result ${impState.result.errors.length ? 'has-err' : ''}">
        <div class="imp-result-t">导入完成:成功 <b>${impState.result.ok}</b> / ${impState.result.total} 行${impState.result.errors.length ? `,失败 <b class="red">${impState.result.errors.length}</b> 行` : ''}</div>
        ${impState.result.errors.length ? `<ul class="imp-err-list">${impState.result.errors.slice(0, 30).map(e => `<li>${esc(e)}</li>`).join('')}${impState.result.errors.length > 30 ? `<li>…共 ${impState.result.errors.length} 条</li>` : ''}</ul>` : '<div class="ok-text">✓ 全部成功</div>'}
        <div class="imp-result-actions">
          <button class="btn btn-primary" id="btnImpView">去查看数据</button>
          <button class="btn" id="btnImpAgain">继续导入下一批</button>
        </div>
      </div>` : ''}
    </div>`;
}

async function bindImport() {
  if (impState.entity === 'invoices') return bindInvoicePanel();
  const entChange = () => {
    impState.entity = document.querySelector('input[name="impEntity"]:checked').value;
    renderImport(); bindImport();
  };
  $$('#content input[name="impEntity"]').forEach(r => r.onchange = entChange);

  // 导入页模板下载:按所选实体类型下载对应模板
  if ($('#impTmplBtn') && impState.entity !== 'invoices') bindTemplateDownload('impTmplBtn', impState.entity, 'xlsx');

  const dz = $('#dropzone'), file = $('#impFile');
  if (dz && file) {
    dz.onclick = () => file.click();
    dz.ondragover = e => { e.preventDefault(); dz.classList.add('over'); };
    dz.ondragleave = () => dz.classList.remove('over');
    dz.ondrop = e => {
      e.preventDefault(); dz.classList.remove('over');
      if (e.dataTransfer.files.length) handleImportFile(e.dataTransfer.files[0]);
    };
    file.onchange = () => { if (file.files.length) handleImportFile(file.files[0]); file.value = ''; };
  }
  $$('#content .imp-map').forEach(sel => sel.onchange = () => {
    impState.mapping[sel.dataset.field] = Number(sel.value);
    renderImport(); bindImport();
  });
  const sh = $('#impSkipHeader');
  if (sh) sh.onchange = () => { impState.skipHeader = sh.checked; };
  const run = $('#btnImpRun');
  if (run) run.onclick = async () => {
    if (!impState.id) return toast('请先上传文件', 'err');
    run.textContent = '导入中…'; run.disabled = true;
    try {
      impState.result = await api('/api/import/run', {
        method: 'POST',
        body: { id: impState.id, entity: impState.entity, mapping: impState.mapping, options: { skipHeader: impState.skipHeader } },
      });
      await loadAll();
      renderImport(); bindImport();
      toast(impState.result.errors.length ? `导入完成,${impState.result.errors.length} 行失败` : '导入成功');
    } catch (e) { toast(e.message, 'err'); run.textContent = '开始导入 ✓'; run.disabled = false; }
  };
  const view = $('#btnImpView');
  if (view) view.onclick = () => {
    const tab = { expenses: 'expenses', staff: 'staff', projects: 'projects', timesheets: 'staff', specialIncomes: 'expenses', amortizations: 'expenses' }[impState.entity] || 'expenses';
    showTab(tab);
  };
  const again = $('#btnImpAgain');
  if (again) again.onclick = () => {
    impState = { ...impState, file: null, fileName: '', id: null, sheet: '', headers: [], sampleRows: [], rowCount: 0, mapping: {}, result: null };
    renderImport(); bindImport();
  };
}

/* ---------------- 数电票发票批量解析(XML/OFD) ---------------- */
let impInv = {
  files: [],            // File 对象列表
  parsed: 0,            // 已解析文件数
  rows: [],             // {date, sellerName, itemsText, amount, summary, invoiceNo, error}
  config: { projectId: '', category: 'direct', capitalization: 'expense' },
  result: null,
};

function invRowFromInvoice(inv) {
  const itemNames = (inv.items || []).map(it => it.name).filter(Boolean);
  const itemsText = itemNames.slice(0, 3).join(' / ');
  const amount = inv.total || (inv.amount + (inv.tax || 0)) || 0;
  const parts = [inv.sellerName || '数电票'];
  if (itemsText) parts.push(itemsText);
  if (inv.remark) parts.push(inv.remark);
  const summary = parts.join('·');
  return {
    date: inv.date || '',
    sellerName: inv.sellerName || '',
    itemsText,
    amount,
    summary,
    invoiceNo: inv.invoiceNo || '',
    error: !inv.total && !inv.amount ? '未识别金额' : (!inv.date ? '未识别开票日期' : ''),
  };
}

async function handleInvoiceFiles(files) {
  impInv.files = impInv.files.concat(Array.from(files));
  impInv.result = null;
  renderImport(); bindImport();
}

async function parseInvoiceFiles() {
  const files = impInv.files;
  if (!files.length) return toast('请先选择文件', 'err');
  const btn = $('#btnInvParse');
  if (btn) { btn.textContent = '解析中…'; btn.disabled = true; }
  let ok = 0;
  for (const f of files) {
    try {
      const buf = await f.arrayBuffer();
      const res = await fetch('/api/invoice/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(f.name) },
        body: buf,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '解析失败');
      const rows = (data.invoices || []).map(invRowFromInvoice);
      impInv.rows.push(...rows.map(r => ({ ...r, fileName: f.name })));
      ok += data.invoices ? data.invoices.length : 0;
    } catch (e) {
      impInv.rows.push({ date: '', sellerName: f.name, itemsText: '', amount: 0, summary: '', invoiceNo: '', error: e.message });
    }
  }
  impInv.parsed = files.length;
  renderImport(); bindImport();
  toast(`解析完成:共识别 ${ok} 张发票(文件 ${files.length} 个)`);
}

async function renderInvoicePanel() {
  const cats = state.meta ? state.meta.categories : [];
  const projs = state.projects || [];
  if (!impInv.config.projectId && projs.length) impInv.config.projectId = projs[0].id;
  if (!impInv.config.category && cats.length) impInv.config.category = cats[0].key;
  $('#content').innerHTML = `
    <div class="card">
      <div class="card-h"><h3> 数电票发票批量解析</h3>
        <span class="muted">电子税务局下载的 XML / OFD 数电票 → 自动提取开票日期/销方/金额 → 生成研发费用</span></div>
      <div class="imp-grid">
        <div class="imp-step">
          <div class="imp-step-t">第 1 步:选择数电票文件(可多选,支持 .xml / .ofd)</div>
          <div class="dropzone" id="invDrop">
            <div class="dz-t">点击选择文件,或将文件拖到这里</div>
            <div class="dz-sub">${impInv.files.length ? `已选择 <b>${impInv.files.length}</b> 个文件` : 'XML / OFD 文件(可一次选多个)'}</div>
            <input type="file" id="invFiles" accept=".xml,.ofd" multiple style="display:none">
          </div>
          <div class="imp-opt" style="margin-top:10px">
            ${impInv.files.length ? `<button class="btn btn-primary" id="btnInvParse"> 解析 ${impInv.files.length} 个文件</button>` : ''}
            ${impInv.files.length ? `<button class="btn" id="btnInvClear">清空文件</button>` : ''}
            <span class="muted">解析后自动按「价税合计」填入金额,可手工修改;同一批文件归入同一个项目与费用类别</span>
          </div>
        </div>
        ${impInv.rows.length ? `
        <div class="imp-step">
          <div class="imp-step-t">第 2 步:确认归集参数与发票行(勾选 = 导入,错误行自动排除)</div>
          <div class="inv-config">
            <label>归入项目 <select id="invProject">${projs.map(p => `<option value="${esc(p.id)}" ${impInv.config.projectId === p.id ? 'selected' : ''}>${esc(p.code)} ${esc(p.name)}</option>`).join('')}</select></label>
            <label>费用类别 <select id="invCategory">${cats.map(c => `<option value="${esc(c.key)}" ${impInv.config.category === c.key ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
            <label>支出类型 <select id="invCap">
              <option value="expense" ${impInv.config.capitalization === 'expense' ? 'selected' : ''}>费用化</option>
              <option value="capitalize" ${impInv.config.capitalization === 'capitalize' ? 'selected' : ''}>资本化</option>
            </select></label>
          </div>
          <div class="imp-preview-table">
            <table>
              <thead><tr><th>√</th><th>文件</th><th>开票日期</th><th>销方名称</th><th>商品/服务</th><th>金额(元)</th><th>摘要</th><th>发票号码</th><th>状态</th></tr></thead>
              <tbody>
                ${impInv.rows.map((r, i) => `<tr class="${r.error ? 'inv-err' : ''}">
                  <td><input type="checkbox" class="inv-check" data-i="${i}" ${r.error ? '' : 'checked'}></td>
                  <td class="muted">${esc(r.fileName || '')}</td>
                  <td><input class="inv-cell inv-date" data-i="${i}" value="${esc(r.date)}"></td>
                  <td>${esc(r.sellerName)}</td>
                  <td class="muted" style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.itemsText)}</td>
                  <td><input class="inv-cell inv-amt" data-i="${i}" type="number" step="0.01" min="0" value="${r.amount}"></td>
                  <td><input class="inv-cell inv-sum" data-i="${i}" value="${esc(r.summary)}" style="min-width:220px"></td>
                  <td class="muted">${esc(r.invoiceNo)}</td>
                  <td>${r.error ? `<span class="red">${esc(r.error)}</span>` : ''}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
          <div class="imp-opt">共解析 ${impInv.rows.length} 张发票,导入时仅处理勾选且无错误的行</div>
          <button class="btn btn-primary" id="btnInvImport">生成费用记录 ✓</button>
        </div>` : ''}
      </div>
      ${impInv.result ? `
      <div class="imp-result ${impInv.result.errors.length ? 'has-err' : ''}">
        <div class="imp-result-t">导入完成:成功 <b>${impInv.result.ok}</b> / ${impInv.result.total} 行${impInv.result.errors.length ? `,失败 <b class="red">${impInv.result.errors.length}</b> 行` : ''}</div>
        ${impInv.result.errors.length ? `<ul class="imp-err-list">${impInv.result.errors.slice(0, 30).map(e => `<li>${esc(e)}</li>`).join('')}</ul>` : '<div class="ok-text">✓ 全部成功</div>'}
        <div class="imp-result-actions">
          <button class="btn btn-primary" id="btnInvView">去查看费用</button>
          <button class="btn" id="btnInvReset">继续解析下一批</button>
        </div>
      </div>` : ''}
    </div>`;
}

async function bindInvoicePanel() {
  const dz = $('#invDrop'), files = $('#invFiles');
  if (dz && files) {
    dz.onclick = () => files.click();
    dz.ondragover = e => { e.preventDefault(); dz.classList.add('over'); };
    dz.ondragleave = () => dz.classList.remove('over');
    dz.ondrop = e => {
      e.preventDefault(); dz.classList.remove('over');
      if (e.dataTransfer.files.length) handleInvoiceFiles(e.dataTransfer.files);
    };
    files.onchange = () => { if (files.files.length) handleInvoiceFiles(files.files); files.value = ''; };
  }
  const parseBtn = $('#btnInvParse');
  if (parseBtn) parseBtn.onclick = parseInvoiceFiles;
  const clearBtn = $('#btnInvClear');
  if (clearBtn) clearBtn.onclick = () => {
    impInv = { ...impInv, files: [], parsed: 0, rows: [], result: null };
    renderImport(); bindImport();
  };
  const proj = $('#invProject');
  if (proj) proj.onchange = () => { impInv.config.projectId = proj.value; };
  const cat = $('#invCategory');
  if (cat) cat.onchange = () => { impInv.config.category = cat.value; };
  const cap = $('#invCap');
  if (cap) cap.onchange = () => { impInv.config.capitalization = cap.value; };
  $$('#content .inv-check').forEach(cb => cb.onchange = () => {
    impInv.rows[Number(cb.dataset.i)].checked = cb.checked;
  });
  $$('#content .inv-date').forEach(inp => inp.onchange = () => { impInv.rows[Number(inp.dataset.i)].date = inp.value; });
  $$('#content .inv-amt').forEach(inp => inp.onchange = () => { impInv.rows[Number(inp.dataset.i)].amount = Number(inp.value); });
  $$('#content .inv-sum').forEach(inp => inp.onchange = () => { impInv.rows[Number(inp.dataset.i)].summary = inp.value; });
  const impBtn = $('#btnInvImport');
  if (impBtn) impBtn.onclick = async () => {
    if (!impInv.config.projectId) return toast('请选择归入项目', 'err');
    const rows = impInv.rows.filter(r => r.checked !== false && !r.error).map(r => ({
      date: r.date, amount: r.amount, summary: r.summary, invoiceNo: r.invoiceNo,
    }));
    if (!rows.length) return toast('没有可导入的行(请检查勾选与错误提示)', 'err');
    impBtn.textContent = '导入中…'; impBtn.disabled = true;
    try {
      impInv.result = await api('/api/invoice/import', {
        method: 'POST',
        body: { rows, projectId: impInv.config.projectId, category: impInv.config.category, capitalization: impInv.config.capitalization },
      });
      await loadAll();
      renderImport(); bindImport();
      toast(impInv.result.errors.length ? `导入完成,${impInv.result.errors.length} 行失败` : `已生成 ${impInv.result.ok} 条费用记录`);
    } catch (e) { toast(e.message, 'err'); impBtn.textContent = '生成费用记录 ✓'; impBtn.disabled = false; }
  };
  const view = $('#btnInvView');
  if (view) view.onclick = () => showTab('expenses');
  const reset = $('#btnInvReset');
  if (reset) reset.onclick = () => {
    impInv = { files: [], parsed: 0, rows: [], config: impInv.config, result: null };
    renderImport(); bindImport();
  };
}

/* ---------------- 政策库 ---------------- */
async function renderPolicy() {
  const p = await api('/api/policies?year=' + state.year);
  const st = p.status;
  $('#content').innerHTML = `
    <div class="card"><h3>${state.year}年度适用政策参数 <span class="sub">自动按年度选择现行口径(联网检查见下方)</span></h3>
      <div class="table-wrap"><table>
        <tr><th>项目</th><th>${state.year}年口径</th></tr>
        <tr><td>费用化加计比例</td><td>${esc(st.deductRatio)}</td></tr>
        <tr><td>资本化摊销</td><td>${esc(st.amortRatio)}</td></tr>
        <tr><td>集成电路/工业母机(清单企业)</td><td>${esc(st.icRatio)}</td></tr>
        <tr><td>委托境内研发</td><td>${esc(st.entrustDomestic)}</td></tr>
        <tr><td>委托境外研发</td><td>${esc(st.entrustOverseas)}</td></tr>
        <tr><td>其他相关费用限额</td><td>${esc(st.otherLimit)}</td></tr>
        <tr><td>小型微利企业</td><td>${esc(st.sme)}</td></tr>
        <tr><td>备查资料留存</td><td>${esc(st.retention)}</td></tr>
      </table></div>
    </div>
    <div class="card"><h3>联网检查最新政策 <span class="sub">仅作提示,不替代人工核对</span></h3>
      <button class="btn btn-primary" id="policyCheck"> 检查网络与最新政策</button>
      <div id="policyResult" class="muted" style="margin-top:8px;line-height:1.7"></div>
    </div>
    <div class="card"><h3>内置政策文件库 <span class="sub">执行时以税务总局官网最新公告为准</span></h3>
      ${p.policies.map(pol => `<div class="policy-item">
        <div class="pi-head"><b>${esc(pol.doc)}</b> ${esc(pol.title)} <span class="tag ${pol.status.includes('现行') ? 'tag-green' : 'tag-gray'}">${esc(pol.status)}</span></div>
        <div class="muted" style="font-size:12px">发布:${esc(pol.date)}</div>
        <ul class="pi-points">${pol.points.map(pt => `<li>${esc(pt)}</li>`).join('')}</ul>
        <a class="btn btn-sm" href="${esc(pol.url)}" target="_blank">官方链接</a>
      </div>`).join('')}
    </div>`;
}
function bindPolicy() {
  const btn = $('#policyCheck');
  if (!btn) return;
  btn.onclick = async () => {
    const box = $('#policyResult');
    btn.disabled = true; btn.textContent = '检查中(最长8秒)…';
    try {
      const r = await api('/api/policy/online');
      box.innerHTML = r.reachable
        ? `<span class="ok-text">✓ 网络可达(状态 ${r.status},${r.bytes} 字节)${r.title ? '<br>页面:' + esc(r.title) : ''}</span><br>${esc(r.note)}`
        : `<span class="red">✗ ${esc(r.note)}</span>`;
    } catch (e) { box.innerHTML = `<span class="red">检查失败:${esc(e.message)}</span>`; }
    btn.disabled = false; btn.textContent = ' 检查网络与最新政策';
  };
}

/* ---------------- 初始化 ---------------- */
async function init() {
  state.meta = await api('/api/meta');
  // 年度选项
  const yearSel = $('#yearSel');
  for (let y = new Date().getFullYear() + 1; y >= new Date().getFullYear() - 3; y--) {
    const o = document.createElement('option');
    o.value = y; o.textContent = y + '年';
    if (String(y) === state.year) o.selected = true;
    yearSel.appendChild(o);
  }
  yearSel.onchange = () => {
    state.year = yearSel.value;
    localStorage.setItem('rd_year', state.year);
    showTab(state.tab);
  };

  $('#nav').addEventListener('click', e => {
    const a = e.target.closest('a[data-tab]');
    if (a) showTab(a.dataset.tab);
  });

  $('#btnGuide').onclick = () => renderFirstRun();
  $('#btnDemo').onclick = async () => {
    if (!confirm('载入示例数据将覆盖现有数据(2个项目、6人、28笔费用),确定?')) return;
    try {
      await api('/api/demo/load', { method: 'POST' });
      toast('示例数据已载入'); await loadAll(); await showTab('dashboard');
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#btnClear').onclick = async () => {
    if (!confirm('清空全部数据?此操作不可恢复。')) return;
    await api('/api/demo/clear', { method: 'POST' });
    toast('已清空'); await loadAll(); await showTab('dashboard');
  };

  await loadAll();
  showFirstRun();
  await showTab('dashboard');
}

init().catch(e => {
  document.getElementById('content').innerHTML =
    `<div class="warn-box">初始化失败:${esc(e.message)} — 请确认服务已启动(npm start)。</div>`;
});
