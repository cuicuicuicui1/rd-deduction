// 示例数据:一家制造业企业、2个研发项目、6人工时、多笔费用(含典型风险点,用于演示自检)
const storage = require('./storage');

function load() {
  const companies = [
    {
      id: 'c1',
      name: '云创智能装备制造有限公司',
      creditCode: '91330100MA27C0DEM0',
      industry: '制造业',
      levyType: '查账征收',
      isHiTech: true,
      headcount: 120,
      revenue: { 2024: 22000000, 2025: 30000000, 2026: 36000000 },
      taxableIncome: { 2024: 800000, 2025: -600000, 2026: 5000000 },
      note: '示例企业(虚构)',
    },
  ];

  const projects = [
    {
      id: 'p1', code: '2025-RD-01', name: '智能产线控制系统研发',
      form: 'self', resultOwner: 'self', activityType: '', startDate: '2025-01-01', endDate: '2025-12-31',
      status: '进行中', capitalization: 'expense',
      hasApprovalDoc: true, hasPlanDoc: true, approvalDate: '2024-12-20',
      note: '自主研发,费用化处理',
    },
    {
      id: 'p2', code: '2025-RD-02', name: '高精度压力传感器试制',
      form: 'self', resultOwner: 'self', activityType: '', startDate: '2025-03-01', endDate: '2025-12-31',
      status: '进行中', capitalization: 'capitalize',
      hasApprovalDoc: false, hasPlanDoc: true, approvalDate: '2025-06-15',
      note: '资本化处理(演示:无立项决议、事后立项、跨期费用等风险点)',
    },
  ];

  const staff = [
    { id: 's1', name: '张伟', dept: '硬件部', role: '硬件工程师', isDirect: true, joinDate: '2022-03-01' },
    { id: 's2', name: '李娜', dept: '软件部', role: '软件工程师', isDirect: true, joinDate: '2021-07-01' },
    { id: 's3', name: '王强', dept: '测试部', role: '测试工程师', isDirect: true, joinDate: '2023-02-01' },
    { id: 's4', name: '陈静', dept: '结构部', role: '结构工程师', isDirect: true, joinDate: '2024-01-01' },
    { id: 's5', name: '赵磊', dept: '工艺部', role: '工艺工程师', isDirect: false, joinDate: '2020-05-01' },
    { id: 's6', name: '刘洋', dept: '电气部', role: '电气工程师', isDirect: true, joinDate: '2025-04-01' },
  ];

  // 工时台账:人员 × 项目 × 月份(研发工时/总工时)
  const timesheets = [];
  const MONTHS = ['2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06'];
  const addTs = (staffId, projectId, fromIdx, toIdx, rdHours, totalHours) => {
    for (let i = fromIdx; i <= toIdx; i++) {
      timesheets.push({
        id: `ts_${staffId}_${i}`, staffId, projectId, period: MONTHS[i],
        rdHours, totalHours, staffName: staff.find(s => s.id === staffId).name,
      });
    }
  };
  addTs('s1', 'p1', 0, 5, 160, 176);
  addTs('s2', 'p1', 0, 4, 168, 176);
  addTs('s2', 'p1', 5, 5, 152, 176); // 6月
  addTs('s2', 'p2', 5, 5, 24, 176);  // 6月跨项目
  addTs('s3', 'p1', 0, 5, 120, 176);
  addTs('s5', 'p1', 0, 5, 40, 176);
  addTs('s4', 'p2', 2, 5, 120, 176); // 3月起
  addTs('s4', 'p1', 2, 5, 40, 176);  // 共用
  addTs('s6', 'p2', 3, 5, 160, 176); // 4月入职

  const E = (id, projectId, category, amount, summary, period, date, extra = {}) => ({
    id, projectId, category, amount, summary, period, date,
    capitalization: 'expense',
    allocMethod: 'direct', isShared: false, allocNote: '',
    voucherNo: '', invoiceNo: '', contractNo: '', paymentMethod: '银行转账', ...extra,
  });

  const expenses = [
    // —— 项目1:智能产线控制系统(费用化) ——
    E('e1', 'p1', 'personnel', 120000, '研发人员1月工资及社保', '2025-01', '2025-01-20', { voucherNo: '记-2025-001' }),
    E('e2', 'p1', 'personnel', 125000, '研发人员2月工资及社保', '2025-02', '2025-02-20', { voucherNo: '记-2025-013' }),
    E('e3', 'p1', 'personnel', 128000, '研发人员3月工资及社保', '2025-03', '2025-03-20', { voucherNo: '记-2025-028' }),
    E('e4', 'p1', 'personnel', 130000, '研发人员4月工资及社保', '2025-04', '2025-04-20', { voucherNo: '记-2025-045' }),
    E('e5', 'p1', 'personnel', 132000, '研发人员5月工资及社保', '2025-05', '2025-05-20', { voucherNo: '记-2025-061' }),
    E('e6', 'p1', 'personnel', 135000, '研发人员6月工资及社保', '2025-06', '2025-06-20', { voucherNo: '记-2025-078' }),
    E('e7', 'p1', 'direct', 86000, '电子元器件及PCB材料(研发专用)', '2025-03', '2025-03-10', { voucherNo: '记-2025-020', invoiceNo: 'FP-2025-0301' }),
    E('e8', 'p1', 'direct', 52000, '测试样机购置(不构成固定资产)', '2025-05', '2025-05-15', { voucherNo: '记-2025-055', invoiceNo: 'FP-2025-0551' }),
    E('e9', 'p1', 'direct', 20000, '试制材料采购(无发票,演示风险)', '2025-06', '2025-06-18', { voucherNo: '记-2025-075' }),
    E('e10', 'p1', 'depreciation', 45000, '研发测试设备折旧(共用,按工时分摊)', '2025-04', '2025-04-12',
      { voucherNo: '记-2025-040', allocMethod: 'ratioHours', isShared: true, allocNote: '按2025-04研发工时比例分摊' }),
    E('e11', 'p1', 'direct', 60000, '研发设备经营租赁费', '2025-02', '2025-02-15', { voucherNo: '记-2025-016', invoiceNo: 'FP-2025-0160' }),
    E('e12', 'p1', 'other', 20000, '行业技术研讨会会议费', '2025-01', '2025-01-30', { voucherNo: '记-2025-008', invoiceNo: 'FP-2025-0081' }),
    E('e13', 'p1', 'other', 16000, '技术资料翻译费', '2025-02', '2025-02-28', { voucherNo: '记-2025-018', invoiceNo: 'FP-2025-0180' }),
    E('e14', 'p1', 'other', 25000, '研发人员职工福利费', '2025-03', '2025-03-28', { voucherNo: '记-2025-033', invoiceNo: 'FP-2025-0330' }),
    E('e15', 'p1', 'other', 18000, '技术图书资料费', '2025-04', '2025-04-10', { voucherNo: '记-2025-038', invoiceNo: 'FP-2025-0380' }),
    E('e16', 'p1', 'other', 18000, '技术交流差旅费(现金支付,演示风险)', '2025-05', '2025-05-28',
      { voucherNo: '记-2025-063', invoiceNo: 'FP-2025-0630', paymentMethod: '现金' }),
    E('e17', 'p1', 'other', 8000, '专家咨询费(无凭证,演示风险)', '2025-06', '2025-06-10',
      { invoiceNo: 'FP-2025-0700', paymentMethod: '银行转账' }),
    E('e18', 'p1', 'other', 22000, '知识产权检索与评审费', '2025-06', '2025-06-28', { voucherNo: '记-2025-085', invoiceNo: 'FP-2025-0855' }),
    E('e19', 'p1', 'entrust_domestic_org', 600000, '委托XX研究院开发控制算法模块', '2025-03', '2025-03-30',
      { voucherNo: '记-2025-030', invoiceNo: 'FP-2025-0309', contractNo: 'HT-2025-003' }),
    E('e20', 'p1', 'entrust_overseas', 2000000, '委托境外XX公司开发核心图像算法', '2025-04', '2025-04-30',
      { voucherNo: '记-2025-048', invoiceNo: 'FP-2025-0480', contractNo: 'HT-2025-007' }),
    // —— 项目2:压力传感器试制(资本化) ——
    E('e21', 'p2', 'personnel', 80000, '传感器项目研发人员3月工资', '2025-03', '2025-03-20',
      { voucherNo: '记-2025-029', capitalization: 'capitalize' }),
    E('e22', 'p2', 'personnel', 85000, '传感器项目研发人员4月工资', '2025-04', '2025-04-20',
      { voucherNo: '记-2025-046', capitalization: 'capitalize' }),
    E('e23', 'p2', 'personnel', 90000, '传感器项目研发人员5月工资', '2025-05', '2025-05-20',
      { voucherNo: '记-2025-062', capitalization: 'capitalize' }),
    E('e24', 'p2', 'personnel', 92000, '传感器项目研发人员6月工资', '2025-06', '2025-06-20',
      { voucherNo: '记-2025-079', capitalization: 'capitalize' }),
    E('e25', 'p2', 'direct', 50000, '传感器试制材料(早于项目立项,演示风险)', '2025-02', '2025-02-10',
      { voucherNo: '记-2025-012', invoiceNo: 'FP-2025-0120', capitalization: 'capitalize' }),
    E('e26', 'p2', 'direct', 150000, '试制模具及工装开发制造', '2025-04', '2025-04-08',
      { voucherNo: '记-2025-041', invoiceNo: 'FP-2025-0410', capitalization: 'capitalize' }),
    E('e27', 'p2', 'direct', 38000, '样品检测与试验费', '2025-05', '2025-05-22',
      { voucherNo: '记-2025-066', invoiceNo: 'FP-2025-0660', capitalization: 'capitalize' }),
    E('e28', 'p2', 'depreciation', 30000, '共用试验设备折旧(按工时分摊)', '2025-06', '2025-06-15',
      { voucherNo: '记-2025-080', allocMethod: 'ratioHours', isShared: true, capitalization: 'capitalize',
        allocNote: '按2025-06研发工时比例分摊' }),
  ];

  const amortizations = [
    { id: 'a1', projectId: 'p2', year: 2026, amount: 180000, note: '2025年形成无形资产,2026年起按200%摊销' },
  ];

  // 个税申报名单(2025年全员申报,用于 R30 比对演示)
  const taxroll = [
    { id: 'tr1', staffId: 's1', year: 2025 },
    { id: 'tr2', staffId: 's2', year: 2025 },
    { id: 'tr3', staffId: 's3', year: 2025 },
    { id: 'tr4', staffId: 's4', year: 2025 },
    { id: 'tr5', staffId: 's5', year: 2025 },
    { id: 'tr6', staffId: 's6', year: 2025 },
  ];

  storage.saveAll('companies', companies);
  storage.saveAll('projects', projects);
  storage.saveAll('staff', staff);
  storage.saveAll('timesheets', timesheets);
  storage.saveAll('expenses', expenses);
  storage.saveAll('amortizations', amortizations);
  storage.saveAll('specialIncomes', []);
  storage.saveAll('taxroll', taxroll);
  return { companies, projects, staff, timesheets, expenses, amortizations, specialIncomes: [], taxroll };
}

module.exports = { load };
