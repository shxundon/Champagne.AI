const WS_BASE_URL = 'wss://ws.deriv.com/websockets/v3';

const symbolEl = document.getElementById('symbol');
const providerNameEl = document.getElementById('providerName');
const priceEl = document.getElementById('price');
const connectionEl = document.getElementById('connection');
const logsEl = document.getElementById('logs');
const appIdInput = document.getElementById('appIdInput');
const tokenInput = document.getElementById('tokenInput');
const connectBtn = document.getElementById('connectBtn');
const authStatusEl = document.getElementById('authStatus');
const symbolInput = document.getElementById('symbolInput');
const providerSelect = document.getElementById('providerSelect');
const timeframeSelect = document.getElementById('timeframeSelect');
const subscribeBtn = document.getElementById('subscribeBtn');
const analyzeBtn = document.getElementById('analyzeBtn');
const buyBtn = document.getElementById('buyBtn');
const sellBtn = document.getElementById('sellBtn');
const autoTradeCheckbox = document.getElementById('autoTradeCheckbox');
const stakeInput = document.getElementById('stakeInput');
const apiUrlInput = document.getElementById('apiUrlInput');
const apiBodyInput = document.getElementById('apiBodyInput');
const apiGetBtn = document.getElementById('apiGetBtn');
const apiPostBtn = document.getElementById('apiPostBtn');
const apiResponseEl = document.getElementById('apiResponse');
const derivChartContainer = document.getElementById('deriv-chart-container');
const tvWidgetContainer = document.getElementById('tv-widget-container');
const chartSwipe = document.getElementById('chartSwipe');
const chartProviderLabel = document.getElementById('chartProviderLabel');
const chartTabButtons = document.querySelectorAll('.chart-tab-btn');
const analysisResults = document.getElementById('analysisResults');
const insightsResults = document.getElementById('insightsResults');

let currentSymbol = symbolInput.value.trim().toUpperCase() || 'R_100';
let currentProvider = providerSelect.value;
let appId = '';
let token = '';
let authorized = false;
let pendingSubscription = null;
let pendingChartLoad = null;
let tradingViewWidget = null;
let tvPriceInterval = null;
let pendingCandleRequest = null;
let pendingProposalRequest = null;
let pendingBuyRequest = null;
let chart = null;
let candlestickSeries = null;
let currentDerivBar = null;
let derivChartGranularity = null;
let liveClosePrices = [];
let liveInsightTimeframe = '5m';
let autoTradeEnabled = autoTradeCheckbox.checked;
let tradeStake = Number(stakeInput.value) || 1;
let publicChartTicker = null;
let ws = null;

const timeframeSeconds = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '1d': 86400 };

if (!window.fetch) {
    window.fetch = function (url, options) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open(options && options.method ? options.method : 'GET', url, true);
            if (options && options.headers) {
                Object.keys(options.headers).forEach(function (key) {
                    xhr.setRequestHeader(key, options.headers[key]);
                });
            }
            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve({
                        ok: true,
                        status: xhr.status,
                        json: function () { return Promise.resolve(JSON.parse(xhr.responseText)); },
                        text: function () { return Promise.resolve(xhr.responseText); }
                    });
                } else {
                    reject(new Error(xhr.statusText || 'Fetch error'));
                }
            };
            xhr.onerror = function () { reject(new Error('Network error')); };
            xhr.send(options && options.body ? options.body : null);
        });
    };
}

function updateConnection(text) {
    connectionEl.innerText = text;
}

function updateAuthStatus(text) {
    if (authStatusEl) {
        authStatusEl.innerText = text;
    }
}

function updateProvider(provider) {
    if (currentProvider === 'tradingview' && provider !== 'tradingview') {
        stopTradingViewPriceTicker();
        stopPublicChartTicker();
    }

    currentProvider = provider;
    providerNameEl.innerText = provider === 'deriv' ? 'Deriv' : 'TradingView';

    if (provider === 'tradingview') {
        updateConnection('Widget mode');
        updatePrice('Chart only');
    }
}

function updateSymbol(symbol) {
    currentSymbol = symbol;
    symbolEl.innerText = symbol;
}

function stopTradingViewPriceTicker() {
    if (tvPriceInterval) {
        clearInterval(tvPriceInterval);
        tvPriceInterval = null;
        log('Stopped TradingView ticker polling.');
    }
}

function stopPublicChartTicker() {
    if (publicChartTicker) {
        clearInterval(publicChartTicker);
        publicChartTicker = null;
        log('Stopped public live chart polling.');
    }
}

function parseTradingViewSymbol(symbol) {
    const normalized = symbol.replace(/\s+/g, '').toUpperCase();
    if (normalized.includes(':')) {
        const [exchange, pair] = normalized.split(':');
        return { exchange, pair };
    }
    return { exchange: null, pair: normalized };
}

