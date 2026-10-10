/* ================= UI 渲染与交互 ================= */
const $ = id => document.getElementById(id);
const WD = ['日', '一', '二', '三', '四', '五', '六'];

/* ---------- 时间控制条 ---------- */
const UITime = {
  render() {
    const m = Math.min(Math.max(GameState.minutes, 0), 18 * 60);
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(Math.floor(m % 60)).padStart(2, '0');
    $('game-clock').textContent = hh + ':' + mm;
    const d = dateOf(GameState.day);
    $('game-date').textContent = (d.getMonth() + 1) + '月' + d.getDate() + '日 · 星期' + WD[d.getDay()] + ' · ' + (GameState.sandbox ? '第 ' + GameState.day + ' 天 · 沙盒' : '第 ' + GameState.day + ' / ' + INITIAL.durationDays + ' 天');
    $('day-fill').style.width = Math.min(100, Math.round(GameState.day / INITIAL.durationDays * 100)) + '%';
    const w = GameState.weather;
    $('weather-temp').textContent = w ? w.temp + '°' : '—';
    $('weather-desc').textContent = w ? w.desc + ' · 武汉' : '—';
    const lb = $('speed-label');
    lb.textContent = GameState.speed === 0 ? '⏸' : GameState.speed + 'x';
    lb.style.background = GameState.speed === 0 ? 'var(--bad)' : '';
  },
};

/* ---------- 轻提示 ---------- */
const UIToast = {
  _t: 0,
  show(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(this._t);
    this._t = setTimeout(() => el.classList.remove('show'), 4500);
  },
};

