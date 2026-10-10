/* ================= 报价/中标概率模型 ================= */
/* 逻辑: 历史中标价区间 [marketLo, marketHi] 中点为 50% 基准;
   报价低于区间 → 中标率上升但利润薄/亏钱; 高于区间 → 快速衰减。
   竞争强度 comp 乘性修正; WIN_PENALTY 为全局中标率下修(训练: 中标更难得)。
   预估以区间带展示(±5% 模糊度)。 */

const WIN_PENALTY = 0.18;

function winProb(opp, price) {
  const mid = (opp.marketLo + opp.marketHi) / 2;
  const spread = (opp.marketHi - opp.marketLo) / 2;
  let p = 1 / (1 + Math.exp((price - mid) / spread));
  p *= opp.comp;
  p -= WIN_PENALTY;
  /* 政策利好: 光伏/储能类中标率 +10% */
  if (GameState.policyBonusUntilDay >= GameState.day && /光伏|储能/.test(opp.product)) p += 0.1;
  return Math.min(0.95, Math.max(0.03, p));
}

/* AI 预估区间(±9% 模糊度, 需自行判断) */
function winProbBand(opp, price) {
  const p = winProb(opp, price);
  const fuzz = 0.09;
  return [Math.max(0.01, p - fuzz), Math.min(0.97, p + fuzz)];
}

/* 预计毛利(万元)与毛利率(%) */
function marginOf(opp, price) {
  const m = Math.round(price - opp.cost);
  const mr = opp.cost > 0 ? Math.round((price - opp.cost) / opp.cost * 100) : 0;
  return { amount: m, rate: mr };
}

/* 报价诊断提示(成本为区间估算时用区间边界判断) */
function quoteHint(opp, price) {
  const lo = opp.costLo != null ? opp.costLo : opp.cost;
  const hi = opp.costHi != null ? opp.costHi : opp.cost;
  if (price < lo) return { cls: 'bad', txt: '⚠ 低于成本区间下限, 大概率亏钱!' };
  if (price < hi) return { cls: 'warn', txt: '⚠ 贴近成本区间, 利润空间很小' };
  if (price > opp.marketHi) return { cls: 'warn', txt: '⚠ 高于历史中标区间上限, 中标率偏低' };
  if (price < opp.marketLo) return { cls: 'warn', txt: '偏低报价: 中标率高, 利润薄' };
  return { cls: 'ok', txt: '✓ 落在历史中标区间内, 利润与中标率较均衡' };
}