async function fetchTradingViewPrice(symbol) {
    const { exchange, pair } = parseTradingViewSymbol(symbol);
    const upperPair = pair.toUpperCase();

    try {
        if (exchange === 'BINANCE' || (!exchange && /USDT$|BUSD$|USD$/.test(upperPair))) {
            const ticker = exchange === 'BINANCE' ? pair : upperPair;
            const response = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${ticker}`);
            const data = await response.json();
            if (data.price) {
                return Number(data.price);
            }
        }

        if (exchange === 'COINBASE' || (!exchange && /USD$/.test(upperPair))) {
            const ticker = upperPair.replace(/USD$/, '-USD');
            const response = await fetch(`https://api.coinbase.com/v2/prices/${ticker}/spot`);
            const data = await response.json();
            if (data && data.data && data.data.amount) {
                return Number(data.data.amount);
            }
        }

        if (!exchange && /EURUSD|GBPUSD|USDJPY|AUDUSD|USDCAD|NZDUSD/.test(upperPair)) {
            const base = upperPair.slice(0, 3);
            const quote = upperPair.slice(3);
            const response = await fetch(`https://api.exchangerate.host/latest?base=${base}&symbols=${quote}`);
            const data = await response.json();
            if (data && data.rates && data.rates[quote]) {
                return Number(data.rates[quote]);
            }
        }
    } catch (error) {
        log(`TradingView price fetch failed: ${error.message}`);
    }

    return null;
}

function startTradingViewPriceTicker(symbol) {
    stopTradingViewPriceTicker();

    const fetchAndUpdate = async () => {
        const price = await fetchTradingViewPrice(symbol);
        if (price) {
            updatePrice(price, symbol);
            log(`TradingView price updated for ${symbol}.`);
        } else {
            updatePrice('Chart only', symbol);
        }
    };

    fetchAndUpdate();
    tvPriceInterval = setInterval(fetchAndUpdate, 15000);
}

function updatePrice(price, symbol) {
    if (typeof price === 'number') {
        priceEl.innerText = Number(price).toFixed(5);
    } else {
        priceEl.innerText = price;
    }
    if (symbol) {
        updateSymbol(symbol);
    }
}

function renderApiResponse(title, payload) {
    apiResponseEl.innerHTML = '';
    const heading = document.createElement('h2');
    heading.innerText = title;
    const content = document.createElement('pre');
    content.innerText = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    apiResponseEl.appendChild(heading);
    apiResponseEl.appendChild(content);
}

function formatFetchError(error) {
    return { error: error.message || String(error) };
}

async function apiGetRequest() {
    const url = apiUrlInput.value.trim();
    if (!url) {
        renderApiResponse('GET Response', { error: 'URL is required.' });
        return;
    }
    try {
        const response = await fetch(url);
        const data = await response.json().catch(() => response.text());
        renderApiResponse('GET Response', { status: response.status, ok: response.ok, data });
    } catch (error) {
        renderApiResponse('GET Error', formatFetchError(error));
    }
}

async function apiPostRequest() {
    const url = apiUrlInput.value.trim();
    if (!url) {
        renderApiResponse('POST Response', { error: 'URL is required.' });
        return;
    }
    let bodyValue = apiBodyInput.value.trim();
    let body;
    try {
        body = bodyValue ? JSON.parse(bodyValue) : {};
    } catch (error) {
        renderApiResponse('POST Error', { error: 'Invalid JSON body.' });
        return;
    }
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await response.json().catch(() => response.text());
        renderApiResponse('POST Response', { status: response.status, ok: response.ok, data });
    } catch (error) {
        renderApiResponse('POST Error', formatFetchError(error));
    }
}

async function startPublicLiveChartTicker(symbol, timeframe) {
    stopPublicChartTicker();
    const granularity = timeframeSeconds[timeframe] || 300;

    const fetchAndUpdate = async () => {
        const price = await fetchTradingViewPrice(symbol);
        if (price !== null) {
            updatePrice(price, symbol);
            updateDerivChartBar(price);
            log(`Public chart updated for ${symbol}.`);
        }
    };

    await fetchAndUpdate();
    publicChartTicker = setInterval(fetchAndUpdate, 10000);
}

function log(message) {
    const logEntry = document.createElement('p');
    logEntry.innerText = `> ${message}`;
    logsEl.prepend(logEntry);
}

function getWsUrl(appId) {
    return `${WS_BASE_URL}?app_id=${encodeURIComponent(appId.trim())}`;
}

function updateTradeSettings() {
    autoTradeEnabled = autoTradeCheckbox.checked;
    tradeStake = Number(stakeInput.value) || 1;
}

