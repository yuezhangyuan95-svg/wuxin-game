/* ================= 内容数据(开局状态与静态素材) ================= */
/* 金额单位: 万元 */

/* 天气池(秋季·武汉) */
const WEATHER_POOL = [
  { desc: '晴', temp: [24, 30] },
  { desc: '多云', temp: [22, 27] },
  { desc: '阴', temp: [20, 25] },
  { desc: '小雨', temp: [17, 22] },
];

/* 物料名称池(随机缺料事件用) */
const MATERIAL_NAMES = ['潜油电缆', '铜排', '变压器油', '元器件'];

/* 商机产品池(每类产品有自己的客户群与金额区间)
   平衡: 两厂月产能合计 4,000 万, 按每天 1 商机×约 40% 中标率反推, 单笔集中在 150~950 万,
   大单(升压变)偶尔出现, 使满产节奏下订单量 ≈ 产能, 逾期压力可控而非必崩。 */
const PRODUCTS = [
  { name: '高低压开关柜', clients: ['某电网公司', '某工业园区'], range: [150, 450] },
  { name: '储能 PCS 设备', clients: ['广州某储能公司', '上海储能项目'], range: [250, 650] },
  { name: '潜油离心泵', clients: ['某油田一厂', '某油田二厂'], range: [350, 850] },
  { name: '光伏箱式变压器', clients: ['某光伏电站', '某新能源公司'], range: [450, 950] },
  { name: '风电场升压变压器', clients: ['某风电场', '某风电开发公司'], range: [700, 1600] },
];

/* 难度三档: 仅初始金额不同, 其余条件一致 */
const DIFFICULTY = {
  '新手': { cash: 8000 },
  '标准': { cash: 6000 },
  '专家': { cash: 4500 },
};

/* 开局: 接手中型企业(标准档), 世界观与数字沿用驾驶舱 demo */
const INITIAL = {
  company: '武新电气',
  startDate: new Date(2026, 9, 1),   // 2026-10-01, 月度起点
  durationDays: 30,                   // 一个经营月
  difficulty: '标准',                 // M5: 新手 / 标准 / 专家

  cash: 6000,                         // 企业现金 6,000 万
  fixedAssets: 8000,                  // 固定资产 8,000 万
  monthlyWages: 300,                  // 工资 300 万/月(每 30 天发放)
  monthlyOverhead: 100,               // 管理+水电物业 100 万/月(按日摊销)
  employees: 120,                     // 生产 80 / 技术 20 / 职能 20

  /* 在账应收 630 万(2 笔); WX-2026-007 放行交付后另有 1,400 万到货款将挂账 */
  receivable: [
    { id: 'R1', client: '某火电厂', amount: 480, age: 35, dueDays: 60, note: '设备款 · 账龄最长' },
    { id: 'R3', client: '某风电场', amount: 150, age: 180, dueDays: 90, note: '质保金' },
  ],

  /* 在手订单 4 单 / 7,200 万(demo 素材) */
  orders: [
    { id: 'O1', name: '津巴布韦变压器采购', client: '津巴布韦电力局', amount: 2400, costRate: 0.72, cost: 1728,
      cls: 'info', statusText: '物流已发车', status: 'logistics', owner: '刘飞',
      note: '6 个集装箱, 在途 33 天, 预计 12 天后到港', factory: 'F1', etaDay: 12,
      terms: { prepay: 0.3, balanceDue: 0.7, retention: 0, balanceDays: 60 },
      penalty: 0.0005, deadlineDay: 12, shippedDay: 1, deliveredDay: null, balanceDueAmt: 1680 },
    { id: 'O2', name: '广州 PCS 采购订单', client: '广州某储能公司', amount: 1200, costRate: 0.75, cost: 900,
      cls: 'warn', statusText: '生产中 · 缺料', status: 'paused', owner: '王广',
      note: '潜油电缆到货后复工', factory: 'F1',
      terms: { prepay: 0.2, balanceDue: 0.75, retention: 0.05, balanceDays: 45 },
      penalty: 0.0005, deadlineDay: 20, resumeDay: null, remainDays: 6, completionDay: null, deliveredDay: null, balanceDueAmt: 900 },
    { id: 'O3', name: 'WX-2026-007 潜油泵 110 套', client: '某油田一厂', amount: 2200, costRate: 0.68, cost: 1496,
      cls: 'bad', statusText: '待放行 · 已逾期 12 天', status: 'release', owner: '李四',
      note: '出厂试验合格, 待放行决策', factory: 'F1',
      terms: { prepay: 0.36, balanceDue: 0.64, retention: 0, balanceDays: 45 },
      penalty: 0.001, deadlineDay: -11, shippedDay: null, deliveredDay: null, balanceDueAmt: 1400 },
    { id: 'O4', name: 'WX-2026-010 升压变压器 8 台', client: '某风电场', amount: 1400, costRate: 0.71, cost: 994,
      cls: 'ok', statusText: '合同已过 · 待排产', status: 'scheduled', owner: '王五',
      note: '45 天交期, 产能可满足', factory: 'F1',
      terms: { prepay: 0.2, balanceDue: 0.75, retention: 0.05, balanceDays: 45 },
      penalty: 0.0005, deadlineDay: 45, startDay: null, prodDays: 15, deliveredDay: null, balanceDueAmt: 1050 },
  ],

  /* 两工厂产能(月产值/万元) */
  factories: [
    { id: 'F1', name: '工厂A · 成套车间', owner: '王广', capacity: 2800, load: 0.85, busyUntilDay: 8,
      tasks: ['广州 PCS(缺料)', 'WX-2026-007 潜油泵'], status: 'bad', statusText: '缺料' },
    { id: 'F2', name: '工厂B · 电子车间', owner: '陈二', capacity: 1200, load: 0.6, busyUntilDay: 5,
      tasks: ['PCB 组装'], status: 'ok', statusText: '正常' },
  ],

  /* 关键物料 */
  materials: [
    { name: '潜油电缆', stock: '0', eta: '待采购决策', cls: 'bad' },
    { name: '铜排', stock: '充足', eta: '', cls: 'ok' },
    { name: '变压器油', stock: '60%', eta: '', cls: 'ok' },
    { name: 'PCB 基板', stock: '充足', eta: '', cls: 'ok' },
    { name: '元器件', stock: '30%', eta: '', cls: 'warn' },
  ],

  todos: [
    { name: '市发改委会议', time: '10:30' },
    { name: '省电力公司考察', time: '14:30' },
  ],

  posts: [
    { who: '王五 · 销售部', tag: '公告', time: '10-07 17:20', body: '省电力公司考察团 10 月 9 日到访, 请各部门准备好资质材料与车间参观路线。' },
    { who: '李菲 · 市场部', tag: '分享', time: '10-06 09:41', body: '津巴布韦变压器项目今日发车, 共 6 个集装箱, 预计 45 天到港。感谢项目组两个月的努力。' },
  ],
};

