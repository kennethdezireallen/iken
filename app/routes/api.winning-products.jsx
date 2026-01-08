const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 30;
const CACHE_TTL_MS = 8 * 60 * 60 * 1000;

const rateLimitBuckets = new Map();
const responseCache = new Map();

const STOPWORDS = new Set([
  'best',
  'top',
  'review',
  'reviews',
  '2023',
  '2024',
  '2025',
  '2026',
  'viral',
  'trending',
  'trend',
  'tiktok',
  'amazon',
  'etsy',
  'youtube',
  'shorts',
  'reels',
  'made',
  'buy',
  'finds',
  'gadget',
  'gadgets',
  'gift',
  'gifts',
  'products',
  'product',
  'ideas',
  'for',
  'with',
  'and',
  'the',
  'a',
  'an',
  'to',
  'of',
  'in',
  'from',
  'on',
  'shop',
  'store',
]);

const SIGNAL_TERMS = [
  'viral',
  'trending',
  'tiktok',
  'made me buy',
  'amazon',
  'movers and shakers',
  'instagram',
  'reels',
  'shorts',
  'must have',
  'problem',
  'hack',
  'before and after',
  'ugc',
];

export async function action({request, context}) {
  if (request.method !== 'POST') {
    return jsonResponse({error: 'Method not allowed'}, 405);
  }

  const clientIp = getClientIp(request);
  if (!checkRateLimit(clientIp)) {
    return jsonResponse({error: 'Rate limit exceeded. Please try later.'}, 429);
  }

  let payload = {};
  try {
    payload = await request.json();
  } catch (error) {
    return jsonResponse({error: 'Invalid JSON body.'}, 400);
  }

  const filters = normalizeFilters(payload);
  const cacheKey = JSON.stringify(filters);
  const cached = responseCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return jsonResponse(cached.data, 200);
  }

  const env = context?.env ?? process.env;
  const apiKey = env.GOOGLE_API_KEY;
  const cseId = env.GOOGLE_CSE_ID;

  if (!apiKey || !cseId) {
    return jsonResponse(
      {error: 'Missing GOOGLE_API_KEY or GOOGLE_CSE_ID configuration.'},
      500,
    );
  }

  const queries = buildQueries(filters);
  try {
    const searchResults = [];
    for (const query of queries) {
      const items = await googleSearch(query, {apiKey, cseId});
      searchResults.push({query, items});
    }

    const candidates = collectCandidates(searchResults);
    const filtered = dedupeAndFilter(candidates, filters.exclude, filters.fresh);
    const ranked = rankCandidates(filtered).slice(0, 8);

    const results = ranked.slice(0, 8).map((candidate) =>
      generatePlanFromProduct(candidate, filters),
    );

    const response = {
      query: queries.join(' | '),
      results: results.slice(0, 8),
    };

    responseCache.set(cacheKey, {
      data: response,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    return jsonResponse(response, 200);
  } catch (error) {
    return jsonResponse(
      {error: 'Google API request failed. Please try again later.'},
      502,
    );
  }
}

export async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({error: 'Method not allowed'}));
    return;
  }

  let payload = {};
  try {
    payload = req.body ?? JSON.parse(req.body || '{}');
  } catch (error) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({error: 'Invalid JSON body.'}));
    return;
  }

  const request = new Request('http://localhost/api/winning-products', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload),
  });

  const response = await action({
    request,
    context: {env: process.env},
  });
  const responseBody = await response.json();
  res.statusCode = response.status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(responseBody));
}

export function buildQueries(filters) {
  const queries = [];
  const baseCategory = filters.category ? filters.category.toLowerCase() : '';
  const platform = filters.platform ? filters.platform.toLowerCase() : '';
  const problem = filters.problemType ? filters.problemType.toLowerCase() : '';
  const audience = filters.audience ? filters.audience.toLowerCase() : '';

  if (platform.includes('tiktok')) {
    queries.push(
      `site:tiktok.com "${baseCategory}" viral ${problem} product`,
      `"TikTok made me buy it" ${baseCategory} ${audience}`.trim(),
    );
  }

  if (platform.includes('instagram')) {
    queries.push(`site:instagram.com "${baseCategory}" reels trend ${problem}`);
  }

  if (platform.includes('youtube')) {
    queries.push(`site:youtube.com "${baseCategory}" shorts viral product`);
  }

  if (platform.includes('amazon')) {
    queries.push(
      `Amazon Movers and Shakers ${baseCategory}`.trim(),
      `best selling ${baseCategory} gadgets trending`.trim(),
    );
  }

  if (platform.includes('etsy')) {
    queries.push(`Etsy trending ${baseCategory} gifts ${audience}`.trim());
  }

  queries.push(
    `viral ${baseCategory} product ${problem} ${audience}`.trim(),
    `${baseCategory} product trend ${problem} 2025`.trim(),
  );

  return Array.from(new Set(queries)).filter(Boolean).slice(0, 6);
}