function handleWsMessage(msg) {
    let data;
    try {
        data = JSON.parse(msg.data);
    } catch (error) {
        log('Received non-JSON WebSocket message.');
        return;
    }

    if (data.msg_type === 'authorize') {
        if (data.authorize && data.authorize.status === 'success') {
            authorized = true;
            updateAuthStatus('Authorized');
            log('Authorization successful.');
            if (pendingSubscription) {
                subscribeTicks(pendingSubscription);
                pendingSubscription = null;
            }
            if (pendingChartLoad) {
                loadDerivLiveChart(pendingChartLoad.symbol, pendingChartLoad.timeframe);
                pendingChartLoad = null;
            }
        } else {
            updateConnection('Authorization failed');
            updateAuthStatus('Failed');
            log(`Authorization error: ${JSON.stringify(data.authorize)}`);
        }
        return;
    }

    if (data.msg_type === 'candles' && pendingCandleRequest) {
        if (data.echo_req && data.echo_req.candles === pendingCandleRequest.symbol) {
            pendingCandleRequest.resolve(data);
            pendingCandleRequest = null;
            return;
        }
    }

    if (data.msg_type === 'proposal' && pendingProposalRequest) {
        if (data.proposal && data.proposal.symbol === pendingProposalRequest.symbol) {
            pendingProposalRequest.resolve(data.proposal);
            pendingProposalRequest = null;
            return;
        }
        if (data.echo_req && data.echo_req.symbol === pendingProposalRequest.symbol) {
            pendingProposalRequest.resolve(data.proposal);
            pendingProposalRequest = null;
            return;
        }
    }

    if (data.msg_type === 'buy' && pendingBuyRequest) {
        if (data.buy) {
            pendingBuyRequest.resolve(data);
            pendingBuyRequest = null;
            return;
        }
    }

    if (data.msg_type === 'tick' && data.tick) {
        if (data.tick.symbol && data.tick.symbol !== currentSymbol) {
            return;
        }

        if (currentProvider === 'deriv') {
            const quote = Number(data.tick.quote);
            updatePrice(quote, data.tick.symbol || currentSymbol);
            updateDerivChartBar(quote);
        }
        return;
    }

    if (data.error) {
        if (pendingCandleRequest) {
            pendingCandleRequest.reject(new Error(data.error.message || 'Deriv error')); 
            pendingCandleRequest = null;
        }
        log(`Error: ${JSON.stringify(data.error)}`);
        return;
    }

    if (data.msg_type) {
        log(`${data.msg_type} received.`);
    }
}

function connectToDeriv() {
    if (!window.WebSocket) {
        updateConnection('WebSocket not supported');
        updateAuthStatus('Unavailable');
        log('This browser does not support WebSockets.');
        return;
    }

    appId = appIdInput.value.trim();
    token = tokenInput.value.trim();
    if (!appId || !token) {
        updateConnection('Enter App ID and Token');
        updateAuthStatus('Not authorized');
        log('Deriv credentials are required to connect.');
        return;
    }

    if (ws) {
        ws.close();
        ws = null;
        authorized = false;
    }

    const url = getWsUrl(appId);
    ws = new WebSocket(url);
    updateConnection('Connecting to Deriv...');
    log('Opening Deriv WebSocket...');

    ws.addEventListener('open', () => {
        updateConnection('Connected');
        updateAuthStatus('Authorizing...');
        log('WebSocket connected, authorizing...');
        ws.send(JSON.stringify({ authorize: token }));
    });

    ws.addEventListener('message', handleWsMessage);

    ws.addEventListener('error', () => {
        updateConnection('WebSocket error');
        log('WebSocket error encountered.');
    });

    ws.addEventListener('close', () => {
        updateConnection('Closed');
        updateAuthStatus('Not authorized');
        log('WebSocket connection closed.');
        authorized = false;
    });
}

function showDerivChart() {
    stopTradingViewPriceTicker();
    stopPublicChartTicker();
    derivChartContainer.classList.remove('hidden');
    tvWidgetContainer.classList.add('hidden');
    chartProviderLabel.innerText = 'Live chart';
    updateChartTabSelection('deriv');
}

function showTradingViewWidget() {
    derivChartContainer.classList.add('hidden');
    tvWidgetContainer.classList.remove('hidden');
    stopPublicChartTicker();
    chartProviderLabel.innerText = 'TradingView widget';
    updateChartTabSelection('tv');
    insightsResults.innerHTML = '<p>Live insights are only available for Deriv live data. Switch to Deriv for real-time signal updates.</p>';
}

function createDerivChart(symbol, timeframe) {
    if (!window.LightweightCharts) {
        log('Chart library not loaded yet.');
        return;
    }

    if (chart) {
        chart.remove();
        chart = null;
        candlestickSeries = null;
        currentDerivBar = null;
    }

    const chartOptions = {
        width: derivChartContainer.clientWidth,
        height: 520,
        layout: {
            background: { color: '#0f1720' },
            textColor: '#f5f8ff',
        },
        grid: {
            vertLines: { color: '#1f2a3d' },
            horzLines: { color: '#1f2a3d' },
        },
        rightPriceScale: {
            borderColor: '#1f2a3d',
        },
        timeScale: {
            borderColor: '#1f2a3d',
            timeVisible: true,
            secondsVisible: false,
        },
    };

    chart = LightweightCharts.createChart(derivChartContainer, chartOptions);
    candlestickSeries = chart.addCandlestickSeries({
        upColor: '#26a69a',
        downColor: '#ef5350',
        borderDownColor: '#ef5350',
        borderUpColor: '#26a69a',
        wickDownColor: '#ef5350',
        wickUpColor: '#26a69a',
    });

    derivChartGranularity = timeframeSeconds[timeframe] || 300;
}