/* 开局 5 决策: OP-1/OP-2 为报价式商机, D-3~D-5 为审批式(素材取自 demo 决策中心) */
const OPENING_DECISIONS = [
  { id: 'OP-1', kind: 'opp', type: '商机 · 投标', title: 'WX-2026-003 某油田二厂潜油离心泵 25 套',
    product: '潜油离心泵', client: '某油田二厂', qty: '25 套',
    amount: 1500, costRate: 0.74, cost: 1110, costLo: 1021, costHi: 1199,
    marketLo: 1380, marketHi: 1620, comp: 1.0,
    arriveDay: 1, deadlineDay: 4, deliveryDays: 25,
    submitted: false, price: null, resolved: false, result: null, resultText: '',
    who: '张三 · 销售部', when: '09:12',
    terms: { prepay: 0.2, balanceDue: 0.75, retention: 0.05, balanceDays: 45 }, penalty: 0.0005,
    ai: '资格满足、预算毛利 26%、历史同类中标率 54% → 建议投标。成本 1,110 万, 历史中标价区间 1,380 ~ 1,620 万。注意: 距截止仅 3 天, 标书还缺一份型式试验报告, 若中标需质检今天补齐(加急费 5 万)。' },
  { id: 'OP-2', kind: 'opp', type: '商机 · 报价', title: '某光伏电站箱式变压器 10 台',
    product: '光伏箱式变压器', client: '某光伏电站', qty: '10 台',
    amount: 860, costRate: 0.767, cost: 660, costLo: 607, costHi: 713,
    marketLo: 791, marketHi: 929, comp: 0.95,
    arriveDay: 1, deadlineDay: 5, deliveryDays: 30,
    submitted: false, price: null, resolved: false, result: null, resultText: '',
    who: '王五 · 销售部', when: '10:05',
    terms: { prepay: 0.2, balanceDue: 0.75, retention: 0.05, balanceDays: 90 }, penalty: 0.0005,
    ai: '成本 660 万, 毛利 23.3%, 落在历史中标价区间内 → 建议报价 860 万。提示: 该客户历史账期 90 天, 建议合同锁定 30% 预付款。' },
  { id: 'D-3', kind: 'approval', type: '合同评审', title: 'WX-2026-010 某风电场升压变压器 8 台',
    who: '王五 · 商务', when: '16:40', arriveDay: 1, expireDay: 3, handled: false, choice: null, resultText: '',
    options: [{ label: '同意', value: 'approve' }, { label: '驳回', value: 'reject' }], defaultChoice: 'approve',
    ai: '当前产能占用 72%, 45 天交期可满足 → 建议通过。注意: 合同违约条款为按日 0.1%, 建议压到 0.05%, 并明确不可抗力范围。' },
  { id: 'D-4', kind: 'approval', type: '设计变更 ECN', title: '广州 PCS 采购订单 · 变更 2 处',
    who: '陈二 · 技术部', when: '14:22', arriveDay: 1, expireDay: 3, handled: false, choice: null, resultText: '',
    options: [{ label: '同意', value: 'approve' }, { label: '驳回', value: 'reject' }], defaultChoice: 'approve',
    ai: '变更不占关键路径, 不影响交期, 成本增加约 12 万 → 建议批准, 并自动同步采购部更新物料清单。' },
  { id: 'D-5', kind: 'approval', type: '出厂放行', title: 'WX-2026-007 某油田一厂潜油泵 110 套(逾期 12 天)',
    who: '李四 · 质检部', when: '11:30', arriveDay: 1, expireDay: 3, handled: false, choice: null, resultText: '',
    options: [{ label: '同意', value: 'approve' }, { label: '驳回', value: 'reject' }], defaultChoice: 'approve',
    ai: '出厂试验逐项合格、随货资料齐全 → 建议放行。提示: 该单已逾期 12 天, 逾期违约金按日 0.1% 累计, 建议随货附客户沟通记录, 现场工程师优先安排安装。' },
];

