const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'when', 'where', 'which',
  'about', 'into', 'your', 'you', 'are', 'can', 'will', 'have', 'has', 'had', 'our',
  'who', 'how', 'why', 'not', 'but', 'all', 'any', 'out', 'get', 'got', 'let', 'its',
  'their', 'they', 'them', 'was', 'were', 'been', 'being', 'there', 'here', 'also',
  'more', 'most', 'than', 'then', 'too', 'very', 'yes', 'no', 'we', 'us', 'i', 'a',
  'an', 'of', 'to', 'in', 'on', 'or', 'as', 'is', 'it', 'at', 'by', 'be', 'do', 'does',
  'did', 'if', 'up', 'down', 'over', 'under', 'again', 'same'
]);

const DEFAULT_CONTEXT_CHAR_LIMIT = 12000;

const INTENT_KEYWORDS = {
  inventory: ['inventory', 'stock', 'item', 'items', 'available', 'availability', 'price', 'pricing', 'cost', 'finance', 'financing', 'lease', 'model', 'models', 'product', 'products', 'vehicle', 'vehicles', 'unit', 'units', 'new', 'used'],
  contact: ['contact', 'call', 'phone', 'number', 'address', 'hours', 'hour', 'open', 'close', 'location', 'directions', 'map', 'email', 'reach'],
  service: ['service', 'repair', 'repairs', 'maintenance', 'parts', 'warranty', 'support', 'faq', 'help', 'schedule', 'appointment']
};

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeQuery(query) {
  const normalized = normalizeText(query);
  if (!normalized) return [];
  return [...new Set(normalized.split(' ').filter(token => token && !STOPWORDS.has(token) && (token.length > 2 || /^\d+$/.test(token))))];
}

function countOverlap(tokens, text) {
  if (!tokens.length) return 0;
  const haystack = normalizeText(text);
  if (!haystack) return 0;
  let hits = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) hits += 1;
  }
  return hits / tokens.length;
}

function phraseMatch(query, text) {
  const normalizedQuery = normalizeText(query);
  const haystack = normalizeText(text);
  if (!normalizedQuery || !haystack) return 0;
  return haystack.includes(normalizedQuery) ? 1 : 0;
}

function detectIntent(tokens, query) {
  const tokenSet = new Set(tokens);
  const normalizedQuery = normalizeText(query);

  const inventory = INTENT_KEYWORDS.inventory.some(keyword => tokenSet.has(keyword) || normalizedQuery.includes(keyword));
  const contact = INTENT_KEYWORDS.contact.some(keyword => tokenSet.has(keyword) || normalizedQuery.includes(keyword));
  const service = INTENT_KEYWORDS.service.some(keyword => tokenSet.has(keyword) || normalizedQuery.includes(keyword));

  return { inventory, contact, service };
}

function getSourceBoost(sourceType) {
  switch (String(sourceType || '').toLowerCase()) {
    case 'profile':
      return 0.12;
    case 'inventory_summary':
      return 0.1;
    case 'inventory':
      return 0.08;
    case 'website':
      return 0.03;
    default:
      return 0;
  }
}

function getPriorityBoost(priority) {
  switch (Number(priority || 0)) {
    case 4:
      return 0.1;
    case 3:
      return 0.07;
    case 2:
      return 0.04;
    case 1:
      return 0.02;
    default:
      return 0;
  }
}

function getIntentBoost(intent, candidate) {
  const sourceType = String(candidate.source_type || '').toLowerCase();
  const title = normalizeText(candidate.page_title || candidate.pageTitle || '');
  const url = normalizeText(candidate.url || '');
  const content = normalizeText(candidate.content || '');
  let boost = 0;

  if (intent.inventory && (sourceType === 'inventory' || sourceType === 'inventory_summary' || /inventory|product|products|catalog|shop|showroom/.test(`${title} ${url}`))) {
    boost += 0.12;
  }

  if (intent.contact && (sourceType === 'profile' || /contact|location|directions|hours|address|phone|email/.test(`${title} ${url} ${content}`))) {
    boost += 0.1;
  }

  if (intent.service && /service|repair|maintenance|parts|warranty|faq/.test(`${title} ${url} ${content}`)) {
    boost += 0.08;
  }

  return boost;
}