export async function googleSearch(query, {apiKey, cseId}) {
  const params = new URLSearchParams({
    key: apiKey,
    cx: cseId,
    q: query,
    num: '10',
  });

  const response = await fetch(
    `https://www.googleapis.com/customsearch/v1?${params.toString()}`,
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Google API error: ${response.status} ${errorBody}`);
  }

  const data = await response.json();
  return data.items || [];
}

export function normalizeName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractProductName(title, snippet) {
  const text = `${title || ''} ${snippet || ''}`.trim();
  if (!text) return '';

  const cleaned = text
    .replace(/\|.+$/g, ' ')
    .replace(/[-–—].+$/g, ' ')
    .replace(/\(|\)|\[|\]/g, ' ')
    .replace(/\s+/g, ' ');

  const tokens = cleaned
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token && !STOPWORDS.has(token.toLowerCase()));

  const phrase = tokens.slice(0, 6).join(' ').trim();
  if (phrase.length >= 4) {
    return toTitleCase(phrase);
  }

  return toTitleCase(cleaned.trim().slice(0, 80));
}

export function dedupeAndFilter(candidates, exclude, fresh) {
  const excludeSet = new Set((exclude || []).map(normalizeName));
  const deduped = [];
  const seen = new Set();

  for (const candidate of candidates) {
    const normalized = normalizeName(candidate.productName);
    if (!normalized) continue;
    if (excludeSet.has(normalized)) continue;
    if (seen.has(normalized)) continue;

    if (fresh) {
      const isNearDuplicate = deduped.some((existing) =>
        isNearDuplicateName(existing.productName, candidate.productName),
      );
      if (isNearDuplicate) continue;
    }

    seen.add(normalized);
    deduped.push(candidate);
  }

  return deduped;
}

export function generatePlanFromProduct(candidate, filters) {
  const name = candidate.productName;
  const audience = filters.audience || 'busy shoppers';
  const niche = `${filters.category} buyers who want to ${filters.problemType.toLowerCase()}`;
  const websiteStyle = `${Math.random() > 0.5 ? 'Single-product' : '3-product'} store, ${filters.category.toLowerCase()} aesthetic, punchy hero with UGC carousel and sticky buy bar.`;
  const whyTrending = `UGC creators are showing quick before/after demos for ${name}, making it easy for ${audience} to visualize the benefit. Short-form ${filters.platform} clips highlight the ${filters.problemType.toLowerCase()} payoff.`;
  const contentIdeas = [
    `POV: trying ${name} to ${filters.problemType.toLowerCase()} in 30 seconds.`,
    `Talking-head review: why ${name} beats typical ${filters.category.toLowerCase()} alternatives.`,
    `B-roll demo showing the instant result + close-up texture shots of ${name}.`,
  ];

  const riskLevel = candidate.signalScore > 3 ? 'High' : candidate.signalScore > 1 ? 'Medium' : 'Low';

  return {
    productName: name,
    niche,
    whyTrending,
    websiteStyle,
    contentIdeas,
    riskLevel,
    sources: candidate.sources.slice(0, 3),
  };
}

function normalizeFilters(payload) {
  return {
    platform: payload.platform || 'TikTok',
    category: payload.category || 'Other',
    priceRange: payload.priceRange || '$20–$35',
    problemType: payload.problemType || 'Convenience',
    audience: payload.audience || '',
    exclude: Array.isArray(payload.exclude) ? payload.exclude : [],
    fresh: payload.fresh === 1 ? 1 : 0,
  };
}

function getClientIp(request) {
  const header = request.headers.get('x-forwarded-for') || '';
  const ips = header.split(',').map((ip) => ip.trim());
  return ips[0] || 'unknown';
}

function checkRateLimit(key) {
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key) || {count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS};
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }

  bucket.count += 1;
  rateLimitBuckets.set(key, bucket);
  return bucket.count <= RATE_LIMIT_MAX;
}

function collectCandidates(searchResults) {
  const candidates = [];

  for (const result of searchResults) {
    for (const item of result.items) {
      const productName = extractProductName(item.title, item.snippet);
      if (!productName) continue;
      candidates.push({
        productName,
        title: item.title || '',
        snippet: item.snippet || '',
        sources: [{title: item.title || '', url: item.link || ''}],
      });
    }
  }

  return candidates;
}

function rankCandidates(candidates) {
  return candidates
    .map((candidate) => {
      const text = `${candidate.title} ${candidate.snippet}`.toLowerCase();
      let score = 0;
      for (const term of SIGNAL_TERMS) {
        if (text.includes(term)) score += 1;
      }
      if (text.match(/2025|2026/)) score += 1;
      if (text.includes('problem') || text.includes('hack') || text.includes('solution')) {
        score += 1;
      }
      return {...candidate, signalScore: score};
    })
    .sort((a, b) => b.signalScore - a.signalScore);
}

function isNearDuplicateName(a, b) {
  const normalizedA = normalizeName(a);
  const normalizedB = normalizeName(b);
  if (normalizedA === normalizedB) return true;

  const tokensA = normalizedA.split(' ');
  const tokensB = normalizedB.split(' ');
  const jaccard = jaccardSimilarity(tokensA, tokensB);
  if (jaccard >= 0.8) return true;

  if (Math.min(normalizedA.length, normalizedB.length) <= 12) {
    return levenshteinDistance(normalizedA, normalizedB) <= 3;
  }

  return false;
}

function jaccardSimilarity(tokensA, tokensB) {
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  const intersection = [...setA].filter((token) => setB.has(token)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

function levenshteinDistance(a, b) {
  const matrix = Array.from({length: a.length + 1}, () => []);
  for (let i = 0; i <= a.length; i += 1) {
    matrix[i][0] = i;
  }
  for (let j = 0; j <= b.length; j += 1) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[a.length][b.length];
}

function toTitleCase(value) {
  return value
    .split(' ')
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : ''))
    .join(' ')
    .trim();
}

function jsonResponse(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {'Content-Type': 'application/json'},
  });
}

/**
 * Example curl request:
 * curl -X POST http://localhost:3000/api/winning-products \
 *   -H "Content-Type: application/json" \
 *   -d '{"platform":"TikTok","category":"Kitchen","priceRange":"$20–$35","problemType":"Convenience","audience":"busy parents","exclude":["Mini Blender"],"fresh":1}'
 *
 * Notes:
 * - Set GOOGLE_API_KEY and GOOGLE_CSE_ID in your environment.
 * - For Vercel/Netlify, export `handler` from this module.
 */
