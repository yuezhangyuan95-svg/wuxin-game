/* ================= 游戏状态与存档 ================= */
const SAVE_KEY = 'wuxin-sim-save';
const SAVE_VERSION = 4;   /* 结构变更时 +1, 旧存档拒绝加载 */

const GameState = {
  day: 1,               // 第几天(1 起)
  minutes: 9 * 60,      // 游戏内时刻(自 0 点起算的分钟)
  speed: 2,             // 固定 2x 运行(无暂停机制)
  autoPaused: false,    // (保留字段)
  pauseReason: '',      // (保留字段)
  weather: null,        // { desc, temp }

  cash: 0,
  fixedAssets: 0,
  monthlyWages: 0,
  monthlyOverhead: 0,
  employees: 0,
  receivable: [],       // 应收
  orders: [],           // 在手订单
  factories: [],        // 工厂
  materials: [],        // 物料
  risks: [],            // 风险速览(每日动态计算)
  todos: [],            // 待办
  decisions: [],        // 收件箱: 商机(kind=opp) + 审批决策(kind=approval)
  cashflow: [],         // 现金流明细
  reports: [],          // 日报
  posts: [],            // 公司动态
  kpi: null,            // 战绩记录 { quotes, wins, losses, abandoned, onTime, late, decisions }
  finished: false,      // 季度是否结束
  bankrupt: false,      // 是否破产

  /* M3: 经营软状态 */
  clientRep: 80,              // 客户关系 0-100(季度 KPI 之一)
  policyBonusUntilDay: 0,     // 新能源补贴: 光伏/储能中标率 +10% 有效期
  strictUntilDay: 0,          // 监管趋严: 质检问题概率提高有效期
  costRateMod: null,          // 材料涨价: { untilDay, delta } 影响新商机成本率
  trainUntilDay: 0,           // 培训: 交付准期缓冲 +2 天有效期
  dispatchUntilDay: 0,        // 外派: 新单工期 +2 天有效期
  turnoverUntilDay: 0,        // 离职: 新单工期 +2 天有效期
  hireUntilDay: 0,            // 招聘生效日(0=未招聘)
  repairDueDay: 0,            // 带病运行设备强制大修到期日(0=无)
  lastHR: { dispatch: 1, hire: 1, train: 1 },  // 人事事件冷却

  /* M4/M5: 结算与难度 */
  difficulty: '标准',         // 新手 / 标准 / 专家
  sandbox: false,             // 季度结束后继续沙盒经营
  reviewSnapshot: null,       // 季度结算快照
};

/* 新游戏 */
function newGame(diff) {
  const cfg = DIFFICULTY[diff] || DIFFICULTY['标准'];
  Object.assign(GameState, {
    version: SAVE_VERSION,
    difficulty: diff || '标准',
    day: 1, minutes: 9 * 60, speed: 2, autoPaused: false, pauseReason: '',
    weather: null,
    cash: cfg.cash,
    fixedAssets: INITIAL.fixedAssets,
    monthlyWages: INITIAL.monthlyWages,
    monthlyOverhead: INITIAL.monthlyOverhead,
    employees: INITIAL.employees,
    receivable: INITIAL.receivable.map(x => ({ ...x })),
    orders: INITIAL.orders.map(x => ({ ...x })),
    factories: INITIAL.factories.map(x => ({ ...x, tasks: [...x.tasks] })),
    materials: INITIAL.materials.map(x => ({ ...x })),
    risks: [],   /* 由 Engine.recomputeRisks() 动态计算 */
    todos: INITIAL.todos.map(x => ({ ...x })),
    decisions: OPENING_DECISIONS.map(x => ({ ...x })),
    cashflow: [], reports: [],
    posts: INITIAL.posts.map(x => ({ ...x })),
    kpi: {
      quotes: [], wins: 0, losses: 0, abandoned: 0, onTime: 0, late: 0, decisions: [],
      startCash: cfg.cash, startRecv: 630,
      cashHistory: [{ day: 0, cash: cfg.cash }],
    },
    finished: false, bankrupt: false, sandbox: false, reviewSnapshot: null,
    clientRep: 80,
    policyBonusUntilDay: 0, strictUntilDay: 0, costRateMod: null,
    trainUntilDay: 0, dispatchUntilDay: 0, turnoverUntilDay: 0, hireUntilDay: 0, repairDueDay: 0,
    lastHR: { dispatch: 1, hire: 1, train: 1 },
  });
  saveGame();
}

/* 存档 */
function saveGame() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(GameState)); } catch (e) { /* 隐私模式等场景忽略 */ }
}

function hasSave() {
  try { return !!localStorage.getItem(SAVE_KEY); } catch (e) { return false; }
}

function loadGame() {
  let s = null;
  try { s = localStorage.getItem(SAVE_KEY); } catch (e) { return false; }
  if (!s) return false;
  try {
    const data = JSON.parse(s);
    if (data.version !== SAVE_VERSION) return false;   /* 旧版本存档拒绝加载 */
    Object.assign(GameState, data);
    return true;
  } catch (e) { return false; }
}

/* ================= 工具 ================= */
function fmt(n) { return Number(n).toLocaleString('zh-CN'); }
function fmtMoney(n) { return fmt(n) + ' 万'; }
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function dateOf(day) { const d = new Date(INITIAL.startDate.getTime()); d.setDate(d.getDate() + day - 1); return d; }
