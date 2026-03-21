/**
 * UT Bot Trading System - Node.js Backend for Render
 * Uses Upstash Redis for persistent state (shared across all devices/sessions)
 * Triggered by cron-job.org every minute
 */

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ─── Upstash Redis Credentials ────────────────────────────────────────────────
// Paste your Upstash credentials here directly:
const REDIS_URL   = 'https://robust-kitten-78595.upstash.io';    // e.g. https://xxx.upstash.io
const REDIS_TOKEN = 'gQAAAAAAATMDAAIncDEyZjJkNzQyMDQyN2Q0ODEwOTI1ZGY4MTczMWM4MGQzYnAxNzg1OTU';  // e.g. AXxxxxxxxxxxxxxxxx

async function redisCmd(...args) {
  const url = `${REDIS_URL}/${args.map(encodeURIComponent).join('/')}`;
  const res  = await fetch(url, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
  const data = await res.json();
  return data.result;
}

async function redisGet(key)        { return redisCmd('GET', key); }
async function redisSet(key, value) { return redisCmd('SET', key, JSON.stringify(value)); }

// ─── Constants ────────────────────────────────────────────────────────────────
const START_BALANCE    = 10000;
const BTC_USDT_RATE    = 85;        // 1 USDT = 85 INR (approximate, update as needed)
const DEFAULT_TRADING_STATE = {
  enabled:      true,
  start_hour:   18,
  end_hour:     23,
  manual_pause: false,
  force_start:  false
};
const DEFAULT_RISK_CONFIG = {
  stop_loss: {
    enabled:               true,
    type:                  'hybrid',
    atr_multiplier:        2.0,
    max_loss_percentage:   3.0,
    trailing_enabled:      true,
    trailing_atr_multiplier: 1.5
  },
  take_profit: {
    enabled: true,
    type:    'scaled_atr',
    levels: [
      { percentage: 50, atr_multiplier: 2.5, name: 'TP1' },
      { percentage: 30, atr_multiplier: 5.0, name: 'TP2' },
      { percentage: 20, atr_multiplier: 7.5, name: 'TP3' }
    ]
  },
  position_sizing: {
    method:           'percentage',
    value:            5.0,
    min_position_size: 0.0001,
    max_position_size: 0.01
  },
  daily_limits: {
    enabled:               true,
    max_daily_loss:        1000.0,
    max_daily_trades:      20,
    max_consecutive_losses: 5,
    reset_hour:            0
  },
  account_protection: {
    max_drawdown_percentage: 20.0,
    min_balance:             5000.0,
    emergency_stop:          false
  },
  different_rules_for_position_type: {
    enabled: true,
    long:    { tp_atr_multipliers: [3.0, 6.0, 9.0] },
    short:   { tp_atr_multipliers: [2.0, 4.0, 6.0] }
  }
};

// ─── Redis State Helpers ──────────────────────────────────────────────────────
async function loadTrades() {
  const raw = await redisGet('trades');
  if (!raw) return {
    balance:    START_BALANCE,
    open_trade: null,
    history:    [],
    order_log:  [],
    last_signal: null
  };
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}
async function saveTrades(data) { await redisSet('trades', data); }

async function loadTradingState() {
  const raw = await redisGet('trading_state');
  if (!raw) { await redisSet('trading_state', DEFAULT_TRADING_STATE); return DEFAULT_TRADING_STATE; }
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}
async function saveTradingState(state) { await redisSet('trading_state', state); }

async function loadRiskConfig() {
  const raw = await redisGet('risk_config');
  if (!raw) { await redisSet('risk_config', DEFAULT_RISK_CONFIG); return DEFAULT_RISK_CONFIG; }
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}
async function saveRiskConfig(cfg) { await redisSet('risk_config', cfg); }

async function loadRiskState() {
  const raw = await redisGet('risk_state');
  const defState = {
    daily_loss: 0, daily_profit: 0, daily_trades: 0,
    consecutive_losses: 0, last_reset: new Date().toISOString(), peak_balance: 0
  };
  if (!raw) { await redisSet('risk_state', defState); return defState; }
  const state = typeof raw === 'string' ? JSON.parse(raw) : raw;
  // Reset if new day
  const cfg = await loadRiskConfig();
  const lastReset = new Date(state.last_reset);
  const now = new Date();
  const resetHour = cfg.daily_limits.reset_hour;
  if (now.getDate() !== lastReset.getDate() ||
      (now.getDate() === lastReset.getDate() && now.getHours() >= resetHour && lastReset.getHours() < resetHour)) {
    const fresh = { ...defState, last_reset: now.toISOString() };
    await redisSet('risk_state', fresh);
    return fresh;
  }
  return state;
}
async function saveRiskState(state) { await redisSet('risk_state', state); }

// ─── Binance Price Fetcher ────────────────────────────────────────────────────
const BINANCE_ENDPOINTS = [
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://data.binance.com'
];

async function binanceRequest(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  for (const base of BINANCE_ENDPOINTS) {
    try {
      const res = await fetch(`${base}${path}?${qs}`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        signal:  AbortSignal.timeout(8000)
      });
      if (res.ok) return await res.json();
    } catch (_) { /* try next */ }
  }
  return null;
}

