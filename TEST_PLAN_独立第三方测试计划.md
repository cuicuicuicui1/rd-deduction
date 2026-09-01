# 研发费用加计扣除辅助软件 — 独立第三方测试计划

> 版本:v1.0 | 适用对象:不了解本项目代码的独立执行者(AI 或人工)
> 被测系统:rd-deduction(本地单机 Web 应用,Node.js + Express,端口 8765)
> 本计划所有期望值均按中国现行税收政策**手工推导**,任何偏差 = 被测系统计算错误。测试的最终目的就是找出这些偏差。

---

## 0. 快速上手(执行前必读)

### 0.1 启动被测系统
```powershell
# 项目目录:C:\Users\limul\Desktop\yewu\rd-deduction
# Node 可执行文件(Windows):
$node = "C:\Users\limul\AppData\Local\Programs\DSH Desktop\resources\node\node.exe"
# 1) 释放 8765 端口(若有旧进程占用)
Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
# 2) 启动服务(工作目录=项目目录)
& $node server.js        # 前台;或 Start-Process 后台运行
# 3) 自检
Invoke-RestMethod -Uri 'http://127.0.0.1:8765/api/health'   # 期望 {"ok":true}
```

### 0.2 测试执行方式
用 Node 18+ 脚本直接调 HTTP API(fetch 全局可用)。**每个测试套件一个脚本**,脚本内必须:
1. 开头调用 `POST /api/backup/create`(body `{"tag":"pretest_xxx"}`)备份当前数据,记录返回的 `name`;
2. 每个场景开始前 `POST /api/demo/clear` 清库;
3. 场景结束/异常时用返回的 `name` 调 `POST /api/backup/restore`(body `{"name":...}`)恢复;
4. 输出 `PASS/FAIL` 逐项清单与汇总;**FAIL 必须打印实际值 vs 期望值**。

### 0.3 数据安全铁律(违反 = 测试作废)
- **不得破坏用户数据**:测试前的备份(0.2 步)与测试后的恢复是强制闭环;脚本异常(process.exit 前)也要恢复。
- 测试期间不得手工修改 `data/` 目录下的 json(除 T5 的 R26 场景特别注明外)。
- 每条断言用 `Math.round(实际值*100)/100` 比较(2 位小数容差),避免浮点误差。

### 0.4 通用 Helper(每个脚本复用,可直接复制)
```js
const BASE = 'http://127.0.0.1:8765';
const R2 = n => Math.round((Number(n) || 0) * 100) / 100;
const j = async (u, o) => {
  const r = await fetch(BASE + u, o);
  const t = await r.text();
  let b = null; try { b = JSON.parse(t); } catch {}
  if (!r.ok) throw new Error(u + ' HTTP ' + r.status + ' ' + (b ? b.error : t.slice(0, 150)));
  return b;
};
const P = (u, b) => j(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
const clear = () => P('/api/demo/clear', {});
const backup = tag => P('/api/backup/create', { tag });
const restore = name => P('/api/backup/restore', { name });
// 构造工厂(默认值刻意"干净",避免无关风险规则干扰)
const comp = (extra = {}) => P('/api/companies', { name: '测试公司', industry: '制造业', levyType: '查账征收', ...extra });
const proj = (extra = {}) => P('/api/projects', {
  code: '2026-RD-01', name: '测试项目', form: 'self', resultOwner: 'self', capitalization: 'expense',
  startDate: '2026-01-01', endDate: '2026-12-31', hasApprovalDoc: true, hasPlanDoc: true, ...extra });
const exp = (projectId, category, amount, extra = {}) => P('/api/expenses', {
  projectId, category, amount, date: '2026-06-30', period: '2026-06', capitalization: 'expense',
  summary: '测试-' + category, voucherNo: 'V-001', invoiceNo: 'INV-001', contractNo: 'C-001',
  paymentMethod: '银行转账', ...extra });
const getSummary = async year => { const s = await j('/api/summary?year=' + year); return { d: s.summary ? s.summary.detail : s.detail, a: s.a107012, s }; };
const LN = (rows, n) => Number((rows.find(r => String(r.line) === String(n)) || {}).amount) || 0; // 行次是字符串!
const ok = (c, m) => { console.log((c ? '✅ PASS ' : '❌ FAIL ') + m); globalThis.fails = globalThis.fails || 0; globalThis.pass = globalThis.pass || 0; c ? globalThis.pass++ : globalThis.fails++; };
```
> 已知坑(设计如此,不是 bug):A107012 的 `line` 字段是**字符串**;`/api/summary` 的 detail 在 `summary.detail` 或顶层 `detail`;`/api/risks` 返回 `{year,risks,counts,snapshot}`,counts 是 `{error,warning,info}`。