window.addEventListener('resize', () => {
    if (chart) {
        chart.applyOptions({ width: derivChartContainer.clientWidth });
    }
});

function updateChartTabSelection(target) {
    chartTabButtons.forEach(button => {
        button.classList.toggle('active', button.dataset.target === target);
    });
}

chartTabButtons.forEach(button => {
    button.addEventListener('click', () => {
        const target = button.dataset.target;
        if (target === 'deriv') {
            showDerivChart();
            updateProvider('deriv');
        } else {
            showTradingViewWidget();
            updateProvider('tradingview');
        }
        const targetEl = target === 'deriv' ? derivChartContainer : tvWidgetContainer;
        if (targetEl && targetEl.scrollIntoView) {
            targetEl.scrollIntoView({ behavior: 'smooth', inline: 'start' });
        }
    });
});

function updateDerivChartBar(price) {
    if (!candlestickSeries || !derivChartGranularity) return;

    const now = Math.floor(Date.now() / 1000);
    const barTime = Math.floor(now / derivChartGranularity) * derivChartGranularity;

    if (currentDerivBar && currentDerivBar.time === barTime) {
        currentDerivBar.high = Math.max(currentDerivBar.high, price);
        currentDerivBar.low = Math.min(currentDerivBar.low, price);
        currentDerivBar.close = price;
        candlestickSeries.update(currentDerivBar);
        if (liveClosePrices.length) {
            liveClosePrices[liveClosePrices.length - 1] = price;
        }
    } else {
        currentDerivBar = {
            time: barTime,
            open: price,
            high: price,
            low: price,
            close: price,
        };
        candlestickSeries.update(currentDerivBar);
        liveClosePrices.push(price);
        if (liveClosePrices.length > 300) {
            liveClosePrices.shift();
        }
    }
    updateLiveInsights();
}

async function loadDerivLiveChart(symbol, timeframe) {
    if (!symbol) {
        log('Enter a symbol to load the chart.');
        return;
    }

    symbol = symbol.trim().toUpperCase();
    updateSymbol(symbol);
    updateProvider('deriv');
    showDerivChart();
    updateConnection('Loading Deriv chart...');

    createDerivChart(symbol, timeframe);

    try {
        const response = await requestDerivCandles(symbol, timeframeSeconds[timeframe] || 300);
        if (!response || !Array.isArray(response.candles)) {
            throw new Error('Invalid candle response');
        }

        const bars = response.candles.map(candle => ({
            time: Math.floor(Number(candle.epoch)),
            open: Number(candle.open),
            high: Number(candle.high),
            low: Number(candle.low),
            close: Number(candle.close),
        }));

        if (bars.length) {
            candlestickSeries.setData(bars);
            currentDerivBar = bars[bars.length - 1];
            liveClosePrices = bars.map(bar => bar.close);
            liveInsightTimeframe = timeframe;
            updatePrice(currentDerivBar.close, symbol);
            updateConnection('Deriv live chart ready');
            log(`Deriv live chart loaded for ${symbol}.`);
            updateLiveInsights();
        } else {
            updateConnection('No candle history');
            log('No historical candle data available for chart.');
        }
    } catch (error) {
        updateConnection('Chart load failed');
        log(`Error loading Deriv chart: ${error.message}`);
    }
}

function loadTradingViewWidget(symbol) {
    if (!window.TradingView) {
        log('TradingView library not loaded yet.');
        return;
    }

    symbol = symbol.trim();
    updateSymbol(symbol);
    updateProvider('tradingview');
    updateConnection('TradingView widget loaded');

    if (tradingViewWidget && tradingViewWidget.remove) {
        tradingViewWidget.remove();
    }

    tvWidgetContainer.innerHTML = '';

    tradingViewWidget = new TradingView.widget({
        autosize: true,
        symbol,
        interval: 'D',
        timezone: 'Etc/UTC',
        theme: 'dark',
        style: '1',
        locale: 'en',
        toolbar_bg: '#2d2d2d',
        container_id: 'tv-widget-container',
        hide_side_toolbar: false,
        enable_publishing: false,
        allow_symbol_change: true,
    });

    showTradingViewWidget();
    updatePrice('Widget only');
    startTradingViewPriceTicker(symbol);
    log(`TradingView widget loaded for ${symbol}.`);
}