async function fetchBTCPrice() {
  const data = await binanceRequest('/api/v3/ticker/price', { symbol: 'BTCUSDT' });
  return data ? parseFloat(data.price) : null;
}

async function fetchKlines(limit = 350) {
  return binanceRequest('/api/v3/klines', { symbol: 'BTCUSDT', interval: '5m', limit });
}

// ─── UT Bot Logic ─────────────────────────────────────────────────────────────
function calcUTBot(klines, keyvalue, atrPeriod) {
  if (!klines || klines.length < atrPeriod + 5) return null;
  const n = klines.length;
  const close  = klines.map(k => parseFloat(k[4]));
  const high   = klines.map(k => parseFloat(k[2]));
  const low    = klines.map(k => parseFloat(k[3]));
  const tr     = high.map((h, i) => h - low[i]);

  // Rolling ATR (simple moving average)
  const atr = new Array(n).fill(0);
  for (let i = atrPeriod - 1; i < n; i++) {
    atr[i] = tr.slice(i - atrPeriod + 1, i + 1).reduce((s, v) => s + v, 0) / atrPeriod;
  }

  const nLoss = atr.map(a => keyvalue * a);
  const stop  = [close[0]];
  const pos   = [0];

  for (let i = 1; i < n; i++) {
    const prev = stop[i - 1];
    const src  = close[i];
    const src1 = close[i - 1];
    let newStop;
    if (src > prev && src1 > prev)       newStop = Math.max(prev, src - nLoss[i]);
    else if (src < prev && src1 < prev)  newStop = Math.min(prev, src + nLoss[i]);
    else                                  newStop = src > prev ? src - nLoss[i] : src + nLoss[i];
    stop.push(newStop);
    if (src1 < prev && src > prev)       pos.push(1);
    else if (src1 > prev && src < prev)  pos.push(-1);
    else                                  pos.push(pos[i - 1]);
  }

  const stableAtr = atr.filter(v => v > 0);
  const atrStable = stableAtr.length ? stableAtr[stableAtr.length - 1] : 0;

  return {
    signal:   pos[n - 1],
    stopLine: stop[n - 1],
    atr:      atrStable,
    close:    close[n - 1]
  };
}

async function getUTBotSignal() {
  const klines = await fetchKlines(350);
  if (!klines) return { signal: 'No Data', price: 0, atr: 0, utbot_stop: 0 };

  const r1 = calcUTBot(klines, 2, 1);    // Sell signals
  const r2 = calcUTBot(klines, 2, 300);  // Buy signals

  const price = r1 ? r1.close : 0;
  let signal  = 'Hold';
  let utbotStop = price;

  if (r2 && r2.signal === 1)  { signal = 'Buy';  utbotStop = r2.stopLine; }
  if (r1 && r1.signal === -1) { signal = 'Sell'; utbotStop = r1.stopLine; }

  const atr14 = calcStableATR(klines, 14);

  console.log(`[UT Bot] ${signal} @ $${price.toFixed(2)} | ATR: ${atr14.toFixed(2)}`);
  return { signal, price, atr: atr14, utbot_stop: utbotStop };
}

function calcStableATR(klines, period = 14) {
  const tr = klines.map(k => parseFloat(k[2]) - parseFloat(k[3]));
  const valid = tr.filter(v => v > 0);
  if (valid.length < period) return valid.reduce((s, v) => s + v, 0) / (valid.length || 1);
  return valid.slice(-period).reduce((s, v) => s + v, 0) / period;
}

