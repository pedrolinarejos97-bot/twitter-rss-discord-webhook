const axios = require('axios');
const Parser = require('rss-parser');
const fs = require('fs');

const FEED_URL = 'https://www.financialjuice.com/feed.ashx?xy=rss';
const WEBHOOK = process.env.DISCORD_WEBHOOK;
const STATE_FILE = 'state.json';
const parser = new Parser();
const MAX_AGE_MINUTES = 12;
const MAX_SEEN = 800;

const IMPORTANT_PATTERNS = [
  /\b(fed|federal reserve|powell|fomc|interest rates?|rate decision|rate cut|rate hike|ecb|boj|boe|central bank|monetary policy|treasury yields?|bond yields?)\b/i,
  /\b(cpi|core cpi|pce|core pce|nfp|nonfarm payrolls?|payrolls|jobless claims|unemployment rate|gdp|ism|pmi|retail sales|producer price index|ppi|inflation|consumer prices?)\b/i,
  /\b(nasdaq|nas 100|nas100|s&p 500|s&p500|spx|us stocks?|stock futures|equity futures|dow jones|wall street|tech stocks?|megacap)\b/i,
  /\b(us dollar|dollar index|dxy|usd|gold|bullion|xau|crude oil|oil prices?|wti|brent|opec|natural gas|energy prices?)\b/i,
  /\b(breaking|market moving|surprise|unexpectedly|emergency|urgent|intervention|liquidity crisis|default|bank failure|banking crisis|recession|ceasefire|invasion|missile|airstrike|war declared|sanctions|tariffs?|trade war|oil supply|shipping disruption|geopolitical)\b/i
];

const GEOPOLITICAL_PATTERN = /\b(breaking|urgent|emergency|war|invasion|missile|airstrike|attack|explosion|sanctions|tariffs?|ceasefire|coup|nuclear|strait of hormuz|red sea|geopolitical|oil supply disruption|shipping disruption)\b/i;

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { initialized: Boolean(parsed.initialized), seen: Array.isArray(parsed.seen) ? parsed.seen : [] };
  } catch {
    return { initialized: false, seen: [] };
  }
}

function itemId(item) {
  return item.guid || item.link || `${item.title || ''}|${item.isoDate || item.pubDate || ''}`;
}