async function loadPublicLiveChart(symbol, timeframe) {
    if (!symbol) {
        log('Enter a symbol to load the live chart.');
        return;
    }

    symbol = symbol.trim().toUpperCase();
    updateSymbol(symbol);
    updateProvider('tradingview');
    showDerivChart();
    updateConnection('Loading public live chart...');

    createDerivChart(symbol, timeframe);
    stopTradingViewPriceTicker();
    stopPublicChartTicker();

    const history = await fetchTradingViewHistory(symbol, timeframeSeconds[timeframe] || 300);
    if (!history || !history.length) {
        updateConnection('Public chart load failed');
        log(`No public history available for ${symbol}.`);
        return;
    }

    const now = Math.floor(Date.now() / 1000);
    const granularity = timeframeSeconds[timeframe] || 300;
    const bars = history.map((bar, index) => {
        const time = bar.time || now - granularity * (history.length - index);
        return {
            time,
            open: bar.open || bar.close,
            high: bar.high || bar.close,
            low: bar.low || bar.close,
            close: bar.close,
        };
    });

    candlestickSeries.setData(bars);
    currentDerivBar = bars[bars.length - 1];
    liveClosePrices = bars.map(bar => bar.close);
    liveInsightTimeframe = timeframe;
    updatePrice(currentDerivBar.close, symbol);
    updateConnection('Public live chart ready');
    log(`Public live chart loaded for ${symbol}.`);
    updateLiveInsights();
    await startPublicLiveChartTicker(symbol, timeframe);
}

function getSelectedTimeframe() {
    return timeframeSelect.value || '5m';
}

function calculateSMA(values, period) {
    if (values.length < period) return null;
    const slice = values.slice(-period);
    return slice.reduce((sum, v) => sum + v, 0) / period;
}

function calculateEMA(values, period) {
    if (values.length < period) return null;
    const k = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
    for (let i = period; i < values.length; i++) {
        ema = values[i] * k + ema * (1 - k);
    }
    return ema;
}

function calculateRSI(values, period = 14) {
    if (values.length < period + 1) return null;
    let gains = 0;
    let losses = 0;
    for (let i = values.length - period; i < values.length; i++) {
        const change = values[i] - values[i - 1];
        if (change > 0) gains += change;
        if (change < 0) losses -= change;
    }
    if (losses === 0) return 100;
    const rs = gains / losses;
    return 100 - 100 / (1 + rs);
}

function renderAnalysis(analysis) {
    analysisResults.innerHTML = '';
    const title = document.createElement('h2');
    title.innerText = `Analysis for ${analysis.symbol} (${analysis.timeframe})`;
    const list = document.createElement('ul');

    const fields = [
        { label: 'Latest close', value: analysis.close },
        { label: 'SMA 20', value: analysis.sma20 },
        { label: 'SMA 50', value: analysis.sma50 },
        { label: 'EMA 10', value: analysis.ema10 },
        { label: 'RSI 14', value: analysis.rsi14 },
        { label: 'Signal', value: analysis.signal },
        { label: 'Recommendation', value: analysis.recommendation },
        { label: 'Summary', value: analysis.summary },
    ];

    fields.forEach(({ label, value }) => {
        const item = document.createElement('li');
        item.innerText = `${label}: ${value}`;
        list.appendChild(item);
    });

    analysisResults.appendChild(title);
    analysisResults.appendChild(list);
}

function renderInsights(insights) {
    insightsResults.innerHTML = '';
    if (!insights) {
        insightsResults.innerHTML = '<p>Live insights will appear after the Deriv live chart loads.</p>';
        return;
    }

    const title = document.createElement('h2');
    title.innerText = `Live Insights for ${insights.symbol} (${insights.timeframe})`;
    const list = document.createElement('ul');

    const fields = [
        { label: 'Latest close', value: insights.latestClose },
        { label: 'Trend', value: insights.trend },
        { label: 'Momentum', value: insights.momentum },
        { label: 'Bias', value: insights.bias },
        { label: 'SMA 20', value: insights.sma20 },
        { label: 'SMA 50', value: insights.sma50 },
        { label: 'RSI 14', value: insights.rsi14 },
        { label: 'Support (10)', value: insights.support },
        { label: 'Resistance (10)', value: insights.resistance },
        { label: 'Recommendation', value: insights.recommendation },
    ];

    fields.forEach(({ label, value }) => {
        const item = document.createElement('li');
        item.innerText = `${label}: ${value}`;
        list.appendChild(item);
    });

    const summary = document.createElement('p');
    summary.style.marginTop = '12px';
    summary.style.color = '#c3d1e5';
    summary.innerText = insights.summary;

    insightsResults.appendChild(title);
    insightsResults.appendChild(list);
    insightsResults.appendChild(summary);
}

function calculateMomentum(values, period = 5) {
    if (values.length < period + 1) return null;
    const latest = values[values.length - 1];
    const reference = values[values.length - 1 - period];
    return ((latest - reference) / reference) * 100;
}

