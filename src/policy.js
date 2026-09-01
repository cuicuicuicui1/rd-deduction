// 政策库内置 + 联网检查 —— 政策依据以税务总局现行有效文件为准,联网检查仅作提示,不替代人工核对
const https = require('https');
const { POLICIES } = require('./constants');

// 内置政策文件库(核心文件;执行时以最新公告为准)
const POLICIES_DB = [
  {
    doc: '财税〔2015〕119号', title: '关于完善研究开发费用税前加计扣除政策的通知', date: '2015-11-02', status: '现行(部分口径被后续文件调整)',
    url: 'https://www.mof.gov.cn/gkml/caizhengwengao/wg2015/wg201512/201604/t20160421_1959849.htm',
    points: ['确立加计扣除基础框架:六大类费用归集范围与负面清单', '负面清单行业:烟草制品业/住宿业/餐饮业/批发业/零售业/房地产业/租赁业/商务服务业/娱乐业', '列举不适用加计的活动(常规升级、成果直接应用、客户技术支持等)', '企业委托研发按实际发生额80%计入(委托境外口径后由64号文件明确)'],
  },
  {
    doc: '国家税务总局公告2015年第97号', title: '关于企业研究开发费用税前加计扣除政策有关问题的公告', date: '2015-12-29', status: '现行(附件样式与部分条款被2021年28号调整)',
    url: 'https://guangdong.chinatax.gov.cn/gdsw/yff/2015-12/29/content_c96f5d64f8024a488545e308e7277600.shtml',
    points: ['发布2015版研发支出辅助账样式:自主研发/委托/合作/集中 4张辅助账 + 1张汇总表', '明确留存备查资料要求(本项目「备查清单」页已内置)', '项目编号建议按"工商登记号15位+年度2位+项目序号4位"编制'],
  },
  {
    doc: '国家税务总局公告2017年第40号', title: '关于研发费用税前加计扣除归集范围有关问题的公告', date: '2017-11-08', status: '现行',
    url: 'https://guangdong.chinatax.gov.cn/gdsw/zjfg/2017-11/23/content_9beff5d804a841639f12f6601ce93db4.shtml',
    points: ['细化六大类归集口径:外聘劳务、加速折旧、多用途对象分配等', '其他相关费用正列举(图书资料/翻译/咨询/差旅会议/福利费/补充保险等),受10%限额', '明确共用仪器设备、人员的分配记录要求'],
  },
  {
    doc: '财税〔2018〕64号', title: '关于企业委托境外研究开发费用税前加计扣除有关政策问题的通知', date: '2018-06-25', status: '现行',
    url: 'https://www.gov.cn/zhengce/zhengceku/2018-12/31/content_5442063.htm',
    points: ['委托境外机构研发费用按实际发生额80%计入', '且不得超过境内符合条件的研发费用×2/3', '委托境外个人研发不得加计扣除', '委托境外研发需经科技部门技术合同认定登记'],
  },
  {
    doc: '财税〔2018〕99号 + 财政部 税务总局公告2021年第6号', title: '提高研究开发费税前加计扣除比例(75%)', date: '2018-09-20', status: '已过渡(2023年起统一100%)',
    url: 'https://www.mof.gov.cn/gkml/caizhengwengao/wg2018/201810WG/201902/t20190213_3146571.htm',
    points: ['2018-2020年:除烟草/住宿/餐饮/批发/零售/房地产/租赁/商务服务/娱乐外,研发费用按75%加计'],
  },
  {
    doc: '财政部 税务总局公告2021年第13号', title: '关于进一步完善研发费用税前加计扣除政策的公告(制造业100%)', date: '2021-03-31', status: '并入2023年7号统一口径',
    url: 'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5202136/content.html',
    points: ['2021年1月1日起,制造业企业研发费用按100%加计扣除'],
  },
  {
    doc: '国家税务总局公告2021年第28号', title: '关于进一步落实研发费用加计扣除政策有关问题的公告', date: '2021-09-13', status: '现行',
    url: 'https://fgk.chinatax.gov.cn/zcfgk/c100012/c5194995/content.html',
    points: ['发布2021版辅助账与汇总表样式(简化:1张辅助账+1张汇总表)', '其他相关费用限额改为全部项目统一计算:前5类费用合计×10%÷(1-10%)', '2021年起可在预缴申报时享受上半年加计扣除(2022年起按季度/月度申报享受)'],
  },
  {
    doc: '财政部 税务总局 科技部公告2022年第16号', title: '关于进一步提高科技型中小企业研发费用税前加计扣除比例的公告', date: '2022-03-23', status: '并入2023年7号统一100%',
    url: 'https://www.gov.cn/zhengce/zhengceku/2022-04/03/content_5683341.htm',
    points: ['2022-2023年:科技型中小企业研发费用按100%加计扣除'],
  },
  {
    doc: '财政部 税务总局公告2023年第7号', title: '关于进一步完善研发费用税前加计扣除政策的公告', date: '2023-03-26', status: '现行(现行统一比例,长期有效)',
    url: 'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5201978/content.html',
    points: ['自2023年1月1日起,所有符合条件企业研发费用加计扣除比例统一为100%', '作为制度性安排长期实施,不再设置适用截止年份', '资本化形成无形资产:按成本200%税前摊销', '本软件按此口径计算(费用化×100%、摊销×200%)'],
  },
  {
    doc: '财政部 税务总局 国家发展改革委 工业和信息化部公告2023年第44号', title: '关于提高集成电路和工业母机企业研发费用加计扣除比例的公告', date: '2023-10-11', status: '现行(2023-01-01~2027-12-31)',
    url: 'https://www.gov.cn/zhengce/zhengceku/202309/content_6905802.htm',
    points: ['列入清单的集成电路和工业母机企业:费用化加计120%', '资本化形成无形资产按成本220%摊销', '清单由工信部等部门动态管理,企业设置「集成电路/工业母机清单企业」后自动按120%计算'],
  },
  {
    doc: '国家税务总局公告2023年第54号', title: '关于发布〈企业所得税年度纳税申报表(A类,2023年版)〉的公告', date: '2023-11-15', status: '现行',
    url: 'https://guangdong.chinatax.gov.cn/gdsw/gzsw_qyndsbbtx/2024-09/30/content_f017fa772f104d53ba6c55f3303066fd.shtml',
    points: ['修订A107012《研发费用加计扣除优惠明细表》行次结构(本项目已按2023/2024版行次生成)', '不再填报《研发项目可加计扣除研究开发费用情况归集表》、不再报送《"研发支出"辅助账汇总表》(改由企业留存备查)'],
  },
];

