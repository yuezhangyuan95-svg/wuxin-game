/* ================= 时间引擎(混合制: 实时流逝 + 关键决策自动暂停) ================= */
/* 节奏: 1x 时游戏 1 天 = 25 现实秒; 一天 09:00-18:00, 18:00 日结出日报。 */

const DAY_REAL_MS = 25000;        // 1x 时游戏 1 天 = 25 秒
const DAY_START_MIN = 9 * 60;     // 09:00 上班
const DAY_END_MIN = 18 * 60;      // 18:00 下班(日结)
const DAY_GAME_MIN = DAY_END_MIN - DAY_START_MIN;  // 540 游戏分钟

/* 随机事件概率(每日) */
const QA_PROB = 0.15;             // 完工质检异常概率
const ECN_PROB = 0.06;            // 在产订单 ECN 概率
const SHORTAGE_PROB = 0.05;       // 在产订单缺料概率
const EVENT_PROB = 0.35;          // 突发事件概率(支出型事件为主)
const COMP_RANGE = [0.85, 1.45];  // 对手竞争强度(全局, 波动大且中标更难得)

const Engine = {
  _last: 0,
  _oppNo: 1,
  _orderNo: 1,
  _decNo: 1,

  init() {
    Engine._last = performance.now();
    setInterval(() => Engine.tick(), 100);
  },

  /* ---------- 时间推进 ---------- */
  tick() {
    const now = performance.now();
    const dt = now - Engine._last;
    Engine._last = now;
    if (GameState.speed === 0 || GameState.finished) return;
    GameState.minutes += (dt * GameState.speed) / DAY_REAL_MS * DAY_GAME_MIN;
    /* 防止后台节流/休眠导致一次跨多天 */
    let guard = 0;
    while (GameState.minutes >= DAY_END_MIN && !GameState.finished && GameState.speed > 0 && guard++ < 100) {
      Engine.endDay();
    }
    UITime.render();
  },

  /* 调速(固定 2x 运行, 无暂停机制) */
  setSpeed(s) {
    GameState.speed = s;
    GameState.autoPaused = false;
    GameState.pauseReason = '';
    UITime.render();
  },

  /* ---------- 日结(18:00) ---------- */
  endDay() {
    const overflow = Math.max(0, GameState.minutes - DAY_END_MIN);
    GameState.day++;
    GameState.minutes = DAY_START_MIN + overflow;
    if (GameState.day > INITIAL.durationDays && !GameState.sandbox) { Engine.finishQuarter(); return; }
    const ended = GameState.day - 1;
    Engine.newWeather();
    Engine.settleDay(ended);
    if (!GameState.finished) Engine.arrivals(GameState.day);
    Engine.generateReport(ended);
    GameState.kpi.cashHistory.push({ day: ended, cash: GameState.cash });
    if (GameState.kpi.cashHistory.length > 150) GameState.kpi.cashHistory.shift();
    saveGame();
    UI.renderAll();
  },

  /* ---------- 日结经济 ---------- */
  settleDay(d) {
    /* 固定支出: 管理水电 100 万/月 按日摊销约 3 万 */
    Engine.pay(3, '管理费用(水电物业)摊销', '财务部', d);
    /* 月度工资(每 30 天发放一次) */
    if (d % 30 === 0) Engine.pay(GameState.monthlyWages, '当月工资发放', '财务部', d);
    /* 招聘生效 */
    if (GameState.hireUntilDay > 0 && d >= GameState.hireUntilDay) {
      GameState.factories.forEach(f => { f.capacity = Math.round(f.capacity * 1.1); });
      GameState.employees += 10;
      GameState.hireUntilDay = 0;
      GameState.posts.unshift({ who: '人事部', tag: '公告', time: Engine.dayStr(d), body: '新招聘的 10 名技工到岗, 两厂月产能各提升 10%。' });
    }
    /* 带病运行设备强制大修到期 */
    if (GameState.repairDueDay > 0 && d >= GameState.repairDueDay) {
      Engine.pay(60, '工厂B 强制大修(带病运行到期)', '设备部', d);
      GameState.repairDueDay = 0;
      GameState.posts.unshift({ who: '设备部', tag: '警示', time: Engine.dayStr(d), body: '工厂B 带病运行到期, 强制大修支出 60 万。' });
    }
    /* 应收账龄推进与到账 */
    for (let i = GameState.receivable.length - 1; i >= 0; i--) {
      const r = GameState.receivable[i];
      r.age++;
      if (r.age >= r.dueDays) {
        GameState.cash += r.amount;
        GameState.cashflow.push({ day: d, amount: r.amount, cls: 'in', reason: r.client + ' 回款到账', meta: r.note || '财务部' });
        GameState.receivable.splice(i, 1);
      }
    }
    /* 订单状态机推进 */
    GameState.orders.forEach(o => Engine.progressOrder(o, d));
    /* 商机截止开标 */
    GameState.decisions.forEach(x => {
      if (x.kind === 'opp' && !x.resolved && d >= x.deadlineDay) Engine.resolveBid(x, d);
    });
    /* 决策到期默认处理 */
    GameState.decisions.forEach(x => {
      if (x.kind === 'approval' && !x.handled && x.expireDay && d >= x.expireDay) Engine.applyDecision(x, x.defaultChoice, d);
    });
    /* 风险与工厂状态刷新 */
    Engine.recomputeRisks();
    Engine.recomputeFactories();
    /* 破产判定 */
    if (GameState.cash < 0) Engine.bankrupt(d);
  },

  /* 现金流支出 */
  pay(amount, reason, meta, d) {
    GameState.cash -= amount;
    GameState.cashflow.push({ day: d, amount: amount, cls: 'out', reason: reason, meta: meta });
    if (GameState.cashflow.length > 200) GameState.cashflow.splice(0, 50);
  },

  /* 现金流收入 */
  gain(amount, reason, meta, d) {
    GameState.cash += amount;
    GameState.cashflow.push({ day: d, amount: amount, cls: 'in', reason: reason, meta: meta });
    if (GameState.cashflow.length > 200) GameState.cashflow.splice(0, 50);
  },

  /* ---------- 订单状态机 ----------
     negotiating(条款谈判) → scheduled(待排产) → production(生产) → ready(待交付) → shipped(发运) → delivered(已交付) */
  progressOrder(o, d) {
    if (o.status === 'scheduled' && o.startDay != null && d >= o.startDay) {
      o.status = 'production'; o.statusText = '生产中'; o.cls = 'ok';
      o.completionDay = d + o.prodDays;
    } else if (o.status === 'paused' && o.resumeDay != null && d >= o.resumeDay) {
      o.status = 'production'; o.statusText = '生产中'; o.cls = 'ok';
      o.completionDay = d + o.remainDays;
    } else if (o.status === 'production' && o.completionDay != null && d >= o.completionDay) {
      const qaP = GameState.strictUntilDay >= d ? 0.35 : QA_PROB;
      if (Math.random() < qaP) {
        o.status = 'qa-hold'; o.statusText = '质检异常 · 待决策'; o.cls = 'bad'; o.note = '出厂试验发现异常项';
        Engine.pushQa(o, d);
      } else {
        o.status = 'ready'; o.statusText = '待交付 · 质检通过'; o.cls = 'info'; o.note = '待发运';
      }
    } else if (o.status === 'ready') {
      o.status = 'shipped'; o.statusText = '已发运'; o.cls = 'info'; o.shippedDay = d; o.note = '在途, 预计 2 天送达';
    } else if (o.status === 'shipped' && o.shippedDay != null && d >= o.shippedDay + 2 && o.deliveredDay == null) {
      Engine.deliver(o, d);
    } else if (o.status === 'logistics' && d >= (o.etaDay || 45) && o.deliveredDay == null) {
      Engine.deliver(o, d);   /* 津巴布韦单: 按预计到港日交付 */
    }
  },

  /* 交付结算: 准期/逾期违约金 + 到货款挂账 */
  deliver(o, d) {
    o.status = 'delivered'; o.statusText = '已交付 · 待回款'; o.cls = 'ok';
    o.deliveredDay = d;
    let due = o.balanceDueAmt;
    let penalty = 0;
    /* 培训缓冲: 培训有效期内交付准期宽限 +2 天 */
    const deadline = o.deadlineDay + (GameState.trainUntilDay >= d ? 2 : 0);
    o.onTime = d <= deadline;
    if (o.onTime) {
      GameState.kpi.onTime++;
    } else {
      GameState.kpi.late++;
      penalty = Math.round(o.amount * o.penalty * (d - o.deadlineDay));
      if (penalty > 0) {
        due = Math.max(0, due - penalty);
        GameState.cashflow.push({ day: d, amount: penalty, cls: 'out', reason: o.name + ' 逾期违约金', meta: '财务部' });
      }
    }
    if (due > 0) GameState.receivable.push({ id: o.id + '-B', client: o.client, amount: due, age: 0, dueDays: o.terms ? o.terms.balanceDays : 45, note: o.name + ' 到货款' });
    if (o.terms && o.terms.retention > 0) {
      const ret = Math.round(o.amount * o.terms.retention);
      if (ret > 0) GameState.receivable.push({ id: o.id + '-R', client: o.client, amount: ret, age: 0, dueDays: 180, note: o.name + ' 质保金' });
    }
    /* 放行时承担的质量风险: 20% 概率交付后投诉 */
    if (o.qualityRisk && Math.random() < 0.2) {
      const comp = Math.round(o.amount * 0.05);
      Engine.pay(comp, o.name + ' 质量投诉维修赔偿', '售后部', d);
      GameState.clientRep = Math.max(0, GameState.clientRep - 5);
      GameState.posts.unshift({ who: '售后部', tag: '警示', time: Engine.dayStr(d), body: o.name + ' 交付后客户投诉质量问题, 赔偿 ' + fmt(comp) + ' 万, 客户关系 -5。' });
    }
    GameState.posts.unshift({
      who: '财务部', tag: o.onTime ? '喜报' : '警示', time: Engine.dayStr(d),
      body: o.name + (o.onTime ? ' 按期交付!' : ' 逾期 ' + (d - o.deadlineDay) + ' 天交付, 违约金 ' + fmt(penalty) + ' 万。') + ' 到货款 ' + fmt(due) + ' 万已挂账。',
    });
  },

  /* ---------- 新一天上午事件 ---------- */
  arrivals(d) {
    const inQuarter = GameState.sandbox || d < INITIAL.durationDays - 2;
    /* 脚本事件: 第 3 天采购加急决策 */
    if (d === 3) {
      GameState.decisions.push({ ...SCRIPTED_DECISIONS.purchase, arriveDay: d, handled: false, choice: null, resultText: '' });
      UIToast.show('📬 新决策: 潜油电缆到货推迟(采购加急?)');
    }
    /* 商机: 每日固定 1 条 */
    if (inQuarter) Engine.pushOpp(d);
    /* 生产事件(每个在产订单) */
    GameState.orders.slice().forEach(o => {
      if (o.status !== 'production' || o.deliveredDay != null) return;
      if (Math.random() < SHORTAGE_PROB) Engine.pushShortage(o, d);
      else if (Math.random() < ECN_PROB) Engine.pushEcn(o, d);
    });
    /* 人事事件(带冷却) */
    const hr = GameState.lastHR;
    if (d - hr.dispatch >= 12 && Math.random() < 0.5) { Engine.pushHrDispatch(d); hr.dispatch = d; }
    if (d - hr.hire >= 15 && Math.random() < 0.5) { Engine.pushHrHire(d); hr.hire = d; }
    if (d - hr.train >= 20 && Math.random() < 0.5) { Engine.pushHrTrain(d); hr.train = d; }
    /* 突发事件 */
    if (Math.random() < EVENT_PROB) Engine.pushEvent(d);
  },

  /* ---------- 商机 ---------- */
  pushOpp(d) {
    const prod = PRODUCTS[Math.floor(Math.random() * PRODUCTS.length)];
    const amount = prod.range[0] + Math.round(Math.random() * (prod.range[1] - prod.range[0]));
    const mod = GameState.costRateMod && d <= GameState.costRateMod.untilDay ? GameState.costRateMod.delta : 0;
    let costRate = 0.72 + Math.round(Math.random() * 100) / 1000 + mod;    // 0.72 ~ 0.82 (+涨价), 毛利变薄
    costRate = Math.min(0.88, costRate);
    const deadline = 3 + Math.floor(Math.random() * 5);                 // 3~7 天
    const deliveryDays = 20 + Math.floor(Math.random() * 26);           // 20~45 天
    const cost = Math.round(amount * costRate);
    /* 成本对玩家只显示区间估算(±8%), 精确值未知 → 报价需要判断 */
    const costLo = Math.round(cost * 0.92), costHi = Math.round(cost * 1.08);
    const lo = Math.round(amount * 0.92), hi = Math.round(amount * 1.08);
    const comp = COMP_RANGE[0] + Math.random() * (COMP_RANGE[1] - COMP_RANGE[0]);
    const opp = {
      id: 'OP-' + (Engine._oppNo++),
      kind: 'opp', type: '商机',
      title: prod.name + ' ' + fmt(amount) + ' 万(交期 ' + deliveryDays + ' 天)',
      product: prod.name, client: prod.clients[Math.floor(Math.random() * prod.clients.length)], qty: '',
      amount: amount, costRate: costRate, cost: cost,
      costLo: costLo, costHi: costHi,
      marketLo: lo, marketHi: hi,
      comp: Math.round(comp * 100) / 100,
      arriveDay: d, deadlineDay: d + deadline, deliveryDays: deliveryDays,
      submitted: false, price: null, resolved: false, result: null, resultText: '',
      who: '市场部', when: '09:30',
      terms: { prepay: 0.2, balanceDue: 0.75, retention: 0.05, balanceDays: 45 },
      penalty: 0.0005,
    };
    const band = winProbBand(opp, amount);
    opp.ai = '成本估算 ' + fmt(costLo) + ' ~ ' + fmt(costHi) + ' 万(区间估算, 精确值未知), 历史中标价区间 ' + fmt(lo) + ' ~ ' + fmt(hi) + ' 万。建议报价 ' + fmt(amount) + ' 万(预估中标率 ' + Math.round(band[0] * 100) + '%~' + Math.round(band[1] * 100) + '%)。截止: 第 ' + opp.deadlineDay + ' 天。';
    GameState.decisions.push(opp);
    /* 商机弹窗: 驾驶舱居中展示, 出现时时间暂停 */
    UI.showOppModal(opp.id);
  },

  /* 开标(截止日 18:00) */
  resolveBid(opp, d) {
    opp.resolved = true;
    const rec = { title: opp.title, product: opp.product, amount: opp.amount, cost: opp.cost, price: opp.price || 0, day: d };
    if (!opp.submitted) {
      opp.result = 'abandoned';
      opp.resultText = '✗ 未在截止前报价, 商机流失(复盘: 投标准备时间管理)。';
      GameState.kpi.abandoned++;
      rec.result = 'abandoned';
    } else {
      const p = winProb(opp, opp.price);
      rec.winProb = Math.round(p * 100);
      if (Math.random() < p) {
        opp.result = 'won';
        GameState.kpi.wins++;
        rec.result = 'won';
        opp.resultText = '🎉 中标! 合同条款谈判已推送至收件箱。';
        Engine.createOrder(opp, d);
      } else {
        opp.result = 'lost';
        GameState.kpi.losses++;
        rec.result = 'lost';
        if (opp.price > opp.marketHi * 0.99 || Math.random() < 0.7) {
          opp.resultText = '✗ 未中标: 对手报价约低 ' + (1 + Math.round(Math.random() * 5)) + '%(复盘: 报价偏高风险)。';
        } else {
          opp.resultText = '✗ 未中标: 评审反馈资质/业绩不符(复盘: 客户画像与资质匹配)。';
        }
      }
    }
    GameState.kpi.quotes.push(rec);
    GameState.posts.unshift({ who: '市场部', tag: opp.result === 'won' ? '喜报' : '公告', time: Engine.dayStr(d), body: opp.title + ' → ' + opp.resultText });
    UIToast.show(opp.resultText);
  },

  /* 中标后创建订单, 进入合同条款谈判 */
  createOrder(opp, d) {
    const fac = Engine.pickFactory();
    let prodDays = Engine.prodDays(opp.amount, fac);
    /* 外派/离职影响: 新单工期 +2 天 */
    if (d <= GameState.dispatchUntilDay || d <= GameState.turnoverUntilDay) prodDays += 2;
    const order = {
      id: 'WX-' + (Engine._orderNo++),
      name: opp.product + '(新单)', client: opp.client,
      amount: opp.amount, costRate: opp.costRate, cost: opp.cost,
      cls: 'warn', statusText: '中标 · 待签合同条款', status: 'negotiating', owner: '销售部',
      note: '合同条款谈判中', factory: fac.id,
      terms: null, penalty: null,
      deadlineDay: d + opp.deliveryDays,
      startDay: null, completionDay: null, prodDays: prodDays,
      deliveredDay: null, balanceDueAmt: Math.round(opp.amount * 0.75),
    };
    GameState.orders.push(order);
    /* OP-1 专属: 中标需补齐型式试验报告 */
    if (opp.id === 'OP-1') Engine.pay(5, '型式试验报告加急补办', '质检部', d);
    Engine.pushNegotiation(order, d);
  },

  /* 选较空闲的工厂 */
  pickFactory() {
    let best = GameState.factories[0];
    for (const f of GameState.factories) if (f.busyUntilDay < best.busyUntilDay) best = f;
    return best;
  },

  /* 生产周期(天) = 金额 / 工厂日产能, 限 6~45 天 */
  prodDays(amount, fac) {
    const dailyCap = fac.capacity / 30;
    return Math.max(6, Math.min(45, Math.round(amount / dailyCap)));
  },

  /* ---------- 决策生成器(M3 四类决策) ---------- */
  newDecision(type, title, ai, options, defaultChoice, expireDays, who) {
    return {
      id: 'EV-' + (Engine._decNo++), kind: 'approval', type: type,
      title: title, who: who || '各部门', when: '10:00',
      arriveDay: GameState.day, expireDay: GameState.day + (expireDays || 2),
      handled: false, choice: null, resultText: '',
      options: options, defaultChoice: defaultChoice, ai: ai,
    };
  },

  /* 商务类: 合同条款谈判(中标后) */
  pushNegotiation(order, d) {
    const cash = GameState.cash;
    const suggestion = cash < 1500 ? 'tight' : cash > 4000 ? 'loose' : 'balanced';
    const x = Engine.newDecision('合同条款', order.name + ' · 合同条款谈判(' + fmt(order.amount) + ' 万)', '', [
      { label: '宽松 · 预付10% · 账期90天 · 违约金0.2%', value: 'loose' },
      { label: '均衡 · 预付30% · 账期45天 · 违约金0.05%', value: 'balanced' },
      { label: '苛刻 · 预付50% · 账期30天 · 违约金0.02%', value: 'tight' },
    ], suggestion, 2, '商务');
    x.orderId = order.id;
    x.acceptRate = { loose: 0.95, balanced: 0.82, tight: 0.6 };
    x.ai = '三选一: 条款越苛刻(高预付+短账期+低违约金), 现金流越稳, 但客户接受率越低(宽松95% / 均衡82% / 苛刻60%)。' +
      (suggestion === 'tight' ? '当前现金 ' + fmt(cash) + ' 万, 偏紧 → 建议苛刻条款保现金流。' :
       suggestion === 'loose' ? '当前现金 ' + fmt(cash) + ' 万, 充裕 → 建议宽松条款稳住订单。' :
       '当前现金 ' + fmt(cash) + ' 万 → 建议均衡条款。');
    GameState.decisions.push(x);
    UIToast.show('📬 中标! 请到收件箱谈判合同条款: ' + order.name);
  },

  /* 生产类: 质检放行 */
  pushQa(o, d) {
    const lateIfRework = d + 3 > o.deadlineDay;
    const x = Engine.newDecision('质检放行', o.name + ' 出厂试验发现 ' + (1 + Math.floor(Math.random() * 2)) + ' 项异常',
      lateIfRework
        ? '异常项非致命, 但返工 3 天会导致逾期(交期第 ' + o.deadlineDay + ' 天, 违约金按日计) → 建议放行并随货附沟通记录。'
        : '异常项非致命, 返工 3 天不影响交期 → 建议返工保质量。',
      [
        { label: '放行(承担质量风险)', value: 'release' },
        { label: '返工(+3 天)', value: 'rework' },
      ], lateIfRework ? 'release' : 'rework', 2, '质检部');
    x.orderId = o.id;
    GameState.decisions.push(x);
    UIToast.show('📬 新决策: 质检异常(' + o.name + ')');
  },

  /* 生产类: 随机 ECN */
  pushEcn(o, d) {
    const cost = 1 + Math.round(Math.random() * 29);
    const x = Engine.newDecision('设计变更', o.name + ' · 客户要求变更 ' + (1 + Math.floor(Math.random() * 3)) + ' 处',
      '变更不占关键路径, 不影响交期, 成本增加约 ' + fmt(cost) + ' 万 → 建议批准, 并自动同步采购部更新物料清单。',
      [
        { label: '同意(+' + fmt(cost) + ' 万)', value: 'approve' },
        { label: '驳回', value: 'reject' },
      ], 'approve', 2, '技术部');
    x.orderId = o.id;
    x.cost = cost;
    GameState.decisions.push(x);
    UIToast.show('📬 新决策: ' + o.name + ' 设计变更');
  },

  /* 生产类: 随机缺料 */
  pushShortage(o, d) {
    const mat = MATERIAL_NAMES[Math.floor(Math.random() * MATERIAL_NAMES.length)];
    const cost = Math.max(20, Math.round(o.amount * 0.02));
    const willLate = o.completionDay + 5 > o.deadlineDay;
    const x = Engine.newDecision('缺料采购', mat + ' 缺货(影响 ' + o.name + ')',
      mat + ' 供应紧张, 到货推迟。加急采购溢价 ' + fmt(cost) + ' 万, 延误 2 天; 等待则延误 5 天。' +
      (willLate ? '等待会导致该单逾期(交期第 ' + o.deadlineDay + ' 天, 违约金按日计) → 建议加急。' : '经测算等待不影响交期 → 建议等待。'),
      [
        { label: '加急采购(+' + fmt(cost) + ' 万, 延误 2 天)', value: 'rush' },
        { label: '等待到货(延误 5 天)', value: 'wait' },
      ], willLate ? 'rush' : 'wait', 2, '采购部');
    x.orderId = o.id;
    x.cost = cost;
    GameState.decisions.push(x);
    UIToast.show('📬 新决策: 物料缺货(' + mat + ')');
  },

  /* 生产类: 插单排产(排队超过 5 天时) */
  pushInsert(o, d, startDay) {
    const x = Engine.newDecision('插单排产', o.name + ' 需排队 ' + (startDay - d) + ' 天才能排产',
      '工厂产能紧张, 新单排队 ' + (startDay - d) + ' 天。插单可立即开工, 但会拖慢在产订单 3 天(可能引发逾期)。',
      [
        { label: '插单优先(老单延误 3 天)', value: 'insert' },
        { label: '按顺序排队', value: 'queue' },
      ], 'queue', 2, '生产部');
    x.orderId = o.id;
    GameState.decisions.push(x);
    UIToast.show('📬 新决策: 排产冲突(' + o.name + ')');
  },

  /* 人事类 */
  pushHrDispatch(d) {
    const loadAvg = GameState.factories.reduce((s, f) => s + f.load, 0) / GameState.factories.length;
    const x = Engine.newDecision('人事', '工程师外派机会(某风电场, 20 天, 收入 80 万)',
      '外派 2 名工程师 20 天, 收入 80 万。期间技术力量吃紧, 新订单工期 +2 天。' +
      (loadAvg < 0.8 ? '当前产能利用率 ' + Math.round(loadAvg * 100) + '%, 有余量 → 建议接单。' : '当前产能利用率 ' + Math.round(loadAvg * 100) + '%, 偏紧 → 建议拒绝。'),
      [
        { label: '接单外派(+80 万)', value: 'accept' },
        { label: '拒绝', value: 'reject' },
      ], loadAvg < 0.8 ? 'accept' : 'reject', 2, '人事部');
    x.id = 'HR-D-' + x.id;
    GameState.decisions.push(x);
    UIToast.show('📬 新决策: 工程师外派');
  },

  pushHrHire(d) {
    const x = Engine.newDecision('人事', '车间扩产招聘(10 名技工)',
      '招聘 10 名技工, 成本 50 万, 28 天后到岗, 两厂月产能各提升 10%。产能长期吃紧时值得投入。',
      [
        { label: '招聘(+50 万)', value: 'accept' },
        { label: '暂缓', value: 'reject' },
      ], 'accept', 2, '人事部');
    x.id = 'HR-H-' + x.id;
    GameState.decisions.push(x);
    UIToast.show('📬 新决策: 扩产招聘');
  },

  pushHrTrain(d) {
    const x = Engine.newDecision('人事', '生产班组培训方案(15 天)',
      '组织生产班组培训, 成本 30 万, 15 天内交付的订单准期宽限 +2 天, 有效降低逾期违约金风险。',
      [
        { label: '组织培训(+30 万)', value: 'accept' },
        { label: '暂缓', value: 'reject' },
      ], 'accept', 2, '人事部');
    x.id = 'HR-T-' + x.id;
    GameState.decisions.push(x);
    UIToast.show('📬 新决策: 班组培训');
  },

  /* 突发事件(权重: 政策10% / 故障20% / 投诉15% / 涨价15% / 离职10% / 坏账10% / 维修10% / 环保10%) */
  pushEvent(d) {
    const kind = Math.random();
    if (kind < 0.08) {
      /* 政策变化(通知) */
      if (Math.random() < 0.5) {
        GameState.policyBonusUntilDay = d + 15;
        GameState.posts.unshift({ who: '政府公告', tag: '利好', time: Engine.dayStr(d), body: '新能源设备补贴政策落地, 光伏/储能类商机中标率 +10%(15 天)。' });
        UIToast.show('📢 政策利好: 光伏/储能类中标率 +10%(15 天)');
      } else {
        GameState.strictUntilDay = d + 15;
        GameState.posts.unshift({ who: '政府公告', tag: '警示', time: Engine.dayStr(d), body: '监管趋严, 出厂试验抽检加强, 质检异常概率上升(15 天)。' });
        UIToast.show('📢 监管趋严: 质检异常概率上升(15 天)');
      }
      return;
    }
    if (kind < 0.2) {
      /* 设备故障 */
      const urgent = GameState.orders.some(o => o.status === 'production' && o.factory === 'F1' && o.completionDay - o.deadlineDay <= 5);
      const x = Engine.newDecision('突发事件', '工厂A 主设备故障停机',
        urgent ? '在产订单交期紧张, 自行维修停工 3 天有逾期风险 → 建议外包抢修(停工 1 天)。' : '在产订单交期宽松, 自行维修停工 3 天影响有限 → 建议省钱自修。',
        [
          { label: '外包抢修(+40 万, 停工 1 天)', value: 'outsource' },
          { label: '自行维修(停工 3 天)', value: 'self' },
        ], urgent ? 'outsource' : 'self', 2, '设备部');
      x.id = 'EV-B-' + x.id;
      GameState.decisions.push(x);
      UIToast.show('📬 突发事件: 工厂A 设备故障');
    } else if (kind < 0.3) {
      /* 客户投诉 */
      const clients = GameState.orders.map(o => o.client);
      const c = clients[Math.floor(Math.random() * clients.length)] || '某电网公司';
      const x = Engine.newDecision('突发事件', '客户投诉: ' + c + ' 反馈产品质量问题',
        '客户关系是 KPI 之一(权重 10%)。赔偿 30 万可稳住关系; 拒绝赔偿关系大幅受损。',
        [
          { label: '赔偿 30 万(关系稳住)', value: 'pay' },
          { label: '拒绝赔偿', value: 'refuse' },
        ], 'pay', 2, '售后部');
      x.id = 'EV-C-' + x.id;
      GameState.decisions.push(x);
      UIToast.show('📬 突发事件: 客户投诉');
    } else if (kind < 0.4) {
      /* 材料涨价 */
      const x = Engine.newDecision('突发事件', '铜排材料涨价 15%',
        GameState.cash > 3000
          ? '现金充裕 → 建议囤货 200 万锁定价格, 避免后续订单成本率 +3%(20 天)。'
          : '现金偏紧, 囤货 200 万压力大 → 建议接受涨价(后续订单成本率 +3%, 持续 20 天)。',
        [
          { label: '囤货锁定(+200 万)', value: 'stock' },
          { label: '不囤(成本率 +3% 持续 20 天)', value: 'pass' },
        ], GameState.cash > 3000 ? 'stock' : 'pass', 2, '采购部');
      x.id = 'EV-P-' + x.id;
      GameState.decisions.push(x);
      UIToast.show('📬 突发事件: 材料涨价');
    } else if (kind < 0.48) {
      /* 员工离职 */
      const x = Engine.newDecision('突发事件', '技术骨干提出离职(竞争对手挖角)',
        '留人: 一次性加薪补偿 20 万; 放人: 20 天内新订单工期 +2 天, 技术力量吃紧。',
        [
          { label: '加薪留人(+20 万)', value: 'keep' },
          { label: '放人', value: 'let' },
        ], 'keep', 2, '人事部');
      x.id = 'EV-R-' + x.id;
      GameState.decisions.push(x);
      UIToast.show('📬 突发事件: 技术骨干离职');
    } else if (kind < 0.58) {
      /* 坏账(需有应收, 否则降级为环保检查) */
      const recv = GameState.receivable.slice().sort((a, b) => b.amount - a.amount)[0];
      if (!recv) { Engine.pushEnvEvent(d); return; }
      const x = Engine.newDecision('突发事件', '客户 ' + recv.client + ' 经营困难, 应收 ' + fmt(recv.amount) + ' 万可能坏账',
        '协商折让: 立即收回 50%, 其余豁免; 起诉追讨: 支出律师费 15 万, 可收回 80%。' + (recv.amount < 60 ? '该笔金额较小, 起诉费用不划算 → 建议协商。' : '该笔金额较大 → 建议起诉追讨。'),
        [
          { label: '协商折让(收回 50%)', value: 'settle' },
          { label: '起诉追讨(-15 万, 收回 80%)', value: 'sue' },
        ], recv.amount < 60 ? 'settle' : 'sue', 2, '财务部');
      x.id = 'EV-BD-' + x.id;
      x.receivableId = recv.id;
      GameState.decisions.push(x);
      UIToast.show('📬 突发事件: 应收坏账风险');
    } else if (kind < 0.66) {
      /* 突发维修 */
      const x = Engine.newDecision('突发事件', '工厂B 生产线突发故障(设备老化)',
        '立即大修: 支出 35 万, 工厂B 在产订单延误 2 天; 带病运行: 暂不花钱, 但 15 天后强制大修(预计 60 万)。',
        [
          { label: '立即大修(-35 万, 延误 2 天)', value: 'repair' },
          { label: '带病运行(15 天后 -60 万)', value: 'delay' },
        ], 'repair', 2, '设备部');
      x.id = 'EV-RP-' + x.id;
      GameState.decisions.push(x);
      UIToast.show('📬 突发事件: 工厂B 设备老化');
    } else if (kind < 0.74) {
      Engine.pushEnvEvent(d);
    } else if (kind < 0.82) {
      Engine.pushFireEvent(d);
    } else if (kind < 0.90) {
      Engine.pushTaxEvent(d);
    } else if (kind < 0.95) {
      Engine.pushInjuryEvent(d);
    } else {
      Engine.pushLogisticsEvent(d);
    }
  },

  /* 环保检查(支出事件) */
  pushEnvEvent(d) {
    const x = Engine.newDecision('突发事件', '环保检查: 危废处置不合规, 拟罚款 60 万',
      '立即整改: 支出 30 万, 罚款免除; 申诉: 一半概率减免至 15 万, 一半概率加倍至 120 万。风险偏好自选。',
      [
        { label: '立即整改(-30 万)', value: 'fix' },
        { label: '申诉(50% -15 万 / 50% -120 万)', value: 'appeal' },
      ], 'fix', 2, '行政部');
    x.id = 'EV-EN-' + x.id;
    GameState.decisions.push(x);
    UIToast.show('📬 突发事件: 环保检查');
  },

  /* 暴雨受损(支出事件) */
  pushFireEvent(d) {
    const loss = 100 + Math.round(Math.random() * 200);
    const x = Engine.newDecision('突发事件', '仓库暴雨进水, 库存物料受损约 ' + fmt(loss) + ' 万(未投保)',
      '紧急处置费用 ' + fmt(Math.round(loss * 0.2)) + ' 万, 可挽回 60%; 放弃处置则损失全部。建议立即处置。',
      [
        { label: '紧急处置(挽回 60%)', value: 'handle' },
        { label: '放弃(损失 100%)', value: 'drop' },
      ], 'handle', 2, '仓储部');
    x.id = 'EV-F-' + x.id;
    x.cost = loss;
    GameState.decisions.push(x);
    UIToast.show('📬 突发事件: 仓库暴雨受损');
  },

  /* 税务稽查(支出事件) */
  pushTaxEvent(d) {
    const x = Engine.newDecision('突发事件', '税务稽查: 历史发票不合规, 拟补缴 80 万',
      '补缴稳妥; 申诉一半概率减免至 40 万, 一半概率加倍至 160 万。风险偏好自选。',
      [
        { label: '补缴(-80 万)', value: 'pay' },
        { label: '申诉(50% -40 / 50% -160)', value: 'appeal' },
      ], 'pay', 2, '财务部');
    x.id = 'EV-TX-' + x.id;
    GameState.decisions.push(x);
    UIToast.show('📬 突发事件: 税务稽查');
  },

  /* 工伤(支出事件) */
  pushInjuryEvent(d) {
    const x = Engine.newDecision('突发事件', '车间员工工伤, 医疗赔偿约 50 万',
      '走工伤保险流程支出 50 万, 规范无后患; 私了支出 30 万, 但有 20% 概率被追加索赔 80 万。建议走保险。',
      [
        { label: '走工伤保险(-50 万)', value: 'insure' },
        { label: '私了(-30 万, 有风险)', value: 'private' },
      ], 'insure', 2, '行政部');
    x.id = 'EV-IN-' + x.id;
    GameState.decisions.push(x);
    UIToast.show('📬 突发事件: 员工工伤');
  },

  /* 物流索赔(支出事件) */
  pushLogisticsEvent(d) {
    const x = Engine.newDecision('突发事件', '在途货物物流事故, 客户索赔 60 万',
      '足额赔付保住关系(客户关系是 KPI); 协商压价省钱但伤关系。',
      [
        { label: '足额赔付(-60 万, 关系 +2)', value: 'pay' },
        { label: '协商压价(-30 万, 关系 -5)', value: 'bargain' },
      ], 'pay', 2, '售后部');
    x.id = 'EV-LG-' + x.id;
    GameState.decisions.push(x);
    UIToast.show('📬 突发事件: 物流索赔');
  },

  /* ---------- 决策应用 ---------- */
  applyDecision(x, choice, d) {
    x.handled = true;
    x.choice = choice;
    const post = (who, tag, body) => GameState.posts.unshift({ who: who, tag: tag, time: Engine.dayStr(d), body: body });
    switch (x.id) {
      case 'D-3': {  /* 合同评审: O4 排产 */
        const o4 = GameState.orders.find(o => o.id === 'O4');
        if (choice === 'approve') {
          o4.status = 'production'; o4.statusText = '生产中'; o4.cls = 'ok';
          o4.startDay = d; o4.completionDay = d + o4.prodDays; o4.note = '工厂A 排产中';
          GameState.factories[0].busyUntilDay = Math.max(GameState.factories[0].busyUntilDay, o4.completionDay);
          x.resultText = '✓ 已通过。订单已排产, 预计第 ' + o4.completionDay + ' 天完工。';
          post('王五 · 商务', '公告', 'WX-2026-010 合同评审通过, 工厂A 已启动排产, 45 天交期可控。');
        } else {
          o4.startDay = d + 10; o4.note = '合同评审被驳回, 客户不满, 推迟 10 天排产';
          x.resultText = '✗ 已驳回。客户不满, 订单推迟 10 天, 交期压力增大。';
          post('王五 · 商务', '警示', 'WX-2026-010 合同评审被驳回, 客户已致电追问, 若再拖延有丢单风险。');
        }
        break;
      }
      case 'D-4': {  /* ECN */
        if (choice === 'approve') {
          Engine.pay(12, '广州 PCS 设计变更 ECN 实施', '技术部', d);
          const o2 = GameState.orders.find(o => o.id === 'O2');
          o2.note += '(ECN 2 处已实施)';
          x.resultText = '✓ 已批准。变更成本 +12 万, 不占关键路径, 采购部物料清单已同步。';
          post('陈二 · 技术部', '公告', '广州 PCS 订单 ECN 2 处变更已落实, 不影响交期。');
        } else {
          x.resultText = '✗ 已驳回。客户不满, 若交付质量不达标可能引发投诉与整改。';
          post('陈二 · 技术部', '警示', 'ECN 被驳回, 客户表示无法接受, 售后风险自担。');
        }
        break;
      }
      case 'D-5': {  /* 出厂放行 */
        const o3 = GameState.orders.find(o => o.id === 'O3');
        if (choice === 'approve') {
          o3.status = 'shipped'; o3.statusText = '已放行 · 发运中'; o3.cls = 'info';
          o3.shippedDay = d; o3.note = '随货附客户沟通记录, 现场工程师优先安装';
          x.resultText = '✓ 已放行。发运中, 到货款将在交付后挂账(逾期违约金按日 0.1% 已累计)。';
          post('李四 · 质检部', '公告', 'WX-2026-007 潜油泵 110 套已放行发运, 逾期 12 天的单子终于出门了。');
        } else {
          o3.status = 'production'; o3.statusText = '返工中'; o3.cls = 'bad';
          o3.completionDay = d + 5; o3.note = '放行被驳回, 返工 5 天, 逾期进一步扩大';
          x.resultText = '✗ 已驳回。返工 5 天, 逾期违约金继续按日 0.1% 累计。';
          post('李四 · 质检部', '警示', 'WX-2026-007 放行被驳回, 车间返工 5 天, 违约金每天都在涨。');
        }
        break;
      }
      case 'D-6': {  /* 采购加急 */
        const o2 = GameState.orders.find(o => o.id === 'O2');
        if (choice === 'rush') {
          Engine.pay(60, '潜油电缆加急采购(溢价 20%)', '采购部', d);
          o2.resumeDay = d + 2;
          x.resultText = '✓ 已加急采购。电缆 2 天后到货复工, 成本 +60 万。';
          post('王广 · 工厂A', '公告', '电缆加急采购已下单, 2 天后到货, 广州 PCS 订单立即复工。');
        } else {
          o2.resumeDay = d + 5;
          x.resultText = '已选择等待。电缆 5 天后到货复工, 无额外成本。';
          post('采购部', '公告', '潜油电缆按原计划 5 天后到货, 工厂A 缺料状态再持续几日。');
        }
        break;
      }
      default: Engine.applyTyped(x, choice, d);
    }
    GameState.kpi.decisions.push({ day: d, title: x.title, type: x.type, choice: choice, recommended: x.defaultChoice, result: x.resultText });
  },

  /* 类型化决策(M3 四类) */
  applyTyped(x, choice, d) {
    const post = (who, tag, body) => GameState.posts.unshift({ who: who, tag: tag, time: Engine.dayStr(d), body: body });
    switch (x.type) {
      case '合同条款': {
        const o = GameState.orders.find(o => o.id === x.orderId);
        const rate = (x.acceptRate && x.acceptRate[choice]) || 0.8;
        if (Math.random() < rate) {
          const T = {
            loose: { prepay: 0.1, balanceDays: 90, penalty: 0.002 },
            balanced: { prepay: 0.3, balanceDays: 45, penalty: 0.0005 },
            tight: { prepay: 0.5, balanceDays: 30, penalty: 0.0002 },
          }[choice];
          o.terms = { prepay: T.prepay, balanceDue: 0.95 - T.prepay, retention: 0.05, balanceDays: T.balanceDays };
          o.penalty = T.penalty;
          o.balanceDueAmt = Math.round(o.amount * o.terms.balanceDue);
          const prepay = Math.round(o.amount * T.prepay);
          Engine.gain(prepay, o.client + ' 预付款到账', '财务部', d);
          /* 排产 */
          const fac = GameState.factories.find(f => f.id === o.factory);
          o.startDay = Math.max(d, fac.busyUntilDay);
          o.completionDay = o.startDay + o.prodDays;
          fac.busyUntilDay = o.completionDay;
          if (o.startDay - d > 5) {
            o.status = 'scheduled'; o.statusText = '待排产 · 排队中'; o.cls = 'info'; o.note = '排队 ' + (o.startDay - d) + ' 天';
            Engine.pushInsert(o, d, o.startDay);
          } else {
            o.status = 'production'; o.statusText = '生产中'; o.cls = 'ok'; o.note = '工厂' + (o.factory === 'F1' ? 'A' : 'B') + ' 排产中';
          }
          x.resultText = '✓ 客户接受条款(预付 ' + (T.prepay * 100) + '%), 预付款 ' + fmt(prepay) + ' 万到账, 订单已排产。';
        } else {
          o.status = 'cancelled'; o.statusText = '客户拒签 · 订单流失'; o.cls = 'bad'; o.note = '条款未被接受';
          GameState.clientRep = Math.max(0, GameState.clientRep - 3);
          x.resultText = '✗ 客户拒绝了条款, 订单流失(复盘: 条款苛刻程度与客户接受度的平衡)。客户关系 -3。';
          post('商务', '警示', o.name + ' 条款谈判破裂, 客户转向竞争对手。');
        }
        break;
      }
      case '质检放行': {
        const o = GameState.orders.find(o => o.id === x.orderId);
        if (choice === 'release') {
          o.status = 'ready'; o.statusText = '待交付 · 质检通过'; o.cls = 'info';
          o.qualityRisk = true; o.note = '放行(承担质量风险)';
          x.resultText = '✓ 已放行。注意: 承担质量风险, 若交付后出现投诉将赔偿并损失客户关系。';
        } else {
          o.status = 'production'; o.statusText = '返工中'; o.cls = 'bad';
          o.completionDay = d + 3; o.note = '返工 3 天';
          x.resultText = '✓ 已返工。3 天后重新出厂试验。';
        }
        break;
      }
      case '设计变更': {
        const o = GameState.orders.find(o => o.id === x.orderId);
        if (choice === 'approve') {
          Engine.pay(x.cost || 10, o.name + ' 设计变更实施', '技术部', d);
          x.resultText = '✓ 已批准。变更成本 +' + fmt(x.cost || 10) + ' 万, 不影响交期。';
        } else {
          GameState.clientRep = Math.max(0, GameState.clientRep - 2);
          x.resultText = '✗ 已驳回。客户不满, 客户关系 -2, 若交付不达标可能引发投诉。';
        }
        break;
      }
      case '缺料采购': {
        const o = GameState.orders.find(o => o.id === x.orderId);
        if (choice === 'rush') {
          Engine.pay(x.cost || 20, o.name + ' 加急采购', '采购部', d);
          o.completionDay += 2;
          x.resultText = '✓ 已加急采购(+' + fmt(x.cost || 20) + ' 万), 该单延误 2 天。';
        } else {
          o.completionDay += 5;
          x.resultText = '已选择等待, 该单延误 5 天。';
        }
        break;
      }
      case '插单排产': {
        const o = GameState.orders.find(o => o.id === x.orderId);
        if (choice === 'insert') {
          const fac = GameState.factories.find(f => f.id === o.factory);
          o.startDay = d; o.completionDay = d + o.prodDays;
          o.status = 'production'; o.statusText = '生产中'; o.cls = 'ok';
          fac.busyUntilDay = o.completionDay;
          const victims = GameState.orders.filter(v => v.status === 'production' && v.id !== o.id).sort((a, b) => a.completionDay - b.completionDay);
          if (victims.length) victims[0].completionDay += 3;
          x.resultText = '✓ 已插单优先生产, 在产订单 ' + (victims.length ? victims[0].name : '') + ' 延误 3 天。';
        } else {
          x.resultText = '已按顺序排队。';
        }
        break;
      }
      case '人事': {
        if (x.id.indexOf('HR-D') >= 0) {
          if (choice === 'accept') {
            Engine.gain(80, '工程师外派服务收入', '市场部', d);
            GameState.dispatchUntilDay = d + 20;
            x.resultText = '✓ 已接单。收入 80 万到账, 20 天内新订单工期 +2 天。';
          } else {
            x.resultText = '已拒绝外派机会。';
          }
        } else if (x.id.indexOf('HR-H') >= 0) {
          if (choice === 'accept') {
            Engine.pay(50, '招聘费用', '人事部', d);
            GameState.hireUntilDay = d + 28;
            x.resultText = '✓ 已启动招聘。28 天后 10 名技工到岗, 两厂产能 +10%。';
          } else {
            x.resultText = '已暂缓招聘。';
          }
        } else {
          if (choice === 'accept') {
            Engine.pay(30, '培训费用', '人事部', d);
            GameState.trainUntilDay = d + 15;
            x.resultText = '✓ 已组织培训。15 天内交付的订单准期宽限 +2 天。';
          } else {
            x.resultText = '已暂缓培训。';
          }
        }
        break;
      }
      case '突发事件': {
        if (x.id.indexOf('EV-B-') >= 0) {
          const delay = choice === 'outsource' ? 1 : 3;
          if (choice === 'outsource') Engine.pay(40, '设备外包抢修', '设备部', d);
          GameState.orders.forEach(o => {
            if (o.status === 'production' && o.factory === 'F1' && o.completionDay) o.completionDay += delay;
          });
          x.resultText = choice === 'outsource' ? '✓ 已外包抢修(-40 万), 工厂A 在产订单延误 1 天。' : '已自行维修, 工厂A 在产订单延误 3 天。';
        } else if (x.id.indexOf('EV-C-') >= 0) {
          if (choice === 'pay') {
            Engine.pay(30, '客户投诉赔偿', '售后部', d);
            GameState.clientRep = Math.min(100, GameState.clientRep + 2);
            x.resultText = '✓ 已赔偿 30 万, 客户关系 +2。';
          } else {
            GameState.clientRep = Math.max(0, GameState.clientRep - 8);
            x.resultText = '✗ 已拒绝赔偿, 客户关系 -8(影响季度 KPI)。';
          }
        } else if (x.id.indexOf('EV-P-') >= 0) {
          if (choice === 'stock') {
            Engine.pay(200, '铜排囤货锁定价格', '采购部', d);
            x.resultText = '✓ 已囤货 200 万, 后续订单成本不受涨价影响。';
          } else {
            GameState.costRateMod = { untilDay: d + 20, delta: 0.03 };
            x.resultText = '已接受涨价, 20 天内新商机成本率 +3%(报价时注意成本变化)。';
          }
        } else if (x.id.indexOf('EV-BD-') >= 0) {
          const recv = GameState.receivable.find(r => r.id === x.receivableId);
          if (!recv) { x.resultText = '该笔应收已回款, 虚惊一场。'; break; }
          const idx = GameState.receivable.indexOf(recv);
          if (choice === 'settle') {
            const back = Math.round(recv.amount * 0.5);
            Engine.gain(back, recv.client + ' 坏账协商回款(50%)', '财务部', d);
            GameState.cashflow.push({ day: d, amount: recv.amount - back, cls: 'out', reason: recv.client + ' 坏账豁免(亏损)', meta: '财务部' });
            GameState.receivable.splice(idx, 1);
            x.resultText = '已协商: 收回 ' + fmt(back) + ' 万, 豁免 ' + fmt(recv.amount - back) + ' 万(亏损)。';
          } else {
            Engine.pay(15, '坏账诉讼律师费', '财务部', d);
            const back = Math.round(recv.amount * 0.8);
            Engine.gain(back, recv.client + ' 坏账诉讼回款(80%)', '财务部', d);
            GameState.cashflow.push({ day: d, amount: recv.amount - back, cls: 'out', reason: recv.client + ' 坏账损失(亏损)', meta: '财务部' });
            GameState.receivable.splice(idx, 1);
            x.resultText = '已起诉: 支出 15 万, 收回 ' + fmt(back) + ' 万, 损失 ' + fmt(recv.amount - back) + ' 万。';
          }
        } else if (x.id.indexOf('EV-RP-') >= 0) {
          if (choice === 'repair') {
            Engine.pay(35, '工厂B 设备大修', '设备部', d);
            GameState.orders.forEach(o => {
              if (o.status === 'production' && o.factory === 'F2' && o.completionDay) o.completionDay += 2;
            });
            x.resultText = '✓ 已大修(-35 万), 工厂B 在产订单延误 2 天。';
          } else {
            GameState.repairDueDay = d + 15;
            x.resultText = '已带病运行, 15 天后强制大修(预计 -60 万)。';
          }
        } else if (x.id.indexOf('EV-EN-') >= 0) {
          if (choice === 'fix') {
            Engine.pay(30, '环保整改', '行政部', d);
            x.resultText = '✓ 已整改(-30 万), 罚款免除。';
          } else {
            const ok = Math.random() < 0.5;
            const fine = ok ? 15 : 120;
            Engine.pay(fine, '环保罚款(申诉' + (ok ? '减免' : '加倍') + ')', '行政部', d);
            x.resultText = ok ? '申诉成功: 罚款减免至 15 万。' : '✗ 申诉失败: 罚款加倍至 120 万!';
          }
        } else if (x.id.indexOf('EV-F-') >= 0) {
          const loss = x.cost || 150;
          if (choice === 'handle') {
            Engine.pay(Math.round(loss * 0.2), '暴雨受损紧急处置', '仓储部', d);
            GameState.cashflow.push({ day: d, amount: Math.round(loss * 0.4), cls: 'out', reason: '暴雨物料损失(挽回 60%)', meta: '仓储部' });
            x.resultText = '已紧急处置: 挽回 60%, 处置费+净损失合计约 ' + fmt(Math.round(loss * 0.2) + Math.round(loss * 0.4)) + ' 万。';
          } else {
            GameState.cashflow.push({ day: d, amount: loss, cls: 'out', reason: '暴雨物料损失(未处置)', meta: '仓储部' });
            x.resultText = '已放弃处置, 损失 ' + fmt(loss) + ' 万。';
          }
        } else if (x.id.indexOf('EV-TX-') >= 0) {
          if (choice === 'pay') {
            Engine.pay(80, '税务补缴与滞纳金', '财务部', d);
            x.resultText = '✓ 已补缴 80 万, 税务风险解除。';
          } else {
            const ok = Math.random() < 0.5;
            Engine.pay(ok ? 40 : 160, '税务申诉' + (ok ? '(减免)' : '(加倍)'), '财务部', d);
            x.resultText = ok ? '申诉成功: 补缴降至 40 万。' : '✗ 申诉失败: 补缴加倍至 160 万!';
          }
        } else if (x.id.indexOf('EV-IN-') >= 0) {
          if (choice === 'insure') {
            Engine.pay(50, '工伤医疗与赔偿(保险流程)', '行政部', d);
            x.resultText = '✓ 已走工伤保险流程(-50 万), 无后患。';
          } else {
            Engine.pay(30, '工伤私了赔偿', '行政部', d);
            if (Math.random() < 0.2) {
              Engine.pay(80, '工伤追加索赔(私了后续)', '行政部', d);
              x.resultText = '✗ 私了失败: 员工后续追加索赔 80 万, 合计 -110 万!';
            } else {
              x.resultText = '已私了(-30 万), 未再起波折。';
            }
          }
        } else if (x.id.indexOf('EV-LG-') >= 0) {
          if (choice === 'pay') {
            Engine.pay(60, '物流事故客户赔付', '售后部', d);
            GameState.clientRep = Math.min(100, GameState.clientRep + 2);
            x.resultText = '✓ 已足额赔付(-60 万), 客户关系 +2。';
          } else {
            Engine.pay(30, '物流事故协商赔付', '售后部', d);
            GameState.clientRep = Math.max(0, GameState.clientRep - 5);
            x.resultText = '已协商压价(-30 万), 客户关系 -5。';
          }
        } else {
          if (choice === 'keep') {
            Engine.pay(20, '骨干留任补偿', '人事部', d);
            x.resultText = '✓ 已加薪留人(-20 万)。';
          } else {
            GameState.turnoverUntilDay = d + 20;
            x.resultText = '已放人, 20 天内新订单工期 +2 天。';
          }
        }
        break;
      }
      default: {
        x.resultText = '已' + (choice === 'approve' ? '批准' : '驳回') + ' · 流转至下一环节。';
      }
    }
  },

  /* ---------- 风险与工厂状态 ---------- */
  recomputeRisks() {
    const r = [];
    const d = GameState.day;
    const o2 = GameState.orders.find(o => o.id === 'O2');
    if (o2 && o2.status === 'paused') r.push({ txt: '工厂A 广州 PCS 订单缺料(潜油电缆未到货)', cls: 'bad' });
    const o3 = GameState.orders.find(o => o.id === 'O3');
    if (o3 && o3.deliveredDay == null) r.push({ txt: 'WX-2026-007 已逾期 ' + (d - o3.deadlineDay) + ' 天' + (o3.status === 'release' ? ', 待放行' : ', 返工中'), cls: 'bad' });
    GameState.decisions.forEach(x => {
      if (x.kind === 'opp' && !x.resolved && !x.submitted && x.deadlineDay - d <= 2 && x.deadlineDay - d >= 0) {
        r.push({ txt: x.title + ' 距截止仅 ' + (x.deadlineDay - d) + ' 天', cls: 'warn' });
      }
    });
    GameState.receivable.forEach(x => {
      if (x.age >= 30) r.push({ txt: '应收 ' + fmt(x.amount) + ' 万账龄 ' + x.age + ' 天, 待催收', cls: 'warn' });
    });
    GameState.orders.forEach(o => {
      if ((o.status === 'production' || o.status === 'paused' || o.status === 'qa-hold' || o.status === 'scheduled') && o.deadlineDay < d && o.deliveredDay == null) {
        r.push({ txt: o.name + ' 已逾期(交期第 ' + o.deadlineDay + ' 天)', cls: 'warn' });
      }
    });
    if (GameState.cash < 800) r.push({ txt: '现金低于警戒线(' + fmt(GameState.cash) + ' 万)', cls: 'bad' });
    GameState.risks = r.slice(0, 6);
  },

  recomputeFactories() {
    const d = GameState.day;
    GameState.factories.forEach(f => {
      f.load = Math.min(1, Math.max(0, (f.busyUntilDay - d) / 30));
    });
    const f1 = GameState.factories[0];
    const o2 = GameState.orders.find(o => o.id === 'O2');
    if (o2 && o2.status === 'paused') { f1.status = 'bad'; f1.statusText = '缺料'; }
    else if (o2 && o2.deliveredDay == null && (o2.status === 'production' || o2.status === 'ready' || o2.status === 'shipped')) { f1.status = 'ok'; f1.statusText = '正常'; }
  },

  /* ---------- 破产 / 季度结束 ---------- */
  bankrupt(d) {
    GameState.bankrupt = true;
    GameState.finished = true;
    GameState.speed = 0;
    GameState.autoPaused = false;
    Review.snapshot();
    UITime.render();
    UIToast.show('💥 现金断流, 企业破产! 评级 F');
    UI.renderAll();
    UI.showView('review');
    saveGame();
  },

  finishQuarter() {
    GameState.finished = true;
    GameState.speed = 0;
    GameState.autoPaused = false;
    Review.snapshot();
    UITime.render();
    UIToast.show('第 30 天结束! 经营复盘报告已生成。');
    UI.renderAll();
    UI.showView('review');
    saveGame();
  },

  /* ---------- 天气 / 日报 ---------- */
  newWeather() {
    const w = WEATHER_POOL[Math.floor(Math.random() * WEATHER_POOL.length)];
    GameState.weather = { desc: w.desc, temp: w.temp[0] + Math.floor(Math.random() * (w.temp[1] - w.temp[0] + 1)) };
  },

  generateReport(ended) {
    const d = dateOf(ended);
    const dayFlow = GameState.cashflow.filter(f => f.day === ended);
    const income = dayFlow.filter(f => f.cls === 'in').reduce((s, f) => s + f.amount, 0);
    const expense = dayFlow.filter(f => f.cls === 'out').reduce((s, f) => s + f.amount, 0);
    const pending = GameState.decisions.filter(x => !x.handled && !x.resolved).length;
    const opps = GameState.decisions.filter(x => x.kind === 'opp' && !x.resolved);
    let ai = '今日现金流: 收 ' + fmt(income) + ' 万, 支 ' + fmt(expense) + ' 万。';
    if (pending > 0) ai += '收件箱 ' + pending + ' 项待处理, 请尽快决策。';
    if (opps.length > 0) ai += '待开标商机 ' + opps.length + ' 个。';
    if (GameState.risks.length > 0) ai += '关注: ' + GameState.risks[0].txt + '。';
    GameState.reports.unshift({
      day: ended,
      date: (d.getMonth() + 1) + '月' + d.getDate() + '日',
      income: income, expense: expense, ai: ai,
    });
    if (GameState.reports.length > 120) GameState.reports.pop();
  },

  /* 日期字符串(用于动态消息) */
  dayStr(d) {
    const dt = dateOf(d);
    return (dt.getMonth() + 1) + '-' + String(dt.getDate()).padStart(2, '0');
  },
};