---

## 1. 测试总览与验收标准

| 套件 | 内容 | 验收 |
|---|---|---|
| T1 | 端到端业务流 + 五件套 | 28 项全过 |
| T2 | 政策口径数字矩阵(19 场景) | 72 项全过 |
| T3 | 辅助账六类列 + 委托列对账 | 42 项全过 |
| T4 | 风险规则触发矩阵(关键 30 条) | 全过 |
| T5 | 万能导入 + 数电票解析 + 附件 | 61 项全过 |
| T6 | 数据自洽 / 年度隔离 / 备份一致性 | 38 项全过 |
| T7 | 边界与安全 | 45 项全过 |
| T8 | 性能与并发 | 16 项全过 |
| T9 | 用户数据基线保护 | 逐项比对 |

**总验收:全部 PASS;任何 FAIL 视为产品缺陷,记录:场景、期望值、实际值、涉及 API、修复建议。**

---

## 2. T1 端到端业务流(最高优先级)

构造(每步一个 API 调用):
1. `comp({ industry:'制造业', isHiTech:true, headcount:120, techStaff:18, revenue:{2026:20000000,2025:18000000}, electricity:{2026:500000,2025:480000}, output:{2026:8000,2025:8200}, hiTechIncome:{2026:13000000} })`
2. 项目:①2026-RD-01 自研费用化 ②2026-RD-02 自研资本化 ③2026-RD-03 委托境内 `form:'entrust_domestic_org'` + `techContractNo:'JS2026-001'`
3. 费用(共 705,000):
   - RD-01:personnel 300,000 / direct 60,000(`materialNo:'LL-2026-001'`)/ depreciation 20,000(`allocMethod:'ratioHours', isShared:true`)/ other 13,000
   - RD-02:personnel 200,000(`capitalization:'capitalize'`)/ direct 12,000(`capitalization:'capitalize'`, `materialNo:'LL-2026-002'`)
   - RD-03:entrust_domestic_org 100,000
4. 特殊收入:specialIncomes `{projectId:RD-01, type:'trial', amount:10000}`
5. 工时:张三/李四 各 80h、王五/赵六 各 40h 挂对应项目,period `2026-06`,totalHours 160
6. 资产:assets `{name:'3D扫描仪', type:'equipment', period:'2026', depreciation:33333, rdHours:600, totalHours:1000}`
7. 摊销计划:`POST /api/amortization/plan` `{projectId:RD-02, startYear:2026, years:10}`

断言(全部数字):
| # | 断言 | 期望值 |
|---|---|---|
| A1 | 会计口径(费用金额合计) | 705,000 |
| A2 | 辅助账四类合计(ledger97 self+entrust+cooperation+centralized 每项目 total 之和) | 705,000 |
| A3 | 加计基数 totalExpenseBase | 463,000 |
| A4 | 委托境内×80% | 80,000 |
| A5 | 其他费用(13,000)未超限,otherDeductible | 13,000 |
| A6 | 特殊收入冲减 specialIncomeDeducted | 10,000 |
| A7 | 口径差异率(R34 用)|Accounting−加计基数−资本化当年支出212,000|/705,000 = 4.3% |
| A8 | A107012 行40 | 685,000 = 行2(605,000)+行36×80%+行38(0) |
| A9 | A107012 行47 | 463,000 |
| A10 | 汇总表 totals.total | 705,000 |
| A11 | 汇总表 费用化+资本化 = 合计 | 等式成立 |
| A12 | 风险红项数 | 0 |
| A13 | archive.zip 含 11 个条目(00/01/02/03/04/05/06/07/08/09/13_) | 全部存在 |
| A14 | 风险报告 HTML 含公司名与"关键指标快照"字样 | 包含 |
| A15 | 2025 demo 基线(若已载入示例数据):2025 年 totalAdd | 2,712,962.97 |

