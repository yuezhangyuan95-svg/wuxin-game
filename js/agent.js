/* ================= Agent 助手(自建问答 API + 规则降级) ================= */
/* 接口约定见 docs/DESIGN.md §10:
   POST /api/chat
   请求: {"message": "...", "context": {"day","date","cash","receivable","orders","decisions","risks"}}
   响应: {"reply": "..."}
   部署时由服务端代理转发大模型(可挂 RAG 知识库), 密钥只放服务端。
   本地 file:// 打开时 API 不可达, 自动降级为内置规则问答。 */

const AGENT_API = '/api/chat';
const AGENT_GREET = '你好, 我是经营助手 Agent。可以问我:\n· 现在现金多少?\n· 当前有哪些风险?\n· 收件箱有什么待处理?\n· 在手订单情况\n· 今天是第几天\n也可以说"打开订单管线"直接跳转。\n(当前为离线规则模式; 部署后接入真实 Agent 与知识库)';

let agentOpen = false, agentGreeted = false;

/* 随请求携带的紧凑游戏状态, 供服务端 Agent 参考 */
function compactContext() {
  return {
    day: GameState.day,
    date: (function () { const d = dateOf(GameState.day); return (d.getMonth() + 1) + '月' + d.getDate() + '日'; })(),
    cash: GameState.cash,
    receivable: GameState.receivable.reduce((s, r) => s + r.amount, 0),
    orders: GameState.orders.length,
    decisions: GameState.decisions.length,
    risks: GameState.risks.slice(0, 3).map(r => r.txt),
  };
}

async function agentReply(q) {
  try {
    const res = await fetch(AGENT_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: q, context: compactContext() }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data && typeof data.reply === 'string') return data.reply;
    throw new Error('bad payload');
  } catch (e) {
    return agentFallback(q);
  }
}

/* 内置规则问答(离线可用) */
function agentFallback(q) {
  if (/(现金|余额|钱)/.test(q)) {
    const recv = GameState.receivable.reduce((s, r) => s + r.amount, 0);
    return '当前企业现金 ' + fmtMoney(GameState.cash) + ', 应收合计 ' + fmtMoney(recv) + '。\n月固定支出约 ' + fmtMoney(GameState.monthlyWages + GameState.monthlyOverhead) + '(工资+管理)。';
  }
  if (/(风险|异常|问题|缺料|逾期)/.test(q)) {
    return '当前风险信号:\n' + GameState.risks.map(r => '· ' + r.txt).join('\n');
  }
  if (/(商机|决策|收件箱|待处理)/.test(q)) {
    const pend = GameState.decisions.filter(x => !x.handled && !x.resolved);
    if (!pend.length) return '收件箱暂无待处理决策。';
    return '收件箱有 ' + pend.length + ' 项待处理:\n' + pend.map(x => '· [' + x.type + '] ' + x.title).join('\n') + '\n建议打开"收件箱"逐项处理。';
  }
  if (/(订单|在手|业务)/.test(q)) {
    const sum = GameState.orders.reduce((s, o) => s + o.amount, 0);
    return '在手订单 ' + GameState.orders.length + ' 单, 合计 ' + fmtMoney(sum) + ':\n' + GameState.orders.map(o => '· ' + o.name + '(' + o.statusText + ')').join('\n');
  }
  if (/(日期|第几天|今天)/.test(q)) {
    const d = dateOf(GameState.day);
    return '今天是 ' + (d.getMonth() + 1) + '月' + d.getDate() + '日 · 第 ' + GameState.day + ' / ' + INITIAL.durationDays + ' 天。';
  }
  if (/(产能|工厂|物料)/.test(q)) {
    return GameState.factories.map(f => '· ' + f.name + ': ' + f.statusText + ', 产能利用率 ' + Math.round(f.load * 100) + '%').join('\n') +
      '\n物料: ' + GameState.materials.filter(m => m.cls !== 'ok').map(m => m.name + '(' + m.stock + ')').join(', ');
  }
  if (/打开/.test(q)) {
    const map = { 驾驶舱: 'cockpit', 收件箱: 'inbox', 订单: 'orders', 财务: 'finance', 产能: 'capacity', 日报: 'report', 社区: 'community', 动态: 'community', 手册: 'handbook', 复盘: 'review' };
    for (const k in map) {
      if (q.indexOf(k) >= 0) { closeAgent(); UI.showView(map[k]); return '已为你打开对应页面。'; }
    }
  }
  return '我可以回答: 现金 / 风险 / 订单 / 日期 / 产能。也可以说"打开订单管线"直接跳转。';
}

/* ---------- 对话面板交互 ---------- */
function pushMsg(cls, text) {
  const el = document.createElement('div');
  el.className = 'msg ' + cls;
  el.textContent = text;
  $('agent-body').appendChild(el);
  $('agent-body').scrollTop = $('agent-body').scrollHeight;
  return el;
}
function toggleAgent() { agentOpen ? closeAgent() : openAgent(); }
function openAgent() {
  $('agent-panel').classList.add('open');
  agentOpen = true;
  if (!agentGreeted) { pushMsg('ai', AGENT_GREET); agentGreeted = true; }
  $('agent-input').focus();
}
function closeAgent() {
  $('agent-panel').classList.remove('open');
  agentOpen = false;
}
async function sendAgent() {
  const q = $('agent-input').value.trim();
  if (!q) return;
  pushMsg('user', q);
  $('agent-input').value = '';
  const t = pushMsg('ai', '正在思考…');
  const reply = await agentReply(q);
  t.textContent = reply;
  $('agent-body').scrollTop = $('agent-body').scrollHeight;
}
$('agent-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') sendAgent();
  if (e.key === 'Escape') closeAgent();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && agentOpen) { closeAgent(); $('agent-trigger').focus(); }
});
