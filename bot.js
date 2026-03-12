/**
 * UT Bot Trading Worker — Paper Trading (Binance BTC/USDT)
 * Runs 24/7 on Render. Syncs state to JSONBin.
 * Dashboard (index.html) reads the same JSONBin data.
 */

const https = require('https');

// ── CONFIG ────────────────────────────────────────────────────────
const JSONBIN_KEY  = '$2a$10$O7ugawOSpBk0bEaKB8s4wOKZNVE2G9VjfCGTtEUb8tGmTmmx2xYYm';
const JSONBIN_BASE = 'https://api.jsonbin.io/v3';
const START_BALANCE = 10000;
const BTC_USDT_RATE = 85;
const LOOP_INTERVAL_MS = 5000;   // 5 seconds
const CANDLE_LIMIT     = 350;

// ── SIMPLE HTTP FETCH (no dependencies) ──────────────────────────
function fetchJSON(url, options = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const reqOpts = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: options.method || 'GET',
            headers: options.headers || {}
        };
        const req = https.request(reqOpts, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch(e) { reject(new Error('JSON parse error: ' + data.slice(0, 200))); }
            });
        });
        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

// ── JSONBIN STATE STORAGE ─────────────────────────────────────────
let _binId = null;

async function getState() {
    try {
        if (!_binId) {
            // Create new bin on first run
            const res = await fetchJSON(`${JSONBIN_BASE}/b`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Master-Key': JSONBIN_KEY,
                    'X-Bin-Name': 'utbot-state',
                    'X-Bin-Private': 'true'
                },
                body: JSON.stringify({ empty: true })
            });
            _binId = res.metadata?.id;
            console.log('📦 Created new JSONBin:', _binId);
            return null;
        }
        const res = await fetchJSON(`${JSONBIN_BASE}/b/${_binId}/latest`, {
            headers: { 'X-Master-Key': JSONBIN_KEY }
        });
        if (res.record?.empty) return null;
        return res.record || null;
    } catch(e) {
        console.warn('⚠️  JSONBin read error:', e.message);
        return null;
    }
}

