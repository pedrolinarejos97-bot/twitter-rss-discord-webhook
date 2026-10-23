const axios = require('axios');
const Parser = require('rss-parser');
const fs = require('fs');

const FEED_URL = 'https://www.financialjuice.com/feed.ashx?xy=rss';
const WEBHOOK = process.env.DISCORD_WEBHOOK;
const STATE_FILE = 'state.json';
const parser = new Parser();
const MAX_AGE_MINUTES = 12;
const MAX_SEEN = 500;

const IMPORTANT_PATTERNS = [
  /\b(fed|federal reserve|powell|fomc|interest rates?|rate decision|rate cut|rate hike|ecb|boj|boe|central bank|monetary policy|treasury yields?|bond yields?)\b/i,
  /\b(cpi|core cpi|pce|core pce|nfp|nonfarm payrolls?|payrolls|jobless claims|unemployment rate|nonfarm|gdp|ism|pmi|retail sales|producer price index|ppi|inflation|consumer prices?)\b/i,
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
  return item.guid || item.link || `${item.title || ''}|${item.pubDate || ''}`;
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
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  if (/\b(fed|federal reserve|powell|fomc|ecb|boj|boe|central bank|interest rate|rate cut|rate hike|monetary policy|treasury yield|bond yield|bonds?)\b/i.test(t)) {
    add('Bonos y rendimientos', 'Las expectativas de tipos y las compras/ventas de deuda pueden mover los rendimientos.');
    add('Dólar (DXY)', 'Los cambios esperados en los tipos suelen alterar el atractivo relativo del dólar.');
    add('Nasdaq y S&P 500', 'Los tipos afectan a la valoración de las acciones, especialmente las tecnológicas.');
    add('Oro', 'El oro puede reaccionar a los rendimientos reales y al dólar.');
  }

  if (/\b(cpi|pce|inflation|inflationary|consumer prices?|ppi|producer price|payrolls|nfp|unemployment|jobless claims|gdp|ism|pmi|retail sales|economic data|jobs report)\b/i.test(t)) {
    add('Dólar (DXY)', 'Los datos macroeconómicos pueden cambiar las expectativas sobre la política de la Fed.');
    add('Bonos y rendimientos', 'Una sorpresa en inflación o empleo puede mover rápidamente los rendimientos.');
    add('Nasdaq y S&P 500', 'El mercado puede reajustar sus expectativas de crecimiento y tipos.');
    add('Oro', 'Puede reaccionar al dólar y a los rendimientos tras el dato.');
  }

  if (/\b(nasdaq|nas 100|nas100|s&p 500|s&p500|spx|dow jones|wall street|stocks?|equities|shares|tech stocks?)\b/i.test(t)) {
    add('Nasdaq y S&P 500', 'La noticia afecta directamente al sentimiento o a las expectativas sobre la renta variable.');
  }

  if (/\b(dollar|dxy|usd|currency|forex|foreign exchange)\b/i.test(t)) {
    add('Dólar (DXY)', 'La noticia puede alterar la demanda de dólares y los movimientos de divisas.');
    add('Oro', 'El oro suele ser sensible a los movimientos del dólar.');
  }

  if (/\b(gold|bullion|xau|precious metal)\b/i.test(t)) {
    add('Oro (XAU/USD)', 'La noticia menciona directamente el oro o factores que influyen en su demanda.');
  }

  if (/\b(oil|crude|wti|brent|opec|petroleum|energy supply|strait of hormuz|red sea|shipping disruption)\b/i.test(t)) {
    add('Petróleo (WTI/Brent)', 'La oferta, el transporte y los riesgos geopolíticos pueden alterar las expectativas de suministro.');
    add('Inflación y bonos', 'Un encarecimiento de la energía puede cambiar las expectativas de inflación y tipos.');
  }

  if (GEOPOLITICAL_PATTERN.test(t)) {
    add('Oro', 'La incertidumbre geopolítica puede aumentar la demanda de activos refugio.');
    add('Petróleo (WTI/Brent)', 'El riesgo sobre la producción o el transporte puede provocar movimientos bruscos.');
    add('Nasdaq y S&P 500', 'Un cambio en la percepción del riesgo puede afectar al apetito por activos de riesgo.');
    add('Dólar (DXY) y bonos', 'En episodios de tensión puede aumentar la demanda de refugio, aunque la reacción depende del contexto.');
  }

  if (assets.length === 0) {
    add('Nasdaq, S&P 500, oro, dólar y petróleo', 'Noticia potencialmente relevante para el sentimiento general del mercado; el impacto concreto no está claro solo con este titular.');
  }

  return { assets, reasons };
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
    if (!id) continue;
    const date = new Date(item.isoDate || item.pubDate || 0).getTime();
    if (seen.has(id)) continue;
    newSeen.push(id);

    const recent = Number.isFinite(date) &&
      now - date <= MAX_AGE_MINUTES * 60 * 1000 &&
      date <= now + 2 * 60 * 1000;

    if (!recent || !isRelevant(item)) continue;

    const title = (item.title || 'Noticia de FinancialJuice').trim();
    const rawText = getItemText(item);
    const spanish = await translateToSpanish(rawText || title);
    const impact = analyzeImpact(`${rawText} ${spanish}`);
    const timestamp = Math.floor(date / 1000);
    const assetList = impact.assets.map((asset) => `• ${asset}`).join('\n');
    const reasonList = impact.reasons.map((reason) => `• ${reason}`).join('\n');

    const message = [
      '🚨 **NOTICIA DE MERCADO · FINANCIALJUICE**',
      `🕒 <t:${timestamp}:t>`,
      '',
      '**📰 RESUMEN EN ESPAÑOL**',
      spanish.slice(0, 1300),
      '',
      '**📊 ACTIVOS QUE PODRÍA AFECTAR**',
      assetList,
      '',
      '**💡 ¿POR QUÉ?**',
      reasonList,
      '',
      '⚠️ *Impacto potencial, no una señal de compra/venta. La dirección depende del contexto y de la reacción del mercado.*'
    ].join('\n');

    await sendDiscord(message.slice(0, 1950));
    console.log('Enviada con análisis de impacto:', title);
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