// ─── Risk Management ──────────────────────────────────────────────────────────
function calcPositionSize(balance, config) {
  const { method, value, min_position_size, max_position_size } = config.position_sizing;
  let size;
  if (method === 'fixed') {
    size = value;
  } else if (method === 'percentage') {
    const btcPriceINR = 97000 * BTC_USDT_RATE;
    size = (balance * (value / 100)) / btcPriceINR;
  } else {
    size = value;
  }
  return Math.max(min_position_size, Math.min(max_position_size, parseFloat(size.toFixed(6))));
}

function calcStopLoss(entryPrice, posType, atr, utbotStop, config) {
  const sl = config.stop_loss;
  if (!sl.enabled) return null;
  if (posType === 'LONG') {
    const slAtr   = entryPrice - (atr * sl.atr_multiplier);
    const slFixed = entryPrice * (1 - sl.max_loss_percentage / 100);
    if (sl.type === 'hybrid') {
      const cand = Math.max(slAtr, slFixed);
      return parseFloat((utbotStop ? Math.max(cand, utbotStop) : cand).toFixed(2));
    }
    if (sl.type === 'atr')     return parseFloat(slAtr.toFixed(2));
    if (sl.type === 'utbot')   return parseFloat((utbotStop || slFixed).toFixed(2));
    return parseFloat(slFixed.toFixed(2));
  } else {
    const slAtr   = entryPrice + (atr * sl.atr_multiplier);
    const slFixed = entryPrice * (1 + sl.max_loss_percentage / 100);
    if (sl.type === 'hybrid') {
      const cand = Math.min(slAtr, slFixed);
      return parseFloat((utbotStop ? Math.min(cand, utbotStop) : cand).toFixed(2));
    }
    if (sl.type === 'atr')     return parseFloat(slAtr.toFixed(2));
    if (sl.type === 'utbot')   return parseFloat((utbotStop || slFixed).toFixed(2));
    return parseFloat(slFixed.toFixed(2));
  }
}

function calcTP(entryPrice, posType, atr, config) {
  const tp  = config.take_profit;
  if (!tp.enabled) return [];
  const rules = config.different_rules_for_position_type;
  const mults = rules.enabled
    ? (posType === 'LONG' ? rules.long.tp_atr_multipliers : rules.short.tp_atr_multipliers)
    : tp.levels.map(l => l.atr_multiplier);

  return mults.map((mult, i) => {
    const price = posType === 'LONG'
      ? parseFloat((entryPrice + atr * mult).toFixed(2))
      : parseFloat((entryPrice - atr * mult).toFixed(2));
    const level = tp.levels[i] || { percentage: Math.floor(100 / mults.length), name: `TP${i + 1}` };
    return { price, percentage: level.percentage, name: level.name, hit: false };
  });
}

function calcLivePL(trade, price) {
  if (!trade) return null;
  const diff = trade.type === 'LONG'
    ? (price - trade.entry_price) * trade.amount
    : (trade.entry_price - price) * trade.amount;
  return parseFloat((diff * BTC_USDT_RATE).toFixed(2));
}

async function canOpenTrade(balance) {
  const config = await loadRiskConfig();
  const state  = await loadRiskState();
  const lim    = config.daily_limits;
  if (lim.enabled) {
    if (state.daily_loss >= lim.max_daily_loss)
      return { allowed: false, reason: `Daily loss limit ₹${state.daily_loss.toFixed(2)} / ₹${lim.max_daily_loss}` };
    if (state.daily_trades >= lim.max_daily_trades)
      return { allowed: false, reason: `Daily trade limit ${state.daily_trades}/${lim.max_daily_trades}` };
    if (state.consecutive_losses >= lim.max_consecutive_losses)
      return { allowed: false, reason: `Max consecutive losses ${state.consecutive_losses}` };
  }
  const prot = config.account_protection;
  if (prot.emergency_stop) return { allowed: false, reason: 'Emergency stop active' };
  if (balance < prot.min_balance) return { allowed: false, reason: `Balance below minimum ₹${prot.min_balance}` };
  if (state.peak_balance > 0) {
    const dd = ((state.peak_balance - balance) / state.peak_balance) * 100;
    if (dd >= prot.max_drawdown_percentage)
      return { allowed: false, reason: `Max drawdown ${dd.toFixed(2)}%` };
  }
  return { allowed: true, reason: null };
}

async function recordTradeResult(profitLoss) {
  const state = await loadRiskState();
  state.daily_trades += 1;
  if (profitLoss < 0) { state.daily_loss += Math.abs(profitLoss); state.consecutive_losses += 1; }
  else                 { state.daily_profit += profitLoss;         state.consecutive_losses  = 0; }
  await saveRiskState(state);
}