async function setState(state) {
    try {
        if (!_binId) await getState();
        if (!_binId) return;
        state.daily_stats.lastUpdated = Date.now();
        await fetchJSON(`${JSONBIN_BASE}/b/${_binId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-Master-Key': JSONBIN_KEY
            },
            body: JSON.stringify(state)
        });
    } catch(e) {
        console.warn('⚠️  JSONBin write error:', e.message);
    }
}

// ── MATH / UT BOT ALGORITHM ───────────────────────────────────────
function calculateATR(highs, lows, closes, period = 14) {
    const trues = closes.map((c, i) => {
        if (i === 0) return highs[i] - lows[i];
        return Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
    });
    return trues.map((_, i) => {
        if (i < period - 1) return null;
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += trues[j];
        return sum / period;
    });
}

function calculateUTBot(closes, highs, lows, keyValue, atrPeriod) {
    const atrs = calculateATR(highs, lows, closes, atrPeriod);
    const nLoss = atrs.map(a => a ? a * keyValue : 0);
    const stop = [closes[0]];
    const pos  = [0];

    for (let i = 1; i < closes.length; i++) {
        const prev = stop[i-1];
        const src  = closes[i];
        const src1 = closes[i-1];
        let newStop;
        if      (src > prev && src1 > prev) newStop = Math.max(prev, src - nLoss[i]);
        else if (src < prev && src1 < prev) newStop = Math.min(prev, src + nLoss[i]);
        else newStop = src > prev ? src - nLoss[i] : src + nLoss[i];
        stop.push(newStop);

        let p;
        if      (src1 < prev && src > prev) p = 1;
        else if (src1 > prev && src < prev) p = -1;
        else p = pos[i-1];
        pos.push(p);
    }
    return { stop, pos, atr: atrs };
}

function processSignal(candles) {
    const closes = candles.map(c => c.close);
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);

    const utBot2 = calculateUTBot(closes, highs, lows, 2, 300); // Buy
    const utBot1 = calculateUTBot(closes, highs, lows, 2, 1);   // Sell

    const signalBuy  = utBot2.pos[utBot2.pos.length - 1] ===  1 ? 'Buy'  : 'Hold';
    const signalSell = utBot1.pos[utBot1.pos.length - 1] === -1 ? 'Sell' : 'Hold';

    let signal = 'Hold';
    if (signalBuy  === 'Buy')  signal = 'Buy';
    if (signalSell === 'Sell') signal = 'Sell';

    const atr14 = calculateATR(highs, lows, closes, 14);
    const atr   = atr14[atr14.length - 1] || 0;
    const stop  = signal === 'Buy'
        ? utBot2.stop[utBot2.stop.length - 1]
        : utBot1.stop[utBot1.stop.length - 1];

    return { price: closes[closes.length - 1], signal, atr, stop };
}

// ── FETCH CANDLES FROM BINANCE ────────────────────────────────────
async function fetchCandles() {
    try {
        const data = await fetchJSON(
            `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=${CANDLE_LIMIT}`
        );
        return data.map(d => ({
            time:   d[0],
            open:   parseFloat(d[1]),
            high:   parseFloat(d[2]),
            low:    parseFloat(d[3]),
            close:  parseFloat(d[4]),
            volume: parseFloat(d[5])
        }));
    } catch(e) {
        console.error('❌ Binance fetch error:', e.message);
        return null;
    }
}

// ── TRADING LOGIC ─────────────────────────────────────────────────
function isTradingAllowed(state) {
    if (state.config.force_start) return { allowed: true };
    if (state.config.manual_pause) return { allowed: false, reason: 'Manually Paused' };
    if (state.config.trading_hours.enabled) {
        const hour = new Date().getHours();
        const { start, end } = state.config.trading_hours;
        if (hour < start || hour >= end)
            return { allowed: false, reason: `Outside hours (${start}:00-${end}:00)` };
    }
    return { allowed: true };
}

function openTrade(state, type, price, atr, utbotStop) {
    let sl, tp;
    if (type === 'Buy') {
        sl = Math.max(price - 2 * atr, utbotStop);
        tp = price + 3 * atr;
    } else {
        sl = Math.min(price + 2 * atr, utbotStop);
        tp = price - 2 * atr;
    }
    state.open_trade = {
        type: type === 'Buy' ? 'LONG' : 'SHORT',
        entry_price: price,
        amount: 0.001,
        stop_loss: sl,
        tp1: tp,
        opened_at: Date.now()
    };
    console.log(`📈 Opened ${state.open_trade.type} @ $${price.toFixed(2)} | SL: $${sl.toFixed(2)} | TP: $${tp.toFixed(2)}`);
}

function closeTrade(state, price, reason) {
    const trade = state.open_trade;
    if (!trade) return;

    const usdtPL = trade.type === 'LONG'
        ? (price - trade.entry_price) * trade.amount
        : (trade.entry_price - price) * trade.amount;
    const inrPL = usdtPL * BTC_USDT_RATE;

    state.balance += inrPL;
    state.history.push({
        type:        trade.type,
        entry_price: trade.entry_price,
        exit_price:  price,
        profit_inr:  inrPL,
        exit_reason: reason,
        time:        Date.now()
    });
    state.daily_stats.trades++;
    if (inrPL < 0) state.daily_stats.loss    += Math.abs(inrPL);
    else           state.daily_stats.profit  += inrPL;

    state.open_trade = null;
    const emoji = inrPL >= 0 ? '✅' : '🛑';
    console.log(`${emoji} Closed ${trade.type} @ $${price.toFixed(2)} | P/L: ₹${inrPL.toFixed(2)} | Reason: ${reason}`);
}

let lastTradeCloseTime = 0;

async function runLoop(state) {
    // Daily reset
    const today = new Date().toDateString();
    if (state.daily_stats.date !== today) {
        console.log('🔄 Daily reset');
        state.daily_stats = { trades: 0, loss: 0, profit: 0, date: today };
    }

    const candles = await fetchCandles();
    if (!candles) return state;

    const { price, signal, atr, stop } = processSignal(candles);
    console.log(`[${new Date().toLocaleTimeString()}] BTC: $${price.toFixed(2)} | Signal: ${signal}`);

    const allowed = isTradingAllowed(state);
    if (!allowed.allowed) {
        console.log(`⏸️  ${allowed.reason}`);
        return state;
    }

    const trade = state.open_trade;
    const COOLDOWN_MS = 5 * 60 * 1000;

    if (trade) {
        const slHit = (trade.type === 'LONG' && price <= trade.stop_loss) ||
                      (trade.type === 'SHORT' && price >= trade.stop_loss);
        const tpHit = (trade.type === 'LONG' && price >= trade.tp1) ||
                      (trade.type === 'SHORT' && price <= trade.tp1);

        if (slHit)      closeTrade(state, price, 'Stop-Loss Hit');
        else if (tpHit) closeTrade(state, price, 'TP1 Hit');
        else {
            const plUSDT = trade.type === 'LONG'
                ? (price - trade.entry_price) * trade.amount
                : (trade.entry_price - price) * trade.amount;
            console.log(`  Holding ${trade.type} | Live P/L: ₹${(plUSDT * BTC_USDT_RATE).toFixed(2)}`);
        }
        if (slHit || tpHit) lastTradeCloseTime = Date.now();

    } else if (signal === 'Buy' || signal === 'Sell') {
        const cooldownOk  = !lastTradeCloseTime || (Date.now() - lastTradeCloseTime > COOLDOWN_MS);
        const tradesOk    = state.daily_stats.trades < state.config.risk.max_trades;
        const lossOk      = state.daily_stats.loss   < state.config.risk.max_daily_loss;

        if (cooldownOk && tradesOk && lossOk) {
            openTrade(state, signal, price, atr, stop);
        } else {
            console.log(`  Signal skipped — cooldown/limits active`);
        }
    }

    return state;
}

// ── MAIN ──────────────────────────────────────────────────────────
async function main() {
    console.log('🤖 UT Bot Worker starting...');

    // Load existing state from JSONBin
    let state = await getState();
    if (!state || state.empty) {
        console.log('📋 No saved state found, starting fresh');
        state = {
            balance:     START_BALANCE,
            open_trade:  null,
            history:     [],
            order_log:   [],
            config: {
                trading_hours: { enabled: true, start: 18, end: 23 },
                manual_pause:  false,
                force_start:   false,
                risk: { max_daily_loss: 1000, max_trades: 20 }
            },
            daily_stats: {
                trades: 0, loss: 0, profit: 0,
                date: new Date().toDateString()
            }
        };
    }
    console.log(`✅ State loaded | Balance: ₹${state.balance?.toFixed(2)} | Trades today: ${state.daily_stats?.trades}`);

    // Save bin ID so dashboard can use same bin
    if (_binId) console.log(`📦 JSONBin ID: ${_binId} (save this in your dashboard!)`);

    // Main loop
    setInterval(async () => {
        try {
            state = await runLoop(state);
            await setState(state);
        } catch(e) {
            console.error('❌ Loop error:', e.message);
        }
    }, LOOP_INTERVAL_MS);

    // Run immediately on start
    try {
        state = await runLoop(state);
        await setState(state);
    } catch(e) {
        console.error('❌ Initial loop error:', e.message);
    }
}

main();