// 某年度适用的关键参数口径
function policyStatus(year) {
  const y = Number(year);
  return {
    year: y,
    deductRatio: y >= 2023 ? '100%(2023年7号,长期有效)' : (y >= 2021 ? '制造业100% / 其他75%' : '75%'),
    amortRatio: y >= 2023 ? '成本200%摊销' : '成本175%~200%摊销',
    icRatio: y >= 2023 && y <= 2027 ? '120%加计 / 220%摊销(44号,清单企业)' : '不适用',
    entrustDomestic: '实际发生额×80%计入(119号/28号)',
    entrustOverseas: y >= 2018 ? '实际发生额×80%,且≤境内×2/3(64号)' : '不得加计',
    otherLimit: '全部项目统一:前5类合计×10%÷(1-10%)(2021年28号)',
    sme: y <= 2027 ? '小型微利企业实际税负5%(财税〔2023〕12号,至2027-12-31)' : '以最新公告为准',
    retention: '备查资料留存10年(自汇算清缴结束之日起)',
  };
}

// 历史年度加计扣除比例(2021年28号修正后口径)——供计算引擎按年度取用,避免老账回溯虚计
// 政策演进:2016-2017 一般50%(119号,2017科技型中小企业75% 34号);2018-2020 一般75%(财税〔2018〕99号+2021年6号延长);
//         2021 制造业100%(13号);2022 制造业/科技型中小企业100%(16号);2023起统一100%(7号,长期);IC 2023-2027 120%(44号)
// 委托境外:2018年1月1日起方可加计(财税〔2018〕64号),此前境外委托不得加计
function annualPolicy(year, company) {
  const y = Number(year);
  const mfg = !!(company && String(company.industry || '').includes('制造业'));
  const techSme = !!(company && company.isTechSme);
  const icActive = !!(company && company.icIndustrial) && y >= POLICIES.icPeriodStart && y <= POLICIES.icPeriodEnd;
  // IC/工业母机清单企业:费用化120%、摊销120%(2023-2027)
  if (icActive) {
    return { deductRatio: POLICIES.icDeductRatio, amortRatio: POLICIES.icAmortRatio, label: '120%(集成电路/工业母机,2023年44号)', overseasAllowed: true };
  }
  // 2023年起:统一100%
  if (y >= 2023) {
    return { deductRatio: 1.0, amortRatio: 1.0, label: '100%(2023年7号,长期有效)', overseasAllowed: true };
  }
  // 2022:制造业/科技型中小企业 100%,其他 75%
  if (y === 2022) {
    if (mfg || techSme) return { deductRatio: 1.0, amortRatio: 1.0, label: '100%(制造业/科技型中小企业,2022年16号)', overseasAllowed: true };
    return { deductRatio: 0.75, amortRatio: 0.75, label: '75%(财税〔2018〕99号+2021年6号)', overseasAllowed: true };
  }
  // 2021:制造业 100%,其他 75%
  if (y === 2021) {
    if (mfg) return { deductRatio: 1.0, amortRatio: 1.0, label: '100%(制造业,2021年13号)', overseasAllowed: true };
    return { deductRatio: 0.75, amortRatio: 0.75, label: '75%(财税〔2018〕99号+2021年6号)', overseasAllowed: true };
  }
  // 2018-2020:一般 75%(科技型中小企业同75%)
  if (y >= 2018) {
    return { deductRatio: 0.75, amortRatio: 0.75, label: '75%(财税〔2018〕99号+2021年6号)', overseasAllowed: true };
  }
  // 2017:科技型中小企业 75%,一般 50%
  if (y === 2017) {
    if (techSme) return { deductRatio: 0.75, amortRatio: 0.75, label: '75%(科技型中小企业,2017年34号)', overseasAllowed: false };
    return { deductRatio: 0.5, amortRatio: 0.5, label: '50%(财税〔2015〕119号)', overseasAllowed: false };
  }
  // 2016:50%
  if (y === 2016) {
    return { deductRatio: 0.5, amortRatio: 0.5, label: '50%(财税〔2015〕119号)', overseasAllowed: false };
  }
  // 2015 及以前:政策未实施,不得加计
  return { deductRatio: 0, amortRatio: 0, label: '2015年及以前不得加计(119号自2016-01-01起施行)', overseasAllowed: false };
}

