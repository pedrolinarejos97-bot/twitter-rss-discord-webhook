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
  const add = (asset, reason) => { if (!assets.includes(asset)) assets.push(asset); if (reason && !reasons.includes(reason)) reasons.push(reason); };
  const frenchEurope = /\b(france|french|eurozone|euro area|european|germany|german|eurostat|ecb|european central bank)\b/i.test(t);
  const usData = /\b(us|united states|american|nonfarm|nfp|federal reserve|fed|powell|ism|core cpi|cpi|pce|treasury)\b/i.test(t);
  const pmi = /\bpmi\b|purchasing managers|business activity/i.test(t);
  const rates = /\b(fed|federal reserve|powell|fomc|ecb|boj|boe|central bank|interest rates?|rate cut|rate hike|monetary policy|bond yields?|treasury yields?)\b/i.test(t);
  const macro = /\b(cpi|pce|inflation|ppi|payrolls|nfp|unemployment|jobless claims|gdp|ism|pmi|retail sales|economic data|business activity)\b/i.test(t);
  const equity = /\b(nasdaq|nas 100|nas100|s&p 500|s&p500|spx|dow jones|wall street|stocks?|equities|shares|tech stocks?)\b/i.test(t);
  const dollar = /\b(dollar|dxy|usd|eurusd|euro|currency|forex)\b/i.test(t);
  const gold = /\b(gold|bullion|xau|precious metal)\b/i.test(t);
  const oil = /\b(oil|crude|wti|brent|opec|petroleum|energy supply|hormuz|red sea|shipping disruption)\b/i.test(t);
  const geopolitics = GEOPOLITICAL_PATTERN.test(t);
  const below = /\b(below expectations|missed expectations|weaker than expected|falls short|decline|fell|contraction|below forecast|slows|slowing)\b/i.test(t);
  const above = /\b(beats expectations|above expectations|stronger than expected|higher than forecast|accelerates|expansion)\b/i.test(t);
  if (pmi && frenchEurope) {
    add('Euro (EUR/USD)', 'PMI europeo débil puede aumentar las expectativas de una política más flexible del BCE y presionar al euro; confirma con EUR/USD.');
    add('Bolsas europeas', 'Una actividad empresarial más débil puede pesar sobre las expectativas de beneficios y el sentimiento bursátil.');
    add('Bonos europeos', 'Los datos débiles pueden favorecer expectativas de menores tipos y movimientos a la baja en los rendimientos.');
    add('Nasdaq y S&P 500', 'Efecto normalmente indirecto; ganará relevancia si el dato cambia el sentimiento global o coincide con datos de EE. UU.');
    add('Oro (XAU/USD)', 'Dirección incierta: puede influir la demanda de refugio, el dólar y los rendimientos.');
  } else if (rates || macro) {
    add('Dólar (DXY)', 'Los datos y los bancos centrales pueden cambiar las expectativas de tipos y la demanda de dólares.');
    add('Bonos / rendimientos', 'Una sorpresa macro puede modificar las expectativas sobre inflación, crecimiento y tipos.');
    add('Nasdaq y S&P 500', 'Tipos esperados más altos suelen presionar valoraciones; tipos más bajos pueden apoyarlas, según el crecimiento.');
    add('Oro (XAU/USD)', 'Puede reaccionar al dólar, los rendimientos reales y la búsqueda de refugio.');
  }
  if (equity) add('Nasdaq y S&P 500', 'La noticia menciona directamente renta variable o índices.');
  if (dollar) add('Dólar / EUR/USD', 'La reacción dependerá de qué divisa se fortalezca y de las expectativas relativas de tipos.');
  if (gold) add('Oro (XAU/USD)', 'La noticia menciona directamente el oro o factores ligados a su demanda.');
  if (oil) { add('Petróleo (WTI/Brent)', 'Oferta, demanda y riesgos de transporte pueden mover el precio de la energía.'); add('Inflación / bonos', 'El precio de la energía puede cambiar las expectativas de inflación y rendimientos.'); }
  if (geopolitics) { add('Oro (XAU/USD)', 'La incertidumbre puede elevar la demanda de refugio, aunque la reacción no está garantizada.'); add('Petróleo (WTI/Brent)', 'Puede subir si el evento amenaza la producción o el transporte.'); add('Índices bursátiles', 'Puede aumentar la volatilidad y reducir el apetito por riesgo.'); }
  if (!assets.length) add('Mercado global', 'El texto no permite atribuir un efecto claro a un activo concreto.');
  const major = /\b(emergency|urgent|breaking|surprise|unexpected|crisis|default|bank failure|rate decision|rate cut|rate hike|core cpi|nfp|nonfarm payrolls|fomc|war|invasion|missile|airstrike|attack|explosion|sanctions|ceasefire|intervention)\b/i.test(t);
  const impact = major ? 'ALTO' : (macro || rates || oil || geopolitics) ? 'MEDIO' : 'BAJO';
  const impactEmoji = impact === 'ALTO' ? '🔴' : impact === 'MEDIO' ? '🟠' : '🟢';
  let bias = 'MIXTO / INCIERTO';
  if (below && frenchEurope) bias = 'NEGATIVO PARA LAS PERSPECTIVAS ECONÓMICAS EUROPEAS; reacción de mercado por confirmar';
  else if (above && frenchEurope) bias = 'MEJORA RELATIVA DE LA ACTIVIDAD EUROPEA; reacción de mercado por confirmar';
  else if (/\b(rate cut|dovish|lower rates|falling yields|cooler inflation|weak jobs)\b/i.test(t)) bias = 'PODRÍA FAVORECER ACTIVOS DE RIESGO; confirmar reacción';
  else if (/\b(rate hike|hawkish|higher rates|rising yields|hotter inflation|strong jobs|supply disruption|escalation|invasion|war)\b/i.test(t)) bias = 'PRESIÓN POTENCIAL SOBRE RIESGO / POSIBLE REFUGIO; confirmar reacción';
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

  const candidates = [];
  for (const item of items) {
    const id = itemId(item);
    if (!id || seen.has(id)) continue;
    const date = new Date(item.isoDate || item.pubDate || 0).getTime();
    const recent = Number.isFinite(date) && now - date <= MAX_AGE_MINUTES * 60 * 1000 && date <= now + 2 * 60 * 1000;
    if (!recent || !isRelevant(item)) continue;
    newSeen.push(id);
    candidates.push({ item, id, date, rawText: getItemText(item) });
  }
  const groups = [];
  const used = new Set();
  const isPmi = (c) => /\bpmi\b|purchasing managers|managers'? index/i.test(c.rawText);
  const countryKey = (c) => {
    const value = ((c.item.title || '') + ' ' + c.rawText).toLowerCase();
    const countries = [['france', /france|french/], ['germany', /germany|german/], ['eurozone', /euro ?zone|euro area/], ['united kingdom', /united kingdom|\buk\b|britain|british/], ['united states', /united states|\bus\b|american/], ['australia', /australia|australian/], ['japan', /japan|japanese/], ['china', /china|chinese/], ['canada', /canada|canadian/]];
    const match = countries.find((entry) => entry[1].test(value));
    return match ? match[0] : null;
  };
  for (const candidate of candidates) {
    if (used.has(candidate.id)) continue;
    const country = countryKey(candidate);
    if (country && isPmi(candidate) && !GEOPOLITICAL_PATTERN.test(candidate.rawText)) {
      const group = candidates.filter((other) => !used.has(other.id) && isPmi(other) && countryKey(other) === country && Math.abs(other.date - candidate.date) <= 5 * 60 * 1000 && !GEOPOLITICAL_PATTERN.test(other.rawText));
      group.forEach((entry) => used.add(entry.id));
      groups.push(group);
    } else { used.add(candidate.id); groups.push([candidate]); }
  }
  for (const group of groups) {
    const blocks = [];
    for (const candidate of group) {
      const item = candidate.item, id = candidate.id, date = candidate.date, rawText = candidate.rawText;
      const spanish = await translateToSpanish(rawText || item.title || 'Noticia de mercado');
      const impact = analyzeImpact(rawText + ' ' + spanish);
      const timestamp = Math.floor(date / 1000);
      const assetList = impact.assets.map((asset) => '• ' + asset).join('\n');
      const reasonList = impact.reasons.map((reason) => '• ' + reason).join('\n');
      blocks.push([impact.impactEmoji + ' **IMPACTO POTENCIAL: ' + impact.impact + '** · FinancialJuice', '🕒 <t:' + timestamp + ':t> · Confianza del análisis: ' + impact.confidence, '', '**📰 RESUMEN EN ESPAÑOL**', spanish.slice(0, 520), '', '**📊 ACTIVOS A VIGILAR Y CÓMO PUEDE AFECTAR**', assetList, '', '**💡 ¿POR QUÉ?**', reasonList, '', '**🧭 SESGO INICIAL:** ' + impact.bias].join('\n'));
      console.log('Preparada (' + impact.impact + '):', item.title || id);
    }
    const separator = '\n\n━━━━━━━━━━━━━━━━━━━━\n\n';
    const footer = '\n\n⚠️ Análisis automático orientativo; no es señal de compra/venta. Confirma con el precio y el contexto.';
    let message = blocks.join(separator) + footer;
    if (message.length > 1950) message = blocks.map((block) => block.slice(0, 430)).join(separator).slice(0, 1700) + footer;
    await sendDiscord(message.slice(0, 1990));
    console.log('Enviado grupo de ' + group.length + ' noticia(s).');
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
