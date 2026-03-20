/**
 * Bot 1 — UT Bot Trading (BTCUSDT 5m)
 * State in memory. Saves to Upstash only on trade open/close.
 * Dashboard reads /state endpoint directly.
 */

const https = require('https');
const http  = require('http');

// ── Config ────────────────────────────────────────────────
const PORT             = process.env.PORT || 3000;
const START_BALANCE    = 10000;
const BTC_USDT_RATE    = 85;
const LOOP_INTERVAL_MS = 5000;
const CANDLE_LIMIT     = 350;
const UPSTASH_URL      = 'https://robust-kitten-78595.upstash.io';
const UPSTASH_TOKEN    = 'gQAAAAAAATMDAAIncDEyZjJkNzQyMDQyN2Q0ODEwOTI1ZGY4MTczMWM4MGQzYnAxNzg1OTU';
const REDIS_KEY        = 'bot1_state';

// ── In-memory state ───────────────────────────────────────
let state = {
    balance:      START_BALANCE,
    open_trade:   null,
    history:      [],
    order_log:    [],
    last_signal:  'Hold',
    last_atr:     0,
    last_price:   0,
    last_ut_stop: 0,
    config: {
        manual_pause: false,
        force_start:  false,
        risk: { max_daily_loss: 1000, max_trades: 20 }
    },
    daily_stats: { trades: 0, loss: 0, profit: 0, date: new Date().toDateString() }
};

// ── Upstash Redis (save/load) ─────────────────────────────
async function saveState() {
    try {
        const encoded = encodeURIComponent(JSON.stringify(state));
        await fetchJSON(UPSTASH_URL + '/set/' + REDIS_KEY + '/' + encoded, {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN }
        });
        console.log('💾 State saved to Upstash');
    } catch(e) { console.warn('⚠️  Upstash save error:', e.message); }
}

async function loadState() {
    try {
        const res = await fetchJSON(UPSTASH_URL + '/get/' + REDIS_KEY, {
            headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN }
        });
        if (res && res.result) {
            const saved = JSON.parse(res.result);
            state = {
                ...state, ...saved,
                config: {
                    ...state.config, ...(saved.config || {}),
                    risk: { ...state.config.risk, ...(saved.config?.risk || {}) }
                }
            };
            console.log('✅ State loaded from Upstash | Balance: ₹' + state.balance.toFixed(2));
        } else {
            console.log('📋 No saved state, starting fresh');
        }
    } catch(e) { console.warn('⚠️  Upstash load error:', e.message); }
}

// ── HTTP Server ───────────────────────────────────────────
http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const headers = {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    };

    if (req.method === 'OPTIONS') {
        res.writeHead(204, headers); res.end(); return;
    }

    // Full state for dashboard
    if (url === '/state' && req.method === 'GET') {
        res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(state));
        return;
    }

    // Control commands from dashboard buttons
    if (url === '/config' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const cmd = JSON.parse(body);
                if (cmd.manual_pause !== undefined) state.config.manual_pause = cmd.manual_pause;
                if (cmd.force_start  !== undefined) state.config.force_start  = cmd.force_start;
                if (cmd.clear_history) {
                    state.history = [];
                    state.daily_stats.trades = 0;
                    state.daily_stats.loss   = 0;
                    state.daily_stats.profit = 0;
                    await saveState();
                }
                if (cmd.force_close && state.open_trade) {
                    const price = state.last_price;
                    const trade = state.open_trade;
                    const usdtPL = trade.type === 'LONG'
                        ? (price - trade.entry_price) * trade.amount
                        : (trade.entry_price - price) * trade.amount;
                    const inrPL = usdtPL * BTC_USDT_RATE;
                    state.balance += inrPL;
                    state.history.push({
                        type: trade.type, entry_price: trade.entry_price,
                        exit_price: price, profit_inr: inrPL,
                        exit_reason: 'Force Stop', amount: trade.amount,
                        rr_mode: '1:1', opened_at: trade.opened_at, time: Date.now()
                    });
                    state.daily_stats.trades++;
                    if (inrPL < 0) state.daily_stats.loss   += Math.abs(inrPL);
                    else           state.daily_stats.profit += inrPL;
                    state.open_trade = null;
                    state.config.manual_pause = true;
                    await saveState();
                }
                await saveState();
                res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch(e) {
                res.writeHead(400, headers);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // Ping for cron-job.org
    if (url === '/ping' || url === '/') {
        res.writeHead(200, { ...headers, 'Content-Type': 'text/plain' });
        res.end('OK');
        return;
    }

    // Health check
    if (url === '/health') {
        const wins    = state.history.filter(t => t.profit_inr > 0).length;
        const totalPL = state.history.reduce((a, b) => a + b.profit_inr, 0);
        res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status:       'running ✅',
            balance_inr:  '₹' + state.balance.toFixed(2),
            open_trade:   state.open_trade ? state.open_trade.type + ' @ $' + state.open_trade.entry_price.toFixed(2) : 'none',
            trades_today: state.daily_stats.trades,
            win_rate:     state.history.length ? Math.round(wins / state.history.length * 100) + '%' : '0%',
            total_pl:     '₹' + totalPL.toFixed(2),
            signal:       state.last_signal,
            time_ist:     new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
        }));
        return;
    }

    res.writeHead(404, headers); res.end('Not found');

}).listen(PORT, () => console.log('🌐 Server on port ' + PORT));