/* 脚本事件: 第 3 天到达的采购决策 */
const SCRIPTED_DECISIONS = {
  purchase: { id: 'D-6', kind: 'approval', type: '采购加急', title: '潜油电缆到货推迟 5 天(缺料影响广州 PCS 订单)',
    who: '采购部', when: '09:20', arriveDay: 3, expireDay: 5, handled: false, choice: null, resultText: '',
    options: [{ label: '加急采购(+60 万)', value: 'rush' }, { label: '等待到货', value: 'wait' }], defaultChoice: 'wait',
    ai: '供应商通知潜油电缆到货推迟 5 天。加急采购: 溢价 20%(+60 万), 2 天后到货; 等待: 无额外成本, 5 天后到货。经测算两种方案均不影响 45 天交期 → 建议等待。' },
};

/* 经营手册(M1 骨架; M4 随复盘知识点扩充) */
const HANDBOOK = [
  {
    title: '报价方法',
    body: '报价 = 成本 ÷ (1 − 目标毛利)。注意: 成本只能拿到区间估算(±8%), 精确值未知, 报价要有安全边际。报价落在历史中标价区间内时, 中标率约 30~45%(偏低端更高); 高于区间上限, 中标率快速衰减; 低于区间, 中标率高但利润薄甚至亏损。核心功课: 在中标率与毛利之间找平衡(报价仅有一次机会, 落笔前想清楚)。真实素材: 曾有 2 笔废标, 原因正是报价偏高、资质不符。',
  },
  {
    title: '合同条款',
    body: '中标后需谈判合同条款, 三组合: 宽松(预付10% · 账期90天 · 违约金0.2%, 客户接受率95%) / 均衡(预付30% · 账期45天 · 违约金0.05%, 接受率82%) / 苛刻(预付50% · 账期30天 · 违约金0.02%, 接受率60%)。条款越苛刻现金流越稳, 但客户可能拒签直接丢单; 违约金按日计, 逾期 10 天 = 合同额 5~20% 被扣。',
  },
  {
    title: 'KPI 指标',
    body: '第 30 天结算加权评分: 净利润 30% / 现金流健康 20% / 交付准期率 20% / 中标率与报价质量 15% / 客户关系 10% / 风险处置 5%。评级: S≥90 / A≥75 / B≥60 / C<60; 破产 = F。',
  },
];
