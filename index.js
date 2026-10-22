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
  // Central banks and rates
  /\b(fed|federal reserve|powell|fomc|interest rates?|rate decision|rate cut|rate hike|ecb|boj|boe|central bank|monetary policy|treasury yields?|bond yields?)\b/i,
  // High-impact US macro
  /\b(cpi|core cpi|pce|core pce|nfp|nonfarm payrolls?|payrolls|jobless claims|unemployment rate|nonfarm|gdp|ism|pmi|retail sales|producer price index|ppi|inflation|consumer prices?)\b/i,
  // Indexes and risk assets
  /\b(nasdaq|nas 100|nas100|s&p 500|s&p500|spx|us stocks?|stock futures|equity futures|dow jones|wall street|tech stocks?|megacap)\b/i,
  // Dollar, FX and commodities
  /\b(us dollar|dollar index|dxy|usd|gold|bullion|xau|crude oil|oil prices?|wti|brent|opec|natural gas|energy prices?)\b/i,
  // Market-moving language
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

function isRelevant(item) {
  const text = `${item.title || ''} ${item.contentSnippet || ''} ${item.content || ''}`
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ');
  const isMarketRelevant = IMPORTANT_PATTERNS.some((pattern) => pattern.test(text));
  const isUrgentGeopolitical = GEOPOLITICAL_PATTERN.test(text);
  return isMarketRelevant || isUrgentGeopolitical;
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
    console.warn('MyMemory no devolvió traducción válida; se enviará el titular original.');
  } catch (error) {
    console.warn('Falló la traducción gratuita:', error.message);
  }
  return clean;
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

  // First execution: establish a baseline and only consider headlines from the last 12 minutes.
  for (const item of items) {
    const id = itemId(item);
    if (!id) continue;
    const date = new Date(item.isoDate || item.pubDate || 0).getTime();
    if (seen.has(id)) continue;
    newSeen.push(id);
    if (state.initialized && Number.isFinite(date) && now - date <= MAX_AGE_MINUTES * 60 * 1000 && date <= now + 2 * 60 * 1000 && isRelevant(item)) {
      const title = (item.title || 'Noticia de FinancialJuice').trim();
      const description = (item.contentSnippet || item.content || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      const spanish = await translateToSpanish(description ? `${title}. ${description}` : title);
      const timestamp = Number.isFinite(date) ? Math.floor(date / 1000) : Math.floor(now / 1000);
      const link = item.link || 'https://www.financialjuice.com/';
      const message = `🚨 **FINANCIALJUICE · NOTICIA POTENCIALMENTE RELEVANTE**\n<t:${timestamp}:t> · Fuente: FinancialJuice\n\n${spanish.slice(0, 1600)}\n\nOriginal: ${link}`;
      await sendDiscord(message);
      console.log('Enviada:', title);
    } else if (!state.initialized && Number.isFinite(date) && now - date <= MAX_AGE_MINUTES * 60 * 1000 && isRelevant(item)) {
      const title = (item.title || 'Noticia de FinancialJuice').trim();
      const spanish = await translateToSpanish(title);
      const timestamp = Math.floor(date / 1000);
      const link = item.link || 'https://www.financialjuice.com/';
      await sendDiscord(`🚨 **FINANCIALJUICE · NOTICIA POTENCIALMENTE RELEVANTE**\n<t:${timestamp}:t> · Fuente: FinancialJuice\n\n${spanish.slice(0, 1600)}\n\nOriginal: ${link}`);
      console.log('Enviada durante la inicialización:', title);
    }
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