/* ---------- 视图渲染 ---------- */
const UI = {
  renderAll() {
    UI.renderCockpit();
    UI.renderInbox();
    UI.renderOrders();
    UI.renderFinance();
    UI.renderCapacity();
    UI.renderReports();
    UI.renderPosts();
    UI.renderHandbook();
    UI.renderReview();
    UI.renderBadge();
  },

  renderBadge() {
    const n = GameState.decisions.filter(x => !x.handled && !x.resolved).length;
    const b = $('inbox-badge');
    b.textContent = n;
    b.style.display = n > 0 ? '' : 'none';
  },

  /* 驾驶舱 */
  renderCockpit() {
    const recv = GameState.receivable.reduce((s, r) => s + r.amount, 0);
    const blockStart = Math.floor((GameState.day - 1) / 30) * 30 + 1;
    let profit = 0;
    GameState.cashflow.forEach(f => {
      if (f.day >= blockStart && f.day <= GameState.day) profit += f.cls === 'in' ? f.amount : -f.amount;
    });
    $('assets').innerHTML = [
      { k: '企业现金', v: fmtMoney(GameState.cash), cls: GameState.cash < 800 ? 'neg' : '' },
      { k: '应收合计', v: fmtMoney(recv) },
      { k: '净资产', v: fmtMoney(GameState.cash + recv + GameState.fixedAssets) },
      { k: '本月损益', v: (profit >= 0 ? '+' : '') + fmtMoney(profit), cls: profit > 0 ? 'pos' : profit < 0 ? 'neg' : '' },
    ].map(a => '<div class="asset"><div class="k">' + a.k + '</div><div class="v ' + (a.cls || '') + '">' + a.v + '</div></div>').join('');

    $('orders').innerHTML = UI.cockpitPipeline();

    $('cockpit-risks').innerHTML = GameState.risks.length
      ? GameState.risks.map(r =>
          '<div class="proj"><span class="chip ' + r.cls + '"><span class="d"></span></span><span class="name" style="flex:1;white-space:normal">' + r.txt + '</span></div>').join('')
      : '<div class="empty">当前无重大风险信号。</div>';

    $('cockpit-fin').innerHTML = GameState.cashflow.length
      ? UI.cashflowRows(GameState.cashflow.slice(-8).reverse())
      : '<div class="empty">暂无现金流记录。</div>';

    $('factories').innerHTML = GameState.factories.map(f => {
      const pct = Math.round(f.load * 100);
      return '<div class="factory">' +
        '<div class="head"><span class="fname">' + f.name + '</span><span class="task">' + f.tasks.join(' / ') + '</span><span class="owner">' + f.owner + '</span></div>' +
        '<div class="status"><span class="chip ' + f.status + '"><span class="d"></span>' + f.statusText + '</span>' +
        '<span class="bar"><span class="bar-fill' + (pct > 85 ? ' hot' : '') + '" style="width:' + pct + '%"></span></span><span class="bar-num">产能 ' + pct + '%</span></div>' +
      '</div>';
    }).join('');
  },

  /* 驾驶舱订单管线卡: 商机(未开标)列最上方 + 在手订单 */
  cockpitPipeline() {
    const opps = GameState.decisions.filter(x => x.kind === 'opp' && !x.resolved)
      .sort((a, b) => a.deadlineDay - b.deadlineDay);
    let html = '';
    if (opps.length) {
      html += '<div class="proj-divider">商机 · 未开标(' + opps.length + ')</div>';
      html += opps.map(x => {
        const left = Math.max(0, x.deadlineDay - GameState.day);
        const chip = x.submitted
          ? '<span class="chip ok"><span class="d"></span>已报价 ' + fmt(x.price) + ' 万</span>'
          : '<span class="chip warn"><span class="d"></span>待报价</span>';
        return '<div class="proj clickable" onclick="oppBoardClick(\'' + x.id + '\')">' +
          '<span class="tag">商</span>' +
          '<span class="name">' + x.product + ' ' + fmt(x.amount) + ' 万</span>' +
          chip +
          '<span class="next">' + (x.submitted ? '截止第 ' + x.deadlineDay + ' 天开标' : '剩 ' + left + ' 天 · 点击报价') + '</span>' +
        '</div>';
      }).join('');
      html += '<div class="proj-divider">在手订单(' + GameState.orders.filter(o => o.status !== 'cancelled').length + ')</div>';
    }
    html += GameState.orders.map(o => {
      const li = GameState.orders.indexOf(o);
      return '<div class="proj">' +
        '<span class="tag">' + String.fromCharCode(65 + li) + '</span>' +
        '<span class="name">' + o.name + '</span>' +
        '<span class="owner">' + o.owner + '</span>' +
        '<span class="chip ' + o.cls + '"><span class="d"></span>' + o.statusText + '</span>' +
        '<span class="next">' + o.note + '</span>' +
      '</div>';
    }).join('');
    return html;
  },

  /* 收件箱: 今日待办 + 决策流 */
  renderInbox() {
    $('inbox-todos').innerHTML = GameState.todos.map(t =>
      '<div class="todo"><span class="dot"></span><span class="name">' + t.name + '</span><span class="time">' + t.time + '</span></div>').join('');
    const list = GameState.decisions.slice().sort((a, b) => {
      const ad = (a.handled || a.resolved) ? 1 : 0, bd = (b.handled || b.resolved) ? 1 : 0;
      return ad - bd || a.arriveDay - b.arriveDay;
    });
    $('decisions').innerHTML = list.length
      ? list.map(UI.decisionCard).join('')
      : '<div class="empty">收件箱空空如也。<br>商机与决策到达时会自动暂停并出现在这里。</div>';
  },

  decisionCard(x) {
    const done = x.kind === 'opp' ? x.resolved : x.handled;
    let body = '<div class="decision">' +
      '<div class="dec-head"><span class="chip info"><span class="d"></span>' + x.type + '</span><span class="t">' + x.title + '</span></div>' +
      '<div class="dec-meta">' + x.who + ' · 第 ' + x.arriveDay + ' 天 ' + x.when + (x.kind === 'opp' ? ' · 截止第 ' + x.deadlineDay + ' 天(剩 ' + Math.max(0, x.deadlineDay - GameState.day) + ' 天)' : '') + '</div>' +
      '<div class="ai-box"><span class="ai-tag">AI 建议</span>' + x.ai + '</div>';
    if (x.kind === 'opp') {
      if (x.resolved) {
        body += '<div class="dec-done">' + x.resultText + '</div>';
      } else if (x.submitted) {
        const band = winProbBand(x, x.price);
        body += '<div class="opp-locked">已报价 ' + fmt(x.price) + ' 万 · 预估中标率 ' + Math.round(band[0] * 100) + '%~' + Math.round(band[1] * 100) + '% · 报价仅一次, 截止第 ' + x.deadlineDay + ' 天开标</div>';
      } else {
        body += '<div class="dec-actions"><button class="btn ok-btn" onclick="openQuoteModal(\'' + x.id + '\')">去报价</button></div>';
      }
    } else {
      if (x.handled) {
        body += '<div class="dec-done">' + x.resultText + '</div>';
      } else {
        body += '<div class="dec-actions">' + x.options.map(o =>
          '<button class="btn ' + (o.value === x.defaultChoice ? 'ok-btn' : 'no-btn') + '" onclick="decide(\'' + x.id + '\',\'' + o.value + '\')">' + o.label + '</button>').join('') + '</div>';
      }
    }
    return body + '</div>';
  },

  /* 订单管线 */
  renderOrders() {
    $('order-pipe').innerHTML = GameState.orders.map(o =>
      '<div class="pipe-item">' +
        '<div class="pipe-head"><span class="t">' + o.name + '</span><span class="chip ' + o.cls + '"><span class="d"></span>' + o.statusText + '</span></div>' +
        '<div class="pipe-meta">客户 ' + o.client + ' · 合同额 ' + fmtMoney(o.amount) + ' · 负责人 ' + o.owner + ' · 交期第 ' + o.deadlineDay + ' 天</div>' +
        '<div class="pipe-note">' + o.note + '</div>' +
      '</div>').join('');
  },

  /* 财务 */
  renderFinance() {
    $('fin-recv').innerHTML = GameState.receivable.length
      ? GameState.receivable.map(r =>
          '<div class="proj">' +
            '<span class="name">' + r.client + '</span>' +
            '<span class="next">' + fmtMoney(r.amount) + ' · 账龄 ' + r.age + '/' + r.dueDays + ' 天</span>' +
            '<span class="owner" style="flex:0 0 auto">' + r.note + '</span>' +
          '</div>').join('')
      : '<div class="empty">暂无应收。</div>';
    $('fin-flow').innerHTML = GameState.cashflow.length
      ? UI.cashflowRows(GameState.cashflow.slice(-40).reverse())
      : '<div class="empty">暂无现金流记录。</div>';
    $('fin-fixed').innerHTML = '月固定支出: 工资 ' + fmtMoney(GameState.monthlyWages) + '(每 30 天) + 管理水电 ' + fmtMoney(GameState.monthlyOverhead) + '(按日摊销约 3 万) · 员工 ' + GameState.employees + ' 人 · 客户关系 <b>' + GameState.clientRep + '/100</b>';
  },

  cashflowRows(list) {
    return list.map(f =>
      '<div class="fin"><span class="amt ' + f.cls + '">' + (f.cls === 'in' ? '+' : '-') + fmt(f.amount) + ' 万</span><span class="reason">' + f.reason + '</span><span class="meta">第' + f.day + '天 · ' + f.meta + '</span></div>').join('');
  },

  /* 产能与物料 */
  renderCapacity() {
    $('cap-factories').innerHTML = GameState.factories.map(f => {
      const pct = Math.round(f.load * 100);
      return '<div class="factory">' +
        '<div class="head"><span class="fname">' + f.name + '</span><span class="task">' + f.tasks.join(' / ') + '</span><span class="owner">' + f.owner + '</span></div>' +
        '<div class="status"><span class="chip ' + f.status + '"><span class="d"></span>' + f.statusText + '</span>' +
        '<span class="bar"><span class="bar-fill' + (pct > 85 ? ' hot' : '') + '" style="width:' + pct + '%"></span></span><span class="bar-num">月产能 ' + fmt(f.capacity) + ' 万 · 利用率 ' + pct + '%</span></div>' +
      '</div>';
    }).join('');
    $('cap-materials').innerHTML = GameState.materials.map(m =>
      '<div class="proj">' +
        '<span class="name">' + m.name + '</span>' +
        '<span class="chip ' + m.cls + '"><span class="d"></span>' + m.stock + '</span>' +
        '<span class="next">' + m.eta + '</span>' +
      '</div>').join('');
  },

  /* 日报 */
  renderReports() {
    $('report-list').innerHTML = GameState.reports.length
      ? GameState.reports.map(r =>
          '<div class="report-item">' +
            '<div class="report-head"><span class="t">' + r.date + ' 经营日报</span>' +
            '<span class="report-io"><span class="in">收 +' + fmt(r.income) + ' 万</span><span class="out">支 -' + fmt(r.expense) + ' 万</span></span></div>' +
            '<div class="report-ai">' + r.ai + '</div>' +
          '</div>').join('')
      : '<div class="empty">日报每天 18:00 自动生成。</div>';
  },

  /* 公司动态 */
  renderPosts() {
    $('posts').innerHTML = GameState.posts.map(p =>
      '<div class="post">' +
        '<div class="head"><span class="who">' + p.who + '</span><span class="tag2">' + p.tag + '</span><span>' + p.time + '</span></div>' +
        '<div class="body">' + p.body + '</div>' +
      '</div>').join('');
  },

  /* 经营手册 */
  renderHandbook() {
    $('handbook').innerHTML = HANDBOOK.map(s =>
      '<div class="hb-section"><h4>' + s.title + '</h4><p>' + s.body + '</p></div>').join('');
  },

  /* 经营复盘 */
  renderReview() {
    if (GameState.finished || GameState.reviewSnapshot) {
      Review.render($('review-box'));
    } else {
      $('review-box').innerHTML = '<div class="review-lock"><div class="icon">🔒</div>经营复盘将在第 30 天结束后解锁。<br>KPI 评分 + 经营复盘报告(现金曲线 / 雷达图 / 报价复盘 / 决策时间线 / 知识点点评)</div>';
    }
  },

  /* 商机弹窗: 驾驶舱居中大弹窗, 出现时时间暂停, 决策后恢复流动 */
  showOppModal(id) {
    oppPausedId = id;
    if (!GameState.finished) Engine.setSpeed(0);
    UI.renderOppModal(id);
  },

  renderOppModal(id) {
    const x = GameState.decisions.find(d => d.id === id);
    if (!x) return;
    $('opp-modal-body').innerHTML =
      '<div class="opp-name">' + x.product + (x.qty ? ' · ' + x.qty : '') + '</div>' +
      '<div class="opp-amount">合同额约 ' + fmt(x.amount) + ' 万</div>' +
      '<div class="opp-meta"><span>客户 ' + x.client + '</span><span>交期 ' + x.deliveryDays + ' 天</span><span class="bad">截止第 ' + x.deadlineDay + ' 天</span></div>' +
      '<div class="opp-ai"><span class="ai-tag">AI 建议</span>' + x.ai + '</div>';
    $('opp-modal').classList.add('open');
  },

  /* 导航切换 */
  showView(v) {
    document.querySelectorAll('#nav a').forEach(x => x.classList.toggle('active', x.dataset.view === v));
    document.querySelectorAll('.view').forEach(x => x.classList.remove('active'));
    $('view-' + v).classList.add('active');
  },

  init() {
    document.querySelectorAll('#nav a').forEach(a => {
      a.onclick = e => { e.preventDefault(); UI.showView(a.dataset.view); };
    });
  },
};

