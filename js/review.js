/* ================= 季度结算: KPI 评分与经营复盘报告(M4) ================= */
/* 图表规范: 2px 圆角线 / ≥8px 圆点带 2px 表面色环 / 1px 发丝网格 / 文字用墨色 token
   散点图三色(中标#1baf7a/未中标#eb6834/放弃#2a78d6)已通过 all-pairs 色觉校验, 语义由位置+形状+图例图标承载 */

const WEIGHTS = [
  { key: 'profit', label: '净利润', weight: 30 },
  { key: 'cash', label: '现金流健康', weight: 20 },
  { key: 'ontime', label: '交付准期率', weight: 20 },
  { key: 'winrate', label: '中标率与报价质量', weight: 15 },
  { key: 'client', label: '客户关系', weight: 10 },
  { key: 'risk', label: '风险处置', weight: 5 },
];

const GRADE_CLS = { S: 'grade-S', A: 'grade-A', B: 'grade-B', C: 'grade-C', F: 'grade-F' };

const ADVICE = {
  profit: '接单注意毛利: 报价越贴近市场价区间上限, 利润越高但中标率越低; 平衡点通常在市场价 ±3% 以内。',
  cash: '现金流偏弱: 合同条款选高预付+短账期可改善回款节奏; 同时避免过多订单压在产线占压资金。',
  ontime: '准期率是命脉: 排产前对照工厂产能余量, 排队超 5 天果断插单或放弃接单; 缺料优先加急采购。',
  winrate: '报价质量: 低于市场价 3% 中标率明显上升, 高于 5% 快速衰减; 先看历史中标区间再落笔。',
  client: '客户关系: 投诉优先赔偿, 条款谈判避免拒签, 放行决策谨慎承担质量风险。',
  risk: '风险处置: 突发事件多参考 AI 建议; 逾期与缺料信号出现当天就处理, 拖延会让小问题发酵。',
};

