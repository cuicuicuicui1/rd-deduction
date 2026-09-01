// 风险自检规则引擎 —— 输出红/黄/绿三级风险报告(附政策依据)
const { NEGATIVE_INDUSTRIES, NEGATIVE_ACTIVITIES, BASE_FIVE, NON_DEDUCTIBLE_KEYWORDS,
  HIGH_RISK_MATERIALS, ADMIN_EXPENSE_KEYWORDS, AFTERSALE_KEYWORDS, POLICIES } = require('./constants');
const { computeSummary, computeCalibers, excludedProjectIds } = require('./summary');

const LEVELS = { error: '红', warning: '黄', info: '绿' };

function fmt(n) {
  return (Number(n) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * 执行全部风险规则
 * @returns {Array<{code, level:'error'|'warning'|'info', title, detail, suggestion, basis, year}>}
 */
function runRiskCheck({ company, projects, staff, timesheets, expenses, amortizations, specialIncomes, taxroll, assets, year }) {
  const risks = [];
  const yearStr = String(year);
  const s = computeSummary({ company, projects, expenses, timesheets, amortizations, specialIncomes, year });
  const d = s.detail;
  const push = (code, level, title, detail, suggestion, basis) =>
    risks.push({ code, level, title, detail, suggestion, basis, year: yearStr });

  // ---- 红:阻断级 ----
  if (company) {
    const neg = NEGATIVE_INDUSTRIES.find(i => String(company.industry || '').includes(i));
    const share = company.negativeRevenueShare !== undefined && company.negativeRevenueShare !== null && company.negativeRevenueShare !== ''
      ? Number(company.negativeRevenueShare) : null;
    if (share !== null && share >= 50) {
      push('R01', 'error', '负面清单行业收入占比≥50%,不得享受加计扣除',
        `负面行业收入占比 ${share}%(≥50%),按主营业务判定属于负面清单行业。`,
        '本年度不得享受加计扣除;需复核收入口径与行业划分。',
        '财税〔2015〕119号(负面清单行业按主营收入占比判定)');
    } else if (neg) {
      const shareTxt = share !== null ? `负面行业收入占比 ${share}%(<50%)` : '未填报负面行业收入占比';
      push('R01', share !== null && share < 50 ? 'warning' : 'error', '负面清单行业不得享受加计扣除',
        `所属行业「${company.industry}」命中负面清单「${neg}」。${shareTxt}。`,
        share !== null && share < 50
          ? '行业名称命中但收入占比<50%,按主营收入占比判定口径需留存收入结构说明备查。'
          : '若实际经营属于负面清单行业,本年度不得享受加计扣除;需确认行业划分是否准确。',
        '财税〔2015〕119号;财政部 税务总局公告2023年第7号');
    }
    if (company.levyType === '核定征收') {
      push('R02', 'error', '核定征收企业不得享受加计扣除',
        '企业所得税为核定征收,不具备享受加计扣除条件。',
        '需转为查账征收后方可享受。',
        '财税〔2015〕119号');
    }
  }

  const projExpenses = pid => (expenses || []).filter(e => e.projectId === pid);
  const allExp = expenses || [];

  // 立项管理
  projects.forEach(p => {
    const exps = projExpenses(p.id);
    const hasMoney = exps.some(e => Number(e.amount) > 0);
    if (hasMoney && p.hasApprovalDoc !== true) {
      push('R03', 'warning', `项目「${p.name}」无立项决议文件`,
        '该项目存在费用但未标记立项决议文件,研发真实性依据不足。',
        '补充企业有权部门立项决议文件(董事会/股东会决议或管理层批准),并录入标记。',
        '2015年97号公告(备查资料第2项)');
    }
    if (hasMoney && p.hasPlanDoc !== true) {
      push('R04', 'warning', `项目「${p.name}」无项目计划书`,
        '缺少研究开发项目计划书。',
        '补充项目计划书(目标、技术路线、预算、周期)。',
        '2015年97号公告(备查资料第1项)');
    }
    if (p.activityType && NEGATIVE_ACTIVITIES.includes(p.activityType)) {
      push('R05', 'warning', `项目「${p.name}」属于不适用加计扣除的研发活动`,
        `研发活动类型为「${p.activityType}」,属于负面清单活动。`,
        '需重新界定项目为实质性研发;若确属常规活动,相应费用不得加计。',
        '财税〔2015〕119号(不适用研发活动)');
    }
    if (p.approvalDate) {
      const firstExpDate = exps.map(e => e.date).filter(Boolean).sort()[0];
      if (firstExpDate && p.approvalDate > firstExpDate) {
        push('R06', 'warning', `项目「${p.name}」存在事后立项嫌疑`,
          `立项决议日期(${p.approvalDate})晚于最早费用发生日期(${firstExpDate})。`,
          '核实立项时间;若确为事后补立,相应费用存在被剔除风险。',
          '财税〔2015〕119号(立项决议为备查要件)');
      }
    }
    // 资本化项目无摊销说明
    if (p.capitalization === 'capitalize') {
      const am = (amortizations || []).filter(a => a.projectId === p.id);
      const hasCap = exps.some(e => e.capitalization === 'capitalize');
      if (hasCap && !am.length) {
        push('R07', 'info', `项目「${p.name}」为资本化项目,未见摊销记录`,
          '资本化支出形成无形资产后应按200%摊销加计,需建立摊销台账。',
          '项目结题形成无形资产后,在「摊销」页录入年度摊销额或一键自动生成摊销计划。',
          '财政部 税务总局公告2023年第7号');
      }
    }
    // 受托开发:成果归客户,整项目不得加计
    if (p.resultOwner === 'client') {
      const hasMoney = exps.some(e => Number(e.amount) > 0);
      if (hasMoney) {
        push('R24', 'error', `项目「${p.name}」为受托开发(成果归客户),不得加计`,
          `该项目 ${exps.length} 笔费用已从加计基数中整项目剔除(合计 ${fmt(exps.reduce((s, e) => s + (Number(e.amount) || 0), 0))} 元)。`,
          '受托开发(按客户要求定制、成果归客户)属于提供研发服务,不得享受加计扣除;相应收入按服务收入核算。',
          '财税〔2015〕119号(企业为他人提供研发服务不属于本企业研发活动)');
      }
    }
    // 委托境外个人:不得加计
    if (p.form === 'entrust_overseas_person') {
      const hasMoney = exps.some(e => Number(e.amount) > 0);
      if (hasMoney) {
        push('R27', 'error', `项目「${p.name}」为委托境外个人研发,不得加计`,
          `委托境外个人进行的研发活动不得享受加计扣除,相关费用已整项目剔除。`,
          '委托境外研发仅限委托境外机构(且需技术合同认定登记);境外个人研发费用不得加计。',
          '财税〔2018〕64号(委托境外个人研发不得加计)');
      }
    }
    // 合作研发:各自费用核算 + 合同
    if (p.form === 'cooperation') {
      const hasMoney = exps.some(e => Number(e.amount) > 0);
      if (hasMoney) {
        push('R28', 'warning', `项目「${p.name}」为合作研发,需合同与费用分割依据`,
          '合作研发各方应分别就自身实际发生的研发费用申报加计;需留存合作合同/协议(建议科技部门登记)。',
          '在项目备注中记录合作方与费用分割口径;留存合同、费用明细与各自核算凭证。',
          '财税〔2015〕119号;2015年97号公告(合作研发备查资料)');
      }
    }
    // 集中研发:集团分摊
    if (p.form === 'centralized') {
      const hasMoney = exps.some(e => Number(e.amount) > 0);
      if (hasMoney) {
        push('R29', 'warning', `项目「${p.name}」为集中研发(集团),需分摊决议与决算`,
          '集中研发项目需集团内合理分摊研发费用,并留存项目立项书、研发费决算表、分摊明细及分摊依据。',
          '补充集团集中研发分摊决议与决算表,按实际受益合理分摊。',
          '财税〔2015〕119号;2015年97号公告(集中研发备查资料)');
      }
    }
  });

  // 工时管理
  const tsByStaff = {};
  (timesheets || []).forEach(t => {
    (tsByStaff[t.staffId] = tsByStaff[t.staffId] || []).push(t);
  });
  (staff || []).forEach(pp => {
    const ts = tsByStaff[pp.id] || [];
    if (pp.isDirect === true && !ts.length) {
      push('R08', 'warning', `研发人员「${pp.name}」无任何工时记录`,
        '标记为直接从事研发,但工时台账为空,人员费用归集缺乏依据。',
        '按月度补录研发工时/总工时,或从研发人员名单中剔除。',
        '2017年40号公告(费用分配说明含工时)');
    }
  });
  // 工时占比100%提示(按人员聚合,避免逐期噪音)
  {
    const fullMap = {};
    (timesheets || []).forEach(t => {
      const ratio = Number(t.totalHours) > 0 ? Number(t.rdHours) / Number(t.totalHours) : 0;
      if (ratio > 0.95 && Number(t.rdHours) > 0) {
        const key = t.staffId || t.staffName || '?';
        fullMap[key] = (fullMap[key] || 0) + 1;
      }
    });
    Object.entries(fullMap).forEach(([key, n]) => {
      push('R09', 'info', `工时占比异常:${key}(${n}期)`,
        `${n} 期研发工时占比接近或等于100%。`,
        '需留存说明,证明该人员当期全部投入研发(如考勤+项目记录)。',
        '2017年40号公告(工时记录)');
    });
  }
  // 发现1:按工时分摊的共享费用,目标期间无任何工时记录 → 计算端静默全额回退挂靠项目,
  // 项目间归集失真(60/40→100/0)但总额不变,分摊依据缺失——稽查核查点,必须预警
  {
    const noTsMap = {};
    (expenses || []).forEach(e => {
      if (e.allocMethod === 'ratioHours' && Number(e.amount) > 0) {
        const period = e.period || String(e.date || '').slice(0, 7) || '未注明期间';
        const hasTs = (timesheets || []).some(t => (t.period || '') === period);
        if (!hasTs) {
          const key = `${period}|${e.projectId}`;
          noTsMap[key] = noTsMap[key] || { period, projectId: e.projectId, count: 0, amount: 0 };
          noTsMap[key].count++;
          noTsMap[key].amount += Number(e.amount) || 0;
        }
      }
    });
    Object.values(noTsMap).forEach(g => {
      const p = (projects || []).find(x => x.id === g.projectId);
      push('R50', 'warning', `按工时分摊费用在期间「${g.period}」无工时记录`,
        `${g.count} 笔共 ${fmt(g.amount)} 元按工时比例分摊的共享费用,期间「${g.period}」无任何工时台账,已全额计入挂靠项目「${p ? p.name : g.projectId}」,项目间归集失真(60/40→100/0)。`,
        '补录该期间各项目研发工时台账(人员与工时页);按工时分摊的依据(工时记录)必须留存备查,否则共用费用分摊不被认可。',
        '财税〔2015〕119号;2017年40号公告(共用费用分摊依据)');
    });
  }

  // 岗位/部门疑似非研发(案例:生产/销售/行政人员工资计入研发被全额剔除)
  const NON_RD_ROLE_HITS = ['销售', '行政', '财务', '人事', '后勤', '仓库', '采购', '客服', '司机', '保安', '保洁', '生产'];
  (staff || []).forEach(pp => {
    if (pp.isDirect !== true) return;
    const roleTxt = String(pp.role || '') + String(pp.dept || '');
    const hit = NON_RD_ROLE_HITS.find(k => roleTxt.includes(k));
    if (hit) {
      push('R35', 'warning', `研发人员「${pp.name}」岗位/部门疑似非研发(${hit})`,
        `岗位/部门「${roleTxt}」含非研发关键词「${hit}」,但标记为直接从事研发。`,
        '核实该人员是否实际从事研发并留存研发任务单/工作记录;若为生产/销售/行政人员,应从研发人员名单剔除并调整工资归集。',
        '税务预警指标体系(人员比对);稽查案例(生产/销售/行政人员工资混入研发被剔除)');
    }
  });

  // 费用规范性
  allExp.forEach(e => {
    const amt = Number(e.amount) || 0;
    if (amt > 0 && !e.voucherNo) {
      push('R10', 'warning', `费用无凭证号(摘要:${(e.summary || '').slice(0, 20)})`,
        `金额 ${fmt(amt)} 元未填写记账凭证号。`,
        '补充凭证号并留存原始凭证。',
        '财税〔2015〕119号(费用真实性)');
    }
    // 需发票/合同的类别:直接投入、设计试验费、其他相关费用、委托研发(工资/折旧/摊销以内部凭证为准)
    const needsInvoice = ['direct', 'design', 'other',
      'entrust_domestic_org', 'entrust_domestic_person', 'entrust_overseas'].includes(e.category);
    if (amt > 0 && needsInvoice && !e.invoiceNo && !e.contractNo) {
      push('R11', 'warning', `费用缺发票/合同(摘要:${(e.summary || '').slice(0, 20)})`,
        `金额 ${fmt(amt)} 元未登记发票号或合同号。`,
        '取得合法有效凭证(发票/合同);委托个人研发需凭合法凭证。',
        '2017年40号公告(合法有效凭证)');
    }
    if (e.paymentMethod === '现金' && amt > 10000) {
      push('R12', 'warning', `大额现金支付(摘要:${(e.summary || '').slice(0, 20)})`,
        `金额 ${fmt(amt)} 元以现金支付,易引发真实性核查。`,
        '改用银行转账,保留付款流水。',
        '财税〔2015〕119号(真实性原则)');
    }
    if (e.projectId) {
      const p = projects.find(x => x.id === e.projectId);
      if (p && p.startDate && p.endDate && e.date) {
        if (e.date < p.startDate || e.date > p.endDate) {
          push('R13', 'warning', `费用跨项目期间(摘要:${(e.summary || '').slice(0, 20)})`,
            `费用日期 ${e.date} 不在项目「${p.name}」期间(${p.startDate}~${p.endDate})内。`,
            '核实归属期间,调整项目期间或费用日期。',
            '财税〔2015〕119号(费用归属)');
        }
      }
    }
    if (e.isShared === true && !e.allocMethod) {
      push('R14', 'warning', `共用费用未选择分摊方法(摘要:${(e.summary || '').slice(0, 20)})`,
        '共用费用必须明确分摊方法与依据。',
        '选择按工时比例或自定义权重分摊,并留存分配说明。',
        '2017年40号公告(共用费用分摊)');
    }
    // P2-1(审计):费用级资本化标记与所属项目资本化属性交叉校验。
    //  ① 项目为资本化、该笔费用标的属形成无形资产支出,却以「费用化」录入(漏填/导入列缺失/API直写)——
    //    会被静默当作费用化当年全额加计,与该资本化项目口径冲突,存在多计加计风险。
    //  ② 项目为费用化、费用却标「资本化」——形成无法摊销的"悬空资本化"。
    //  注意:共享费用(工时分摊/自定义权重)在 allocationType 中按"分摊目标项目"定型,自身 capitalization 字段被忽略,
    //        故不参与本校验,避免误报(否则共享费用挂资本化项目但标费用化会被误报)。
    const sharedExp = e.isShared === true || e.allocMethod === 'ratioHours' || e.allocMethod === 'ratioCustom';
    if (e.projectId && !sharedExp) {
      const p = projects.find(x => x.id === e.projectId);
      if (p) {
        if (p.capitalization === 'capitalize' && e.capitalization !== 'capitalize') {
          push('R51', 'warning', `资本化项目下费用标注为费用化:${(e.summary || '').slice(0, 20)}`,
            `项目「${p.name}」为资本化项目(形成无形资产按200%/220%摊销加计),该笔费用(${fmt(amt)} 元)支出类型却是「费用化」,会被计入当年费用化加计基数。`,
            '资本化项目下用于形成无形资产的直接支出应标注为「资本化」;若该笔支出确属当期费用化(未资本化),请确认后将项目属性改为费用化或在该项目下拆分。',
            '财税〔2015〕119号;2021年28号公告第三条(资本化支出未形成无形资产期间不计入基数)');
        } else if (p.capitalization !== 'capitalize' && e.capitalization === 'capitalize') {
          push('R51', 'warning', `费用化项目下费用标注为资本化:${(e.summary || '').slice(0, 20)}`,
            `项目「${p.name}」为费用化项目,该笔费用(${fmt(amt)} 元)却标注「资本化」,将计入资本化形成成本但无法摊销,产生"悬空资本化"。`,
            '费用化项目下的费用应标注「费用化」(当年直接加计);若确需资本化,请先将项目属性改为资本化。',
            '财税〔2015〕119号;2021年28号公告第三条(资本化支出未形成无形资产期间不计入基数)');
        }
      }
    }
  });

  // 共用设备/资源无使用台账(案例:共用设备无工时台账,折旧全额入研发被调减)
  const sharedDep = allExp.filter(e => e.isShared === true && ['depreciation', 'amortization', 'other'].includes(e.category) && Number(e.amount) > 0);
  if (sharedDep.length) {
    const yearAssets = (assets || []).filter(a => !a.period || String(a.period).startsWith(yearStr));
    if (!yearAssets.length) {
      push('R41', 'warning', '共用设备/资源无使用台账(折旧分摊依据缺失)',
        `${sharedDep.length} 笔共用折旧/摊销/其他类费用(合计 ${fmt(sharedDep.reduce((s, e) => s + (Number(e.amount) || 0), 0))} 元),但未登记任何共用资源使用台账。`,
        '在「共用资源」页登记共用设备/厂房/云服务等资源,录入年度研发工时与总工时,系统自动生成分摊表(备查包 13);否则折旧全额计入研发不被税务认可。',
        '2017年40号公告(费用分配说明);稽查案例(共用设备无工时台账,折旧全额入研发被调减)');
    }
  }

  // 材料领料单缺失(领料单需标注项目编号;总局通报:领料单无项目编号、生产领料混入研发)
  const matExps = allExp.filter(e => e.category === 'direct' && Number(e.amount) >= 5000);
  const noMatNo = matExps.filter(e => !e.materialNo);
  if (noMatNo.length) {
    noMatNo.slice(0, 5).forEach(e => {
      push('R49', 'warning', `材料费无领料单号:${(e.summary || '').slice(0, 20)}`,
        `直接投入材料费 ${fmt(e.amount)} 元未登记领料单号。`,
        '研发领料必须留存领料单并标注项目编号(总局通报:领料单无项目编号、生产领料混入研发领料)。在费用编辑中补录领料单号,并确保领料单与项目/用途对应。',
        '金税四期领料单-项目比对;总局通报(领料单无项目编号,生产领料混入研发)');
    });
    if (noMatNo.length > 5) {
      push('R49', 'warning', `另有 ${noMatNo.length - 5} 笔材料费无领料单号`,
        '同上,建议逐笔补录领料单号。', '补录领料单号并留存领料凭证。', '金税四期领料单-项目比对');
    }
  }

  // 限额与比例
  if (d.otherExcess > 0) {
    push('R15', 'error', '其他相关费用超过10%限额',
      `实际发生 ${fmt(d.otherActual)} 元,限额 ${fmt(d.otherLimit)} 元,超限 ${fmt(d.otherExcess)} 元已自动剔除。`,
      '申报时以限额金额计入;超限部分剔除。建议调减不属于直接相关的其他费用。',
      '财税〔2015〕119号;2017年40号公告(限额=前5类合计×10%÷90%)');
  } else if (d.otherActual > 0) {
    const ratio = d.base5 > 0 ? d.otherActual / (d.base5 + d.otherActual) : 0;
    if (ratio > 0.085) {
      push('R16', 'info', '其他相关费用占比接近10%上限',
        `其他费用占可加计费用 ${(ratio * 100).toFixed(1)}%,接近10%限额。`,
        '注意超限剔除;关注差旅、会议、咨询费的真实性佐证。',
        '财税〔2015〕119号');
    }
  }
  if (d.entrustOverseasExcess > 0) {
    push('R17', 'warning', '委托境外研发超过境内2/3限额',
      `委托境外按80%计入 ${fmt(d.entrustOverseasRaw)} 元,境内2/3限额 ${fmt(d.entrustOverseasCap)} 元,超限 ${fmt(d.entrustOverseasExcess)} 元已剔除。`,
      '申报时以限额金额计入;境外委托需技术合同认定登记。',
      '财税〔2018〕64号');
  }

  // 会计口径 vs 加计口径差异率(税局交叉比对红线:差异率≤5%)
  // H3:合规口径差异(资本化当年支出/委托×80%/境外2/3/其他费用10%限额/特殊收入冲减/不征税剔除/受托开发剔除)全部视为"已解释差异",
  // 仅对剩余"未解释差异"是否超过5%预警——避免全委托/含大额合规调整企业误报。
  const cal = computeCalibers({ company, projects, expenses, timesheets, amortizations, specialIncomes, year });
  if (cal.accounting > 0 && cal.eligible !== false) {
    const raw = d.categoryActual || {};
    const excluded = excludedProjectIds(projects || []);
    const excludedSpend = round2((expenses || [])
      .filter(e => excluded.has(e.projectId) && String(e.period || e.date || '').startsWith(yearStr))
      .reduce((s, e) => s + (Number(e.amount) || 0), 0));
    // 资本化当年支出(全额,含资本化池内委托原值——不重复计20%)
    const capitalCurrent = round2((expenses || [])
      .filter(e => e.capitalization === 'capitalize' && String(e.period || e.date || '').startsWith(yearStr))
      .reduce((s, e) => s + (Number(e.amount) || 0), 0));
    // 委托×80%差额(仅费用化池,资本化池已含在 capitalCurrent 全额剔除内)
    const entrustRaw = round2((raw.entrust_domestic_org || 0) + (raw.entrust_domestic_person || 0) + (raw.entrust_overseas || 0));
    const entrustCut = round2(entrustRaw * 0.2);
    // 境外2/3超限剔除 + 其他费用10%限额剔除 + 特殊收入冲减 + 不征税剔除
    // 委托境外个人:不得加计(财税〔2018〕64号),会计口径全额列支、加计口径剔除——属纯政策合规差异
    const entrustOverseasPersonRaw = round2(raw.entrust_overseas_person || 0);
    const explained = round2(capitalCurrent + entrustCut + (d.entrustOverseasExcess || 0)
      + (d.otherExcess || 0) + (d.specialIncomeDeducted || 0) + (d.exemptExcluded || 0) + excludedSpend + entrustOverseasPersonRaw);
    const residual = round2(Math.abs(cal.accounting - cal.deduction - explained));
    const diffRate = residual / cal.accounting;
    if (diffRate > 0.05) {
      push('R34', 'warning', '会计口径与加计口径差异率超过5%(核查红线)',
        `会计口径 ${fmt(cal.accounting)} 元,费用化加计基数 ${fmt(cal.deduction)} 元,其中已解释合规差异 ${fmt(explained)} 元(资本化当年支出 ${fmt(capitalCurrent)}、委托×80%差额 ${fmt(entrustCut)}、境外2/3超限 ${fmt(d.entrustOverseasExcess || 0)}、其他费用10%限额 ${fmt(d.otherExcess || 0)}、特殊收入冲减 ${fmt(d.specialIncomeDeducted || 0)}、不征税剔除 ${fmt(d.exemptExcluded || 0)}、受托开发剔除 ${fmt(excludedSpend)}、委托境外个人(不得加计) ${fmt(entrustOverseasPersonRaw)}),未解释差异 ${fmt(residual)} 元,差异率 ${(diffRate * 100).toFixed(1)}%。`,
        '税局交叉比对辅助账/申报表/高企专项审计,要求差异率控制在5%以内。上列合规差异均已自动剔除,若仍超5%,请逐项核对:是否存在跨年费用归属错误、重复入账、漏分摊、类别错挂等真实问题。',
        '税务核查实践(辅助账 vs 申报表 vs 高企专项审计差异率≤5%)');
    }
  }

  // 费用结构占比(大数据预警指标:材料费占比/委托研发占比畸高)
  if (d.totalExpenseBase > 0) {
    const raw = d.categoryActual || {};
    const rawTotal = d.base5 + d.otherActual +
      (raw.entrust_domestic_org || 0) + (raw.entrust_domestic_person || 0) + (raw.entrust_overseas || 0);
    if (rawTotal > 0) {
      const directRatio = (raw.direct || 0) / rawTotal;
      if (directRatio > 0.6) {
        push('R38', 'warning', '研发材料费(直接投入)占比过高',
          `直接投入 ${fmt(raw.direct || 0)} 元,占研发费用总额 ${(directRatio * 100).toFixed(0)}%。`,
          '材料费占比畸高易触发大数据预警。核查:生产领料是否混入研发领料(需领料单与项目关联)、研发领料是否有领用记录、研发产出样品收入是否已冲减。',
          '税务预警指标体系(费用结构比对)');
      }
      const entrustRawTotal = (raw.entrust_domestic_org || 0) + (raw.entrust_domestic_person || 0) + (raw.entrust_overseas || 0);
      const entrustRatio = entrustRawTotal / rawTotal;
      if (entrustRatio > 0.5) {
        push('R39', 'warning', '委托研发占比畸高',
          `委托研发实际发生额 ${fmt(entrustRawTotal)} 元,占研发费用总额 ${(entrustRatio * 100).toFixed(0)}%。`,
          '自主研发极少、委托研发畸高易被质疑"变相购买研发成果"。需留存:委托技术合同(经科技部门登记)、受托方研发过程材料、成果归属证明。',
          '税务预警指标体系(研发形式结构比对)');
      }
    }
  }

  // 规模与结构预警
  const revenue = company && company.revenue ? Number(company.revenue[yearStr]) || 0 : 0;
  if (revenue > 0) {
    const ratio = d.totalExpenseBase / revenue;
    if (ratio > 0.15) {
      push('R18', 'warning', '研发费用占营业收入比例异常偏高',
        `加计基数 ${fmt(d.totalExpenseBase)} 元,占收入 ${fmt(revenue)} 元的 ${(ratio * 100).toFixed(1)}%。`,
        '显著高于行业水平时易触发预警;需准备研发真实性证明材料。',
        '税务预警指标体系(行业比对)');
    }
    if (ratio < 0.005 && d.totalExpenseBase > 0) {
      push('R19', 'info', '研发费用占营业收入比例偏低',
        `占收入仅 ${(ratio * 100).toFixed(2)}%。`,
        '确认是否漏归集费用。',
        '税务预警指标体系(行业比对)');
    }
  }
  const prevYear = String(Number(yearStr) - 1);
  const revPrev = company && company.revenue ? Number(company.revenue[prevYear]) || 0 : 0;
  const prevSummary = computeSummary({ company, projects, expenses, timesheets, amortizations, year: prevYear });
  const prevBase = prevSummary.detail.totalExpenseBase;
  if (revenue > 0 && revPrev > 0) {
    if (prevBase > 0 && d.totalExpenseBase > prevBase * 1.5) {
      push('R20', 'info', '研发费用较上年大幅增长',
        `本年加计基数 ${fmt(d.totalExpenseBase)} 元,上年 ${fmt(prevBase)} 元,增长 ${((d.totalExpenseBase / prevBase - 1) * 100).toFixed(0)}%。`,
        '大额突增需准备立项与过程证据,防止"无中生有"质疑。',
        '税务预警指标体系(变动分析)');
    }
  }
  // 研发费用增幅 vs 收入增幅(案例:研发增幅远高于收入增幅触发大数据预警)
  if (d.totalExpenseBase > 0 && prevBase > 0) {
    const expGrowth = d.totalExpenseBase / prevBase - 1;
    if (expGrowth > 0.5) {
      if (revenue > 0 && revPrev > 0) {
        const revGrowth = revenue / revPrev - 1;
        if (expGrowth > revGrowth + 0.5) {
          push('R37', 'warning', '研发费用增幅远超收入增幅(大数据预警)',
            `本年加计基数 ${fmt(d.totalExpenseBase)} 元,较上年增长 ${(expGrowth * 100).toFixed(0)}%;同期营业收入仅增长 ${(revGrowth * 100).toFixed(0)}%。`,
            '研发投入远快于收入增长,易被系统标记"异常增长"。需准备:新立项项目计划书、研发过程记录、成果证明,证明费用真实发生。',
            '税务预警指标体系(收入与研发费用变动匹配分析)');
        }
      } else if (!revenue && !revPrev) {
        push('R37', 'info', '研发费用大幅增长,建议补录营业收入以便跨年比对',
          `本年加计基数较上年增长 ${(expGrowth * 100).toFixed(0)}%,但未录入两年营业收入,无法与收入增速比对。`,
          '在企业设置页补录本年/上年营业收入,系统自动检测"研发费用增幅 vs 收入增幅"异常。',
          '税务预警指标体系(变动分析)');
      }
    }
  }
  if (company && company.taxableIncome && Number(company.taxableIncome[yearStr]) < 0) {
    const hiTech = !!company.isHiTech;
    push('R21', 'info', '亏损企业享受加计扣除',
      `当年应纳税所得额为负(${fmt(Number(company.taxableIncome[yearStr]))} 元),加计扣除将进一步增加亏损,可结转弥补:${hiTech ? '高新技术企业/科技型中小企业 10 年(财税〔2018〕76号)' : '一般企业 5 年(企业所得税法第十八条)'}。`,
      hiTech
        ? '按财税〔2018〕76号建立 10 年亏损弥补台账,确保具备高新技术企业资格年度前 5 个年度的亏损可结转。'
        : '按企业所得税法第十八条建立 5 年亏损弥补台账,注意结转时效。',
      hiTech ? '财税〔2018〕76号' : '企业所得税法第十八条');
  }

  // 研发人员占比异常(金税四期人员结构建模;行业差异大,>60% 提示)
  {
    const directCount = (staff || []).filter(s => s.isDirect === true).length;
    const totalStaff = Number(company && company.headcount) || (staff || []).length;
    if (totalStaff >= 5 && directCount > 0) {
      const ratio = directCount / totalStaff;
      if (ratio > 0.6) {
        push('R45', 'warning', '研发人员占比异常偏高',
          `直接研发人员 ${directCount} 人/从业 ${totalStaff} 人,占比 ${(ratio * 100).toFixed(0)}%。`,
          '除软件/技术服务等特殊行业外,研发人员占比过高易触发人员结构预警。核查:是否将生产/销售/行政人员计入研发名单(个税/社保与研发名单交叉比对)。',
          '金税四期人员结构建模;总局通报(扩大研发人员范围,非研发人员工资668万纳入研发被罚571万)');
      }
    }
  }

  // 税负率跨年监控(应纳税所得额/收入代理,大幅下降触发预警)
  {
    const taxCur = company && company.taxableIncome ? Number(company.taxableIncome[yearStr]) || 0 : 0;
    const taxPrev = company && company.taxableIncome ? Number(company.taxableIncome[prevYear]) || 0 : 0;
    if (revenue > 0 && revPrev > 0 && taxCur > 0 && taxPrev > 0) {
      const rateCur = taxCur / revenue;
      const ratePrev = taxPrev / revPrev;
      if (rateCur < ratePrev * 0.5) {
        push('R46', 'warning', '税负率大幅下降(异常预警)',
          `应纳税所得额/收入:本年 ${(rateCur * 100).toFixed(2)}%,上年 ${(ratePrev * 100).toFixed(2)}%,降幅 ${((1 - rateCur / ratePrev) * 100).toFixed(0)}%。`,
          '企业所得税税负率大幅异常下降是金税四期重点监控信号。核实:研发费用真实性、是否漏记收入、加计扣除后税负是否合理。',
          '金税四期税负率监控;总局通报(税负率大幅异常下降触发稽查)');
      }
    }
  }

  // 高投入零成果(空壳研发识别)
  {
    const threshold = 500000; // 50 万
    if (d.totalExpenseBase >= threshold) {
      const projWithMoney = projects.filter(p => projExpenses(p.id).some(e => Number(e.amount) > 0));
      const anyEvidence = projWithMoney.some(p => p.hasResultDocs === true || p.hasProcessDocs === true);
      if (!anyEvidence) {
        push('R47', 'warning', '高研发投入但无任何成果/过程证据(空壳研发风险)',
          `本年加计基数 ${fmt(d.totalExpenseBase)} 元(≥50万),但所有有费用的项目均未标记「过程文档/实验记录」或「成果证明」。`,
          '高投入零成果是最典型的空壳研发信号(总局通报:配方微调包装研发、虚构项目均为此类)。补齐:实验记录、测试报告、专利/软著申请、样机鉴定等;无法提供的项目应主动放弃加计。',
          '金税四期投入-成果匹配;总局通报(虚构研发项目、高投入零成果)');
      }
    }
  }

  // 能耗(电费)-产出(产量)合理性(金税四期"以电倒推"模型)
  {
    const elecCur = company && company.electricity ? Number(company.electricity[yearStr]) || 0 : 0;
    const elecPrev = company && company.electricity ? Number(company.electricity[prevYear]) || 0 : 0;
    const outCur = company && company.output ? Number(company.output[yearStr]) || 0 : 0;
    const outPrev = company && company.output ? Number(company.output[prevYear]) || 0 : 0;
    if (elecCur > 0 && outCur > 0 && elecPrev > 0 && outPrev > 0) {
      const intensityCur = elecCur / outCur;
      const intensityPrev = elecPrev / outPrev;
      if (intensityCur > intensityPrev * 1.5) {
        push('R48', 'warning', '单位产出电耗大幅上升(能耗倒推异常)',
          `单位产出电费:本年 ${fmt(intensityCur)} 元/单位,上年 ${fmt(intensityPrev)} 元/单位,上升 ${(((intensityCur / intensityPrev) - 1) * 100).toFixed(0)}%。`,
          '电费与产量不匹配是金税四期"以电倒推"的核心模型(总局通报:虚报研发动力电费、材料费异常)。核查:电费是否虚列、研发耗电与产量变化是否匹配。',
          '金税四期能耗-产出倒推模型;总局通报(虚报研发动力电费、材料费占比异常)');
      }
    } else if (d.totalExpenseBase >= 100000 && (elecCur === 0 || outCur === 0)) {
      push('R48', 'info', '建议补录年度电费与产量数据(能耗倒推检查)',
        `本年加计基数 ≥10万,但未录入年度电费/产量,无法执行"电费-产量"合理性校验。`,
        '在企业设置页补录本年(及上年)年度电费(元)与年度产量(件/吨/台),系统自动检测能耗与产出匹配异常。',
        '金税四期能耗-产出倒推模型');
    }
  }
  if (company && company.isHiTech) {
    push('R22', 'info', '高新认定企业与加计扣除口径需保持一致',
      '两套申报(高新年报与加计扣除)费用数据易被交叉比对。',
      '建议使用本系统「三口径对照」台账,确保高企研发费用占比达标且两口径数据可解释。',
      '国科发火〔2016〕32号;税务预警指标体系(跨部门比对)');
  }

  // 高企资格存续期核心指标动态监控(科技人员占比≥10%、研发费用占比分档、高新收入占比≥60%)
  if (company && company.isHiTech) {
    const issues = [];
    const headcount = Number(company.headcount) || 0;
    const techStaff = Number(company.techStaff) || 0;
    if (headcount > 0 && techStaff > 0) {
      const techRatio = techStaff / headcount;
      if (techRatio < 0.1) issues.push(`科技人员占比 ${(techRatio * 100).toFixed(1)}%(要求≥10%)`);
    } else {
      issues.push('未填科技人员数或从业人数(无法判定科技人员占比)');
    }
    if (revenue > 0) {
      const req = revenue <= 50000000 ? 0.05 : revenue <= 200000000 ? 0.04 : 0.03;
      const htRatio = cal.hiTech / revenue;
      if (htRatio < req) issues.push(`研发费用占收入比 ${(htRatio * 100).toFixed(2)}%(要求≥${(req * 100).toFixed(0)}%)`);
    } else if (d.totalExpenseBase > 0) {
      issues.push('未填营业收入(无法判定研发费用占比)');
    }
    const htIncome = Number(company.hiTechIncome && company.hiTechIncome[yearStr]) || 0;
    if (revenue > 0 && htIncome > 0) {
      const incRatio = htIncome / revenue;
      if (incRatio < 0.6) issues.push(`高新产品(服务)收入占比 ${(incRatio * 100).toFixed(1)}%(要求≥60%)`);
    } else if (revenue > 0 && !htIncome) {
      issues.push('未填高新产品(服务)收入(无法判定收入占比)');
    }
    if (issues.length) {
      push('R40', 'warning', '高企核心指标需关注',
        `高新技术企业资格存续期核心指标:${issues.join(';')}。`,
        '高企资格一旦取消,当年及后续年度不得享受15%优惠税率(涉及补税风险)。在企业设置页补充从业人数/科技人员数/营业收入/高新产品收入,并确保指标达标;口径与加计扣除保持可解释一致。',
        '国科发火〔2016〕32号(高企认定条件:科技人员占比≥10%、研发费用占比分档、高新收入占比≥60%)');
    } else {
      push('R40', 'info', '高企核心指标达标',
        '科技人员占比、研发费用占比、高新产品收入占比均已达标(以最终专项审计报告为准)。',
        '维持年度监控,留存研发人员花名册、研发费用辅助账、高新产品收入明细。',
        '国科发火〔2016〕32号');
    }
  }

  // 委托研发合同
  const entrustExps = allExp.filter(e => String(e.category).startsWith('entrust'));
  if (entrustExps.length) {
    const noDoc = entrustExps.filter(e => !e.contractNo && !e.invoiceNo);
    if (noDoc.length) {
      push('R23', 'warning', '委托研发缺合同或发票',
        `${noDoc.length} 笔委托研发费用未登记合同号/发票号。`,
        '委托研发必须留存合同/协议、费用支出明细、发票及付款凭证;境外委托需技术合同认定登记。',
        '2015年97号公告;财税〔2018〕64号');
    }
  }

  // 委托研发技术合同认定登记(案例:外购现成技术伪装委托研发被追缴1715万)
  (projects || []).forEach(p => {
    if (!p.form || !p.form.startsWith('entrust')) return;
    const hasMoney = (expenses || []).some(e => e.projectId === p.id && Number(e.amount) > 0);
    if (hasMoney && !p.techContractNo) {
      push('R36', 'warning', `委托研发项目「${p.name}」缺技术合同认定登记编号`,
        '委托研发费用存在,但未登记技术合同认定登记编号(委托境内/境外机构的合同需经科技部门认定登记)。',
        '在「研发项目」页补录科技部门技术合同认定登记编号并留存登记证明;未登记的委托研发存在被全额剔除风险。',
        '技术合同认定登记管理办法;财税〔2015〕119号;财税〔2018〕64号');
    }
  });

  // 特殊收入冲减
  if (d.specialIncomeTotal > 0) {
    push('R25', 'info', '特殊收入已冲减研发费用',
      `本年登记下脚料/残次品/试制品销售收入 ${fmt(d.specialIncomeTotal)} 元,已冲减研发费用 ${fmt(d.specialIncomeDeducted)} 元${d.specialIncomeUnused > 0 ? `;超出可冲减费用 ${fmt(d.specialIncomeUnused)} 元,按收入处理` : ''}。`,
      '特殊收入冲减研发费用后,留存销售台账与记账凭证备查。',
      '国家税务总局公告2017年第40号(特殊收入冲减研发费用)');
  }

  // 不可计入项拦截(培训/房屋折旧/物业水电/招待/商业保险)
  // F5(审计):与入口校验(blockedKeyword)口径一致——「水电」记在「直接投入(direct)」类属研发直接消耗动力费(119号/40号),不标红;
  //          记在其他类别(办公室水电/物业水电)仍标红。此处仅提示级,入口处已被强校验。
  const banned = allExp.filter(e => {
    if ((String(e.summary || '').includes('会议') && String(e.summary || '').includes('接待'))) return true;
    const hit = NON_DEDUCTIBLE_KEYWORDS.find(k => String(e.summary || '').includes(k));
    if (!hit) return false;
    if (hit === '水电' && e.category === 'direct') return false; // 研发动力费放行(与入口一致)
    return true;
  });
  if (banned.length) {
    banned.slice(0, 5).forEach(e => {
      push('R26', 'error', `疑似不可计入项:${(e.summary || '').slice(0, 24)}`,
        `摘要命中不可计入关键词,金额 ${fmt(e.amount)} 元(类别:${e.category})。`,
        '培训费/职工教育费/房屋折旧/房租/物业水电/业务招待费/商业保险等不属于可加计研发费用,应从研发费用中剔除。',
        '财税〔2015〕119号;2017年40号公告(费用归集范围)');
    });
    if (banned.length > 5) {
      push('R26', 'error', `另有 ${banned.length - 5} 笔疑似不可计入项`,
        '同上,建议逐笔复核剔除。', '从研发费用中剔除并调整记账科目。', '财税〔2015〕119号');
    }
  }

  // 高危发票品名(金税四期品名建模:特殊品名进研发需特别证明)
  const highRisk = allExp.filter(e => HIGH_RISK_MATERIALS.some(k => String(e.summary || '').includes(k)));
  if (highRisk.length) {
    highRisk.slice(0, 5).forEach(e => {
      push('R42', 'warning', `高危品名材料:${(e.summary || '').slice(0, 24)}`,
        `摘要命中高危品名(黄金/贵金属/动力电/煤炭/燃料等),金额 ${fmt(e.amount)} 元。`,
        '特殊品名材料计入研发极易触发金税四期品名建模预警。需留存:领料单(标注项目编号)、购销合同、进项发票、出入库记录、研发用途说明;无法证明用途的必须剔除。',
        '金税四期发票品名建模;总局通报(虚列黄金材料消耗、虚报动力电费)');
    });
    if (highRisk.length > 5) {
      push('R42', 'warning', `另有 ${highRisk.length - 5} 笔高危品名支出`,
        '同上,建议逐笔复核用途证明。', '补齐领料单与用途证明或剔除。', '金税四期发票品名建模');
    }
  }

  // 管理费用重分类识别(金税四期科目重分类比对)
  const adminLike = allExp.filter(e => ADMIN_EXPENSE_KEYWORDS.some(k => String(e.summary || '').includes(k)));
  if (adminLike.length) {
    adminLike.slice(0, 5).forEach(e => {
      push('R43', 'warning', `疑似管理费用重分类:${(e.summary || '').slice(0, 24)}`,
        `摘要命中办公/行政类关键词(办公用品/快递/饮用水等),金额 ${fmt(e.amount)} 元。`,
        '办公用品、饮用水、快递等行政性支出不属于研发费用,禁止重分类为研发费(总局通报:管理费用重分类为研发费被追缴)。若确为研发专用,需留存领料/领用记录证明。',
        '金税四期科目重分类比对;总局通报(管理费用重分类为研发费)');
    });
    if (adminLike.length > 5) {
      push('R43', 'warning', `另有 ${adminLike.length - 5} 笔疑似管理费重分类`,
        '同上,建议逐笔复核。', '从研发费用中剔除。', '金税四期科目重分类比对');
    }
  }

  // 售后/维护类支出(不属于研发活动)
  const aftersale = allExp.filter(e => AFTERSALE_KEYWORDS.some(k => String(e.summary || '').includes(k)));
  if (aftersale.length) {
    aftersale.slice(0, 5).forEach(e => {
      push('R44', 'warning', `疑似售后/维护支出:${(e.summary || '').slice(0, 24)}`,
        `摘要命中售后/调试/维修/保养关键词,金额 ${fmt(e.amount)} 元。`,
        '产品售后调试、常规工艺维护不属于研发活动,不得加计(总局通报:售后调试、常规维护计入研发被调增)。若为研发设备维修或研发样机调试,需留存维修/调试记录与研发关联证明。',
        '财税〔2015〕119号(不适用研发活动);总局通报(售后调试计入研发)');
    });
    if (aftersale.length > 5) {
      push('R44', 'warning', `另有 ${aftersale.length - 5} 笔疑似售后/维护支出`,
        '同上,建议逐笔复核研发属性。', '区分研发性维修与售后维护,后者剔除。', '财税〔2015〕119号');
    }
  }

  // 不征税收入对应支出
  if (d.exemptExcluded > 0) {
    push('R31', 'warning', '不征税收入对应研发支出已剔除',
      `登记不征税收入对应研发支出 ${fmt(d.exemptRelated)} 元,已从加计基数剔除 ${fmt(d.exemptExcluded)} 元。`,
      '政府补助/软件增值税即征即退若按不征税收入处理,对应支出不得税前扣除及加计;若拟全额加计,需将退税款作应税收入处理。',
      '企业所得税法实施条例第二十八条;财税〔2011〕100号(软件即征即退)');
  }

  // 集成电路/工业母机 120%
  if (company && company.icIndustrial) {
    const inWindow = Number(year) >= POLICIES.icPeriodStart && Number(year) <= POLICIES.icPeriodEnd;
    if (inWindow) {
      push('R33', 'info', '集成电路/工业母机清单企业,加计比例120%',
        `本年度费用化加计按 ${d.deductRatio * 100}%、资本化摊销按 ${d.amortRatio * 100}% 计算(2023-01-01~2027-12-31)。`,
        '需确认企业处于工信部清单内;离开清单年度按100%执行。',
        '财政部 税务总局公告2023年第44号');
    } else {
      push('R33', 'warning', '标记为集成电路/工业母机企业,但不在44号公告适用年度内',
        `44号公告适用于 2023-01-01~2027-12-31,当前年度 ${year} 不适用,已按100%计算。`,
        '若仍有疑问请核对清单年度。', '财政部 税务总局公告2023年第44号');
    }
  }

  // 个税申报名单比对(研发人员应全员在个税申报中,防止"名单虚挂")
  if ((staff || []).length && (taxroll || []).length) {
    const inTaxroll = new Set((taxroll || []).filter(t => String(t.year) === yearStr).map(t => t.staffId));
    const missing = (staff || []).filter(pp => pp.isDirect === true && !inTaxroll.has(pp.id));
    if (missing.length) {
      push('R30', 'warning', `个税申报名单缺 ${missing.length} 名直接研发人员`,
        `${missing.slice(0, 5).map(m => m.name).join('、')}${missing.length > 5 ? ' 等' : ''} 标记为直接研发,但未出现在 ${yearStr} 年个税申报名单中。`,
        '研发人员名单与个税/社保申报名单应一致;补齐申报或在「人员与工时」页登记个税名单。',
        '税务预警指标体系(人员比对:个税/社保 vs 研发名单)');
    }
  }

  // 无任何数据时的提示
  if (!allExp.length && (!projects || !projects.length)) {
    push('R99', 'info', '暂无数据',
      '尚未录入项目与费用,无法进行完整自检。',
      '可先「载入示例数据」体验全流程。',
      '—');
  }

  return risks;
}

module.exports = { runRiskCheck, LEVELS };