/* ---------- 决策操作 ---------- */
function oppBoardClick(id) {
  const x = GameState.decisions.find(d => d.id === id);
  if (!x || x.resolved) return;
  if (x.submitted) {
    UIToast.show('该商机已报价 ' + fmt(x.price) + ' 万, 截止第 ' + x.deadlineDay + ' 天开标');
    return;
  }
  openQuoteModal(id);
}

function decide(id, choice) {
  const x = GameState.decisions.find(d => d.id === id);
  if (!x) return;
  Engine.applyDecision(x, choice, GameState.day);
  UI.renderAll();
  UIToast.show(x.resultText);
  saveGame();
}

/* ---------- 商机弹窗操作 ---------- */
let oppPausedId = null;   /* 当前因商机弹窗暂停的商机 id */

function oppGoQuote() {
  const id = oppPausedId;
  $('opp-modal').classList.remove('open');
  if (id) openQuoteModal(id);
}
function oppLater() {
  $('opp-modal').classList.remove('open');
  oppPausedId = null;
  if (!GameState.finished && GameState.speed === 0) Engine.setSpeed(2);
}

/* ---------- 报价弹窗 ---------- */
let quoteOppId = null;

function openQuoteModal(id) {
  const x = GameState.decisions.find(d => d.id === id);
  if (!x) return;
  quoteOppId = id;
  $('quote-info').innerHTML =
    '<div class="q-row"><span class="q-k">产品</span><span>' + x.product + (x.qty ? ' · ' + x.qty : '') + '</span></div>' +
    '<div class="q-row"><span class="q-k">客户</span><span>' + x.client + ' · 账期 ' + x.terms.balanceDays + ' 天</span></div>' +
    '<div class="q-row"><span class="q-k">成本估算</span><span>' + (x.costLo != null ? fmt(x.costLo) + ' ~ ' + fmt(x.costHi) + ' 万(区间估算, 精确值未知)' : fmt(x.cost) + ' 万') + '</span></div>' +
    '<div class="q-row"><span class="q-k">历史中标区间</span><span>' + fmt(x.marketLo) + ' ~ ' + fmt(x.marketHi) + ' 万</span></div>' +
    '<div class="q-row"><span class="q-k">交期要求</span><span>' + x.deliveryDays + ' 天 · 截止第 ' + x.deadlineDay + ' 天</span></div>';
  $('quote-ai').textContent = x.ai;
  $('quote-price').value = x.price != null ? x.price : x.amount;
  updateQuoteFeedback();
  $('quote-modal').classList.add('open');
  $('quote-price').focus();
}