const Review = {
  /* ---------- 评分 ---------- */
  compute() {
    const k = GameState.kpi;
    const dims = {};
    const startBase = k.startCash + k.startRecv;
    const endBase = GameState.cash + GameState.receivable.reduce((s, r) => s + r.amount, 0);
    const profit = endBase - startBase;
    dims.profit = {
      score: clamp(Math.round(profit / 1200 * 100), 0, 100),
      note: '期初现金+应收 ' + fmt(startBase) + ' 万 → 期末 ' + fmt(endBase) + ' 万, 净增 ' + (profit >= 0 ? '+' : '') + fmt(profit) + ' 万(满分线 1,200 万)',
    };
    dims.cash = {
      score: GameState.bankrupt ? 0 : clamp(Math.round(GameState.cash / 7000 * 100), 0, 100),
      note: GameState.bankrupt ? '资金链断裂, 破产' : '期末现金 ' + fmt(GameState.cash) + ' 万(满分线 7,000 万)',
    };
    const delivered = k.onTime + k.late;
    dims.ontime = {
      score: delivered ? Math.round(k.onTime / delivered * 100) : 60,
      note: '准期 ' + k.onTime + ' 单 / 逾期 ' + k.late + ' 单',
    };
    let winScore = 50, winNote = '本季无报价记录';
    if (k.quotes.length) {
      const winRate = k.wins / k.quotes.length;
      const won = k.quotes.filter(q => q.result === 'won');
      const avgMargin = won.length ? won.reduce((s, q) => s + (q.price - q.cost) / q.price, 0) / won.length : 0;
      winScore = Math.round(clamp(winRate / 0.4 * 100, 0, 100) * 0.5 + clamp(avgMargin / 0.25 * 100, 0, 100) * 0.5);
      winNote = '中标率 ' + Math.round(winRate * 100) + '%(' + k.wins + '/' + k.quotes.length + ', 满分线 40%), 中标单平均毛利率 ' + Math.round(avgMargin * 100) + '%(满分线 25%)';
    }
    dims.winrate = { score: winScore, note: winNote };
    dims.client = { score: clamp(GameState.clientRep, 0, 100), note: '客户关系 ' + GameState.clientRep + '/100' };
    const riskDecs = k.decisions.filter(x => x.type === '突发事件' || x.type === '质检放行' || x.type === '缺料采购');
    dims.risk = {
      score: riskDecs.length ? Math.round(riskDecs.filter(x => x.choice === x.recommended).length / riskDecs.length * 100) : 70,
      note: riskDecs.length ? '关键处置 ' + riskDecs.filter(x => x.choice === x.recommended).length + '/' + riskDecs.length + ' 次采纳 AI 建议' : '本季无关键处置',
    };
    const total = Math.round(WEIGHTS.reduce((s, w) => s + dims[w.key].score * w.weight, 0) / 100);
    const grade = GameState.bankrupt ? 'F' : total >= 90 ? 'S' : total >= 75 ? 'A' : total >= 60 ? 'B' : 'C';
    return { total, grade, dims, profit, startBase, endBase, k, difficulty: GameState.difficulty, bankrupt: GameState.bankrupt, day: GameState.day };
  },

  snapshot() { GameState.reviewSnapshot = Review.compute(); },

  /* ---------- 报告渲染 ---------- */
  render(container) {
    const r = GameState.finished ? Review.compute() : GameState.reviewSnapshot;
    if (!r) return;
    const html =
      '<div class="rv">' +
        Review.headHtml(r) +
        '<div class="rv-grid">' +
          '<div class="rv-chart"><h5>现金曲线(万元)</h5>' + Review.cashChart(r.k.cashHistory) + '<div class="rv-tip"></div></div>' +
          '<div class="rv-chart"><h5>KPI 六维评分</h5>' + Review.radarChart(r) + '<div class="rv-tip"></div></div>' +
          '<div class="rv-chart"><h5>报价复盘</h5>' + Review.scatterLegend() + Review.scatterChart(r.k.quotes) + '<div class="rv-tip"></div></div>' +
          '<div class="rv-chart"><h5>维度得分(权重)</h5>' + Review.barsHtml(r) + '</div>' +
        '</div>' +
        '<div class="rv-section"><h5>决策时间线</h5>' + Review.timelineHtml(r) + '</div>' +
        '<div class="rv-section"><h5>失误与知识点</h5>' + Review.lessonsHtml(r) + '</div>' +
        '<div class="rv-section"><h5>标杆对比与重玩建议</h5>' + Review.benchHtml(r) + '</div>' +
      '</div>';
    container.innerHTML = html;
    Review.bindHover(container, r);
  },

  headHtml(r) {
    const action = r.bankrupt
      ? '<button class="btn ok-btn" onclick="startNewConfirm()">重新开始</button>'
      : '<button class="btn ok-btn" onclick="continueSandbox()">继续沙盒经营</button>';
    return '<div class="rv-head">' +
      '<div class="rv-grade ' + (GRADE_CLS[r.grade] || 'grade-B') + '">' + r.grade + '</div>' +
      '<div class="rv-head-info">' +
        '<div class="rv-total">综合评分 ' + r.total + ' / 100</div>' +
        '<div class="rv-sub">评级 ' + r.grade + ' · ' + r.difficulty + '难度 · 第 ' + r.day + ' 天 · ' + (r.bankrupt ? '破产出局' : '30 天经营结算') + '</div>' +
      '</div>' +
      '<div class="rv-actions">' + action + '</div>' +
    '</div>';
  },

  /* ---------- 图 1: 现金曲线 ---------- */
  cashChart(hist) {
    if (!hist || hist.length < 2) return '<div class="rv-nodata">数据不足</div>';
    const W = 600, H = 210, L = 48, R = 22, T = 16, B = 28;
    const maxDay = Math.max(INITIAL.durationDays, hist[hist.length - 1].day);
    const vals = hist.map(h => h.cash);
    let yMin = Math.min(0, ...vals), yMax = Math.max(...vals);
    if (yMax - yMin < 200) { const mid = (yMax + yMin) / 2; yMin = mid - 100; yMax = mid + 100; }
    yMin = Math.floor(yMin / 500) * 500;
    yMax = Math.ceil(yMax / 500) * 500;
    const X = d => L + (W - L - R) * d / maxDay;
    const Y = v => T + (H - T - B) * (1 - (v - yMin) / (yMax - yMin));
    let g = '';
    for (let i = 0; i <= 4; i++) {
      const v = yMin + (yMax - yMin) * i / 4, y = Y(v);
      g += '<line x1="' + L + '" y1="' + y + '" x2="' + (W - R) + '" y2="' + y + '" stroke="#e7ebf3" stroke-width="1"/>';
      g += '<text x="' + (L - 8) + '" y="' + (y + 4) + '" text-anchor="end" font-size="10.5" fill="#7a869c" font-variant-numeric="tabular-nums">' + fmt(v) + '</text>';
    }
    [0, 30, 60, 90].forEach(d => {
      if (d > maxDay) return;
      g += '<text x="' + X(d) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10.5" fill="#7a869c">第 ' + d + ' 天</text>';
    });
    const pts = hist.map(h => [X(h.day), Y(h.cash)]);
    const pathD = 'M' + pts.map(p => p[0] + ' ' + p[1]).join(' L');
    g += '<path d="' + pathD + ' L' + pts[pts.length - 1][0] + ' ' + Y(yMin) + ' L' + pts[0][0] + ' ' + Y(yMin) + ' Z" fill="#2e54a1" opacity="0.08"/>';
    g += '<path d="' + pathD + '" fill="none" stroke="#2e54a1" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
    const lp = pts[pts.length - 1];
    g += '<circle cx="' + lp[0] + '" cy="' + lp[1] + '" r="4.5" fill="#2e54a1" stroke="#ffffff" stroke-width="2"/>';
    g += '<text x="' + Math.min(lp[0] + 8, W - 4) + '" y="' + (lp[1] + 4) + '" font-size="11.5" font-weight="700" fill="#1a2333">期末 ' + fmt(hist[hist.length - 1].cash) + ' 万</text>';
    g += '<line class="rv-cross" y1="' + T + '" y2="' + (H - B) + '" stroke="#1a2333" stroke-width="1" opacity="0.3" style="display:none"/>';
    g += '<circle class="rv-crossdot" r="4.5" fill="#2e54a1" stroke="#ffffff" stroke-width="2" style="display:none"/>';
    g += '<rect class="rv-hover" x="' + L + '" y="' + T + '" width="' + (W - L - R) + '" height="' + (H - T - B) + '" fill="transparent"/>';
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" data-chart="cash" data-L="' + L + '" data-W="' + W + '" data-R="' + R + '" data-T="' + T + '" data-H="' + H + '" data-B="' + B + '" data-maxday="' + maxDay + '" data-ymin="' + yMin + '" data-ymax="' + yMax + '">' + g + '</svg>';
  },

  /* ---------- 图 2: KPI 雷达 ---------- */
  radarChart(r) {
    const scores = WEIGHTS.map(w => ({ label: w.label, score: r.dims[w.key].score }));
    const W = 320, H = 300, C = 160, CY = 150, R = 96, n = scores.length;
    const ang = i => -Math.PI / 2 + i * 2 * Math.PI / n;
    const pt = (i, rad) => [Math.round((C + rad * Math.cos(ang(i))) * 10) / 10, Math.round((CY + rad * Math.sin(ang(i))) * 10) / 10];
    let g = '';
    [25, 50, 75, 100].forEach(level => {
      g += '<polygon points="' + scores.map((_, i) => pt(i, R * level / 100).join(',')).join(' ') + '" fill="none" stroke="#e7ebf3" stroke-width="1"/>';
    });
    scores.forEach((_, i) => {
      const p = pt(i, R);
      g += '<line x1="' + C + '" y1="' + CY + '" x2="' + p[0] + '" y2="' + p[1] + '" stroke="#e7ebf3" stroke-width="1"/>';
    });
    scores.forEach((s, i) => {
      const p = pt(i, R + 22);
      const anchor = Math.abs(p[0] - C) < 6 ? 'middle' : p[0] < C ? 'end' : 'start';
      g += '<text x="' + p[0] + '" y="' + (p[1] + 4) + '" text-anchor="' + anchor + '" font-size="11" fill="#1a2333">' + s.label + '</text>';
    });
    g += '<polygon points="' + scores.map((s, i) => pt(i, R * s.score / 100).join(',')).join(' ') + '" fill="#2e54a1" opacity="0.12" stroke="#2e54a1" stroke-width="2" stroke-linejoin="round"/>';
    scores.forEach((s, i) => {
      const p = pt(i, R * s.score / 100);
      g += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="4" fill="#2e54a1" stroke="#ffffff" stroke-width="2"/>';
      const lp = pt(i, R * s.score / 100 + 12);
      g += '<text x="' + lp[0] + '" y="' + (lp[1] + 3.5) + '" text-anchor="middle" font-size="10" fill="#7a869c" font-variant-numeric="tabular-nums">' + s.score + '</text>';
    });
    return '<svg viewBox="0 0 ' + W + ' ' + H + '">' + g + '</svg>';
  },

  /* ---------- 图 3: 报价散点 ---------- */
  scatterLegend() {
    return '<div class="rv-legend">' +
      '<span><span class="rv-sw rv-sw-won"></span>● 中标 ✓</span>' +
      '<span><span class="rv-sw rv-sw-lost"></span>✕ 未中标</span>' +
      '<span><span class="rv-sw rv-sw-abd"></span>▲ 放弃</span>' +
      '<span class="rv-legend-note">竖线: 历史中标价区间 0.92~1.08</span>' +
    '</div>';
  },

  scatterChart(quotes) {
    if (!quotes.length) return '<div class="rv-nodata">本季无报价记录</div>';
    const W = 600, H = 250, L = 74, R = 18, T = 20, B = 30;
    const ratios = quotes.map(q => (q.amount > 0 ? q.price / q.amount : 1));
    const xMin = Math.min(0.9, ...ratios) - 0.02, xMax = Math.max(1.1, ...ratios) + 0.02;
    const X = rr => L + (W - L - R) * (rr - xMin) / (xMax - xMin);
    const yWon = 74, yLost = 176;
    const COLORS = { won: '#1baf7a', lost: '#eb6834', abandoned: '#2a78d6' };
    let g = '';
    [0.9, 1.0, 1.1].forEach(rr => {
      if (rr < xMin || rr > xMax) return;
      g += '<line x1="' + X(rr) + '" y1="' + T + '" x2="' + X(rr) + '" y2="' + (H - B) + '" stroke="#e7ebf3" stroke-width="1"/>';
      g += '<text x="' + X(rr) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10.5" fill="#7a869c" font-variant-numeric="tabular-nums">' + rr.toFixed(2) + '</text>';
    });
    [[0.92, '区间下限'], [1.08, '区间上限']].forEach(pair => {
      const rr = pair[0];
      if (rr < xMin || rr > xMax) return;
      g += '<line x1="' + X(rr) + '" y1="' + T + '" x2="' + X(rr) + '" y2="' + (H - B) + '" stroke="#d9e2f0" stroke-width="1"/>';
      g += '<text x="' + X(rr) + '" y="' + (T - 6) + '" text-anchor="middle" font-size="10" fill="#7a869c">' + pair[1] + '</text>';
    });
    g += '<text x="' + (L - 10) + '" y="' + (yWon + 4) + '" text-anchor="end" font-size="11.5" fill="#1a2333">✓ 中标</text>';
    g += '<text x="' + (L - 10) + '" y="' + (yLost + 4) + '" text-anchor="end" font-size="11.5" fill="#1a2333">✗ 未中标 / ▲ 放弃</text>';
    quotes.forEach((q, i) => {
      const rr = q.amount > 0 ? q.price / q.amount : 1;
      const jit = ((i % 7) - 3) * 0.006;
      const x = X(rr + jit), y = q.result === 'won' ? yWon : yLost;
      const c = COLORS[q.result] || COLORS.lost;
      let shape;
      if (q.result === 'won') {
        shape = '<circle cx="' + x + '" cy="' + y + '" r="6" fill="' + c + '" stroke="#ffffff" stroke-width="2"/>';
      } else if (q.result === 'abandoned') {
        shape = '<path d="M' + x + ' ' + (y - 6.5) + ' L' + (x + 6) + ' ' + (y + 5) + ' L' + (x - 6) + ' ' + (y + 5) + ' Z" fill="' + c + '" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/>';
      } else {
        shape = '<path d="M' + (x - 4.6) + ' ' + (y - 4.6) + ' L' + (x + 4.6) + ' ' + (y + 4.6) + ' M' + (x + 4.6) + ' ' + (y - 4.6) + ' L' + (x - 4.6) + ' ' + (y + 4.6) + '" stroke="' + c + '" stroke-width="3" stroke-linecap="round"/>';
      }
      g += '<g class="rv-mark" data-i="' + i + '">' + shape + '<circle cx="' + x + '" cy="' + y + '" r="12" fill="transparent"/></g>';
    });
    g += '<text x="' + ((L + W - R) / 2) + '" y="' + H + '" text-anchor="middle" font-size="10" fill="#7a869c">报价 ÷ 市场价</text>';
    return '<svg viewBox="0 0 ' + W + ' ' + (H + 6) + '" data-chart="scatter">' + g + '</svg>';
  },

  /* ---------- 维度得分条形 ---------- */
  barsHtml(r) {
    return '<div class="rv-bars">' + WEIGHTS.map(w => {
      const d = r.dims[w.key];
      return '<div class="rv-bar-row">' +
        '<span class="lbl">' + w.label + '</span><span class="w">' + w.weight + '%</span>' +
        '<span class="rv-track"><span class="rv-fill" style="width:' + d.score + '%"></span></span>' +
        '<span class="rv-val">' + d.score + '</span>' +
      '</div>' +
      '<div class="rv-note">' + d.note + '</div>';
    }).join('') + '</div>';
  },

  /* ---------- 决策时间线 ---------- */
  timelineHtml(r) {
    const items = r.k.decisions.slice(0, 80);
    if (!items.length) return '<div class="rv-nodata">本季无决策记录</div>';
    return '<div class="rv-tl">' + items.map(x =>
      '<div class="li"><span class="d">第 ' + x.day + ' 天</span>' +
      '<div class="t"><b>[' + x.type + ']</b> ' + x.title +
      '<div class="r">' + x.result + '</div></div></div>').join('') + '</div>';
  },

  /* ---------- 失误与知识点 ---------- */
  lessonsHtml(r) {
    const list = Review.lessons(r);
    if (!list.length) return '<div class="rv-nodata">没有发现明显失误, 经营稳健。</div>';
    return list.map(l =>
      '<div class="rv-lesson"><span class="rv-lesson-tag">' + l.sec + '</span>' + l.txt + '</div>').join('');
  },

  lessons(r) {
    const list = [];
    r.k.quotes.forEach(q => {
      const ratio = q.amount > 0 ? q.price / q.amount : 1;
      if (q.result === 'lost' && ratio > 1.02) list.push({ txt: '报价高于市场价 2% 以上仍竞标, 未中标(第 ' + q.day + ' 天 ' + q.product + ')。', sec: '报价方法' });
      if (q.result === 'won' && q.price < q.cost) list.push({ txt: '低于成本的报价中标了, 这一单在亏钱(第 ' + q.day + ' 天 ' + q.product + ')。', sec: '报价方法' });
      if (q.result === 'abandoned') list.push({ txt: '商机过期未报价流失(第 ' + q.day + ' 天 ' + q.product + ')。', sec: '报价方法' });
    });
    GameState.orders.filter(o => o.deliveredDay != null && o.onTime === false).forEach(o => {
      list.push({ txt: o.name + ' 逾期 ' + (o.deliveredDay - o.deadlineDay) + ' 天交付, 违约金被扣、准期率受损。', sec: '合同条款' });
    });
    r.k.decisions.forEach(x => {
      if (x.type === '合同条款' && /流失/.test(x.result)) list.push({ txt: '合同条款被客户拒签, 订单流失(第 ' + x.day + ' 天)。', sec: '合同条款' });
      if (x.type === '突发事件' && x.choice === 'refuse') list.push({ txt: '拒绝客户赔偿诉求, 客户关系 -8, 直接影响季度 KPI(第 ' + x.day + ' 天)。', sec: 'KPI 指标' });
      if (x.type === '质检放行' && x.choice === 'release' && /投诉|赔偿/.test(x.result)) list.push({ txt: '放行时承担的质量风险, 最终兑现为投诉赔偿(第 ' + x.day + ' 天)。', sec: 'KPI 指标' });
    });
    if (GameState.bankrupt) list.push({ txt: '现金断流破产。接单节奏、账期管理与固定支出要放在一起算。', sec: 'KPI 指标' });
    if (GameState.clientRep < 60) list.push({ txt: '客户关系已恶化至 ' + GameState.clientRep + '/100: 拒签、投诉、拒赔会叠加伤害。', sec: 'KPI 指标' });
    return list.slice(0, 12);
  },

  /* ---------- 标杆对比与重玩建议 ---------- */
  benchHtml(r) {
    const k = r.k;
    const quoted = k.quotes.filter(q => q.price > 0);
    let bench = '你实际投标 ' + quoted.length + ' 次, 中标 ' + k.wins + ' 次';
    if (quoted.length) {
      const expected = quoted.reduce((s, q) => {
        const fake = { marketLo: q.amount * 0.92, marketHi: q.amount * 1.08, comp: 1, product: q.product };
        return s + winProb(fake, q.amount);
      }, 0);
      const exp = Math.round(expected);
      bench += '; 若全部按 AI 建议价(市场价)投标, 预估中标约 ' + exp + ' 次' +
        (k.wins < exp ? ' → 你的报价偏保守/偏高, 中标少于基准, 注意别把利润单放跑了。' :
         k.wins > exp ? ' → 你的报价比基准更有攻击性, 中标更多, 但务必核对毛利率。' :
         ' → 与基准持平。');
    }
    bench += '。';
    const sorted = WEIGHTS.slice().sort((a, b) => r.dims[a.key].score - r.dims[b.key].score);
    const advices = sorted.slice(0, 2).map(w => '<div class="rv-advice-li"><b>' + w.label + '(' + r.dims[w.key].score + ' 分)</b>: ' + ADVICE[w.key] + '</div>').join('');
    return '<div class="rv-bench">' + bench + '</div><div class="rv-advice">' + advices + '</div>';
  },

  /* ---------- 悬停提示 ---------- */
  bindHover(container, r) {
    const showTip = (chartEl, ev, text) => {
      const tip = chartEl.querySelector('.rv-tip');
      if (!tip) return;
      const rect = chartEl.getBoundingClientRect();
      let x = ev.clientX - rect.left + 14, y = ev.clientY - rect.top + 12;
      if (x > rect.width - 160) x = ev.clientX - rect.left - 160;
      if (y > rect.height - 60) y = ev.clientY - rect.top - 60;
      tip.style.left = x + 'px';
      tip.style.top = y + 'px';
      tip.textContent = text;
      tip.style.display = 'block';
    };
    const hideTip = chartEl => {
      const tip = chartEl.querySelector('.rv-tip');
      if (tip) tip.style.display = 'none';
    };
    /* 散点悬停 */
    container.querySelectorAll('svg[data-chart="scatter"] .rv-mark').forEach(m => {
      const q = r.k.quotes[Number(m.dataset.i)];
      if (!q) return;
      m.addEventListener('mousemove', ev => {
        const out = q.result === 'won' ? '✓ 中标' : q.result === 'lost' ? '✗ 未中标' : '▲ 放弃';
        showTip(m.closest('.rv-chart'), ev,
          q.product + ' · 第 ' + q.day + ' 天\n报价 ' + fmt(q.price) + ' 万(市场价 ' + fmt(q.amount) + ' 万)\n毛利 ' + fmt(q.price - q.cost) + ' 万 · ' + out);
      });
      m.addEventListener('mouseleave', () => hideTip(m.closest('.rv-chart')));
    });
    /* 现金曲线悬停 */
    container.querySelectorAll('svg[data-chart="cash"]').forEach(svg => {
      const hover = svg.querySelector('.rv-hover');
      if (!hover) return;
      const cross = svg.querySelector('.rv-cross');
      const dot = svg.querySelector('.rv-crossdot');
      const L = Number(svg.dataset.L), W = Number(svg.dataset.W), R = Number(svg.dataset.R);
      const T = Number(svg.dataset.T), H = Number(svg.dataset.H), B = Number(svg.dataset.B);
      const yMin = Number(svg.dataset.ymin), yMax = Number(svg.dataset.ymax);
      const maxDay = Number(svg.dataset.maxday);
      const hist = r.k.cashHistory;
      hover.addEventListener('mousemove', ev => {
        const rect = svg.getBoundingClientRect();
        const px = (ev.clientX - rect.left) / rect.width * 600;
        const day = Math.round((px - L) / (W - L - R) * maxDay);
        let best = hist[0];
        for (const h of hist) if (Math.abs(h.day - day) < Math.abs(best.day - day)) best = h;
        const y = T + (H - T - B) * (1 - (best.cash - yMin) / (yMax - yMin));
        cross.setAttribute('x1', px); cross.setAttribute('x2', px);
        cross.style.display = '';
        dot.setAttribute('cx', px); dot.setAttribute('cy', y);
        dot.style.display = '';
        showTip(hover.closest('.rv-chart'), ev, '第 ' + best.day + ' 天\n现金 ' + fmt(best.cash) + ' 万');
      });
      hover.addEventListener('mouseleave', () => {
        cross.style.display = 'none';
        dot.style.display = 'none';
        hideTip(hover.closest('.rv-chart'));
      });
    });
  },
};