// 联网检查:访问税务总局公开页面做连通性探活(失败不影响使用)
function checkOnline(timeoutMs = 8000) {
  return new Promise(resolve => {
    let settled = false;
    const done = obj => { if (!settled) { settled = true; resolve(obj); } };
    const url = 'https://www.chinatax.gov.cn/chinatax/n810341/n810755/c5169537/content.html';
    const req = https.get(url, { timeout: timeoutMs }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const html = buf.toString('utf8');
        const m = /<title>([\s\S]*?)<\/title>/i.exec(html);
        done({
          reachable: true, status: res.statusCode, bytes: buf.length,
          title: m ? m[1].trim().slice(0, 80) : '',
          note: '已连通国家税务总局网站。提示:联网检查仅确认网络可达,政策是否更新请以税务总局官网最新公告为准,建议年度汇算清缴前人工核对一次。',
        });
      });
      res.on('error', () => done({ reachable: false, note: '访问目标站点出错,请点击政策库中的官方链接人工核对。' }));
    });
    req.on('timeout', () => { req.destroy(); done({ reachable: false, note: '连接超时(8秒)。可能当前无网络或目标站点限制访问,不影响软件使用;请点击政策库中的官方链接人工核对。' }); });
    req.on('error', () => done({ reachable: false, note: '网络不可用。请点击政策库中的官方链接人工核对最新政策。' }));
  });
}

module.exports = { POLICIES_DB, policyStatus, annualPolicy, checkOnline };