function buildLiveInsight(symbol, timeframe) {
    if (!liveClosePrices || liveClosePrices.length < 50) {
        return null;
    }

    const latestClose = liveClosePrices[liveClosePrices.length - 1];
    const sma20 = calculateSMA(liveClosePrices, 20);
    const sma50 = calculateSMA(liveClosePrices, 50);
    const ema10 = calculateEMA(liveClosePrices, 10);
    const rsi14 = calculateRSI(liveClosePrices, 14);
    const momentum = calculateMomentum(liveClosePrices, 5);
    const recentSlice = liveClosePrices.slice(-10);
    const support = Math.min(...recentSlice);
    const resistance = Math.max(...recentSlice);

    let trend = 'Neutral';
    if (sma20 && sma50 && latestClose > sma20 && sma20 > sma50) {
        trend = 'Strong Uptrend';
    } else if (sma20 && sma50 && latestClose < sma20 && sma20 < sma50) {
        trend = 'Strong Downtrend';
    } else if (sma20 && sma50 && latestClose > sma20 && latestClose < sma50) {
        trend = 'Sideways / Pullback';
    }

    let bias = 'Neutral';
    if (rsi14 !== null) {
        bias = rsi14 >= 70 ? 'Overbought' : rsi14 <= 30 ? 'Oversold' : 'Balanced';
    }

    let recommendation = 'Hold / monitor price action';
    if (trend === 'Strong Uptrend' && bias !== 'Overbought') {
        recommendation = 'Consider Buy on strength';
    } else if (trend === 'Strong Downtrend' && bias !== 'Oversold') {
        recommendation = 'Consider Sell on weakness';
    } else if (trend === 'Strong Uptrend' && bias === 'Overbought') {
        recommendation = 'Cautious: potential pullback';
    } else if (trend === 'Strong Downtrend' && bias === 'Oversold') {
        recommendation = 'Cautious: possible short-term reversal';
    }

    const summary = `Derived from the last ${liveClosePrices.length} bars: ${trend}, ${bias}, and momentum of ${momentum !== null ? momentum.toFixed(2) : 'N/A'}%.`;

    return {
        symbol,
        timeframe,
        latestClose: latestClose.toFixed(5),
        sma20: sma20 ? sma20.toFixed(5) : 'N/A',
        sma50: sma50 ? sma50.toFixed(5) : 'N/A',
        ema10: ema10 ? ema10.toFixed(5) : 'N/A',
        rsi14: rsi14 ? rsi14.toFixed(2) : 'N/A',
        momentum: momentum !== null ? `${momentum.toFixed(2)}%` : 'N/A',
        trend,
        bias,
        support: support.toFixed(5),
        resistance: resistance.toFixed(5),
        recommendation,
        summary,
    };
}

function updateLiveInsights() {
    const insight = buildLiveInsight(currentSymbol, liveInsightTimeframe);
    renderInsights(insight);
}

function determineSignal(close, sma20, sma50, rsi14) {
    const signals = [];
    if (close > sma20 && sma20 > sma50) signals.push('Bullish momentum');
    if (close < sma20 && sma20 < sma50) signals.push('Bearish momentum');
    if (close > sma20 && close < sma50) signals.push('Neutral / downtrend');
    if (close < sma20 && close > sma50) signals.push('Neutral / uptrend');
    if (rsi14 >= 70) signals.push('Overbought');
    if (rsi14 <= 30) signals.push('Oversold');
    return signals.length ? signals.join(', ') : 'No clear signal';
}

function getAutoTradeDirection(recommendation) {
    if (!recommendation) return null;
    const normalized = recommendation.toLowerCase();
    if (normalized.includes('buy')) return 'CALL';
    if (normalized.includes('sell')) return 'PUT';
    return null;
}

function requestDerivProposal(symbol, contractType, duration = 5) {
    return new Promise((resolve, reject) => {
        if (!authorized) {
            reject(new Error('WebSocket is not authorized yet.'));
            return;
        }

        pendingProposalRequest = { resolve, reject, symbol, contractType, duration };
        ws.send(JSON.stringify({
            proposal: 1,
            amount: tradeStake,
            basis: 'stake',
            contract_type: contractType,
            currency: 'USD',
            symbol,
            duration,
            duration_unit: 'm',
        }));
    });
}

function executeDerivBuy(proposal) {
    return new Promise((resolve, reject) => {
        if (!authorized) {
            reject(new Error('WebSocket is not authorized yet.'));
            return;
        }

        pendingBuyRequest = { resolve, reject, proposal_id: proposal.id };
        ws.send(JSON.stringify({ buy: proposal.id, price: proposal.ask_price }));
    });
}