> 注意:此场景 R09(工时占比 100%)应聚合为 6 条(6 人各 1 条),不得逐期 72 条。

---

## 3. T2 政策口径数字矩阵(逐条核对政策条款,每场景 clear→构造→断言)

> 通用模式:每场景清库 → 建公司(带政策标记)→ 项目 → 费用 → 断言 `detail` 与 A107012 行次 **两口径汇合**(`totalExpenseBase == 行47` 必须成立)。

| 场景 | 构造 | 期望(全部需断言) |
|---|---|---|
| S1 纯费用化 100% | personnel 100,000 + direct 50,000 + depreciation 20,000 + other 10,000 | 基数 180,000;行2=行40=行41=行47=行51=180,000;行42=0 |
| S2 资本化 200%摊销 | capitalize 项目 personnel 150,000 + 摊销计划 10 年 | 年摊销 15,000(≠30,000!);行43=15,000;行51=15,000;totalAdd=15,000 |
| S3 委托境内 80%(自研项目挂委托类别) | entrust_domestic_org 100,000 | entrustDomesticOrg=80,000;行36=100,000;行40=行47=80,000 |
| S4 境外 2/3 限额(超限) | personnel 100,000 + entrust_overseas 100,000 | 境外×80%=80,000;境内基准=100,000→限额 66,666.67;可扣 66,666.67;剔除 13,333.33;基数 166,666.67;行38=66,666.67 |
| S5 境外不超限 | personnel 300,000 + overseas 100,000 | 境外全额 80,000(限额 200,000);基数 380,000 |
| S6 其他费用 10% 限额超限 | personnel 100,000 + other 30,000 | 限额 11,111.11;可扣 11,111.11;剔除 18,888.89;基数 111,111.11;行34=11,111.11 |
| S7 IC 120%(费用化) | comp({icIndustrial:true}) + personnel 100,000 | deductRatio=1.2;expenseAdd=120,000;行50 note 含"120%"(金额列为空!查 note);行51=120,000 |
| S8 IC 摊销 220% | icIndustrial + capitalize 150,000 + 计划 10 年 | 摊销 15,000×120%=18,000;行51=18,000 |
| S9 小微 5% | GET /api/tax-saving?year=2026&income=2000000 | rate=0.05;rateNote 含"小型微利" |
| S10 高企 15% | comp({isHiTech:true}) + income=10000000 | rate=0.15 |
| S11 特殊收入冲减(不超) | personnel 50,000 + specialIncome 10,000 | 冲减 10,000;基数 40,000;行46=10,000;行47=40,000 |
| S12 不征税收入剔除 | comp({nonTaxRelated:{2026:30000}}) + personnel 100,000 | exemptExcluded=30,000;基数 70,000;行47=70,000 |
| S13 年度隔离 | 2025 费用 70,000 + 2026 费用 150,000 | /api/summary?year=2025 基数=70,000;year=2026 基数=150,000 |
| S14 混合费+资 | 费 personnel 100,000 + 资 direct 50,000 | 行2=行40=150,000;行41=100,000;行42=50,000;基数(费用化)=100,000;capitalFormed=50,000 |
| S15 受托开发剔除 | proj({resultOwner:'client'}) + personnel 100,000 | 基数=0;行47=0;行1=0;excludedProjectCount=1 |
| S16 资本化 other 共享限额 | 费 personnel 100,000 + 资 other 20,000 | 费用化可扣 other=0;基数=100,000;行47=100,000;资本化成本=20,000(不受限额) |
| S17 特殊收入超基数+摊销 | 费 personnel 100,000 + 资 personnel 100,000 + 摊销 10,000 + 特殊 105,000 | 基数被冲完=0;**摊销被冲减 5,000 剩 5,000**;totalAdd=5,000;行47=行51=5,000;资本化形成成本仍=100,000 |
| S18 高企口径含资本化 | isHiTech + 费 100,000 + 资 direct 50,000 | /api/calibers hiTech=150,000(资本化必须计入!) |
| S19 委托境内个人 80% | entrust_domestic_person 50,000 | ×80%=40,000;行36=50,000;行47=40,000 |
| S20 境外个人不得加计 | entrust_overseas_person 50,000 | 基数=0;行39=50,000(仅列示);行40=0 |
| S21 委托项目 | proj({form:'entrust_domestic_org'}) + 委托 100,000 | ×80%=80,000;行40=80,000 |
| S22 合作研发 | proj({form:'cooperation'}) + personnel 80,000 | 计入池:基数=80,000;行2=80,000 |

