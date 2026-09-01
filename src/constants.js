// 政策常量与规则库 —— 政策依据均以税务总局现行有效文件为准
// 政策基线: 财税〔2015〕119号 / 2015年97号 / 2017年40号 / 财税〔2018〕64号 / 2021年28号 / 财政部 税务总局公告2023年第7号

const POLICIES = {
  deductRatio: 1.0,        // 费用化部分加计比例 100%(2023年7号)
  amortRatio: 1.0,         // 资本化无形资产本年摊销加计比例 100%(摊销按200%)
  entrustDomesticRatio: 0.8,   // 委托境内研发按实际发生额80%计入
  entrustOverseasRatio: 0.8,   // 委托境外研发按实际发生额80%计入
  overseasCap: 2 / 3,          // 委托境外不超过境内符合条件研发费用的2/3
  otherLimitRatio: 0.1,        // 其他相关费用≤可加计费用总额10%
  lossCarryYears: 10,          // 高新技术企业/科技型中小企业未弥补亏损结转10年(财税〔2018〕76号);一般企业5年(企业所得税法第十八条)
  smeIncomeCap: 3000000,       // 小型微利企业年应纳税所得额上限(实际税负5%,财税〔2023〕12号,现行至2027-12-31)
  smePeriodEnd: 2027,          // 小微优惠现行文件截止年度(到期以新公告为准,历史惯例均延续)
  smallMicroRate: 0.05,        // 小型微利企业实际税负(≤300万部分)
  standardRate: 0.25,          // 企业所得税法定税率
  hiTechRate: 0.15,            // 高新技术企业优惠税率15%(企业所得税法28条)
  halfRate: 0.125,             // 软件企业"两免三减半"减半期实际税负(25%÷2)
  zeroRate: 0,                 // 软件企业"两免三减半"免税期
  icDeductRatio: 1.2,          // 集成电路/工业母机清单企业:费用化加计120%(2023年44号,2023-01-01~2027-12-31)
  icAmortRatio: 1.2,           // 集成电路/工业母机清单企业:资本化摊销加计120%
  icPeriodStart: 2023,         // 44号公告适用起始年度
  icPeriodEnd: 2027,           // 44号公告适用截止年度
  retentionYears: 10,          // 留存备查资料保存年限
};

// 六大类费用 + 委托研发
const EXPENSE_CATEGORIES = [
  { key: 'personnel', name: '人员人工费用', note: '直接从事研发活动人员工资薪金、五险一金、外聘劳务费用' },
  { key: 'direct', name: '直接投入费用', note: '材料、燃料动力、试制模具/样机、租赁费等' },
  { key: 'depreciation', name: '折旧费用', note: '用于研发活动的仪器设备折旧' },
  { key: 'amortization', name: '无形资产摊销', note: '用于研发的软件、专利权、非专利技术摊销' },
  { key: 'design', name: '新产品设计费等', note: '新产品设计费、新工艺规程制定费、新药临床试验费、勘探现场试验费' },
  { key: 'other', name: '其他相关费用', note: '图书资料、翻译、咨询、差旅会议、福利费、补充保险等,受10%限额' },
  { key: 'entrust_domestic_org', name: '委托境内机构研发', note: '按实际发生额80%计入' },
  { key: 'entrust_domestic_person', name: '委托境内个人研发', note: '凭合法有效凭证,按80%计入' },
  { key: 'entrust_overseas', name: '委托境外研发', note: '按80%计入,且不超过境内符合条件研发费用的2/3' },
  { key: 'entrust_overseas_person', name: '委托境外个人研发', note: '不得加计扣除(税前可正常扣除)' },
];

const CATEGORY_MAP = Object.fromEntries(EXPENSE_CATEGORIES.map(c => [c.key, c.name]));

// 前五类(不含其他相关费用与委托),用于10%限额计算基数
const BASE_FIVE = ['personnel', 'direct', 'depreciation', 'amortization', 'design'];
const ENTRUST_KEYS = ['entrust_domestic_org', 'entrust_domestic_person', 'entrust_overseas'];

// 负面清单行业(财税〔2015〕119号,2023年7号延续排除)——按国标行业大类名称判定
const NEGATIVE_INDUSTRIES = [
  '烟草制品业', '住宿业', '餐饮业', '批发业', '零售业',
  '房地产业', '租赁业', '商务服务业', '娱乐业',
];