function scoreCandidate(query, candidate) {
  const tokens = tokenizeQuery(query);
  const intent = detectIntent(tokens, query);
  const vectorSimilarity = clamp(Number(candidate.vector_similarity ?? candidate.similarity ?? candidate.score ?? 0));
  const keywordRank = clamp(Number(candidate.keyword_rank ?? candidate.text_rank ?? 0) * 3);
  const hybridScore = clamp(Number(candidate.hybrid_score ?? 0));

  const title = candidate.page_title || candidate.pageTitle || candidate.source_name || candidate.url || '';
  const content = candidate.content || '';
  const url = candidate.url || '';
  const combinedText = `${title} ${candidate.source_name || ''} ${content} ${url}`;
  const tokenCoverage = countOverlap(tokens, combinedText);
  const titleCoverage = countOverlap(tokens, title);
  const phraseBoost = Math.max(phraseMatch(query, title), phraseMatch(query, content), phraseMatch(query, url));
  const sourceBoost = getSourceBoost(candidate.source_type);
  const priorityBoost = getPriorityBoost(candidate.priority);
  const intentBoost = getIntentBoost(intent, candidate);
  const sourceNameBoost = candidate.source_name && normalizeText(candidate.source_name).includes(normalizeText(query)) ? 0.04 : 0;
  const exactTitleBoost = tokens.length && tokens.every(token => normalizeText(title).includes(token)) ? 0.05 : 0;

  const baseScore = hybridScore > 0 ? hybridScore : (vectorSimilarity * 0.65 + keywordRank * 0.35);
  const rerankScore = (
    baseScore * 0.38 +
    vectorSimilarity * 0.18 +
    keywordRank * 0.16 +
    tokenCoverage * 0.1 +
    titleCoverage * 0.07 +
    phraseBoost * 0.06 +
    sourceBoost +
    priorityBoost +
    intentBoost +
    sourceNameBoost +
    exactTitleBoost
  );

  return {
    ...candidate,
    rerank_score: Number(rerankScore.toFixed(6)),
    rerank_signals: {
      vector_similarity: Number(vectorSimilarity.toFixed(4)),
      keyword_rank: Number(keywordRank.toFixed(4)),
      hybrid_score: Number(hybridScore.toFixed(4)),
      token_coverage: Number(tokenCoverage.toFixed(4)),
      title_coverage: Number(titleCoverage.toFixed(4)),
      phrase_boost: phraseBoost,
      source_boost: sourceBoost,
      priority_boost: priorityBoost,
      intent_boost: Number(intentBoost.toFixed(4)),
      source_name_boost: sourceNameBoost,
      exact_title_boost: exactTitleBoost
    }
  };
}

function rerankCandidates(query, candidates, { limit = null } = {}) {
  const scored = candidates.map(candidate => scoreCandidate(query, candidate));
  scored.sort((left, right) => {
    const scoreDelta = (right.rerank_score || 0) - (left.rerank_score || 0);
    if (scoreDelta !== 0) return scoreDelta;

    const hybridDelta = Number(right.hybrid_score || 0) - Number(left.hybrid_score || 0);
    if (hybridDelta !== 0) return hybridDelta;

    const vectorDelta = Number(right.vector_similarity || right.similarity || 0) - Number(left.vector_similarity || left.similarity || 0);
    if (vectorDelta !== 0) return vectorDelta;

    const keywordDelta = Number(right.keyword_rank || right.text_rank || 0) - Number(left.keyword_rank || left.text_rank || 0);
    if (keywordDelta !== 0) return keywordDelta;

    return Number(right.priority || 0) - Number(left.priority || 0);
  });

  return limit ? scored.slice(0, limit) : scored;
}

function formatChunkForContext(chunk) {
  const title = chunk.page_title || chunk.pageTitle || chunk.source_name || chunk.url || 'Result';
  return `[${title}]\n${chunk.content || ''}`;
}

function buildContextBlock(chunks, { maxCharacters = DEFAULT_CONTEXT_CHAR_LIMIT } = {}) {
  let context = '';
  for (const chunk of chunks) {
    const block = formatChunkForContext(chunk);
    const separator = context ? '\n\n---\n\n' : '';
    if ((context.length + separator.length + block.length) > maxCharacters) break;
    context += separator + block;
  }
  return context;
}

function summarizeChunk(chunk) {
  return {
    id: chunk.id || null,
    url: chunk.url || null,
    page_title: chunk.page_title || chunk.pageTitle || null,
    source_type: chunk.source_type || null,
    priority: Number(chunk.priority || 0),
    vector_similarity: chunk.vector_similarity != null ? Number(chunk.vector_similarity) : null,
    keyword_rank: chunk.keyword_rank != null ? Number(chunk.keyword_rank) : null,
    hybrid_score: chunk.hybrid_score != null ? Number(chunk.hybrid_score) : null,
    rerank_score: chunk.rerank_score != null ? Number(chunk.rerank_score) : null,
    match_reason: chunk.match_reason || null,
    preview: String(chunk.content || '').slice(0, 180)
  };
}

function summarizeChunks(chunks) {
  return chunks.map(summarizeChunk);
}

function countSourceTypes(chunks) {
  const counts = {};
  for (const chunk of chunks) {
    const type = String(chunk.source_type || 'unknown');
    counts[type] = (counts[type] || 0) + 1;
  }
  return counts;
}

function analyzeQuery(query) {
  const tokens = tokenizeQuery(query);
  return {
    tokens,
    token_count: tokens.length,
    intent: detectIntent(tokens, query),
    normalized_query: normalizeText(query)
  };
}

module.exports = {
  analyzeQuery,
  buildContextBlock,
  countSourceTypes,
  rerankCandidates,
  summarizeChunks,
  tokenizeQuery
};