function getItemText(item) {
  return `${item.title || ''} ${item.contentSnippet || ''} ${item.content || ''}`
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isRelevant(item) {
  const text = getItemText(item);
  return IMPORTANT_PATTERNS.some((pattern) => pattern.test(text)) || GEOPOLITICAL_PATTERN.test(text);
}

async function translateToSpanish(text) {
  const clean = String(text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  try {
    const response = await axios.get('https://api.mymemory.translated.net/get', {
      params: { q: clean.slice(0, 450), langpair: 'en|es' },
      timeout: 10000
    });
    const translated = response.data?.responseData?.translatedText;
    if (response.data?.responseStatus === 200 && translated) return translated;
    console.warn('MyMemory no devolvió traducción válida; se enviará el texto original.');
  } catch (error) {
    console.warn('Falló la traducción gratuita:', error.message);
  }
  return clean;
}

function analyzeImpact(text) {
  const t = text.toLowerCase();
  const assets = [];
  const reasons = [];
  const add = (asset, reason) => {
    if (!assets.includes(asset)) assets.push(asset);
    if (reason && !reasons.includes(reason)) reasons.push(reason);
  };

  const rates = /\b(fed|federal reserve|powell|fomc|ecb|boj|boe|central bank|interest rate|rate cut|rate hike|monetary policy|treasury yield|bond yield|bonds?)\b/i.test(t);
  const macro = /\b(cpi|pce|inflation|consumer prices?|ppi|producer price|payrolls|nfp|unemployment|jobless claims|gdp|ism|pmi|retail sales|jobs report|economic data)\b/i.test(t);
  const equity = /\b(nasdaq|nas 100|nas100|s&p 500|s&p500|spx|dow jones|wall street|stocks?|equities|shares|tech stocks?)\b/i.test(t);
  const dollar = /\b(dollar|dxy|usd|currency|forex|foreign exchange)\b/i.test(t);
  const gold = /\b(gold|bullion|xau|precious metal)\b/i.test(t);
  const oil = /\b(oil|crude|wti|brent|opec|petroleum|energy supply|strait of hormuz|red sea|shipping disruption)\b/i.test(t);
  const geopolitics = GEOPOLITICAL_PATTERN.test(t);

  if (rates || macro) {
    add('Dólar (DXY)', 'Tipos y datos macro pueden cambiar las expectativas sobre la Fed y la demanda de dólares.');
    add('Bonos / rendimientos', 'Las sorpresas en inflación, empleo o bancos centrales pueden mover rápidamente los rendimientos.');
    add('Nasdaq y S&P 500', 'El mercado puede reajustar las valoraciones según las perspectivas de tipos y crecimiento.');
    add('Oro (XAU/USD)', 'Puede reaccionar al dólar, a los rendimientos reales y a la búsqueda de refugio.');
  }
  if (equity) add('Nasdaq y S&P 500', 'La noticia menciona directamente índices o renta variable.');
  if (dollar) add('Dólar (DXY)', 'Puede cambiar la demanda de dólares y el movimiento de las divisas.');
  if (gold) add('Oro (XAU/USD)', 'La noticia menciona directamente el oro o factores ligados a su demanda.');
  if (oil) {
    add('Petróleo (WTI/Brent)', 'La oferta, la demanda y los riesgos de transporte pueden alterar el precio de la energía.');
    add('Inflación / bonos', 'Un cambio en el precio de la energía puede modificar las expectativas de inflación.');
  }
  if (geopolitics) {
    add('Oro (XAU/USD)', 'La incertidumbre puede aumentar la demanda de activos refugio.');
    add('Petróleo (WTI/Brent)', 'El riesgo sobre producción o transporte puede provocar movimientos bruscos.');
    add('Índices bursátiles', 'La noticia puede cambiar el apetito por riesgo y la volatilidad.');
    add('Dólar y bonos', 'Pueden recibir flujos de refugio; la reacción depende del contexto.');
  }
  if (!assets.length) {
    add('Mercado global', 'Puede afectar al sentimiento general, pero el activo y la dirección no quedan claros solo con el texto.');
  }

  const high = /\b(emergency|urgent|breaking|surprise|unexpected|crisis|default|bank failure|rate decision|rate cut|rate hike|cpi|core cpi|nfp|nonfarm payrolls|fomc|war|invasion|missile|airstrike|attack|explosion|sanctions|ceasefire|intervention|halt|emergency meeting)\b/i.test(t);
  const medium = /\b(fed|powell|central bank|inflation|pce|ppi|gdp|ism|pmi|retail sales|jobless claims|unemployment|opec|oil|tariffs?|trade war|geopolitical|bond yields?|treasury|recession|economic data)\b/i.test(t);
  const impact = high ? 'ALTO' : medium ? 'MEDIO' : 'BAJO';
  const impactEmoji = impact === 'ALTO' ? '🔴' : impact === 'MEDIO' ? '🟠' : '🟢';

  let bias = 'MIXTO / INCIERTO';
  if (/\b(rate cut|dovish|lower rates|falling yields|cooler inflation|inflation falls|weak jobs|missed expectations|stimulus|ceasefire|peace deal|dollar falls|dollar weakens|oil supply increase)\b/i.test(t)) bias = 'PODRÍA FAVORECER ACTIVOS DE RIESGO (confirmar reacción)';
  if (/\b(rate hike|hawkish|higher rates|rising yields|hotter inflation|inflation rises|strong jobs|beats expectations|dollar rises|dollar strengthens|oil supply cut|supply disruption|escalation|invasion|war)\b/i.test(t)) bias = 'PRESIÓN POTENCIAL SOBRE RIESGO / POSIBLE REFUGIO (confirmar reacción)';

  const confidence = (rates || macro || equity || dollar || gold || oil || geopolitics) ? 'MEDIA' : 'BAJA';
  return { assets, reasons, impact, impactEmoji, bias, confidence };
}

async function sendDiscord(message) {
  if (!WEBHOOK) throw new Error('Falta el secreto DISCORD_WEBHOOK en GitHub Actions.');
  await axios.post(WEBHOOK, { content: message }, { timeout: 15000 });
}

async function main() {
  const state = loadState();
  console.log('Leyendo RSS de FinancialJuice...');
  const feed = await parser.parseURL(FEED_URL);
  const items = (feed.items || []).slice().reverse();
  const now = Date.now();
  const seen = new Set(state.seen);
  const newSeen = [];

  for (const item of items) {
    const id = itemId(item);
    if (!id || seen.has(id)) continue;
    const date = new Date(item.isoDate || item.pubDate || 0).getTime();
    const recent = Number.isFinite(date) &&
      now - date <= MAX_AGE_MINUTES * 60 * 1000 &&
      date <= now + 2 * 60 * 1000;
    if (!recent || !isRelevant(item)) continue;
    newSeen.push(id);

    const rawText = getItemText(item);
    const spanish = await translateToSpanish(rawText || item.title || 'Noticia de mercado');
    const impact = analyzeImpact(`${rawText} ${spanish}`);
    const timestamp = Math.floor(date / 1000);
    const assetList = impact.assets.map((asset) => `• ${asset}`).join('\n');
    const reasonList = impact.reasons.map((reason) => `• ${reason}`).join('\n');
    const message = [
      `${impact.impactEmoji} **IMPACTO POTENCIAL: ${impact.impact}** · FinancialJuice`,
      `🕒 <t:${timestamp}:t> · Confianza del análisis: ${impact.confidence}`,
      '',
      '**📰 RESUMEN EN ESPAÑOL**',
      spanish.slice(0, 850),
      '',
      '**📊 ACTIVOS A VIGILAR**',
      assetList,
      '',
      '**💡 ¿POR QUÉ?**',
      reasonList,
      '',
      `**🧭 SESGO INICIAL:** ${impact.bias}`,
      '',
      '⚠️ Clasificación automática orientativa, no una señal de compra/venta. No implica dirección segura; confirma con precio, volumen, calendario y niveles técnicos.'
    ].join('\n');

    await sendDiscord(message.slice(0, 1950));
    console.log(`Enviada (${impact.impact}):`, item.title || id);
  }

  const combined = [...state.seen, ...newSeen];
  const unique = [...new Set(combined)].slice(-MAX_SEEN);
  fs.writeFileSync(STATE_FILE, JSON.stringify({ initialized: true, seen: unique }, null, 2) + '\n');
  console.log(`Comprobación terminada. Elementos RSS: ${items.length}; IDs nuevos guardados: ${newSeen.length}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