function closeFullPosition(data, trade, exitPrice, reason) {
  const pnlUSDT = trade.type === 'LONG'
    ? (exitPrice - trade.entry_price) * trade.amount
    : (trade.entry_price - exitPrice) * trade.amount;
  const pnlINR = parseFloat((pnlUSDT * BTC_USDT_RATE).toFixed(2));
  const before = data.balance;
  data.balance = parseFloat((data.balance + pnlINR).toFixed(2));
  const rec = {
    type:         trade.type,
    entry_price:  trade.entry_price,
    exit_price:   exitPrice,
    amount:       trade.amount,
    profit_usdt:  parseFloat(pnlUSDT.toFixed(4)),
    profit_inr:   pnlINR,
    balance_before: parseFloat(before.toFixed(2)),
    balance_after:  data.balance,
    closed_at:    new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    opened_at:    trade.opened_at,
    duration:     calcDuration(trade.opened_at),
    exit_reason:  reason,
    strategy:     trade.strategy,
    atr_at_entry: trade.atr_at_entry,
    rr_ratio:     calcRR(trade, exitPrice),
    partial:      false
  };
  data.history.push(rec);
  data.open_trade = null;
  return rec;
}

function calcDuration(openedAt) {
  try {
    const open = new Date(openedAt.replace(/(\d{2})\/(\d{2})\/(\d{4}),/, '$3-$2-$1'));
    const diff = Math.floor((Date.now() - open.getTime()) / 60000);
    if (isNaN(diff)) return 'N/A';
    if (diff < 60) return `${diff}m`;
    return `${Math.floor(diff / 60)}h ${diff % 60}m`;
  } catch { return 'N/A'; }
}

function calcRR(trade, exitPrice) {
  if (!trade.stop_loss) return 'N/A';
  const risk   = Math.abs(trade.entry_price - trade.stop_loss);
  const reward = Math.abs(exitPrice - trade.entry_price);
  if (risk === 0) return 'N/A';
  return `1:${(reward / risk).toFixed(2)}`;
}

// ─── Trading Hours ────────────────────────────────────────────────────────────
function getISTHour() {
  const now   = new Date();
  const utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
  const istMs = utcMs + (5.5 * 3600000);
  return new Date(istMs).getHours();
}

function isTradingAllowed(state) {
  // force_start overrides everything
  if (state.force_start === true) return { allowed: true, reason: null };
  // manual pause
  if (state.manual_pause === true) return { allowed: false, reason: 'Manually paused' };
  // hours disabled = 24/7
  if (!state.enabled) return { allowed: true, reason: null };
  // check IST hour window
  const istHr = getISTHour();
  const { start_hour, end_hour } = state;
  if (istHr >= start_hour && istHr < end_hour) return { allowed: true, reason: null };
  return { allowed: false, reason: `Outside trading hours (${start_hour}:00-${end_hour}:00 IST). Current IST: ${istHr}:00` };
}

