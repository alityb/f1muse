/**
 * Intent Cache
 * caches resolved query intents to avoid repeated llm calls
 */

import { createHash } from 'crypto';
import { QueryIntent } from '../types/query-intent';
import { getRedisCache } from '../cache/redis-cache';
import { metrics } from '../observability/metrics';

const CACHE_PREFIX = 'intent';
const CACHE_VERSION = 'v5'; // bumped to add career pole count support
const CURRENT_SEASON = 2025;

// ttl: 1 hour for current season, 24 hours for past
const TTL_CURRENT_SEASON = 3600;
const TTL_PAST_SEASON = 86400;

// feature flag for aggressive normalization
const USE_CANONICAL_NORMALIZATION = process.env.INTENT_CACHE_CANONICAL !== 'false';

// stopwords to remove (small fixed list, english only)
const STOPWORDS = new Set([
  's', // possessive remnant after punctuation removal
  'the', 'a', 'an', 'is', 'was', 'were', 'are', 'been', 'be',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'can', 'may', 'might', 'must', 'shall',
  'this', 'that', 'these', 'those',
  'i', 'me', 'my', 'we', 'our', 'you', 'your',
  'it', 'its', 'they', 'them', 'their',
  'what', 'which', 'who', 'whom', 'whose',
  'where', 'when', 'why', 'how',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such',
  'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
  'just', 'also', 'now', 'here', 'there',
  'and', 'but', 'or', 'if', 'because', 'as', 'until', 'while',
  'of', 'at', 'by', 'for', 'with', 'about', 'against', 'between', 'into',
  'through', 'during', 'before', 'after', 'above', 'below', 'to', 'from',
  'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under', 'again',
  'then', 'once',
  'please', 'tell', 'show', 'give', 'get', 'let', 'make',
]);

export interface CachedIntent {
  intent: QueryIntent;
  cachedAt: string;
}

/**
 * normalize question for cache key
 * basic: lowercase, trim whitespace, collapse spaces
 * canonical: also removes punctuation and stopwords
 */
function normalizeQuestion(question: string): string {
  const basic = question
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[?.!,]+$/g, '');

  if (!USE_CANONICAL_NORMALIZATION) {
    return basic;
  }

  return normalizeCanonical(basic);
}

/**
 * canonical normalization for higher cache hit rates
 * removes punctuation and stopwords, preserves numbers/names
 */
export function normalizeCanonical(text: string): string {
  // lowercase first
  let result = text.toLowerCase();

  // remove punctuation except hyphens in compound words
  result = result.replace(/[^\w\s-]/g, ' ');

  // collapse whitespace
  result = result.replace(/\s+/g, ' ').trim();

  // remove stopwords
  const words = result.split(' ');
  const filtered = words.filter(word => {
    // skip empty
    if (!word) {
      return false;
    }
    // keep numbers (seasons, positions)
    if (/^\d+$/.test(word)) {
      return true;
    }
    // keep words not in stoplist
    return !STOPWORDS.has(word);
  });

  return filtered.join(' ');
}

/**
 * generate cache key from normalized question
 */
function generateCacheKey(question: string): string {
  const normalized = normalizeQuestion(question);
  const hash = createHash('sha256')
    .update(normalized)
    .digest('hex')
    .substring(0, 16);
  return `${CACHE_PREFIX}:${CACHE_VERSION}:${hash}`;
}

/**
 * determine ttl based on intent season
 */
function getTTL(intent: QueryIntent): number {
  const season = intent.season || CURRENT_SEASON;
  return season >= CURRENT_SEASON ? TTL_CURRENT_SEASON : TTL_PAST_SEASON;
}

/**
 * check if intent should be cached
 * only cache successful, unambiguous resolutions
 */
function shouldCache(intent: QueryIntent): boolean {
  // must have a valid kind
  if (!intent.kind) {
    return false;
  }

  // Career queries don't require a season
  const careerKinds = ['driver_career_summary', 'driver_career_pole_count', 'driver_career_wins_by_circuit', 'teammate_comparison_career'];
  if (careerKinds.includes(intent.kind)) {
    return true;
  }

  // must have a season for non-career queries
  if (!intent.season) {
    return false;
  }

  return true;
}

/**
 * get cached intent for question
 */
export async function getCachedIntent(
  question: string
): Promise<QueryIntent | null> {
  const cache = getRedisCache();
  if (!cache.isAvailable()) {
    return null;
  }

  const key = generateCacheKey(question);
  const result = await cache.get<CachedIntent>(key);

  if (result.hit && result.data) {
    metrics.incrementIntentCacheHit();
    console.log(`[IntentCache] HIT: ${key}`);
    return result.data.intent;
  }

  metrics.incrementIntentCacheMiss();
  return null;
}

/**
 * cache intent for question
 */
export async function cacheIntent(
  question: string,
  intent: QueryIntent
): Promise<boolean> {
  if (!shouldCache(intent)) {
    return false;
  }

  const cache = getRedisCache();
  if (!cache.isAvailable()) {
    return false;
  }

  const key = generateCacheKey(question);
  const ttl = getTTL(intent);

  const cached: CachedIntent = {
    intent,
    cachedAt: new Date().toISOString(),
  };

  const success = await cache.set(key, cached, intent.season || CURRENT_SEASON);

  if (success) {
    console.log(`[IntentCache] SET: ${key} (ttl=${ttl}s)`);
  }

  return success;
}

/**
 * clear intent cache (for testing)
 */
export async function clearIntentCache(): Promise<boolean> {
  const cache = getRedisCache();
  if (!cache.isAvailable()) {
    return false;
  }

  // note: this clears all cache, not just intent cache
  // a more targeted clear would require key scanning
  return await cache.clearAll();
}