**两口径汇合断言(每个场景都要加)**:`|detail.totalExpenseBase − A107012行47| < 1`;若 totalAdd>0 则 `|totalAdd − 行51| < 1`。

---

## 4. T3 辅助账六类列 + 委托列对账(重点:最近修复的两类计算错误)

> 目的:验证"其他相关费用"列不被委托金额污染;境外限额基准与申报口径一致。六类键:`personnel/direct/depreciation/amortization/design/other`。

### 场景 A:无共享、六类全列
- P1(费):personnel 100,000 / direct 50,000 / depreciation 20,000 / amortization 10,000 / design 15,000 / other 5,000
- P2(资):personnel 80,000 / direct 30,000
- 断言:`ledger97.self` 两项目 six 列:personnel=180,000、direct=80,000、depreciation=20,000、amortization=10,000、design=15,000、other=5,000;P1 expenseSum=total=200,000;P2 capitalizeSum=total=110,000;六列合计 310,000=汇总表合计。

### 场景 B:共享折旧工时分摊 + 委托项目
- P1 300,000+60,000+共享折旧 20,000(ratioHours)+other 13,000;P2 200,000+12,000(资);P3 委托境内 100,000(form=entrust_domestic_org)
- 工时:P1 160h / P2 80h → 共享折旧分摊 P1 13,333.33 / P2 6,666.67
- 断言:P1.six.depreciation=13,333.33;P2.six.depreciation=6,666.67;自研六列合计=605,000;P3 total=100,000、dedBase=80,000、entrustDomestic=80,000;`l97.domesticBase=685,000`;汇总表 entrustDomestic=80,000、six.depreciation=20,000、total=705,000。

### 场景 C:自研项目挂委托类别(核心回归——修复过的 bug)
- personnel 100,000 + entrust_domestic_org 100,000 + entrust_overseas 500,000(全部挂自研项目)
- 断言:
  - `six.other = 0`(委托不得进"其他相关费用"列!)
  - `entrustDomestic = 80,000`、`entrustOverseas = 400,000`、total=700,000
  - `l97.domesticBase = 180,000`(100,000+80,000,**不含境外委托**)、`cap2of3 = 120,000`、`overseasTotalBase = 400,000`、`overseasExcess = 280,000`
  - 汇总表行:six.other=0、entrustDomestic=80,000、entrustOverseas=400,000、合计=700,000
  - 加计基数 = 100,000+80,000+境外限额内 120,000 = **300,000**;行47=300,000

### 场景 D:委托境外个人(不得加计)
- personnel 100,000 + entrust_overseas_person 50,000 → six.other=0;entrustOverseas=40,000;total=150,000

---

## 5. T4 风险规则触发矩阵(每条规则构造最小触发场景)

> 通用:每场景清库 → 构造 → `GET /api/risks?year=2026` → 断言目标 `code+level` 存在。费用构造尽量带全凭证/发票/领料单号,避免无关规则干扰。

