// 日常运维操作测试:编辑补录 / 凭证附件 / 备份恢复 / 摊销计划 / 整改跟踪
const BASE = process.env.BASE || 'http://127.0.0.1:8765';
const fs = require('fs'); const path = require('path');
let pass = 0, fail = 0; const fails = [];
function expect(name, got, want, extra) {
  const ok = Array.isArray(want) ? want.includes(got) : got === want;
  if (ok) { pass++; console.log(`[PASS] ${name} -> ${got}`); }
  else { fail++; fails.push(`${name}: 实际=${JSON.stringify(got)} 预期=${JSON.stringify(want)} ${extra || ''}`); console.log(`[FAIL] ${name} -> 实际=${JSON.stringify(got)} 预期=${JSON.stringify(want)} ${extra || ''}`); }
}
const sec = t => console.log('\n===== ' + t + ' =====');
async function api(method, p, body, isRaw, ct) {
  const opt = { method, headers: {} };
  if (body !== undefined) { opt.headers['Content-Type'] = ct || (isRaw ? 'application/octet-stream' : 'application/json'); opt.body = isRaw ? body : JSON.stringify(body); }
  const res = await fetch(BASE + p, opt);
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { __raw: text.slice(0, 200) }; }
  return { status: res.status, body: json, text };
}