// 不适用加计扣除的研发活动(119号列举)
const NEGATIVE_ACTIVITIES = [
  '产品(服务)常规性升级', '科研成果直接应用', '商品化后客户技术支持',
  '重复或简单改变(工艺/材料)', '市场调查/效率调查/管理研究',
  '常规质量控制/测试分析/维修维护', '社会科学/艺术/人文学研究',
];

// 研发形式
const PROJECT_FORMS = [
  { key: 'self', name: '自主研发' },
  { key: 'entrust_domestic_org', name: '委托境内机构' },
  { key: 'entrust_domestic_person', name: '委托境内个人' },
  { key: 'entrust_overseas', name: '委托境外机构' },
  { key: 'entrust_overseas_person', name: '委托境外个人(不得加计)' },
  { key: 'cooperation', name: '合作研发' },
  { key: 'centralized', name: '集中研发(集团)' },
];

// 成果归属:受托开发(成果归客户)整项目不得加计
const RESULT_OWNERS = [
  { key: 'self', name: '成果归本企业(自研/委托开发)' },
  { key: 'client', name: '成果归客户(受托开发,不得加计)' },
];

// 特殊收入冲减类型(研发过程中形成的下脚料/残次品/试制品销售收入,应冲减研发费用)
const SPECIAL_INCOME_TYPES = [
  { key: 'scrap', name: '下脚料销售' },
  { key: 'defective', name: '残次品销售' },
  { key: 'trial', name: '试制品销售' },
];

// 明确不可计入研发费用加计扣除的支出(命中即提示/拦截)
const NON_DEDUCTIBLE_KEYWORDS = [
  '培训', '职工教育', '房屋折旧', '房租', '物业', '水电',
  '业务招待', '招待费', '宴请', '商业保险', '普通商业保险',
];

// 高危发票品名(金税四期品名建模:特殊品名出现在研发费用中需特别证明用途)
// 案例:深圳金斯达虚列黄金材料消耗(追缴3618万)、裕民焦煤虚报动力电费
const HIGH_RISK_MATERIALS = [
  '黄金', '白银', '贵金属', '铂金', '钻石', '金条', '银条',
  '动力电', '煤炭', '燃料油', '原油', '柴油', '汽油',
];

// 管理费用重分类识别(金税四期科目重分类比对:办公/行政类支出被归入研发)
// 案例:永锴建设管理费用重分类为研发费(631万)、程康行政人员费用(115万)
const ADMIN_EXPENSE_KEYWORDS = [
  '办公用品', '打印纸', '复印纸', 'A4纸', '饮用水', '桶装水', '快递', '邮寄',
  '办公耗材', '清洁用品', '办公家具', '文具', '绿植', '茶叶', '招待',
];

// 售后/维护类支出(不属于研发活动,不得加计)
// 案例:铜陵科技公司售后调试、常规工艺维护计入研发,仅立项书无实验记录
const AFTERSALE_KEYWORDS = [
  '售后', '调试', '维修', '维护', '保养', '检修', '返工', '售后支持', '客户支持',
];

// 分摊方法
const ALLOC_METHODS = [
  { key: 'direct', name: '直接归集' },
  { key: 'ratioHours', name: '按研发工时比例分摊' },
  { key: 'ratioCustom', name: '按自定义权重分摊' },
];

// 支出类型
const EXPENSE_TYPES = [
  { key: 'expense', name: '费用化' },
  { key: 'capitalize', name: '资本化' },
];

// 征收方式
const LEVY_TYPES = ['查账征收', '核定征收'];

// 行业选项(简表,用于录入与负面清单判定)
const INDUSTRIES = [
  '制造业', '软件和信息技术服务业', '科学研究和技术服务业', '生物医药制造业',
  '烟草制品业', '住宿业', '餐饮业', '批发业', '零售业', '房地产业', '租赁业', '商务服务业', '娱乐业',
  '建筑业', '交通运输业', '金融业', '其他',
];

// 备查资料阶段分组
const CHECKLIST_PHASES = [
  { key: 'planning', name: '① 立项阶段(项目启动前完成)' },
  { key: 'daily', name: '② 日常归集阶段(每月随做随留)' },
  { key: 'filing', name: '③ 申报与归档阶段(汇算清缴前整理)' },
];