| 规则 | 触发构造 | 期望 |
|---|---|---|
| R01 负面行业 | comp({industry:'批发业',negativeRevenueShare:60}) | error |
| R01 占比<50% | industry:'餐饮业',share:30 | warning |
| R01 未填占比 | industry:'零售业' | error |
| R02 核定征收 | comp({levyType:'核定征收'}) | error |
| R03/R04 立项缺失 | proj({hasApprovalDoc:false}) / proj({hasPlanDoc:false}) + 费用 | warning |
| R05 负面活动 | proj({activityType:'市场调查/效率调查/管理研究'}) | warning |
| R06 事后立项 | proj({approvalDate:'2026-12-01'}) + 2026-06-30 费用 | warning |
| R07 资本化无摊销 | capitalize 项目+资本化费用,无摊销 | info |
| R08 无工时 | staff isDirect:true 无 timesheets | warning |
| R09 工时100% | timesheets rdHours=totalHours=160(两期同一人) | info 且聚合 1 条 |
| R24 受托开发 | proj({resultOwner:'client'})+费用 | error |
| R27 境外个人 | proj({form:'entrust_overseas_person'})+费用 | error |
| R28/R29 合作/集中 | proj({form:'cooperation'/'centralized'})+费用 | warning |
| R35 岗位疑似 | staff({role:'生产经理',dept:'生产部'},isDirect:true) | warning |
| R10 无凭证号 | exp(...,{voucherNo:''}) | warning |
| R11 缺发票/合同 | direct 类,无 invoiceNo/contractNo | warning |
| R12 大额现金 | paymentMethod:'现金',amount>10,000 | warning |
| R13 跨期间 | 项目期间 1-6 月,费用 9 月 | warning |
| R14 共用无方法 | 文件直写 expenses.json 改 isShared:true 且删 allocMethod(API 层被设计性拦截) | warning |
| R41 共用折旧无台账 | isShared depreciation + 无 assets | warning |
| R49 领料单缺失 | 6 笔 direct≥5,000 无 materialNo | 5 条逐笔 + 1 条"另有N笔"= 6 条 |
| R15 其他超限 | personnel 100,000 + other 30,000 | error |
| R16 接近上限 | personnel 100,000 + other 10,000(占比 9.1%) | info |
| R17 境外超限 | personnel 100,000 + overseas 100,000 | warning |
| R34 差异率>5% | personnel 100,000 + other 30,000(差异率 14.5%) | warning |
| R38 材料占比 | direct 70,000 + personnel 30,000 | warning |
| R39 委托占比 | entrust 60,000 + personnel 40,000 | warning |
| R18 研发占收入>15% | revenue 500,000 + 费用 100,000 | warning |
| R19 <0.5% | revenue 100,000,000 + 费用 100,000 | info |
| R20 较上年+50% | revenue{2026:1M,2025:0.9M}+费用 2026:160,000/2025:100,000 | info |
| R37 增幅远超收入 | 费用 2026:300,000/2025:100,000 + 收入 1M/0.9M | warning |
| R21 亏损 | taxableIncome:{2026:-50000} | info |
| R45 人员占比 | headcount:10 + 7 名 isDirect staff | warning |
| R46 税负率降半 | 收入 1M/1M + 应税 50,000/200,000 | warning |
| R47 空壳研发 | 费用≥500,000 且项目无 hasResultDocs/hasProcessDocs | warning |
| R48 电耗上升 | electricity 100,000/60,000 + output 1000/1200 | warning |
| R40 高企不达标 | isHiTech + headcount:100,techStaff:5 | warning |
| R40 高企达标 | isHiTech + techStaff:30/100 + revenue 10M + 费用 750,000 + hiTechIncome 7M | info |
| R23 委托缺合同发票 | entrust 费用无 contractNo/invoiceNo | warning |
| R36 委托缺登记 | entrust 项目无 techContractNo | warning |
| R25 特殊收入 | specialIncome>0 | info |
| R26 不可计入项 | **文件直写** data/expenses.json 某条 summary 改"业务招待费测试"(API 层拦截关键词,必须绕行) | error |
| R42 高危品名 | summary 含"黄金" | warning |
| R43 管理费 | summary 含"办公用品" | warning |
| R44 售后 | summary 含"维修" | warning |
| R31 不征税剔除 | nonTaxRelated:{2026:30000} | warning |
| R33 IC | icIndustrial:true,year=2026 → info;year=2028 → warning | 两者 |
| R30 个税缺员 | 2 staff(1 直接)+ taxroll 仅含非直接(2026) | warning |
| R99 空库 | clear 后直接 GET | info |