// ─── Main Trade Update ────────────────────────────────────────────────────────
async function updateDemoTrade(signal, price, atr, utbotStop) {
  signal = signal.charAt(0).toUpperCase() + signal.slice(1).toLowerCase();
  const data    = await loadTrades();
  const config  = await loadRiskConfig();
  let openTrade = data.open_trade;
  let actionMsg = '';
  let lastClosed = null;

  const ts = () => new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const logEntry = { time: ts(), side: signal, price, quantity: calcPositionSize(data.balance, config) };

  // ── Check open trade for SL / TP hits ──
  if (openTrade) {
    const { type, stop_loss, tp1_price } = openTrade;
    const slHit = type === 'LONG' ? price <= stop_loss : price >= stop_loss;
    const tpHit = tp1_price && (type === 'LONG' ? price >= tp1_price : price <= tp1_price);

    if (slHit && stop_loss) {
      lastClosed = closeFullPosition(data, openTrade, price, 'Stop-Loss Hit');
      await recordTradeResult(lastClosed.profit_inr);
      actionMsg = `🛑 STOP-LOSS @ $${price.toFixed(2)} | P/L: ₹${lastClosed.profit_inr}`;
      logEntry.action = 'STOP_LOSS'; logEntry.pl_inr = lastClosed.profit_inr;
      openTrade = null;
    } else if (tpHit) {
      lastClosed = closeFullPosition(data, openTrade, price, 'TP1 Hit - Full Exit');
      await recordTradeResult(lastClosed.profit_inr);
      actionMsg = `✅ TP1 HIT @ $${price.toFixed(2)} | P/L: ₹${lastClosed.profit_inr}`;
      logEntry.action = 'TP1_FULL_EXIT'; logEntry.pl_inr = lastClosed.profit_inr;
      openTrade = null;
    } else {
      // Trailing stop
      if (openTrade.breakeven_moved && config.stop_loss.trailing_enabled) {
        const dist = atr * config.stop_loss.trailing_atr_multiplier;
        const newSL = openTrade.type === 'LONG' ? price - dist : price + dist;
        const improved = openTrade.type === 'LONG' ? newSL > openTrade.stop_loss : newSL < openTrade.stop_loss;
        if (improved) {
          openTrade.stop_loss = parseFloat(newSL.toFixed(2));
          actionMsg = `📈 Trailing SL → $${openTrade.stop_loss}`;
          logEntry.action = 'TRAILING_STOP_UPDATE';
        }
      }
    }
  }

  if (signal === 'Hold') {
    if (!actionMsg) { actionMsg = 'Holding position'; logEntry.action = 'HOLD'; }
  } else if (signal === 'Buy') {
    const check = await canOpenTrade(data.balance);
    if (!check.allowed) {
      actionMsg = `⚠️ Blocked: ${check.reason}`;
      logEntry.action = 'BLOCKED';
    } else if (openTrade && openTrade.type === 'LONG') {
      actionMsg = 'Already LONG'; logEntry.action = 'IGNORED';
    } else {
      if (openTrade && openTrade.type === 'SHORT') {
        lastClosed = closeFullPosition(data, openTrade, price, 'Opposite Signal');
        await recordTradeResult(lastClosed.profit_inr);
        actionMsg += `CLOSED SHORT @ $${price.toFixed(2)}, P/L: ₹${lastClosed.profit_inr} | `;
        logEntry.action = 'CLOSE_SHORT'; logEntry.pl_inr = lastClosed.profit_inr;
        openTrade = null;
      }
      const size  = calcPositionSize(data.balance, config);
      const sl    = calcStopLoss(price, 'LONG', atr, utbotStop, config);
      const tpArr = calcTP(price, 'LONG', atr, config);
      const tp1   = tpArr[0]?.price || null;
      openTrade = {
        type:            'LONG',
        entry_price:     price,
        amount:          size,
        original_amount: size,
        stop_loss:       sl,
        tp1_price:       tp1,
        tp_levels:       tpArr.slice(0, 1),
        opened_at:       ts(),
        strategy:        'UT Bot #2 (KV=2, ATR=300)',
        atr_at_entry:    atr,
        breakeven_moved: false,
        entry_reason:    'UT Bot ATR=300 pos=1 (Buy Signal)'
      };
      actionMsg += `🟢 LONG @ $${price.toFixed(2)} | Size: ${size} BTC | SL: $${sl} | TP1: $${tp1}`;
      logEntry.action = 'OPEN_LONG'; logEntry.stop_loss = sl; logEntry.tp1 = tp1;
      data.last_signal = 'Buy';
    }
  } else if (signal === 'Sell') {
    const check = await canOpenTrade(data.balance);
    if (!check.allowed) {
      actionMsg = `⚠️ Blocked: ${check.reason}`;
      logEntry.action = 'BLOCKED';
    } else if (openTrade && openTrade.type === 'SHORT') {
      actionMsg = 'Already SHORT'; logEntry.action = 'IGNORED';
    } else {
      if (openTrade && openTrade.type === 'LONG') {
        lastClosed = closeFullPosition(data, openTrade, price, 'Opposite Signal');
        await recordTradeResult(lastClosed.profit_inr);
        actionMsg += `CLOSED LONG @ $${price.toFixed(2)}, P/L: ₹${lastClosed.profit_inr} | `;
        logEntry.action = 'CLOSE_LONG'; logEntry.pl_inr = lastClosed.profit_inr;
        openTrade = null;
      }
      const size  = calcPositionSize(data.balance, config);
      const sl    = calcStopLoss(price, 'SHORT', atr, utbotStop, config);
      const tpArr = calcTP(price, 'SHORT', atr, config);
      const tp1   = tpArr[0]?.price || null;
      openTrade = {
        type:            'SHORT',
        entry_price:     price,
        amount:          size,
        original_amount: size,
        stop_loss:       sl,
        tp1_price:       tp1,
        tp_levels:       tpArr.slice(0, 1),
        opened_at:       ts(),
        strategy:        'UT Bot #1 (KV=2, ATR=1)',
        atr_at_entry:    atr,
        breakeven_moved: false,
        entry_reason:    'UT Bot ATR=1 pos=-1 (Sell Signal)'
      };
      actionMsg += `🔴 SHORT @ $${price.toFixed(2)} | Size: ${size} BTC | SL: $${sl} | TP1: $${tp1}`;
      logEntry.action = 'OPEN_SHORT'; logEntry.stop_loss = sl; logEntry.tp1 = tp1;
      data.last_signal = 'Sell';
    }
  }

  data.open_trade = openTrade;
  if (!data.order_log) data.order_log = [];
  data.order_log.push(logEntry);
  // Keep only last 500 log entries in Redis to avoid size issues
  if (data.order_log.length > 500) data.order_log = data.order_log.slice(-500);
  await saveTrades(data);

  // Update peak balance
  const riskState = await loadRiskState();
  if (data.balance > (riskState.peak_balance || 0)) {
    riskState.peak_balance = data.balance;
    await saveRiskState(riskState);
  }

  return { data, openTrade, lastClosed, logEntry, actionMsg };
}