// ── HTTP Fetch ────────────────────────────────────────────
function fetchJSON(url, options, redirectCount) {
    options       = options       || {};
    redirectCount = redirectCount || 0;
    return new Promise((resolve, reject) => {
        if (redirectCount > 5) return reject(new Error('Too many redirects'));
        const urlObj = new URL(url);
        const req = https.request({
            hostname: urlObj.hostname,
            path:     urlObj.pathname + urlObj.search,
            method:   options.method || 'GET',
            headers:  options.headers || {}
        }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
                return fetchJSON(res.headers.location, options, redirectCount + 1).then(resolve).catch(reject);
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (res.statusCode >= 400) reject(new Error('HTTP ' + res.statusCode + ': ' + data.slice(0, 200)));
                    else resolve(parsed);
                } catch(e) { reject(new Error('JSON parse: ' + data.slice(0, 100))); }
            });
        });
        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

// ── Fetch Candles ─────────────────────────────────────────
async function fetchCandles(interval, limit) {
    const endpoints = [
        `https://api.binance.us/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`,
        `https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`,
        `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`
    ];
    for (const url of endpoints) {
        try {
            const data = await fetchJSON(url);
            if (!Array.isArray(data)) continue;
            console.log(`✅ Candles fetched (${data.length})`);
            return data.map(d => ({
                time: d[0], open: parseFloat(d[1]), high: parseFloat(d[2]),
                low: parseFloat(d[3]), close: parseFloat(d[4]), volume: parseFloat(d[5])
            }));
        } catch(e) { console.warn('⚠️  Candle fetch failed:', e.message); }
    }
    return null;
}

// ── Indicators ────────────────────────────────────────────
function calcATR(candles, period) {
    period = period || 14;
    const trues = candles.map((c, i) => i === 0 ? c.high - c.low :
        Math.max(c.high - c.low, Math.abs(c.high - candles[i-1].close), Math.abs(c.low - candles[i-1].close)));
    return trues.map((_, i) => {
        if (i < period - 1) return null;
        let sum = 0; for (let j = i - period + 1; j <= i; j++) sum += trues[j];
        return sum / period;
    });
}

function calcUTBot(candles, keyValue, atrPeriod) {
    const closes = candles.map(c => c.close);
    const atrs   = calcATR(candles, atrPeriod);
    const nLoss  = atrs.map(a => a ? a * keyValue : 0);
    const stop   = [closes[0]], pos = [0];
    for (let i = 1; i < closes.length; i++) {
        const prev = stop[i-1], src = closes[i], src1 = closes[i-1];
        let ns;
        if      (src > prev && src1 > prev) ns = Math.max(prev, src - nLoss[i]);
        else if (src < prev && src1 < prev) ns = Math.min(prev, src + nLoss[i]);
        else ns = src > prev ? src - nLoss[i] : src + nLoss[i];
        stop.push(ns);
        let p;
        if      (src1 < prev && src > prev) p =  1;
        else if (src1 > prev && src < prev) p = -1;
        else p = pos[i-1];
        pos.push(p);
    }
    return { stop, pos };
}

// ── Signal Processing ─────────────────────────────────────
function processSignal(candles) {
    const closes = candles.map(c => c.close);
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);
    const n      = closes.length;

    const utBot2 = calcUTBot(candles, 2, 300);
    const utBot1 = calcUTBot(candles, 2, 1);

    const signalBuy  = utBot2.pos[n-1] ===  1 ? 'Buy'  : 'Hold';
    const signalSell = utBot1.pos[n-1] === -1 ? 'Sell' : 'Hold';

    let signal = 'Hold';
    if (signalBuy  === 'Buy')  signal = 'Buy';
    if (signalSell === 'Sell') signal = 'Sell';

    const atr14 = calcATR(candles, 14);
    const atr   = atr14[n-1] || 0;
    const stop  = signal === 'Buy' ? utBot2.stop[n-1] : utBot1.stop[n-1];

    return { price: closes[n-1], signal, atr, stop, utBot2, utBot1 };
}

// ── Trading Logic ─────────────────────────────────────────
function isTradingAllowed() {
    if (state.config.force_start)  return { allowed: true };
    if (state.config.manual_pause) return { allowed: false, reason: 'Manually Paused' };
    return { allowed: true };
}