> R26/R14 的文件直写方法:POST 一条正常费用 → 读 `data/expenses.json`(纯数组)→ 改目标字段 → 写回 → 调 /api/risks。

---

## 6. T5 万能导入 + 数电票解析 + 附件链路

### 6.1 Excel/CSV 导入
- 构造一个 1000 行 CSV(6 实体各 1 批):expenses/staff/projects/timesheets/specialIncomes/amortizations,列名含中文表头;**金额用千分位文本**如 `"1,000.50"`(必须能导入)。
- 上传:`POST /api/import/upload`,body 用 `express.raw`(Content-Type text/csv)+ `X-Filename` 头(encodeURIComponent);返回 `{id,rowCount,headers,sampleRows}`。
- 执行:`POST /api/import/run` body `{id,entity,mapping,options:{skipHeader:true}}`,断言 `ok` 行数、errors=0。
- 断言:导入后金额、期间、类别与源文件一致;合计可对账。

### 6.2 数电票 XML 变体(全部走 `POST /api/invoice/parse`,raw XML)
| 变体 | 关键点 | 期望 |
|---|---|---|
| 专票标准 | `<Invoice>` 块 + 明细 Item | 发票级金额/税额/价税合计正确 |
| 属性形式字段 | 发票号/日期写在 `<Invoice ...>` 开始标签属性上 | 必须解析出(曾修复) |
| 多个 Invoice 块 | 一个文件多张发票 | 全部解析 |
| GBK 编码 | XML 声明 encoding="GBK" | 中文不乱码 |
| 折扣票 | 明细含折扣行 | 金额正确 |
| 红字 | 负金额 | 正确 |
| 铁路/航空 | 字段名变体 | 兜底汇总正确 |
| 缺字段 | 无金额时 | 明细汇总兜底 |

明细标签名:Item/item/Goods/商品/明细 均可。断言后再 `POST /api/invoice/import` 入账:重复导入同一文件第 2 次,应返回"已导入过,已跳过(防重复记账)"。

### 6.3 OFD 解析
- 真实 OFD 特征:Content.xml 里节点带命名空间前缀 `<ofd:TextObject>`(GB/T 33190)、金额格式 `金额合计(小写):¥1234.56`。这两点曾导致 400,必须修复过。构造含这两种形态的 Content.xml 测试。

### 6.4 附件链路
- 上传附件(≤10MB)→ 存档 → 下载:内容一致;文件名穿越(`../../x`)必须被 404/400 拒绝。

---

## 7. T6 数据自洽 / 年度隔离 / 备份一致性 / 除零

- **跨年摊销**:capitalize 150,000 + 计划 10 年(2026 起)→ 2026 行43=15,000(会计口径,不是 30,000);2025 行43=0;2026 不含 2025 年费用。
- **备份一致性**:备份 → 加一条费用 → 恢复 → 断言加计基数回到原值。
- **除零防护**:共享费用(ratioHours)但无任何工时 → API 不崩,降级全额计入原项目。
- **导出文件对账**:a107012.xlsx 行40/47 与 API 一致;ledger97.xlsx 4 个 sheet(自主研发/委托/合作/集中),各"借方合计"之和 = API 四类合计;collection.xlsx 合计行存在;archive.zip>5KB。

---

## 8. T7 边界与安全(全部应返回 400/413/404,不得 5xx 或崩进程)

