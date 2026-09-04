import type { Source } from "./sources";

/**
 * Cache-aside for source lookups. The same question re-asked, a scheduled
 * follow-up, and a workflow step that retries after a later step fails all hit
 * the same upstream queries, so this removes redundant calls to Wikipedia and
 * Hacker News and keeps us well inside their rate limits.
 */

const TTL_SECONDS = 60 * 60 * 6;

export type CacheStats = { hits: number; misses: number };

function key(provider: string, query: string): string {
  return `src:v1:${provider}:${query.toLowerCase().trim()}`;
}

export async function cachedSearch(
  kv: KVNamespace | undefined,
  provider: string,
  query: string,
  search: (q: string) => Promise<Source[]>,
  stats?: CacheStats
): Promise<Source[]> {
  // No binding in some test contexts; degrade to a direct fetch rather than fail.
  if (!kv) return search(query);

  const cacheKey = key(provider, query);
  const hit = await kv.get<Source[]>(cacheKey, "json");
  if (hit) {
    if (stats) stats.hits += 1;
    return hit;
  }

  const fresh = await search(query);
  if (stats) stats.misses += 1;

  // Never cache an empty result: a transient upstream blip would otherwise be
  // pinned for the whole TTL.
  if (fresh.length > 0) {
    await kv.put(cacheKey, JSON.stringify(fresh), {
      expirationTtl: TTL_SECONDS
    });
  }
  return fresh;
}
