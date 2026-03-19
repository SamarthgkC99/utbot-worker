/**
 * UT Bot Trading Worker — Paper Trading (Binance BTC/USDT)
 * Runs 24/7 on Render Web Service (FREE).
 * UptimeRobot pings /health every 5 mins to prevent sleep.
 * Syncs state to JSONBin. Dashboard reads same JSONBin data.
 */

const https = require('https');
const http  = require('http');

// ── CONFIG ────────────────────────────────────────────────────────
const JSONBIN_KEY      = '$2a$10$89MGgEAgjXyETvQ4x/vEpO.2NeEiLaR7nr.4oYSl1uaOr3VihCFtu';
const JSONBIN_BASE     = 'https://api.jsonbin.io/v3';
const START_BALANCE    = 10000;
const BTC_USDT_RATE    = 85;
const LOOP_INTERVAL_MS = 5000;
const CANDLE_LIMIT     = 350;
const PORT             = process.env.PORT || 3000;

// ── KEEP-ALIVE HTTP SERVER ────────────────────────────────────────
let _state_ref = null;

http.createServer((req, res) => {
    const url = req.url.split('?')[0];

    // OPTIONS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
        res.end(); return;
    }

    if (url === '/ping') {
        // Ultra-tiny response for cron-job.org
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end('OK');

    } else if (url === '/health' || url === '/') {
        const s       = _state_ref;
        const trade   = s?.open_trade;
        const totalPL = s?.history?.reduce((a,b) => a+b.profit_inr, 0) ?? 0;
        const wins    = s?.history?.filter(t => t.profit_inr > 0).length ?? 0;
        const body    = JSON.stringify({
            status:       'running',
            time_ist:     new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
            balance_inr:  s ? s.balance.toFixed(2) : '0',
            open_trade:   trade ? trade.type + ' @ $' + trade.entry_price.toFixed(2) : 'none',
            trades_today: s?.daily_stats?.trades ?? 0,
            win_rate:     s?.history?.length ? Math.round(wins/s.history.length*100)+'%' : '0%',
            total_pl:     totalPL.toFixed(2)
        });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(body);

    } else {
        res.writeHead(404); res.end('Not found');
    }
}).listen(PORT, () => {
    console.log('🌐 HTTP server on port ' + PORT);
});

// ── HTTP FETCH (no npm deps, handles redirects) ───────────────────
function fetchJSON(url, options, redirectCount) {
    options       = options       || {};
    redirectCount = redirectCount || 0;

    return new Promise(function(resolve, reject) {
        if (redirectCount > 5) return reject(new Error('Too many redirects'));
        var urlObj = new URL(url);
        var reqOpts = {
            hostname: urlObj.hostname,
            path:     urlObj.pathname + urlObj.search,
            method:   options.method || 'GET',
            headers:  options.headers || {}
        };
        var req = https.request(reqOpts, function(res) {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchJSON(res.headers.location, options, redirectCount + 1)
                    .then(resolve).catch(reject);
            }
            var data = '';
            res.on('data', function(chunk) { data += chunk; });
            res.on('end', function() {
                try {
                    var parsed = JSON.parse(data);
                    if (res.statusCode >= 400) {
                        reject(new Error('HTTP ' + res.statusCode + ': ' + data.slice(0, 300)));
                    } else {
                        resolve(parsed);
                    }
                } catch(e) {
                    reject(new Error('JSON parse error (' + res.statusCode + '): ' + data.slice(0, 200)));
                }
            });
        });
        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

// ── JSONBIN STATE STORAGE ─────────────────────────────────────────
var _binId = null;

async function getState() {
    try {
        if (!_binId) {
            var res = await fetchJSON(JSONBIN_BASE + '/b', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Master-Key': JSONBIN_KEY,
                    'X-Bin-Name':   'utbot-state',
                    'X-Bin-Private':'true'
                },
                body: JSON.stringify({ empty: true })
            });
            console.log('JSONBin create response:', JSON.stringify(res).slice(0, 200));
            _binId = (res.metadata && res.metadata.id) ? res.metadata.id : null;
            if (_binId) {
                console.log('📦 JSONBin ID: ' + _binId + '  ← copy this into your index.html!');
            } else {
                console.error('❌ Could not create JSONBin. Response:', JSON.stringify(res));
            }
            return null;
        }
        var res2 = await fetchJSON(JSONBIN_BASE + '/b/' + _binId + '/latest', {
            headers: { 'X-Master-Key': JSONBIN_KEY }
        });
        if (res2.record && res2.record.empty) return null;
        return res2.record || null;
    } catch(e) {
        console.warn('⚠️  JSONBin read error:', e.message);
        return null;
    }
}