- 空数据:清库后所有 GET 列表/计算 API 返回 200(空数组),不 5xx。
- 畸形输入:非 JSON body;空对象 `{}`;`amount` 为负数/0/字符串"abc"/布尔/`NaN`/`Infinity`/`"NaN"`/`"Infinity"`。
- 缺日期费用:POST expenses 无 date → 400(曾因漏校验导致费用隐形)。
- 路径穿越:备份名 `../../etc/passwd` → 400;导出 `year=../../x` 容错。
- 超长 body:>20MB → 413(express.json limit)。
- XSS:摘要存 `<script>` 字符串,存储原样、渲染转义(前端 esc 验证)。
- 并发写:10 个并行 POST expenses 后总条数正确(不丢数据)。
- 原型污染/XXE:JSON 解析无 `__proto__` 污染;XML 正则解析不执行实体。
- 校验表:specialIncomes amount≥0;amortizations amount>0 且 year 2000-2100;timesheets/assets rdHours,totalHours≥0;projects code/name 非空。

---

## 9. T8 性能(5000 条量级)

- 批量导入 5000 行 <3s;`/api/summary`、`/api/ledger97` <1s;`/api/export/archive.zip` <5s。
- 5000 条时辅助账四类合计=会计口径(精确对账,曾出现 1,252,000 vs 1,260,000 漏计 bug)。

---

## 10. T9 用户数据基线保护(最后执行,全程只读)

被测系统**当前数据就是真实用户数据**,测试前先做完整只读快照,测试后逐项核对:

| 基线项 | 期望值(2026 年) |
|---|---|
| 费用条数 | 14 |
| 会计口径(费用合计) | 1,260,000 |
| 加计基数 totalExpenseBase(=A107012 行47) | 940,000 |
| 高企口径 hiTech(/api/calibers) | 1,140,000 |
| otherLimit / otherDeductible | 67,777.78 / 50,000 |
| detail.domesticTotal(境外限额基准) | 740,000 |
| 境外:entrustOverseas / entrustOverseasCap | 400,000 / 493,333.33 |
| ledger97.domesticBase / cap2of3 / overseasTotalBase / overseasExcess | 740,000 / 493,333.33 / 400,000 / 0 |
| RD-01(费用化):six.other / entrustDomestic / entrustOverseas / total | 50,000 / 80,000 / 400,000 / 1,060,000 |
| RD-02(资本化):six.personnel / six.direct | 100,000 / 80,000 |
| 项目:2026-RD-01 费用化、2026-RD-02 资本化 | 各 1 个 |
| 2025 示例数据 totalAdd(若载入 demo) | 2,712,962.97 |

---

## 11. 已知 Bug 模式重点回归(本轮修复过,防复发)

1. **委托类别污染"其他相关费用"列** → 见 T3 场景 C(`six.other` 必须为 0)。
2. **境外限额基准含境外委托 / 漏计自研项目内境外委托** → 见 T3 场景 C(l97.domesticBase=180,000、overseasExcess=280,000)。
3. **高企口径漏资本化** → S18(hiTech 含资本化)。
4. **摊销口径虚高(把 200% 当摊销额)** → S2(annual=15,000 非 30,000)。
5. **特殊收入冲减到资本化成本** → S17(capitalFormed 不受冲)。
6. **其他费用可扣额费/资口径混用** → S6/S16(费用化可扣=min(费用化 other,限额);限额基准含资本化池)。
7. **A107012 未剔不征税收入** → S12(行47=70,000)。
8. **R09 工时占比逐期噪音** → T4(聚合 1 条)。
9. **报销缺日期费用隐形** → T7(缺 date 400)。
10. **备份缺 expenses 集合/被滚动删除** → T6 备份一致性 + 备份保留≥30 份。

---

## 12. 测试报告模板(每套件一份)

```markdown
# 测试报告:T<编号> <名称>
执行时间:____ | 执行者:____ | 服务状态:____(health ok?)
数据备份:pretest_xxx(已恢复?是/否)
结果:<通过>/<总数>
FAIL 明细:
1. 场景/断言:____
   期望:____ | 实际:____ | 涉及 API:____
   初步分析:____
复测后:____
```

**最后交付**:所有套件报告 + 汇总缺陷清单(按严重度排序,标注影响:数字错误/口径不一致/崩溃/安全)+ 每项修复建议。发现的任何"实际值 ≠ 期望值"都必须视为缺陷上报,不要自行放行。
