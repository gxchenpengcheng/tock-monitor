/* 云端股票买卖点信号监控 —— GitHub Actions 定时运行
 * 复用 index.html 里的同一套策略引擎；信号出现时通过 Server酱 推送到微信。
 * 用法：node monitor/cloud-monitor.mjs
 *   环境变量 SCT_SENDKEY  Server酱密钥（GitHub Secrets 里配置）
 *   环境变量 DRY_RUN=1    只打印推送内容，不真正发送（本地测试用）
 *   环境变量 TEST_PUSH=1  强制推一条测试消息验证通道，不改动信号状态
 * 状态去重：monitor/state.json（每次运行后提交回仓库，跨运行持久化）
 *
 * 配置支持两种形态（见 config.json）：
 *   1) 单策略：{ strategy:'ma', params:{short:5,long:20} }
 *   2) 组合：  { combo:[{key:'pxma',params:{period:5,confirm:1}}, ...], comboMode:'majority' }
 *      合成方式与网页「策略组合」完全一致：and / majority / or，由 BT.combineSignals 计算。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_HTML = path.join(DIR, '..', 'index.html');
const CONFIG_PATH = path.join(DIR, 'config.json');
const STATE_PATH = path.join(DIR, 'state.json');
const SENDKEY = process.env.SCT_SENDKEY || '';
const DRY_RUN = process.env.DRY_RUN === '1';
const TEST_PUSH = process.env.TEST_PUSH === '1';

/* ---------- 引擎加载 ---------- */
function loadEngine() {
  const html = fs.readFileSync(ENGINE_HTML, 'utf8');
  const m = html.match(/<script id="engine">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('engine 脚本未找到');
  const sandbox = { console, Date, Math, JSON, isFinite, parseFloat, parseInt,
    Object, Array, String, Number, Boolean, RegExp, Error, Promise, setTimeout };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(m[1], { filename: 'engine.js' }).runInContext(sandbox);
  return sandbox.BT;
}

/* ---------- 配置与状态 ---------- */
const DEFAULTS = {
  symbol: '588170',
  strategy: 'ma',
  params: { short: 5, long: 20 },
  combo: [],                 // [{key, params}]，长度 >=2 时按组合模式运行
  comboMode: 'majority',     // and / majority / or
  periods: ['day', 'm30'],
  fq: 1
};
function loadConfig() {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  return Object.assign({}, DEFAULTS, user);
}
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch (e) { return { baseline: false }; }
}
function saveState(s) { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 1)); }

/* ---------- 行情拉取（失败重试 3 次，接口偶发抖动不影响整轮） ---------- */
async function getJSON(url, timeoutMs = 15000, tries = 3) {
  for (let k = 1; k <= tries; k++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (k === tries) throw e;
      await new Promise(s => setTimeout(s, 1500 * k));
    } finally { clearTimeout(t); }
  }
}

/* ---------- 收盘K线过滤 ----------
 * GitHub Actions 服务器时区是 UTC，这里统一按北京时间（UTC+8）判断。
 * 日线：当天 15:00 前那根未收盘，去掉；30分钟：当前槽位未收盘，去掉。 */
function bjNow() { return new Date(Date.now() + 8 * 3600 * 1000); }
function closedBars(bars, period) {
  const now = bjNow();
  const out = bars.slice();
  const last = out[out.length - 1];
  if (!last) return out;
  if (period === 'day') {
    const t = new Date(now); t.setUTCHours(7, 0, 0, 0);          // 北京 15:00
    if (last.date === isoDate(now) && now < t) out.pop();
  } else {
    const slotMs = 30 * 60 * 1000;
    const nowSlot = Math.floor(now.getTime() / slotMs) * slotMs;
    // K线日期是北京墙钟时间；+8h 平移到与 bjNow() 相同的「偏移尺度」再比较
    const barStart = new Date(last.date.replace(' ', 'T') + 'Z').getTime() + 8 * 3600 * 1000;
    if (barStart >= nowSlot) out.pop();
  }
  return out;
}
function isoDate(d) {
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') +
         '-' + String(d.getUTCDate()).padStart(2, '0');
}

