// T4 风险规则触发矩阵(40 条规则,每条最小触发场景)
const H = require('./harness');
const fs = require('fs'); const path = require('path');
const { P, clear, comp, proj, exp, staff, ts, getRisks, getSummary, LN, fmt, eq, ok, sec, suite, j } = H;
const DATA = path.join(__dirname, '..', '..', 'data');

const hasRisk = (risks, code, level) => risks.some(r => r.code === code && r.level === level);
const checkRule = async (name, buildFn, code, level) => {
  await clear(); await comp();
  const extra = await buildFn();
  const { risks } = await getRisks('2026');
  const hit = hasRisk(risks, code, level);
  ok(hit, `${name}: 期望 [${level}] ${code}${hit ? '' : ' 未触发(实际:' + risks.filter(r => r.code === code).map(r => r.level).join(',') + ')'}`);
  return risks;
};
const baseProj = async (extra = {}) => proj({ code: 'RD-T', name: '项目T', ...extra });
const baseExp = async (pid, cat = 'personnel', amt = 50000, extra = {}) =>
  exp(pid, cat, amt, { materialNo: cat === 'direct' ? 'L1' : undefined, ...extra });

(async () => {
  await suite('T4 风险规则触发矩阵', 't4', async () => {

    // R01 负面行业
    await checkRule('R01 负面行业占比60%', async () => {
      await clear(); await comp({ industry: '批发业', negativeRevenueShare: 60 });
      const p = await baseProj(); await baseExp(p.id);
    }, 'R01', 'error');
    await checkRule('R01 占比30%(<50%)', async () => {
      await clear(); await comp({ industry: '餐饮业', negativeRevenueShare: 30 });
      const p = await baseProj(); await baseExp(p.id);
    }, 'R01', 'warning');
    await checkRule('R01 未填占比', async () => {
      await clear(); await comp({ industry: '零售业' });
      const p = await baseProj(); await baseExp(p.id);
    }, 'R01', 'error');

    // R02 核定征收
    await checkRule('R02 核定征收', async () => {
      await clear(); await comp({ levyType: '核定征收' });
      const p = await baseProj(); await baseExp(p.id);
    }, 'R02', 'error');

    // R03/R04 立项缺失
    await checkRule('R03 无立项决议', async () => {
      const p = await baseProj({ hasApprovalDoc: false }); await baseExp(p.id);
    }, 'R03', 'warning');
    await checkRule('R04 无计划书', async () => {
      const p = await baseProj({ hasPlanDoc: false }); await baseExp(p.id);
    }, 'R04', 'warning');

    // R05 负面活动
    await checkRule('R05 负面活动', async () => {
      const p = await baseProj({ activityType: '市场调查/效率调查/管理研究' }); await baseExp(p.id);
    }, 'R05', 'warning');

    // R06 事后立项
    await checkRule('R06 事后立项', async () => {
      const p = await baseProj({ approvalDate: '2026-12-01' });
      await baseExp(p.id, 'direct', 50000, { date: '2026-06-30', period: '2026-06' });
    }, 'R06', 'warning');

    // R07 资本化无摊销
    await checkRule('R07 资本化无摊销', async () => {
      const p = await baseProj({ capitalization: 'capitalize' });
      await baseExp(p.id, 'personnel', 50000, { capitalization: 'capitalize' });
    }, 'R07', 'info');

    // R08 无工时
    await checkRule('R08 直接人员无工时', async () => {
      await staff('张八'); const p = await baseProj(); await baseExp(p.id);
    }, 'R08', 'warning');

    // R09 工时100% 聚合
    {
      await clear(); await comp();
      const p = await baseProj(); await baseExp(p.id);
      const s = await staff('全时');
      await ts(s.id, p.id, '2026-06', 160, 160);
      await ts(s.id, p.id, '2026-07', 160, 160);
      const { risks } = await getRisks('2026');
      const r09 = risks.filter(r => r.code === 'R09');
      ok(r09.length === 1 && r09[0].level === 'info', `R09 工时占比100% 聚合1条(info),实际${r09.length}条: ${r09.map(r => r.title).join(';')}`);
    }

    // R24 受托开发
    await checkRule('R24 受托开发', async () => {
      const p = await baseProj({ resultOwner: 'client' }); await baseExp(p.id);
    }, 'R24', 'error');

    // R27 境外个人
    await checkRule('R27 境外个人委托', async () => {
      const p = await baseProj({ form: 'entrust_overseas_person' }); await baseExp(p.id, 'entrust_overseas_person', 50000);
    }, 'R27', 'error');

    // R28/R29 合作/集中
    await checkRule('R28 合作研发', async () => {
      const p = await baseProj({ form: 'cooperation' }); await baseExp(p.id);
    }, 'R28', 'warning');
    await checkRule('R29 集中研发', async () => {
      const p = await baseProj({ form: 'centralized' }); await baseExp(p.id);
    }, 'R29', 'warning');

    // R35 岗位疑似
    await checkRule('R35 岗位疑似非研发', async () => {
      await staff('生产张', { role: '生产经理', dept: '生产部', isDirect: true });
      const p = await baseProj(); await baseExp(p.id);
    }, 'R35', 'warning');

    // R10 无凭证号
    await checkRule('R10 无凭证号', async () => {
      const p = await baseProj(); await baseExp(p.id, 'direct', 50000, { voucherNo: '' });
    }, 'R10', 'warning');

    // R11 缺发票/合同
    await checkRule('R11 缺发票/合同', async () => {
      const p = await baseProj(); await baseExp(p.id, 'direct', 50000, { invoiceNo: '', contractNo: '' });
    }, 'R11', 'warning');

    // R12 大额现金
    await checkRule('R12 大额现金', async () => {
      const p = await baseProj(); await baseExp(p.id, 'direct', 20000, { paymentMethod: '现金' });
    }, 'R12', 'warning');

    // R13 跨期间
    await checkRule('R13 费用跨项目期间', async () => {
      const p = await baseProj({ startDate: '2026-01-01', endDate: '2026-06-30' });
      await baseExp(p.id, 'direct', 50000, { date: '2026-09-15', period: '2026-09' });
    }, 'R13', 'warning');

    // R14 共用无方法(文件直写)
    {
      await clear(); await comp();
      const p = await baseProj();
      const e = await baseExp(p.id, 'depreciation', 50000);
      const fp = path.join(DATA, 'expenses.json');
      const arr = JSON.parse(fs.readFileSync(fp, 'utf8'));
      const i = arr.findIndex(x => x.id === e.id);
      arr[i].isShared = true; delete arr[i].allocMethod;
      fs.writeFileSync(fp, JSON.stringify(arr, null, 2), 'utf8');
      const { risks } = await getRisks('2026');
      ok(hasRisk(risks, 'R14', 'warning'), 'R14 共用费用未选分摊方法(文件直写) 触发');
    }

    // R41 共用折旧无台账
    await checkRule('R41 共用折旧无台账', async () => {
      const p = await baseProj();
      await baseExp(p.id, 'depreciation', 50000, { allocMethod: 'ratioHours', isShared: true, period: '2026-06' });
    }, 'R41', 'warning');

    // R49 领料单缺失 6笔
    {
      await clear(); await comp(); const p = await baseProj();
      for (let k = 1; k <= 6; k++) await baseExp(p.id, 'direct', 5000 * k + 100, { materialNo: '' });
      const { risks } = await getRisks('2026');
      const r49 = risks.filter(r => r.code === 'R49');
      ok(r49.length === 6, `R49 领料单缺失 6笔 → 5逐笔+1汇总=6条,实际${r49.length}条`);
    }

    // R15 其他超限 / R16 接近上限
    await checkRule('R15 其他费用超限额', async () => {
      const p = await baseProj();
      await baseExp(p.id, 'personnel', 100000); await baseExp(p.id, 'other', 30000);
    }, 'R15', 'error');
    await checkRule('R16 接近上限(占比9.1%)', async () => {
      const p = await baseProj();
      await baseExp(p.id, 'personnel', 100000); await baseExp(p.id, 'other', 10000);
    }, 'R16', 'info');

    // R17 境外超限
    await checkRule('R17 境外超2/3', async () => {
      const p = await baseProj();
      await baseExp(p.id, 'personnel', 100000); await baseExp(p.id, 'entrust_overseas', 100000);
    }, 'R17', 'warning');

    // R34 差异率>5%
    await checkRule('R34 口径差异率>5%', async () => {
      const p = await baseProj();
      await baseExp(p.id, 'personnel', 100000); await baseExp(p.id, 'other', 30000);
    }, 'R34', 'warning');

    // R38 材料占比 / R39 委托占比
    await checkRule('R38 材料费占比畸高', async () => {
      const p = await baseProj();
      await baseExp(p.id, 'direct', 70000, { materialNo: 'L1' }); await baseExp(p.id, 'personnel', 30000);
    }, 'R38', 'warning');
    await checkRule('R39 委托占比畸高', async () => {
      const p = await baseProj();
      await baseExp(p.id, 'entrust_domestic_org', 60000); await baseExp(p.id, 'personnel', 40000);
    }, 'R39', 'warning');

    // R18/R19 占收入比
    await checkRule('R18 研发占收入>15%', async () => {
      await clear(); await comp({ revenue: { 2026: 500000 } });
      const p = await baseProj(); await baseExp(p.id, 'personnel', 100000);
    }, 'R18', 'warning');
    await checkRule('R19 研发占收入<0.5%', async () => {
      await clear(); await comp({ revenue: { 2026: 100000000 } });
      const p = await baseProj(); await baseExp(p.id, 'personnel', 100000);
    }, 'R19', 'info');

    // R20 较上年+50% / R37 增幅远超收入
    await checkRule('R20 研发较上年+50%', async () => {
      await clear(); await comp({ revenue: { 2026: 1000000, 2025: 900000 } });
      const p = await baseProj();
      await baseExp(p.id, 'personnel', 100000, { date: '2025-06-30', period: '2025-06' });
      await baseExp(p.id, 'personnel', 160000, { date: '2026-06-30', period: '2026-06' });
    }, 'R20', 'info');
    await checkRule('R37 研发增幅远超收入', async () => {
      await clear(); await comp({ revenue: { 2026: 1000000, 2025: 900000 } });
      const p = await baseProj();
      await baseExp(p.id, 'personnel', 100000, { date: '2025-06-30', period: '2025-06' });
      await baseExp(p.id, 'personnel', 300000, { date: '2026-06-30', period: '2026-06' });
    }, 'R37', 'warning');

    // R21 亏损
    await checkRule('R21 亏损', async () => {
      await clear(); await comp({ taxableIncome: { 2026: -50000 } });
      const p = await baseProj(); await baseExp(p.id);
    }, 'R21', 'info');

    // R45 人员占比 / R46 税负率降半
    await checkRule('R45 研发人员占比异常', async () => {
      await clear(); await comp({ headcount: 10 });
      for (let k = 0; k < 7; k++) await staff('人' + k, { isDirect: true });
      const p = await baseProj(); await baseExp(p.id);
    }, 'R45', 'warning');
    await checkRule('R46 税负率降半', async () => {
      await clear(); await comp({ revenue: { 2026: 1000000, 2025: 1000000 }, taxableIncome: { 2026: 50000, 2025: 200000 } });
      const p = await baseProj(); await baseExp(p.id);
    }, 'R46', 'warning');

    // R47 空壳研发
    await checkRule('R47 高投入零成果', async () => {
      const p = await baseProj({ hasResultDocs: false, hasProcessDocs: false });
      await baseExp(p.id, 'personnel', 500000);
    }, 'R47', 'warning');

    // R48 电耗上升
    await checkRule('R48 单位电耗上升', async () => {
      await clear(); await comp({ electricity: { 2026: 100000, 2025: 60000 }, output: { 2026: 1000, 2025: 1200 } });
      const p = await baseProj(); await baseExp(p.id);
    }, 'R48', 'warning');

    // R40 高企达标/不达标
    await checkRule('R40 高企不达标', async () => {
      await clear(); await comp({ isHiTech: true, headcount: 100, techStaff: 5 });
      const p = await baseProj(); await baseExp(p.id);
    }, 'R40', 'warning');

    // R23 委托缺合同发票 / R36 委托缺登记
    await checkRule('R23 委托缺合同发票', async () => {
      const p = await baseProj();
      await baseExp(p.id, 'entrust_domestic_org', 50000, { contractNo: '', invoiceNo: '' });
    }, 'R23', 'warning');
    await checkRule('R36 委托缺技术合同登记', async () => {
      const p = await baseProj({ form: 'entrust_domestic_org', techContractNo: '' });
      await baseExp(p.id, 'entrust_domestic_org', 50000);
    }, 'R36', 'warning');

    // R25 特殊收入
    await checkRule('R25 特殊收入', async () => {
      const p = await baseProj(); await baseExp(p.id, 'personnel', 100000);
      await P('/api/specialIncomes', { projectId: p.id, type: 'scrap', amount: 10000, date: '2026-06-20', period: '2026-06' });
    }, 'R25', 'info');

    // R26 不可计入项(文件直写绕过关键词拦截)
    {
      await clear(); await comp();
      const p = await baseProj();
      const e = await baseExp(p.id, 'other', 50000);
      const fp = path.join(DATA, 'expenses.json');
      const arr = JSON.parse(fs.readFileSync(fp, 'utf8'));
      const i = arr.findIndex(x => x.id === e.id);
      arr[i].summary = '业务招待费测试';
      fs.writeFileSync(fp, JSON.stringify(arr, null, 2), 'utf8');
      const { risks } = await getRisks('2026');
      ok(hasRisk(risks, 'R26', 'error'), 'R26 不可计入项(业务招待,文件直写) 触发error');
    }

    // R42/R43/R44 金税四期品名
    await checkRule('R42 高危品名(黄金)', async () => {
      const p = await baseProj();
      await baseExp(p.id, 'direct', 50000, { summary: '采购黄金材料', materialNo: 'L1' });
    }, 'R42', 'warning');
    await checkRule('R43 管理费用重分类(办公用品)', async () => {
      const p = await baseProj();
      await baseExp(p.id, 'other', 50000, { summary: '办公用品采购' });
    }, 'R43', 'warning');
    await checkRule('R44 售后维护(维修)', async () => {
      const p = await baseProj();
      await baseExp(p.id, 'direct', 50000, { summary: '设备维修费', materialNo: 'L1' });
    }, 'R44', 'warning');

    // R31 不征税剔除 / R33 IC
    await checkRule('R31 不征税收入剔除', async () => {
      await clear(); await comp({ nonTaxRelated: { 2026: 30000 } });
      const p = await baseProj(); await baseExp(p.id, 'personnel', 100000);
    }, 'R31', 'warning');
    {
      await clear(); await comp({ icIndustrial: true });
      const p = await baseProj(); await baseExp(p.id);
      const r26 = await getRisks('2026');
      const r28 = await getRisks('2028');
      ok(hasRisk(r26.risks, 'R33', 'info') && hasRisk(r28.risks, 'R33', 'warning'),
        `R33 IC企业2026=info / 2028=warning (实际2026:${r26.risks.filter(r => r.code === 'R33').map(r => r.level)}, 2028:${r28.risks.filter(r => r.code === 'R33').map(r => r.level)})`);
    }

    // R30 个税缺员
    await checkRule('R30 个税名单缺员', async () => {
      const s1 = await staff('研发张', { isDirect: true });
      const s2 = await staff('行政李', { isDirect: false });
      await P('/api/taxroll', { staffId: s2.id, staffName: '行政李', year: 2026 });
      const p = await baseProj(); await baseExp(p.id);
    }, 'R30', 'warning');

    // R99 空库
    {
      await clear();
      const { risks } = await getRisks('2026');
      console.log('      空库风险数 =', risks.length, JSON.stringify(risks.map(r => [r.code, r.level])));
      ok(risks.length === 0 || risks.every(r => r.level === 'info'), 'R99 空库仅info或无风险');
    }
  });

  const chk = await j('/api/expenses');
  console.log('\n[数据恢复校验] 费用条数 =', chk.length, '(应为 14)');
})();