async function setState(state) {
    try {
        if (!_binId) { await getState(); }
        if (!_binId) { console.warn('⚠️  No binId, skipping save'); return; }
        state.daily_stats.lastUpdated = Date.now();
        await fetchJSON(JSONBIN_BASE + '/b/' + _binId, {
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

// ── ATR & UT BOT MATH ─────────────────────────────────────────────
function calculateATR(highs, lows, closes, period) {
    period = period || 14;
    var trues = closes.map(function(c, i) {
        if (i === 0) return highs[i] - lows[i];
        return Math.max(
            highs[i] - lows[i],
            Math.abs(highs[i] - closes[i-1]),
            Math.abs(lows[i]  - closes[i-1])
        );
    });
    return trues.map(function(_, i) {
        if (i < period - 1) return null;
        var sum = 0;
        for (var j = i - period + 1; j <= i; j++) sum += trues[j];
        return sum / period;
    });
}

function calculateUTBot(closes, highs, lows, keyValue, atrPeriod) {
    var atrs  = calculateATR(highs, lows, closes, atrPeriod);
    var nLoss = atrs.map(function(a) { return a ? a * keyValue : 0; });
    var stop  = [closes[0]];
    var pos   = [0];

    for (var i = 1; i < closes.length; i++) {
        var prev = stop[i-1];
        var src  = closes[i];
        var src1 = closes[i-1];
        var newStop;
        if      (src > prev && src1 > prev) newStop = Math.max(prev, src - nLoss[i]);
        else if (src < prev && src1 < prev) newStop = Math.min(prev, src + nLoss[i]);
        else newStop = src > prev ? src - nLoss[i] : src + nLoss[i];
        stop.push(newStop);

        var p;
        if      (src1 < prev && src > prev) p =  1;
        else if (src1 > prev && src < prev) p = -1;
        else p = pos[i-1];
        pos.push(p);
    }
    return { stop: stop, pos: pos, atr: atrs };
}

function processSignal(candles) {
    var closes = candles.map(function(c) { return c.close; });
    var highs  = candles.map(function(c) { return c.high;  });
    var lows   = candles.map(function(c) { return c.low;   });

    var utBot2 = calculateUTBot(closes, highs, lows, 2, 300);
    var utBot1 = calculateUTBot(closes, highs, lows, 2, 1);

    var signalBuy  = utBot2.pos[utBot2.pos.length - 1] ===  1 ? 'Buy'  : 'Hold';
    var signalSell = utBot1.pos[utBot1.pos.length - 1] === -1 ? 'Sell' : 'Hold';

    var signal = 'Hold';
    if (signalBuy  === 'Buy')  signal = 'Buy';
    if (signalSell === 'Sell') signal = 'Sell';

    var atr14 = calculateATR(highs, lows, closes, 14);
    var atr   = atr14[atr14.length - 1] || 0;
    var stop  = signal === 'Buy'
        ? utBot2.stop[utBot2.stop.length - 1]
        : utBot1.stop[utBot1.stop.length - 1];

    return { price: closes[closes.length - 1], signal: signal, atr: atr, stop: stop };
}

// ── FETCH CANDLES (tries 3 endpoints) ────────────────────────────
async function fetchCandles() {
    var endpoints = [
        'https://api.binance.us/api/v3/klines?symbol=BTCUSDT&interval=5m&limit='    + CANDLE_LIMIT,
        'https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=5m&limit=' + CANDLE_LIMIT,
        'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit='   + CANDLE_LIMIT
    ];

    for (var i = 0; i < endpoints.length; i++) {
        try {
            var data = await fetchJSON(endpoints[i]);
            if (!Array.isArray(data)) {
                console.warn('⚠️  Endpoint ' + i + ' returned non-array:', JSON.stringify(data).slice(0, 100));
                continue;
            }
            console.log('✅ Candles fetched from endpoint ' + i + ' (' + data.length + ' candles)');
            return data.map(function(d) {
                return {
                    time:   d[0],
                    open:   parseFloat(d[1]),
                    high:   parseFloat(d[2]),
                    low:    parseFloat(d[3]),
                    close:  parseFloat(d[4]),
                    volume: parseFloat(d[5])
                };
            });
        } catch(e) {
            console.warn('⚠️  Endpoint ' + i + ' failed:', e.message);
        }
    }
    console.error('❌ All Binance endpoints failed');
    return null;
}

// ── TRADING LOGIC ─────────────────────────────────────────────────
function isTradingAllowed(state) {
    if (state.config.force_start) return { allowed: true };
    if (state.config.manual_pause) return { allowed: false, reason: 'Manually Paused' };
    if (state.config.trading_hours.enabled) {
        var hour  = new Date().getHours();
        var start = state.config.trading_hours.start;
        var end   = state.config.trading_hours.end;
        if (hour < start || hour >= end)
            return { allowed: false, reason: 'Outside hours (' + start + ':00-' + end + ':00)' };
    }
    return { allowed: true };
}

function openTrade(state, type, price, atr, utbotStop) {
    var sl, tp;
    if (type === 'Buy') {
        sl = Math.max(price - 2 * atr, utbotStop);
        tp = price + 3 * atr;
    } else {
        sl = Math.min(price + 2 * atr, utbotStop);
        tp = price - 2 * atr;
    }
    state.open_trade = {
        type:        type === 'Buy' ? 'LONG' : 'SHORT',
        entry_price: price,
        amount:      0.001,
        stop_loss:   sl,
        tp1:         tp,
        rr_mode:     '1:1',
        opened_at:   Date.now()
    };
    console.log('📈 Opened ' + state.open_trade.type + ' @ $' + price.toFixed(2) +
        ' | SL: $' + sl.toFixed(2) + ' | TP: $' + tp.toFixed(2));
}

function closeTrade(state, price, reason) {
    var trade = state.open_trade;
    if (!trade) return;

    var usdtPL = trade.type === 'LONG'
        ? (price - trade.entry_price) * trade.amount
        : (trade.entry_price - price) * trade.amount;
    var inrPL = usdtPL * BTC_USDT_RATE;

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
    var emoji = inrPL >= 0 ? '✅' : '🛑';
    console.log(emoji + ' Closed ' + trade.type + ' @ $' + price.toFixed(2) +
        ' | P/L: ₹' + inrPL.toFixed(2) + ' | Reason: ' + reason);
}

var lastTradeCloseTime = 0;

async function runLoop(state) {
    // ── Sync config from JSONBin every loop ──
    // This allows dashboard pause/resume/force buttons to work
    try {
        var remote = await fetchJSON(JSONBIN_BASE + '/b/' + _binId + '/latest', {
            headers: { 'X-Master-Key': JSONBIN_KEY }
        });
        if (remote && remote.record && !remote.record.empty) {
            var r = remote.record;
            // Only sync config — don't overwrite local trade state
            if (r.config) {
                state.config.manual_pause = r.config.manual_pause;
                state.config.force_start  = r.config.force_start;
                if (r.config.risk) {
                    state.config.risk.max_trades    = r.config.risk.max_trades;
                    state.config.risk.max_daily_loss = r.config.risk.max_daily_loss;
                }
            }
            // If dashboard force-closed a trade
            if (!r.open_trade && state.open_trade) {
                console.log('📋 Dashboard closed trade — syncing');
                state.open_trade   = null;
                state.history      = r.history      || state.history;
                state.balance      = r.balance      || state.balance;
                state.daily_stats  = r.daily_stats  || state.daily_stats;
            }
            // Sync history clear if dashboard cleared it
            if (r.history && r.history.length === 0 && state.history.length > 0) {
                console.log('📋 Dashboard cleared history — syncing');
                state.history     = [];
                state.balance     = r.balance     || state.balance;
                state.daily_stats = r.daily_stats || state.daily_stats;
            }
        }
    } catch(e) { console.warn('⚠️  Config sync error:', e.message); }

    // ── Daily reset ──
    var today = new Date().toDateString();
    if (state.daily_stats.date !== today) {
        console.log('🔄 Daily reset');
        state.daily_stats = { trades: 0, loss: 0, profit: 0, date: today };
    }

    var candles = await fetchCandles();
    if (!candles) return state;

    var sig   = processSignal(candles);
    var price = sig.price;
    var signal= sig.signal;
    var atr   = sig.atr;
    var stop  = sig.stop;

    // Save signal data to state so dashboard can display it
    state.last_signal  = signal;
    state.last_atr     = atr;
    state.last_price   = price;
    state.last_ut_stop = stop;

    console.log('[' + new Date().toLocaleTimeString() + '] BTC: $' + price.toFixed(2) + ' | Signal: ' + signal);

    var allowed = isTradingAllowed(state);
    if (!allowed.allowed) {
        console.log('⏸️  ' + allowed.reason);
        return state;
    }

    var trade = state.open_trade;
    var COOLDOWN_MS = 5 * 60 * 1000;

    if (trade) {
        var slHit = (trade.type === 'LONG'  && price <= trade.stop_loss) ||
                    (trade.type === 'SHORT' && price >= trade.stop_loss);
        var tpHit = (trade.type === 'LONG'  && price >= trade.tp1) ||
                    (trade.type === 'SHORT' && price <= trade.tp1);

        if (slHit)      { closeTrade(state, price, 'Stop-Loss Hit'); lastTradeCloseTime = Date.now(); }
        else if (tpHit) { closeTrade(state, price, 'TP1 Hit');       lastTradeCloseTime = Date.now(); }
        else {
            var plUSDT = trade.type === 'LONG'
                ? (price - trade.entry_price) * trade.amount
                : (trade.entry_price - price) * trade.amount;
            console.log('  Holding ' + trade.type + ' | Live P/L: ₹' + (plUSDT * BTC_USDT_RATE).toFixed(2));
        }
    } else if (signal === 'Buy' || signal === 'Sell') {
        var cooldownOk = !lastTradeCloseTime || (Date.now() - lastTradeCloseTime > COOLDOWN_MS);
        var tradesOk   = state.daily_stats.trades < state.config.risk.max_trades;
        var lossOk     = state.daily_stats.loss   < state.config.risk.max_daily_loss;

        if (cooldownOk && tradesOk && lossOk) {
            openTrade(state, signal, price, atr, stop);
        } else {
            console.log('  Signal skipped — cooldown/limits active');
        }
    }

    return state;
}

// ── MAIN ──────────────────────────────────────────────────────────
async function main() {
    console.log('🤖 UT Bot Worker starting...');

    var state = await getState();
    if (!state || state.empty) {
        console.log('📋 No saved state, starting fresh');
        state = {
            balance:    START_BALANCE,
            open_trade: null,
            history:    [],
            order_log:  [],
            config: {
                trading_hours: { enabled: true, start: 18, end: 23 },
                manual_pause:  false,
                force_start:   false,
                risk: { max_daily_loss: 1000, max_trades: 20 }
            },
            daily_stats: { trades: 0, loss: 0, profit: 0, date: new Date().toDateString() }
        };
    }
    console.log('✅ State loaded | Balance: ₹' + (state.balance || 0).toFixed(2) +
        ' | Trades today: ' + (state.daily_stats && state.daily_stats.trades || 0));

    _state_ref = state;

    // Run immediately
    try {
        state = await runLoop(state);
        await setState(state);
        _state_ref = state;
    } catch(e) {
        console.error('❌ Initial loop error:', e.message);
    }

    // Then every 5 seconds
    setInterval(async function() {
        try {
            state = await runLoop(state);
            await setState(state);
            _state_ref = state;
        } catch(e) {
            console.error('❌ Loop error:', e.message);
        }
    }, LOOP_INTERVAL_MS);
}

main();