/* ---------- 策略清单：单策略 / 组合 ---------- */
function stratLabel(st, p) {
  const vals = st.params.filter(x => x.opt !== false).map(x => p[x.k]);
  return st.name.replace(/\s*\(.*\)\s*$/, '') + (vals.length ? '(' + vals.join(',') + ')' : '');
}
function resolveList(BT, cfg) {
  const raw = (cfg.combo && cfg.combo.length) ? cfg.combo
    : [{ key: cfg.strategy, params: cfg.params }];
  return raw.map(item => {
    const st = BT.STRATS[item.key];
    if (!st) throw new Error('未知策略 ' + item.key);
    // 先用参数默认值铺底，再覆盖配置里的值
    const p = Object.assign({}, ...st.params.map(x => ({ [x.k]: x.def })), item.params || {});
    if (st.validate && !st.validate(p)) throw new Error('参数不合法 ' + item.key + ' ' + JSON.stringify(p));
    return { st, p, label: stratLabel(st, p) };
  });
}
function comboTitle(list, mode) {
  if (list.length === 1) return list[0].label;
  const m = { and: '全部同意', majority: '多数同意', or: '任一同意' }[mode] || mode;
  return '策略组合(' + list.length + ') · ' + m;
}

/* ---------- 单周期信号检测（组合时按 combineSignals 合成） ---------- */
function detectPeriod(BT, list, mode, bars, period) {
  const closed = closedBars(bars, period);
  if (closed.length < 30) throw new Error('有效K线不足30根');
  const view = {
    close: closed.map(d => d.close), open: closed.map(d => d.open),
    high: closed.map(d => d.high), low: closed.map(d => d.low),
    volume: closed.map(d => d.volume)
  };
  const sigs = list.map(it => it.st.build(view, it.p));
  const pos = list.length > 1 ? BT.combineSignals(sigs, mode) : sigs[0];

  let flipIdx = -1;
  for (let i = 1; i < pos.length; i++) if (pos[i] !== pos[i - 1]) flipIdx = i;
  const lastIdx = closed.length - 1;

  // 每个子策略在最后一根K线上的态度，便于消息里说明「谁在看多」
  const votes = list.map((it, j) => ({
    label: it.label,
    long: sigs[j][lastIdx] > 0,
    longAtFlip: flipIdx >= 0 ? sigs[j][flipIdx] > 0 : null
  }));

  return {
    period,
    position: pos[lastIdx] ? 'hold' : 'empty',
    lastDate: closed[lastIdx].date,
    lastClose: closed[lastIdx].close,
    votes,
    flip: flipIdx >= 0 ? {
      date: closed[flipIdx].date,
      side: pos[flipIdx] ? 'buy' : 'sell',
      close: closed[flipIdx].close,
      longCount: votes.filter(v => v.longAtFlip).length
    } : null
  };
}

/* ---------- Server酱 推送 ---------- */
async function pushServerChan(title, desp) {
  if (DRY_RUN) {
    console.log('[DRY_RUN] 推送内容 ->', JSON.stringify({ title, desp }));
    return;
  }
  if (!SENDKEY) throw new Error('缺少 SCT_SENDKEY（GitHub Secrets 未配置）');
  // 注意：必须显式 UTF-8，否则中文在部分环境按 GBK 发出会被服务端拒收（30001）
  const body = new URLSearchParams({ title, desp });
  const r = await fetch('https://sctapi.ftqq.com/' + SENDKEY + '.send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body
  });
  const j = await r.json().catch(() => ({}));
  if (!(j.code === 0 || j.ok)) throw new Error('Server酱推送失败: ' + JSON.stringify(j).slice(0, 200));
  console.log('[push] 已推送:', title, JSON.stringify(j).slice(0, 120));
}