// 备查资料清单(2015年97号公告 + 2017年40号公告)
// 每项含:准备指引 desc(材料应包含什么) / 实操提示 how(常见错误与红线) / 可一键获取的动作 action
const CHECKLIST = [
  {
    key: 'plan', name: '研究开发项目计划书', required: true, phase: 'planning',
    desc: '应包含:项目目标、技术路线与创新点、人员与组织安排、经费预算、进度计划、预期成果。',
    how: '立项时编写并随项目推进更新;日期逻辑会被跨部门比对,严禁事后倒补。',
    action: { label: '📄 下载立项书模板', api: '/templates/立项书模板.md', download: '研发项目立项书模板.md' },
  },
  {
    key: 'approval', name: '企业有权部门立项决议文件', required: true, phase: 'planning',
    desc: '董事会/股东会/总经理办公会批准立项的决议,写明项目名称、期间、预算、负责人。',
    how: '决议日期必须早于项目第一笔费用发生日(系统 R06 自动检测"事后立项");附会议纪要更稳妥。',
  },
  {
    key: 'orgchart', name: '研发机构/项目组编制与研发人员名单', required: true, phase: 'planning',
    desc: '研发部门设置或项目组名单,标注岗位与职责;直接从事研发的人员单列。',
    how: '名单须与个税/社保申报名单一致(系统 R30 自动比对);人员变动按月更新。',
  },
  {
    key: 'allocNote', name: '费用分配说明(含工时记录)', required: true, phase: 'daily',
    desc: '共用人员/设备/无形资产的分配说明与依据:工时台账、使用记录、面积占比等。',
    how: '本系统工时台账按月度维护(备查包 06 自动导出);共用折旧/房租必须留分配底稿(R14)。',
  },
  {
    key: 'ledger', name: '“研发支出”辅助账及汇总表(2021年版)', required: true, phase: 'daily',
    desc: '按项目归集的研发支出辅助账,分月小计、分类合计,与账面「研发支出」科目对平。',
    how: '本系统「辅助账」页自动生成并导出 Excel(备查包 01);年底与总账科目核对差额要能解释。',
    action: { label: '⬇ 导出辅助账 Excel', api: '/api/export/ledger.xlsx', download: true },
  },
  {
    key: 'centralizedDoc', name: '集中研发项目决算表与分摊资料', required: false, phase: 'daily',
    desc: '集团集中研发项目的决算表、费用分摊明细、分摊依据与受益比例。',
    how: '仅集团集中研发需要;分摊比例要有合同或决议支撑(R29)。',
  },
  {
    key: 'appraisal', name: '地市级(含)以上科技部门鉴定意见', required: false, phase: 'filing',
    desc: '有异议或留存困难的研发项目可申请科技部门鉴定,意见书作为真实性佐证。',
    how: '非强制;高企认定材料可复用同一份鉴定。',
  },
  {
    key: 'entrustContract', name: '委托研发合同、费用明细、发票与付款凭证', required: false, phase: 'filing',
    desc: '委托境内/境外机构的合同或协议、费用支出明细、发票、银行付款凭证。',
    how: '委托合同必须留存(系统 R23 检测);关联方委托需提供费用明细;发票与付款流水匹配。',
  },
  {
    key: 'overseasReg', name: '委托境外研发技术合同认定登记证明', required: false, phase: 'filing',
    desc: '委托境外机构研发,技术合同需经科技部门认定登记。',
    how: '未登记即被剔除(系统 R17/R23);境外个人委托不得加计(R27)。',
  },
  {
    key: 'capitalNote', name: '资本化项目无形资产成本确认与摊销说明', required: false, phase: 'filing',
    desc: '资本化项目形成无形资产后的成本确认依据与摊销年限、方法说明(≥10年)。',
    how: '本系统「摊销台账」支持一键自动生成摊销计划(成本×200%÷年限)。',
  },
];

module.exports = {
  POLICIES, EXPENSE_CATEGORIES, CATEGORY_MAP, BASE_FIVE, ENTRUST_KEYS,
  NEGATIVE_INDUSTRIES, NEGATIVE_ACTIVITIES, PROJECT_FORMS, RESULT_OWNERS,
  ALLOC_METHODS, SPECIAL_INCOME_TYPES, NON_DEDUCTIBLE_KEYWORDS,
  HIGH_RISK_MATERIALS, ADMIN_EXPENSE_KEYWORDS, AFTERSALE_KEYWORDS,
  EXPENSE_TYPES, LEVY_TYPES, INDUSTRIES, CHECKLIST, CHECKLIST_PHASES,
};