function openTrade(signal, price, atr, utbotStop) {
    let sl, tp;
    if (signal === 'Buy') {
        sl = Math.max(price - 2 * atr, utbotStop);
        tp = price + 3 * atr;
    } else {
        sl = Math.min(price + 2 * atr, utbotStop);
        tp = price - 2 * atr;
    }
    state.open_trade = {
        type:        signal === 'Buy' ? 'LONG' : 'SHORT',
        entry_price: price,
        amount:      0.001,
        stop_loss:   sl,
        tp1:         tp,
        rr_mode:     '1:1',
        opened_at:   Date.now()
    };
    console.log(`📈 Opened ${state.open_trade.type} @ $${price.toFixed(2)} | SL: $${sl.toFixed(2)} | TP: $${tp.toFixed(2)}`);
}

function closeTrade(price, reason) {
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
        amount:      trade.amount,
        rr_mode:     trade.rr_mode || '1:1',
        opened_at:   trade.opened_at,
        time:        Date.now()
    });
    state.daily_stats.trades++;
    if (inrPL < 0) state.daily_stats.loss   += Math.abs(inrPL);
    else           state.daily_stats.profit += inrPL;
    state.open_trade = null;
    const emoji = inrPL >= 0 ? '✅' : '🛑';
    console.log(`${emoji} Closed ${trade.type} @ $${price.toFixed(2)} | P/L: ₹${inrPL.toFixed(2)} | ${reason}`);
}

let lastTradeCloseTime = 0;
const COOLDOWN_MS = 5 * 60 * 1000;

// ── Main Loop ─────────────────────────────────────────────
// ── Session Check (6 PM – 11 PM IST = 12:30 UTC – 17:30 UTC) ──
function isInSession() {
    const now    = new Date();
    const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    const start  = 12 * 60 + 30;  // 12:30 UTC = 18:00 IST
    const end    = 17 * 60 + 30;  // 17:30 UTC = 23:00 IST
    return utcMin >= start && utcMin < end;
}

async function runLoop() {
    // Daily reset
    const today = new Date().toDateString();
    if (state.daily_stats.date !== today) {
        console.log('🔄 Daily reset');
        state.daily_stats = { trades: 0, loss: 0, profit: 0, date: today };
    }

    // ── Session filter — only trade 6 PM to 11 PM IST ──────
    if (!state.config.force_start && !isInSession()) {
        const istTime = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
        console.log('[' + istTime + ' IST] Outside session (18:00-23:00) — skipping Binance API call');
        state.last_signal = 'Hold';
        return;
    }

    const candles = await fetchCandles('5m', CANDLE_LIMIT);
    if (!candles) return;

    const { price, signal, atr, stop } = processSignal(candles);
    state.last_price   = price;
    state.last_signal  = signal;
    state.last_atr     = atr;
    state.last_ut_stop = stop;

    console.log(`[${new Date().toLocaleTimeString('en-IN', {timeZone:'Asia/Kolkata'})} IST] BTC: $${price.toFixed(2)} | Signal: ${signal}`);

    const allowed = isTradingAllowed();
    if (!allowed.allowed) {
        console.log('⏸️  ' + allowed.reason);
        return;
    }

    const trade = state.open_trade;
    if (trade) {
        const slHit = (trade.type === 'LONG'  && price <= trade.stop_loss) ||
                      (trade.type === 'SHORT' && price >= trade.stop_loss);
        const tpHit = (trade.type === 'LONG'  && price >= trade.tp1) ||
                      (trade.type === 'SHORT' && price <= trade.tp1);
        if (slHit)      { closeTrade(price, 'Stop-Loss Hit'); lastTradeCloseTime = Date.now(); await saveState(); }
        else if (tpHit) { closeTrade(price, 'TP1 Hit');       lastTradeCloseTime = Date.now(); await saveState(); }
        else {
            const pl = trade.type === 'LONG'
                ? (price - trade.entry_price) * trade.amount
                : (trade.entry_price - price) * trade.amount;
            console.log(`  Holding ${trade.type} | Live P/L: ₹${(pl * BTC_USDT_RATE).toFixed(2)}`);
        }
    } else if (signal === 'Buy' || signal === 'Sell') {
        const cooldownOk = !lastTradeCloseTime || (Date.now() - lastTradeCloseTime > COOLDOWN_MS);
        const tradesOk   = state.daily_stats.trades < state.config.risk.max_trades;
        const lossOk     = state.daily_stats.loss   < state.config.risk.max_daily_loss;
        if (cooldownOk && tradesOk && lossOk) {
            openTrade(signal, price, atr, stop);
            await saveState();
        } else {
            console.log('  Signal skipped — cooldown/limits');
        }
    }
}

// ── Boot ──────────────────────────────────────────────────
async function main() {
    console.log('🤖 Bot 1 (UT Bot) starting...');
    await loadState();
    await runLoop();
    setInterval(runLoop, LOOP_INTERVAL_MS);
}

main();