/* ---------- 主流程 ---------- */
async function main() {
  const BT = loadEngine();
  const cfg = loadConfig();
  const state = loadState();
  const code = BT.tencentCodeOf(cfg.symbol);
  const list = resolveList(BT, cfg);
  const isCombo = list.length > 1;
  const mode = cfg.comboMode || 'majority';
  const title = comboTitle(list, mode);

  const dayJSON = await getJSON(BT.buildTencentURL(code, { fq: cfg.fq, days: 180 }));
  const dayR = BT.parseTencent(dayJSON, 180, code);
  const m30JSON = await getJSON(BT.buildMklineURL(code, { n: 120 }));
  const m30R = BT.parseMkline(m30JSON, code);

  const name = m30R.name || dayR.name || code;
  const alerts = [], positions = {}, details = {};
  state.day = state.day || null;
  state.m30 = state.m30 || null;

  for (const period of cfg.periods) {
    const raw = period === 'day' ? dayR.data : m30R.data;
    const det = detectPeriod(BT, list, mode, raw, period);
    const pTag = period === 'day' ? '日线' : '30分钟';
    positions[period] = { position: det.position, lastDate: det.lastDate, close: det.lastClose };
    details[period] = { position: det.position, lastDate: det.lastDate, close: det.lastClose,
      votes: det.votes.map(v => ({ label: v.label, long: v.long })) };

    if (!det.flip) continue;
    const key = det.flip.date + '|' + det.flip.side;
    if (state[period] === key) continue;
    if (!state.baseline) { state[period] = key; continue; }   // 首次运行只记基线
    state[period] = key;

    const sideTxt = det.flip.side === 'buy' ? '买入' : '卖出';
    const voteTxt = isCombo
      ? det.votes.map(v => (v.longAtFlip ? '✅' : '⬜') + v.label).join('\n')
      : '';
    alerts.push({
      title: ('【' + name + '】' + pTag + sideTxt).slice(0, 32),
      desp: '**' + name + '** (' + code + ')\n\n' +
        '- 策略：' + title + '\n' +
        '- 信号：' + pTag + ' ' + det.flip.date + ' **' + sideTxt + '**\n' +
        '- 信号K线收盘：' + det.flip.close + '\n' +
        (isCombo ? '- 当时票数：' + det.flip.longCount + '/' + list.length + ' 看多\n' + voteTxt + '\n' : '') +
        '- 当前持仓口径：' + (det.position === 'hold' ? '持有' : '空仓') + '\n\n' +
        '> 按回测口径信号次日开盘成交，仅供参考，不构成投资建议'
    });
  }

  /* 测试推送：只验证通道，不改动去重状态 */
  if (TEST_PUSH) {
    const lines = cfg.periods.map(p => {
      const d = details[p];
      const pTag = p === 'day' ? '日线' : '30分钟';
      const sub = isCombo
        ? '（' + d.votes.filter(v => v.long).length + '/' + list.length + ' 看多：' +
          d.votes.map(v => (v.long ? '✅' : '⬜') + v.label.replace(/\(.*\)$/, '')).join(' ') + '）'
        : '';
      return '- ' + pTag + '：' + (d.position === 'hold' ? '持有' : '空仓') + sub +
             '，最后K线 ' + d.lastDate + ' 收盘 ' + d.close;
    });
    await pushServerChan(
      '【测试】信号监控推送通道正常',
      '**' + name + '** (' + code + ')\n\n' +
      '- 策略：' + title + '\n' + lines.join('\n') +
      '\n- 时间：' + bjNow().toISOString().replace('T', ' ').slice(0, 19) + ' 北京时间' +
      '\n\n> 手动触发的测试消息，不代表买卖信号'
    );
    console.log('[done] 测试推送已发送');
    return;
  }

  const wasBaseline = !state.baseline;
  let stateChanged = false;
  if (wasBaseline) { state.baseline = true; stateChanged = true; }
  else if (alerts.length) stateChanged = true;
  if (stateChanged) saveState(state);

  const now = bjNow();
  const result = {
    ok: true,
    time: now.toISOString().replace('T', ' ').slice(0, 19) + ' 北京时间',
    symbol: code, name,
    strategy: title,
    combo: isCombo ? list.map(it => it.label) : undefined,
    comboMode: isCombo ? mode : undefined,
    positions, details,
    alertCount: alerts.length,
    pushed: false, baseline: wasBaseline
  };

  for (const a of alerts) {
    await pushServerChan(a.title, a.desp);
    result.pushed = true;
  }

  fs.writeFileSync(path.join(DIR, 'last-run.json'), JSON.stringify(result, null, 1));
  console.log('[done]', JSON.stringify(result));
}

main().catch(e => {
  console.error('[fail]', e.message);
  process.exit(1);
});