// ─── Risk Status Helper ───────────────────────────────────────────────────────
async function getRiskStatus() {
  const config = await loadRiskConfig();
  const state  = await loadRiskState();
  const lim    = config.daily_limits;
  return {
    daily_stats: {
      trades:             `${state.daily_trades}/${lim.max_daily_trades}`,
      loss:               `₹${(state.daily_loss || 0).toFixed(2)}/₹${lim.max_daily_loss}`,
      profit:             `₹${(state.daily_profit || 0).toFixed(2)}`,
      consecutive_losses: `${state.consecutive_losses}/${lim.max_consecutive_losses}`
    },
    limits_usage: {
      trades_pct: lim.max_daily_trades ? (state.daily_trades / lim.max_daily_trades) * 100 : 0,
      loss_pct:   lim.max_daily_loss   ? ((state.daily_loss || 0) / lim.max_daily_loss) * 100 : 0
    },
    config
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// ── Cron-job.org ping: runs the bot logic
app.get('/tick', async (req, res) => {
  try {
    const tradingState        = await loadTradingState();
    const { allowed, reason } = isTradingAllowed(tradingState);
    const data                = await loadTrades();
    const openTrade           = data.open_trade;

    // ── SLEEP MODE: outside hours AND no open position ──────────────────────
    // Do NOT hit Binance at all. Just ping-back so cron knows we are alive.
    if (!allowed && !openTrade) {
      console.log(`[tick] Sleeping — ${reason}`);
      return res.json({ status: 'sleeping', reason, trading_allowed: false });
    }

    // ── We need price (either active trading OR open position needs SL/TP check)
    const { signal, price, atr, utbot_stop } = await getUTBotSignal();

    if (signal === 'No Data' || price === 0) {
      return res.json({ status: 'error', message: 'Could not fetch Binance price' });
    }

    const livePL     = calcLivePL(openTrade, price);
    const riskStatus = await getRiskStatus();

    // ── PAUSED but open position exists: only check SL/TP, no new trades ────
    if (!allowed) {
      const slHit = openTrade && (openTrade.type === 'LONG' ? price <= openTrade.stop_loss : price >= openTrade.stop_loss);
      const tpHit = openTrade?.tp1_price && (openTrade.type === 'LONG' ? price >= openTrade.tp1_price : price <= openTrade.tp1_price);
      if (slHit || tpHit) {
        const result   = await updateDemoTrade(signal, price, atr, utbot_stop);
        const reloaded = await loadTrades();
        return res.json({
          status: 'sl_tp_hit', trading_allowed: false, pause_reason: reason,
          price, balance: reloaded.balance,
          action: result.actionMsg, last_closed: result.lastClosed
        });
      }
      return res.json({
        status: 'paused', trading_allowed: false, pause_reason: reason,
        price, signal: 'Hold', balance: data.balance,
        holding: !!openTrade, live_pl_inr: livePL,
        entry_price: openTrade?.entry_price, stop_loss: openTrade?.stop_loss,
        position_type: openTrade?.type, risk_status: riskStatus
      });
    }

    // ── ACTIVE TRADING ───────────────────────────────────────────────────────
    console.log(`[tick] Trading ACTIVE | ${signal} @ $${price.toFixed(2)}`);
    const result   = await updateDemoTrade(signal, price, atr, utbot_stop);
    const reloaded = await loadTrades();

    return res.json({
      status: 'ok', trading_allowed: true,
      price, signal,
      balance:       reloaded.balance,
      holding:       !!reloaded.open_trade,
      position_type: reloaded.open_trade?.type || null,
      entry_price:   reloaded.open_trade?.entry_price || null,
      stop_loss:     reloaded.open_trade?.stop_loss || null,
      tp1_price:     reloaded.open_trade?.tp1_price || null,
      tp_levels:     reloaded.open_trade?.tp_levels || [],
      position_size: reloaded.open_trade?.amount || 0,
      action:        result.actionMsg,
      live_pl_inr:   calcLivePL(reloaded.open_trade, price),
      atr,
      risk_status:   riskStatus,
      last_closed:   result.lastClosed,
      force_start:   tradingState.force_start,
      strategy_info: { buy_strategy: 'UT Bot #2 (KV=2, ATR=300)', sell_strategy: 'UT Bot #1 (KV=2, ATR=1)' }
    });
  } catch (err) {
    console.error('[/tick error]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Dashboard signal endpoint — always returns current state for UI
app.get('/signal', async (req, res) => {
  try {
    const tradingState        = await loadTradingState();
    const { allowed, reason } = isTradingAllowed(tradingState);
    const data                = await loadTrades();
    const openTrade           = data.open_trade;
    const istHr               = getISTHour();

    // Always fetch live price for the dashboard display
    let price = await fetchBTCPrice();
    if (!price) price = openTrade?.entry_price || 0;

    const livePL     = calcLivePL(openTrade, price);
    const riskStatus = await getRiskStatus();

    return res.json({
      trading_allowed: allowed,
      pause_reason:    reason,
      price,
      balance:         data.balance,
      holding:         !!openTrade,
      position_type:   openTrade?.type || null,
      entry_price:     openTrade?.entry_price || null,
      stop_loss:       openTrade?.stop_loss || null,
      tp1_price:       openTrade?.tp1_price || null,
      tp_levels:       openTrade?.tp_levels || [],
      position_size:   openTrade?.amount || 0,
      opened_at:       openTrade?.opened_at || null,
      atr_at_entry:    openTrade?.atr_at_entry || null,
      entry_reason:    openTrade?.entry_reason || null,
      strategy:        openTrade?.strategy || null,
      live_pl_inr:     livePL,
      last_signal:     data.last_signal,
      risk_status:     riskStatus,
      force_start:     tradingState.force_start,
      ist_hour:        istHr,
      trading_hours:   { start: tradingState.start_hour, end: tradingState.end_hour }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Trade history
app.get('/history', async (req, res) => {
  try {
    const data = await loadTrades();
    res.json(data.history || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Order log
app.get('/orders', async (req, res) => {
  try {
    const data = await loadTrades();
    const log  = (data.order_log || []).filter(e => ['OPEN_LONG','OPEN_SHORT','STOP_LOSS','TP1_FULL_EXIT','CLOSE_LONG','CLOSE_SHORT','FORCE_CLOSE'].includes(e.action));
    res.json([...log].reverse());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Status — fast Redis-only, NO Binance call (used by dashboard on load)
app.get('/status', async (req, res) => {
  try {
    const [data, risk, ts] = await Promise.all([loadTrades(), getRiskStatus(), loadTradingState()]);
    const open  = data.open_trade;
    const bal   = parseFloat((data.balance || START_BALANCE).toFixed(2));
    const { allowed, reason } = isTradingAllowed(ts);
    res.json({
      balance:         bal,
      pnl:             parseFloat((bal - START_BALANCE).toFixed(2)),
      has_open_trade:  !!open,
      open_trade:      open,
      holding:         !!open,
      position_type:   open?.type || null,
      entry_price:     open?.entry_price || null,
      stop_loss:       open?.stop_loss || null,
      tp1_price:       open?.tp1_price || null,
      tp_levels:       open?.tp_levels || [],
      position_size:   open?.amount || 0,
      opened_at:       open?.opened_at || null,
      atr_at_entry:    open?.atr_at_entry || null,
      entry_reason:    open?.entry_reason || null,
      strategy:        open?.strategy || null,
      last_signal:     data.last_signal,
      total_trades:    (data.history || []).filter(t => t.exit_price).length,
      risk_status:     risk,
      trading_allowed: allowed,
      pause_reason:    reason,
      force_start:     ts.force_start,
      ist_hour:        getISTHour(),
      trading_hours:   { start: ts.start_hour, end: ts.end_hour },
      start_balance:   START_BALANCE
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Risk config
app.get('/risk-config', async (req, res) => {
  try { res.json(await loadRiskConfig()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/risk-config', async (req, res) => {
  try {
    await saveRiskConfig(req.body);
    res.json({ success: true, message: 'Risk config updated' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Risk status
app.get('/risk-status', async (req, res) => {
  try { res.json(await getRiskStatus()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Trading control
app.get('/trading-control', async (req, res) => {
  try {
    const state = await loadTradingState();
    const { allowed, reason } = isTradingAllowed(state);
    res.json({ state, trading_allowed: allowed, pause_reason: reason });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/trading-control', async (req, res) => {
  try {
    const { action } = req.body;
    const state = await loadTradingState();

    if (action === 'pause')       { state.manual_pause = true;  state.force_start = false; }
    else if (action === 'resume') { state.manual_pause = false; state.force_start = false; }
    else if (action === 'force_start') { state.manual_pause = false; state.force_start = true; }
    else if (action === 'force_stop') {
      const price = await fetchBTCPrice();
      const data  = await loadTrades();
      let msg = 'No open position';
      if (data.open_trade && price) {
        const rec = closeFullPosition(data, data.open_trade, price, 'Force Stop');
        await recordTradeResult(rec.profit_inr);
        data.order_log = data.order_log || [];
        data.order_log.push({ time: new Date().toLocaleString('en-IN',{timeZone:'Asia/Kolkata'}), side:'CLOSE', action:'FORCE_CLOSE', price, quantity: rec.amount, pl_inr: rec.profit_inr });
        await saveTrades(data);
        msg = `Closed @ $${price.toFixed(2)} | P/L: ₹${rec.profit_inr}`;
      }
      state.manual_pause = true; state.force_start = false;
      await saveTradingState(state);
      return res.json({ success: true, message: msg });
    } else if (action === 'update_hours') {
      state.start_hour = req.body.start_hour ?? 18;
      state.end_hour   = req.body.end_hour   ?? 23;
      state.enabled    = req.body.enabled    ?? true;
    } else if (action === 'set_usdt_rate') {
      // Store manual USDT rate override
      await redisSet('usdt_rate_override', req.body.rate);
      return res.json({ success: true, message: `USDT rate set to ₹${req.body.rate}` });
    } else {
      return res.status(400).json({ success: false, error: 'Unknown action' });
    }

    await saveTradingState(state);
    res.json({ success: true, message: `Action: ${action}` });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── USDT/INR rate (live or manual override)
app.get('/usdt-rate', async (req, res) => {
  try {
    const override = await redisGet('usdt_rate_override');
    if (override) return res.json({ rate: parseFloat(override), source: 'manual' });
    // Try to fetch live rate from a free API
    try {
      const r = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const d = await r.json();
        const rate = d.rates?.INR;
        if (rate) return res.json({ rate: parseFloat(rate.toFixed(2)), source: 'live' });
      }
    } catch (_) {}
    res.json({ rate: BTC_USDT_RATE, source: 'default' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Reset balance (for testing)
app.post('/reset', async (req, res) => {
  try {
    await saveTrades({ balance: START_BALANCE, open_trade: null, history: [], order_log: [], last_signal: null });
    await saveRiskState({ daily_loss: 0, daily_profit: 0, daily_trades: 0, consecutive_losses: 0, last_reset: new Date().toISOString(), peak_balance: 0 });
    res.json({ success: true, message: 'Balance and history reset' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Debug time (check if IST hour is correct)
app.get('/debug-time', async (req, res) => {
  const ts    = await loadTradingState();
  const istHr = getISTHour();
  const { allowed, reason } = isTradingAllowed(ts);
  res.json({
    utc_time:      new Date().toUTCString(),
    ist_hour:      istHr,
    ist_time:      new Date(new Date().getTime() + (5.5*3600000)).toISOString(),
    trading_state: ts,
    trading_allowed: allowed,
    reason
  });
});

// ── Health check
app.get('/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString(), ist_hour: getISTHour() }));
app.get('/', (_, res) => res.send('UT Bot API running. Dashboard: use static index.html'));

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 UT Bot Trading Backend — port ${PORT}`);
  console.log(`⏰ Trading hours: check /trading-control`);
  console.log(`📊 Tick (cron): GET /tick`);
  console.log(`${'='.repeat(60)}\n`);
});