(async () => {
  const projects = (await api('GET', '/api/projects')).body;
  const P1 = projects.find(p => p.code === '2026-RD-01');
  const P2 = projects.find(p => p.code === '2026-RD-02');
  const Y = '2026';

  sec('A. 编辑补录领料单号 → 风险应消除');
  const before = (await api('GET', `/api/risks?year=${Y}`)).body;
  const r49before = before.risks.filter(r => r.code === 'R49').length;
  console.log('      补录前 R49 条数 =', r49before);
  const exps = (await api('GET', '/api/expenses')).body;
  const mats = exps.filter(e => e.category === 'direct' && !e.materialNo);
  for (const e of mats) {
    const rr = await api('PUT', `/api/expenses/${e.id}`, { materialNo: 'LL-2026-' + String(Math.floor(Math.random() * 9000) + 1000) });
    if (rr.status !== 200) console.log('      !! 补录失败', rr.status, rr.body.error);
  }
  const after = (await api('GET', `/api/risks?year=${Y}`)).body;
  const r49after = after.risks.filter(r => r.code === 'R49').length;
  console.log('      补录后 R49 条数 =', r49after);
  expect('A1 补录领料单号后 R49 清零', r49after, 0);

  sec('B. 编辑改支付方式(现金→转账)→ 风险应消除');
  const cash = exps.find(e => e.paymentMethod === '现金');
  let r = await api('PUT', `/api/expenses/${cash.id}`, { paymentMethod: '银行转账' });
  expect('B1 编辑支付方式', r.status, 200, r.body.error);
  const r2 = (await api('GET', `/api/risks?year=${Y}`)).body;
  expect('B2 R12 大额现金风险消除', r2.risks.filter(x => x.code === 'R12').length, 0);

  sec('C. 编辑时把摘要改成不可加计内容 → 应被拦截');
  r = await api('PUT', `/api/expenses/${cash.id}`, { summary: '研发人员业务招待费' });
  expect('C1 编辑为违规摘要应被拒绝', r.status, 400, r.body.error);
  r = await api('PUT', `/api/expenses/${cash.id}`, { amount: -1 });
  expect('C2 编辑为负金额应被拒绝', r.status, 400, r.body.error);
  r = await api('PUT', `/api/expenses/${cash.id}`, { category: '乱写的类别' });
  expect('C3 编辑为非法类别应被拒绝', r.status, 400, r.body.error);
  r = await api('PUT', `/api/expenses/${cash.id}`, { date: '2026-99-99' });
  expect('C4 编辑为非法日期', r.status, [200, 400], JSON.stringify(r.body).slice(0, 120));
  r = await api('PUT', `/api/expenses/not_exist_id`, { amount: 100 });
  expect('C5 编辑不存在的费用返回404', r.status, 404, JSON.stringify(r.body).slice(0, 100));
  r = await api('DELETE', '/api/expenses/not_exist_id');
  expect('C6 删除不存在的费用(应幂等或404)', r.status, [200, 404], JSON.stringify(r.body).slice(0, 100));

  sec('D. 凭证附件上传/列表/删除');
  const target = exps.find(e => e.projectId === P1.id);
  const png = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A49444154789C6300010000050001', 'hex');
  r = await api('POST', `/api/expenses/${target.id}/attachments`, png, true, 'application/octet-stream');
  console.log('      上传响应:', JSON.stringify(r.body).slice(0, 200));
  expect('D1 附件上传(缺少文件名参数)', r.status, [200, 201, 400], JSON.stringify(r.body).slice(0, 150));
  r = await api('GET', `/api/expenses/${target.id}/attachments`);
  console.log('      附件列表:', JSON.stringify(r.body).slice(0, 250));
  r = await api('GET', '/api/attachments');
  expect('D2 全量附件清单接口', r.status, 200);

  sec('E. 备份与恢复');
  r = await api('POST', '/api/backup/create', { tag: 'rdtest' });
  expect('E1 创建备份', r.status, 200, r.body.error);
  const bkName = r.body.name;
  const list = (await api('GET', '/api/backups')).body;
  console.log('      备份数量 =', list.backups.length, '| 最新 =', bkName);
  // 破坏数据后恢复
  const cntBefore = (await api('GET', '/api/expenses')).body.length;
  await api('POST', '/api/demo/clear');
  const cntCleared = (await api('GET', '/api/expenses')).body.length;
  expect('E2 清空后费用数', cntCleared, 0);
  r = await api('POST', '/api/backup/restore', { name: bkName });
  expect('E3 恢复备份', r.status, 200, r.body.error);
  const cntRestored = (await api('GET', '/api/expenses')).body.length;
  expect('E4 恢复后费用数回到原值', cntRestored, cntBefore);
  r = await api('POST', '/api/backup/restore', { name: 'backup_不存在_00000000_000000' });
  expect('E5 恢复不存在的备份应报错', r.status, 400, JSON.stringify(r.body).slice(0, 100));
  r = await api('POST', '/api/backup/restore', { name: '../../etc/passwd' });
  expect('E6 路径穿越备份名应被拒绝', r.status, 400, JSON.stringify(r.body).slice(0, 100));

  sec('F. 摊销计划自动生成(资本化项目)');
  r = await api('POST', '/api/amortization/plan', { projectId: P2.id, startYear: 2027, years: 10 });
  console.log('      摊销计划:', JSON.stringify(r.body).slice(0, 250));
  expect('F1 生成10年摊销计划', r.status, 201, r.body.error);
  if (r.status === 201) {
    const formed = r.body.formed, annual = r.body.annual;
    expect('F2 形成无形资产成本', formed, 595000);
    expect('F3 年摊销额(成本÷10年)', annual, 59500);
    const ams = (await api('GET', '/api/amortizations')).body;
    const total = ams.reduce((s, a) => s + a.amount, 0);
    expect('F4 摊销计划合计=形成成本(无尾差)', Math.round(total * 100) / 100, 595000);
    // 2027 年应有摊销加计
    const s27 = (await api('GET', '/api/summary?year=2027')).body;
    expect('F5 2027年摊销额', s27.detail.amortAmount, 59500);
    expect('F6 2027年摊销加计(×100%)', s27.detail.amortAdd, 59500);
    // 年限不足 10 年应拒绝
    r = await api('POST', '/api/amortization/plan', { projectId: P2.id, startYear: 2027, years: 5 });
    expect('F7 摊销年限<10年应被拒绝', r.status, 400, r.body.error);
    // 费用化项目应拒绝
    r = await api('POST', '/api/amortization/plan', { projectId: P1.id, startYear: 2027, years: 10 });
    expect('F8 费用化项目生成摊销应被拒绝', r.status, 400, r.body.error);
    // 清理
    for (const a of ams) await api('DELETE', '/api/amortizations/' + a.id);
  }

  sec('G. 整改完成跟踪');
  r = await api('POST', '/api/risks', {});
  expect('G1 /api/risks 不支持POST(应为404)', r.status, 404, JSON.stringify(r.body).slice(0, 80));
  // 整改状态存在哪?查 meta / 前端 localStorage
  const rr = (await api('GET', `/api/risks?year=${Y}`)).body;
  console.log('      风险对象字段:', Object.keys(rr.risks[0] || {}).join(', '));
  expect('G2 风险项含唯一标识(code+title)', rr.risks.every(x => x.code && x.title), true);

  sec('H. 特殊收入与不征税收入(端到端)');
  r = await api('POST', '/api/specialIncomes', { projectId: P1.id, type: 'scrap', amount: 100000, date: '2026-06-20', period: '2026-06', summary: '试制下脚料销售' });
  expect('H1 登记特殊收入', r.status, 201, r.body.error);
  const s2 = (await api('GET', `/api/summary?year=${Y}`)).body;
  expect('H2 特殊收入冲减后加计基数', s2.detail.totalExpenseBase, 1174000);
  const siId = r.body.id;
  await api('DELETE', '/api/specialIncomes/' + siId);
  const s3 = (await api('GET', `/api/summary?year=${Y}`)).body;
  expect('H3 删除后恢复', s3.detail.totalExpenseBase, 1274000);
  r = await api('POST', '/api/specialIncomes', { projectId: P1.id, type: 'scrap', amount: -500, date: '2026-06-20', period: '2026-06' });
  expect('H4 负金额特殊收入应被拒绝', r.status, 400, r.body.error);

  console.log('\n########## 运维操作测试汇总 ##########');
  console.log(`通过 ${pass} / 失败 ${fail}`);
  if (fails.length) { console.log('\n失败项:'); fails.forEach(f => console.log('  - ' + f)); }
})().catch(e => { console.error('脚本异常:', e); process.exit(1); });