function updateQuoteFeedback() {
  const x = GameState.decisions.find(d => d.id === quoteOppId);
  const el = $('quote-feedback');
  if (!x) { el.innerHTML = ''; return; }
  const v = Number($('quote-price').value);
  if (!(v > 0)) { el.innerHTML = ''; return; }
  const band = winProbBand(x, v);
  const hint = quoteHint(x, v);
  let marginHtml;
  if (x.costLo != null) {
    const mHi = Math.round(v - x.costLo);   /* 乐观毛利 */
    const mLo = Math.round(v - x.costHi);   /* 保守毛利 */
    marginHtml = '<div>预计毛利 <b>' + fmt(mLo) + ' ~ ' + fmt(mHi) + ' 万</b>(成本区间估算)</div>';
  } else {
    const m = marginOf(x, v);
    marginHtml = '<div>预计毛利 <b>' + fmt(m.amount) + ' 万(' + (m.rate >= 0 ? '+' : '') + m.rate + '%)</b></div>';
  }
  el.innerHTML =
    '<div>预估中标率 <b>' + Math.round(band[0] * 100) + '%~' + Math.round(band[1] * 100) + '%</b></div>' +
    marginHtml +
    '<div class="q-hint-' + hint.cls + '">' + hint.txt + '</div>';
}

