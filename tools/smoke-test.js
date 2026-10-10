/* 轻量冒烟测试: 用 Node 无浏览器环境验证核心逻辑(数据/状态/报价/引擎) */
/* 用法: node tools/smoke-test.js */
const fs = require('fs');
const vm = require('vm');

global.localStorage = {
  _d: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
};

/* 可控随机数: 默认 0.5, 测试中可替换 */
const M = Object.create(Math);
M.random = () => 0.5;

const ctx = vm.createContext({
  console, Math: M, Date, JSON, Object, Array, String, Number, Boolean,
  M,
  setInterval: () => 0,
  localStorage,
  performance: { now: () => Date.now() },
  UITime: { render() {} },
  UIToast: { show() {} },
  UI: { showView() {}, renderAll() {}, showOppModal() {} },
});

for (const f of ['js/data.js', 'js/state.js', 'js/pricing.js', 'js/engine.js', 'js/review.js']) {
  vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f });
}

vm.runInContext(`
  Engine.init();
  newGame('标准');
  Engine.newWeather();

  // ---- 开局数据 ----
  if (GameState.cash !== 6000) throw new Error('开局现金异常');
  if (GameState.receivable.reduce((s, r) => s + r.amount, 0) !== 630) throw new Error('在账应收应为 630, 实际 ' + GameState.receivable.reduce((s, r) => s + r.amount, 0));
  if (GameState.orders.reduce((s, o) => s + o.amount, 0) !== 7200) throw new Error('在手订单应为 7200');
  if (GameState.decisions.length !== 5) throw new Error('开局应有 5 决策, 实际 ' + GameState.decisions.length);
  if (GameState.decisions.filter(x => x.kind === 'opp').length !== 2) throw new Error('开局应有 2 个报价商机');

  // ---- 报价模型: 概率单调性 ----
  const op1 = GameState.decisions.find(x => x.id === 'OP-1');
  const mid = (op1.marketLo + op1.marketHi) / 2;
  const pCost = winProb(op1, op1.cost), pMid = winProb(op1, mid), pHi = winProb(op1, op1.marketHi);
  if (!(pCost > pMid && pMid > pHi)) throw new Error('中标概率不随报价递减');
  if (!(pMid > 0.25 && pMid < 0.55)) throw new Error('区间中点概率应约 40% 左右, 实际 ' + pMid);

  // ---- 决策: 放行(同意) ----
  const d5 = GameState.decisions.find(x => x.id === 'D-5');
  Engine.applyDecision(d5, 'approve', 1);
  const o3 = GameState.orders.find(o => o.id === 'O3');
  if (o3.status !== 'shipped') throw new Error('放行同意后 O3 应发运');

  // ---- 决策: 合同评审(同意) → O4 排产 ----
  Engine.applyDecision(GameState.decisions.find(x => x.id === 'D-3'), 'approve', 1);
  const o4 = GameState.orders.find(o => o.id === 'O4');
  if (o4.status !== 'production' || !o4.completionDay) throw new Error('合同评审同意后 O4 应排产');

  // ---- 决策: ECN(同意) → 现金 -12 ----
  const cashBefore = GameState.cash;
  Engine.applyDecision(GameState.decisions.find(x => x.id === 'D-4'), 'approve', 1);
  if (GameState.cash !== cashBefore - 12) throw new Error('ECN 应扣 12 万');

  // ---- 日结经济: 第 2 天(管理费 -3, 同时账龄 180 天的质保金 150 到账) ----
  const c2 = GameState.cash;
  Engine.settleDay(2);
  if (GameState.cash !== c2 - 3 + 150) throw new Error('管理费 -3 + 质保金 +150, 实际变动 ' + (GameState.cash - c2));
  const r3 = GameState.receivable.find(r => r.id === 'R3');
  if (r3) throw new Error('账龄 180 天的质保金应已到账');

  // ---- O3 交付: 第 3 天(逾期 14 天, 违约金 0.1%/日) ----
  Engine.settleDay(3);
  const o3b = GameState.orders.find(o => o.id === 'O3');
  if (o3b.deliveredDay !== 3 || o3b.onTime !== false) throw new Error('O3 应逾期交付');
  if (GameState.kpi.late !== 1) throw new Error('准期率记录异常');
  const recvO3 = GameState.receivable.find(r => r.id === 'O3-B');
  const expectDue = 1400 - Math.round(2200 * 0.001 * 14);
  if (!recvO3 || recvO3.amount !== expectDue) throw new Error('O3 到货款应为 ' + expectDue + ', 实际 ' + (recvO3 && recvO3.amount));

  // ---- 开标: 中标(随机 0.05 < 概率) ----
  M.random = () => 0.05;
  const op1x = GameState.decisions.find(x => x.id === 'OP-1');
  op1x.price = 1500; op1x.submitted = true;
  const ordersBefore = GameState.orders.length;
  const cashBeforeBid = GameState.cash;
  Engine.resolveBid(op1x, 4);
  if (op1x.result !== 'won') throw new Error('OP-1 应中标(随机 0.05)');
  if (GameState.orders.length !== ordersBefore + 1) throw new Error('中标后应新增订单');
  const newOrder = GameState.orders[GameState.orders.length - 1];
  if (newOrder.status !== 'negotiating') throw new Error('新订单应先进入合同条款谈判');
  if (GameState.cash !== cashBeforeBid - 5) throw new Error('未签条款前仅扣型式报告 5 万, 实际变动 ' + (GameState.cash - cashBeforeBid));
  if (GameState.kpi.wins !== 1) throw new Error('中标记录异常');
  /* 谈判: 均衡条款被接受(M.random 0.05 < 0.82), 预付 30% 到账并排产 */
  const negOP1 = GameState.decisions.find(x => x.type === '合同条款' && !x.handled);
  if (!negOP1) throw new Error('OP-1 中标应生成条款谈判');
  Engine.applyDecision(negOP1, 'balanced', 4);
  if (newOrder.status !== 'production' && newOrder.status !== 'scheduled') throw new Error('谈判后应排产, 实际 ' + newOrder.status);
  if (GameState.cash !== cashBeforeBid - 5 + 450) throw new Error('均衡条款预付 30% = 450 万应到账, 实际变动 ' + (GameState.cash - cashBeforeBid));

  // ---- 开标: 未中标(随机 0.99) ----
  M.random = () => 0.99;
  const op2 = GameState.decisions.find(x => x.id === 'OP-2');
  op2.price = 860; op2.submitted = true;
  Engine.resolveBid(op2, 5);
  if (op2.result !== 'lost') throw new Error('OP-2 应未中标(随机 0.99)');
  if (GameState.kpi.losses !== 1) throw new Error('未中标记录异常');

  // ---- 脚本事件: 第 3 天采购决策 + 每日固定 1 商机 ----
  const oppsBefore = GameState.decisions.filter(x => x.kind === 'opp').length;
  Engine.arrivals(3);
  if (!GameState.decisions.find(x => x.id === 'D-6')) throw new Error('第 3 天应到达采购决策');
  const oppsAfter = GameState.decisions.filter(x => x.kind === 'opp').length;
  if (oppsAfter !== oppsBefore + 1) throw new Error('每日应固定到达 1 个商机, 实际 +' + (oppsAfter - oppsBefore));

  // ---- 旧存档拒绝加载 ----
  saveGame();
  const saved = JSON.parse(localStorage.getItem('wuxin-sim-save'));
  saved.version = 1;
  localStorage.setItem('wuxin-sim-save', JSON.stringify(saved));
  GameState.day = 12345;
  if (loadGame()) throw new Error('旧版本存档应拒绝加载');

  // ---- 工资发放: 第 30 天 ----
  const c30 = GameState.cash;
  Engine.settleDay(30);
  if (GameState.cash !== c30 - 3 - 300) throw new Error('第 30 天应扣工资 300 + 管理 3');

  // ---- M3: 合同条款谈判(苛刻条款被接受) ----
  M.random = () => 0.05;
  const oppT = { id: 'OP-T', kind: 'opp', type: '商机', title: '储能 PCS 设备 1,000 万(交期 30 天)', product: '储能 PCS 设备', client: '上海储能项目', qty: '', amount: 1000, costRate: 0.75, cost: 750, marketLo: 920, marketHi: 1080, comp: 1.0, arriveDay: 32, deadlineDay: 35, deliveryDays: 30, submitted: true, price: 1000, resolved: false, result: null, resultText: '', who: '市场部', when: '09:30', terms: { prepay: 0.2, balanceDue: 0.75, retention: 0.05, balanceDays: 45 }, penalty: 0.0005, ai: '' };
  GameState.decisions.push(oppT);
  const cashBN = GameState.cash;
  Engine.resolveBid(oppT, 35);
  if (oppT.result !== 'won') throw new Error('测试商机应中标');
  const negOrder = GameState.orders[GameState.orders.length - 1];
  if (negOrder.status !== 'negotiating') throw new Error('中标后应进入合同谈判');
  const neg = GameState.decisions.find(x => x.type === '合同条款' && !x.handled);
  if (!neg) throw new Error('应生成合同条款决策');
  Engine.applyDecision(neg, 'tight', 35);
  if (negOrder.status !== 'production' && negOrder.status !== 'scheduled') throw new Error('谈判接受后应排产, 实际 ' + negOrder.status);
  if (GameState.cash !== cashBN + 500) throw new Error('苛刻条款预付 50% 应到账(+500), 实际 +' + (GameState.cash - cashBN));

  // ---- M3: 谈判被客户拒绝 ----
  M.random = () => 0.2;
  const oppT2 = { id: 'OP-T2', kind: 'opp', type: '商机', title: '高低压开关柜 600 万(交期 25 天)', product: '高低压开关柜', client: '某电网公司', qty: '', amount: 600, costRate: 0.75, cost: 450, marketLo: 552, marketHi: 648, comp: 1.0, arriveDay: 36, deadlineDay: 38, deliveryDays: 25, submitted: true, price: 600, resolved: false, result: null, resultText: '', who: '市场部', when: '09:30', terms: { prepay: 0.2, balanceDue: 0.75, retention: 0.05, balanceDays: 45 }, penalty: 0.0005, ai: '' };
  GameState.decisions.push(oppT2);
  const cashBN2 = GameState.cash;
  const repBefore = GameState.clientRep;
  Engine.resolveBid(oppT2, 38);
  M.random = () => 0.99;
  const neg2 = GameState.decisions.find(x => x.type === '合同条款' && !x.handled);
  const negOrder2 = GameState.orders[GameState.orders.length - 1];
  Engine.applyDecision(neg2, 'balanced', 38);
  if (negOrder2.status !== 'cancelled') throw new Error('拒签后订单应取消');
  if (GameState.cash !== cashBN2) throw new Error('拒签不应有预付款, 实际变动 ' + (GameState.cash - cashBN2));
  if (GameState.clientRep !== repBefore - 3) throw new Error('拒签后客户关系应 -3, 实际 ' + GameState.clientRep);

  // ---- M3: 质检放行决策(放行 / 返工两路径) ----
  M.random = () => 0.5;
  const o4x = GameState.orders.find(o => o.id === 'O4');
  o4x.status = 'qa-hold';
  Engine.pushQa(o4x, 40);
  const qa = GameState.decisions.find(x => x.type === '质检放行' && !x.handled);
  if (!qa) throw new Error('应生成质检放行决策');
  Engine.applyDecision(qa, 'release', 40);
  if (o4x.status !== 'ready' || !o4x.qualityRisk) throw new Error('放行后应 ready 且带质量风险');
  const dummy = { id: 'QA-T', name: '测试单', client: '测试客户', amount: 500, costRate: 0.75, cost: 375, cls: 'bad', statusText: '质检异常 · 待决策', status: 'qa-hold', owner: '测试', note: '', factory: 'F2', terms: { prepay: 0.2, balanceDue: 0.75, retention: 0.05, balanceDays: 45 }, penalty: 0.0005, deadlineDay: 44, completionDay: null, deliveredDay: null, balanceDueAmt: 375 };
  GameState.orders.push(dummy);
  Engine.pushQa(dummy, 41);
  const qa2 = GameState.decisions.find(x => x.type === '质检放行' && !x.handled);
  if (qa2.defaultChoice !== 'rework') throw new Error('返工不逾期时应默认返工');
  Engine.applyDecision(qa2, 'rework', 41);
  if (dummy.status !== 'production' || dummy.completionDay !== 44) throw new Error('返工后应回生产, 完工日 44, 实际 ' + dummy.completionDay);

  // ---- M3: 突发事件(设备故障 · 外包抢修) ----
  M.random = () => 0.15;
  Engine.pushEvent(45);
  const evb = GameState.decisions.find(x => x.type === '突发事件' && !x.handled);
  if (!evb || evb.id.indexOf('EV-B') < 0) throw new Error('应生成设备故障决策');
  const cBeforeEv = GameState.cash;
  Engine.applyDecision(evb, 'outsource', 45);
  if (GameState.cash !== cBeforeEv - 40) throw new Error('外包抢修应扣 40 万');

  // ---- M3: 人事招聘(28 天后产能 +10%) ----
  const capBefore = GameState.factories[0].capacity;
  Engine.pushHrHire(46);
  const hrH = GameState.decisions.find(x => x.type === '人事' && !x.handled);
  if (!hrH || hrH.id.indexOf('HR-H') < 0) throw new Error('应生成招聘决策');
  const cBeforeHr = GameState.cash;
  Engine.applyDecision(hrH, 'accept', 46);
  if (GameState.cash !== cBeforeHr - 50) throw new Error('招聘应扣 50 万');
  GameState.hireUntilDay = 50;
  Engine.settleDay(50);
  if (GameState.factories[0].capacity !== Math.round(capBefore * 1.1)) throw new Error('招聘生效后产能应 +10%');

  // ---- M3: 政策利好提高光伏/储能中标率 ----
  GameState.policyBonusUntilDay = 99999;
  const pWith = winProb(oppT, 1000);
  GameState.policyBonusUntilDay = 0;
  const pWithout = winProb(oppT, 1000);
  if (!(pWith > pWithout)) throw new Error('政策利好应提高光伏/储能中标率');

  // ---- M4: 结算评分与快照 ----
  Review.snapshot();
  if (!GameState.reviewSnapshot || typeof GameState.reviewSnapshot.total !== 'number') throw new Error('结算快照异常');
  if (!/^[SABC]$/.test(GameState.reviewSnapshot.grade)) throw new Error('评级异常: ' + GameState.reviewSnapshot.grade);
  const dimKeys = Object.keys(GameState.reviewSnapshot.dims);
  if (dimKeys.length !== 6) throw new Error('应有 6 个评分维度, 实际 ' + dimKeys.length);
  if (GameState.reviewSnapshot.total < 0 || GameState.reviewSnapshot.total > 100) throw new Error('总分越界');

  // ---- M5: 难度三档 ----
  newGame('新手');
  if (GameState.cash !== 8000 || GameState.difficulty !== '新手') throw new Error('新手档异常');
  newGame('专家');
  if (GameState.cash !== 4500 || GameState.difficulty !== '专家') throw new Error('专家档异常');
  newGame('标准');
  if (GameState.cash !== 6000 || GameState.difficulty !== '标准') throw new Error('标准档异常');
  if (winProb({ marketLo: 920, marketHi: 1080, comp: 1, product: '储能 PCS 设备' }, 1000) < 0.3) throw new Error('标准档基准中标率异常');

  // ---- 沙盒继续经营(跨过第 90 天) ----
  GameState.day = 90;
  GameState.minutes = 18 * 60;
  GameState.finished = false;
  GameState.sandbox = true;
  M.random = () => 0.99;
  Engine.tick();
  if (GameState.day !== 91 || GameState.finished) throw new Error('沙盒模式应跨过 90 天继续经营');
  if (GameState.kpi.cashHistory.length < 2) throw new Error('现金历史应随日结记录');

  // ---- 坏账事件(新增亏损事件): 协商收回 50% ----
  M.random = () => 0.55;
  const recvMax = GameState.receivable.slice().sort((a, b) => b.amount - a.amount)[0];
  if (!recvMax) throw new Error('坏账测试需要应收');
  Engine.pushEvent(60);
  const evBd = GameState.decisions.find(x => x.type === '突发事件' && !x.handled && x.id.indexOf('EV-BD') >= 0);
  if (!evBd) throw new Error('应收存在时应生成坏账事件');
  const cashBeforeBd = GameState.cash;
  Engine.applyDecision(evBd, 'settle', 60);
  if (GameState.cash !== cashBeforeBd + Math.round(recvMax.amount * 0.5)) throw new Error('协商应收回 50%, 实际 +' + (GameState.cash - cashBeforeBd));
  if (GameState.receivable.find(r => r.id === evBd.receivableId)) throw new Error('坏账应收应已核销');

  // ---- 税务稽查事件(支出事件): 补缴 -80 万 ----
  M.random = () => 0.85;
  Engine.pushEvent(70);
  const evTx = GameState.decisions.find(x => x.type === '突发事件' && !x.handled && x.id.indexOf('EV-TX-') >= 0);
  if (!evTx) throw new Error('应生成税务稽查事件');
  const cashBeforeTx = GameState.cash;
  Engine.applyDecision(evTx, 'pay', 70);
  if (GameState.cash !== cashBeforeTx - 80) throw new Error('补缴应扣 80 万, 实际 -' + (cashBeforeTx - GameState.cash));

  // ---- 破产判定 ----
  GameState.cash = 0;
  Engine.settleDay(31);
  if (!GameState.bankrupt || !GameState.finished) throw new Error('现金为负应破产');

  console.log('冒烟测试全部通过 ✓ (现金 ' + GameState.cash + ', 订单 ' + GameState.orders.length + ' 单, 中标 ' + GameState.kpi.wins + '/丢单 ' + GameState.kpi.losses + ', 准期 ' + GameState.kpi.onTime + '/逾期 ' + GameState.kpi.late + ')');
`, ctx, { filename: 'smoke.js' });