async function autoExecuteTrade(recommendation) {
    updateTradeSettings();
    if (!autoTradeEnabled || currentProvider !== 'deriv') {
        log('Auto trade is disabled or not running on Deriv provider.');
        return;
    }

    const direction = getAutoTradeDirection(recommendation);
    if (!direction) {
        log('Auto trade skipped: no actionable recommendation.');
        return;
    }

    try {
        log(`Auto trade: requesting ${direction} proposal for ${currentSymbol}...`);
        const proposal = await requestDerivProposal(currentSymbol, direction, 5);
        if (!proposal || !proposal.id) {
            throw new Error('Invalid proposal returned.');
        }
        log(`Proposal received: ${direction} at ${proposal.ask_price || proposal.bid_price}`);

        const buyResponse = await executeDerivBuy(proposal);
        log(`Auto trade executed: ${JSON.stringify(buyResponse)}`);
    } catch (error) {
        log(`Auto trade failed: ${error.message}`);
    }
}

function requestDerivCandles(symbol, granularity) {
    return new Promise((resolve, reject) => {
        if (!authorized) {
            reject(new Error('WebSocket is not authorized yet.'));
            return;
        }

        pendingCandleRequest = { resolve, reject, symbol, granularity };
        ws.send(JSON.stringify({
            candles: symbol,
            granularity,
            count: 100,
            end: 'latest',
        }));
    });
}

async function fetchTradingViewHistory(symbol, granularitySeconds) {
    const { exchange, pair } = parseTradingViewSymbol(symbol);
    const upperPair = pair.toUpperCase();
    const bars = [];

    try {
        if (exchange === 'BINANCE' || (!exchange && /USDT$|BUSD$|USD$/.test(upperPair))) {
            const interval = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '1d': '1d' }[getSelectedTimeframe()] || '5m';
            const ticker = exchange === 'BINANCE' ? pair : upperPair;
            const response = await fetch(`https://api.binance.com/api/v3/klines?symbol=${ticker}&interval=${interval}&limit=100`);
            const data = await response.json();
            if (Array.isArray(data)) {
                return data.map(row => ({ time: Math.floor(Number(row[0]) / 1000), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]) }));
            }
        }

        if (exchange === 'COINBASE' || (!exchange && /USD$/.test(upperPair))) {
            const ticker = exchange === 'COINBASE' ? pair : upperPair.replace(/USD$/, '-USD');
            const response = await fetch(`https://api.pro.coinbase.com/products/${ticker}/candles?granularity=${granularitySeconds}&limit=100`);
            const data = await response.json();
            if (Array.isArray(data)) {
                return data.map(row => ({ time: Number(row[0]), open: Number(row[3]), high: Number(row[2]), low: Number(row[1]), close: Number(row[4]) })).reverse();
            }
        }

        if (!exchange && /EURUSD|GBPUSD|USDJPY|AUDUSD|USDCAD|NZDUSD/.test(upperPair) && granularitySeconds === 86400) {
            const end = new Date();
            const start = new Date(end.getTime() - 100 * 86400 * 1000);
            const base = upperPair.slice(0, 3);
            const quote = upperPair.slice(3);
            const response = await fetch(`https://api.exchangerate.host/timeseries?start_date=${start.toISOString().slice(0,10)}&end_date=${end.toISOString().slice(0,10)}&base=${base}&symbols=${quote}`);
            const data = await response.json();
            if (data && data.rates) {
                return Object.entries(data.rates).map(([date, rate]) => ({ time: Math.floor(new Date(date).getTime() / 1000), close: Number(rate[quote]) }));
            }
        }
    } catch (error) {
        log(`History fetch failed for ${symbol}: ${error.message}`);
    }

    return bars;
}

async function analyzeSymbol(symbol, provider, timeframe) {
    const granularity = timeframeSeconds[timeframe] || 300;
    const closePrices = [];
    let source = provider;

    if (provider === 'deriv') {
        const response = await requestDerivCandles(symbol, granularity);
        if (!response || !response.candles) {
            throw new Error('Deriv candle response invalid');
        }
        response.candles.forEach(candle => closePrices.push(Number(candle.close)));
    } else {
        const history = await fetchTradingViewHistory(symbol, granularity);
        if (!history || !history.length) {
            throw new Error('Unable to fetch history for TradingView symbol');
        }
        history.forEach(bar => closePrices.push(Number(bar.close)));
        source = 'TradingView/public API';
    }

    if (closePrices.length < 50) {
        throw new Error('Not enough historical data to analyze this pair.');
    }

    const latestClose = closePrices[closePrices.length - 1];
    const sma20 = calculateSMA(closePrices, 20);
    const sma50 = calculateSMA(closePrices, 50);
    const ema10 = calculateEMA(closePrices, 10);
    const rsi14 = calculateRSI(closePrices, 14);
    const signal = determineSignal(latestClose, sma20, sma50, rsi14);
    const summary = `${provider === 'deriv' ? 'Deriv' : 'TradingView'} analysis using ${source} for ${symbol}`;

    let recommendation = 'Hold / monitor price action';
    if (signal.includes('Bullish momentum') && rsi14 !== null && rsi14 < 70) {
        recommendation = 'Consider Buy on strength';
    } else if (signal.includes('Bearish momentum') && rsi14 !== null && rsi14 > 30) {
        recommendation = 'Consider Sell on weakness';
    } else if (signal.includes('Bullish momentum') && rsi14 !== null && rsi14 >= 70) {
        recommendation = 'Cautious: Overbought, consider wait';
    } else if (signal.includes('Bearish momentum') && rsi14 !== null && rsi14 <= 30) {
        recommendation = 'Cautious: Oversold, consider wait';
    }

    return {
        symbol,
        timeframe,
        source,
        close: latestClose.toFixed(5),
        sma20: sma20 ? sma20.toFixed(5) : 'N/A',
        sma50: sma50 ? sma50.toFixed(5) : 'N/A',
        ema10: ema10 ? ema10.toFixed(5) : 'N/A',
        rsi14: rsi14 ? rsi14.toFixed(2) : 'N/A',
        signal,
        recommendation,
        summary,
    };
}