function submitQuote() {
  const x = GameState.decisions.find(d => d.id === quoteOppId);
  if (!x) return;
  const v = Number($('quote-price').value);
  if (!(v > 0)) { $('quote-price').focus(); return; }
  x.price = Math.round(v);
  x.submitted = true;
  $('quote-modal').classList.remove('open');
  quoteOppId = null;
  oppPausedId = null;
  UI.renderAll();
  UIToast.show('报价已提交: ' + fmt(x.price) + ' 万(截止第 ' + x.deadlineDay + ' 天开标, 不可修改)');
  saveGame();
  /* 决策完成 → 时间恢复流动 */
  if (!GameState.finished && GameState.speed === 0) Engine.setSpeed(2);
}

function closeQuoteModal() {
  $('quote-modal').classList.remove('open');
  quoteOppId = null;
  /* 取消报价(未决策): 回到商机弹窗, 时间保持暂停 */
  if (oppPausedId) UI.renderOppModal(oppPausedId);
}
$('quote-price').addEventListener('input', updateQuoteFeedback);
$('quote-price').addEventListener('keydown', e => { if (e.key === 'Enter') submitQuote(); });
$('quote-modal').addEventListener('keydown', e => { if (e.key === 'Escape') closeQuoteModal(); });

/* ---------- 开始界面 ---------- */
function startNew(diff) {
  if (hasSave() && !confirm('已有存档, 开始新游戏会覆盖存档, 确定?')) return;
  newGame(diff);
  Engine.newWeather();
  Engine.recomputeRisks();
  Engine.recomputeFactories();
  enterGame();
}
function startNewConfirm() {
  if (!confirm('返回开始界面? (当前进度已存档)')) return;
  $('start-view').style.display = 'flex';
  $('app-view').style.display = 'none';
}
function continueGame() {
  if (!loadGame()) { alert('没有找到存档, 或存档版本过旧(请开始新游戏)。'); return; }
  if (!GameState.weather) Engine.newWeather();
  Engine.recomputeRisks();
  Engine.recomputeFactories();
  enterGame();
}
function enterGame() {
  $('start-view').style.display = 'none';
  $('app-view').style.display = 'block';
  UI.renderAll();
  UITime.render();
  const n = GameState.decisions.filter(x => !x.handled && !x.resolved).length;
  if (n > 0) UIToast.show('收件箱有 ' + n + ' 项待决策, 时间正在流动(2x), 请及时处理');
}
function continueSandbox() {
  GameState.finished = false;
  GameState.sandbox = true;
  Engine.setSpeed(2);
  UIToast.show('继续沙盒经营: 时间恢复流动, 结算与复盘保留在「经营复盘」页。');
  UI.showView('cockpit');
  saveGame();
}
function backToStart() {
  if (!confirm('返回开始界面? (进度已自动存档)')) return;
  saveGame();
  $('start-view').style.display = 'flex';
  $('app-view').style.display = 'none';
}

/* ---------- 新增待办 ---------- */
function openTodoModal() {
  $('todo-modal').classList.add('open');
  $('todo-name').focus();
}
function closeTodoModal() {
  $('todo-modal').classList.remove('open');
  $('todo-name').value = '';
  $('todo-time').value = '';
}
function confirmTodo() {
  const name = $('todo-name').value.trim();
  if (!name) { $('todo-name').focus(); return; }
  GameState.todos.push({ name: name, time: $('todo-time').value.trim() || '未定' });
  UI.renderInbox();
  closeTodoModal();
  saveGame();
}
['todo-name', 'todo-time'].forEach(id =>
  $(id).addEventListener('keydown', e => { if (e.key === 'Enter') confirmTodo(); }));

/* ---------- 启动 ---------- */
UI.init();
$('btn-continue').disabled = !hasSave();
Engine.init();