function subscribeTicks(symbol) {
    if (!symbol) {
        log('Please enter a valid trading pair symbol.');
        return;
    }

    stopTradingViewPriceTicker();
    stopPublicChartTicker();

    symbol = symbol.trim().toUpperCase();
    updateSymbol(symbol);

    if (!authorized) {
        pendingSubscription = symbol;
        log(`Queued Deriv subscription for ${symbol} until authorization completes.`);
        return;
    }

    log(`Subscribing to Deriv ticks for ${symbol}`);
    ws.send(JSON.stringify({ ticks: symbol }));
}

connectBtn.addEventListener('click', () => {
    connectToDeriv();
});

autoTradeCheckbox.addEventListener('change', updateTradeSettings);
stakeInput.addEventListener('change', updateTradeSettings);

subscribeBtn.addEventListener('click', () => {
    const symbol = symbolInput.value.trim();
    if (!symbol) {
        log('Please enter a trading pair before subscribing.');
        return;
    }

    const provider = providerSelect.value;
    const timeframe = getSelectedTimeframe();
    updateProvider(provider);

    if (provider === 'tradingview') {
        loadPublicLiveChart(symbol, timeframe);
    } else {
        if (!authorized) {
            if (!ws) {
                connectToDeriv();
            }
            pendingSubscription = symbol;
            pendingChartLoad = { symbol, timeframe };
            updateConnection('Awaiting Deriv authorization...');
            log('Deriv subscription and chart load queued until authorization completes.');
            return;
        }

        loadDerivLiveChart(symbol, timeframe);
        subscribeTicks(symbol);
    }
});

analyzeBtn.addEventListener('click', async () => {
    const symbol = symbolInput.value.trim();
    if (!symbol) {
        log('Please enter a trading pair before analyzing.');
        return;
    }

    const provider = providerSelect.value;
    const timeframe = getSelectedTimeframe();
    updateProvider(provider);

    if (provider === 'deriv' && !authorized) {
        if (!ws) {
            connectToDeriv();
        }
        analysisResults.innerHTML = '<p>Please connect to Deriv to analyze this symbol.</p>';
        log('Deriv analysis requires connection and authorization. Press Connect.');
        return;
    }

    analysisResults.innerHTML = 'Analyzing...';
    try {
        const analysis = await analyzeSymbol(symbol, provider, timeframe);
        renderAnalysis(analysis);
        log(`Analysis complete for ${symbol}.`);
        if (provider === 'deriv') {
            await autoExecuteTrade(analysis.summary || analysis.signal);
        }
    } catch (error) {
        analysisResults.innerHTML = `<p style="color: #f88;">Analysis failed: ${error.message}</p>`;
        log(`Analysis failed for ${symbol}: ${error.message}`);
    }
});

async function executeManualTrade(contractType) {
    if (!authorized) {
        log('Connect and authorize Deriv before manual trading.');
        return;
    }
    if (currentProvider !== 'deriv') {
        log('Manual trade is only supported on Deriv provider.');
        return;
    }
    updateTradeSettings();
    try {
        log(`Requesting ${contractType} proposal for ${currentSymbol}...`);
        const proposal = await requestDerivProposal(currentSymbol, contractType, 5);
        log(`Proposal received: ${JSON.stringify(proposal)}`);
        const buyResponse = await executeDerivBuy(proposal);
        log(`Manual trade executed: ${JSON.stringify(buyResponse)}`);
    } catch (error) {
        log(`Manual trade failed: ${error.message}`);
    }
}

buyBtn.addEventListener('click', async () => {
    await executeManualTrade('CALL');
});

sellBtn.addEventListener('click', async () => {
    await executeManualTrade('PUT');
});

apiGetBtn.addEventListener('click', apiGetRequest);
apiPostBtn.addEventListener('click', apiPostRequest);
