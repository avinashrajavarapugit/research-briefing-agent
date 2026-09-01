/**
 * Keyless research sources, so a reviewer needs no API keys or account setup.
 *
 * Security: both hosts are hardcoded constants and only the query string is
 * interpolated, through encodeURIComponent. A model-supplied URL is never
 * fetched, so there is no SSRF surface here.
 */

const WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php";
const HACKERNEWS_API = "https://hn.algolia.com/api/v1/search";

// Wikimedia's policy requires a descriptive User-Agent on API traffic.
const USER_AGENT =
  "research-briefing-agent/1.0 (Cloudflare Agents assignment demo)";

const MAX_EXTRACT_CHARS = 1200;

export type Source = {
  provider: "wikipedia" | "hackernews";
  title: string;
  url: string;
  extract: string;
};

function truncate(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > MAX_EXTRACT_CHARS
    ? `${clean.slice(0, MAX_EXTRACT_CHARS)}…`
    : clean;
}

type WikipediaResponse = {
  query?: {
    pages?: Record<
      string,
      { pageid?: number; title?: string; extract?: string }
    >;
  };
};

export async function searchWikipedia(
  query: string,
  limit = 3
): Promise<Source[]> {
  const url = new URL(WIKIPEDIA_API);
  url.search = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: query,
    gsrlimit: String(limit),
    prop: "extracts",
    exintro: "1",
    explaintext: "1",
    format: "json",
    origin: "*"
  }).toString();

  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  // Throwing here is what makes the workflow step retry with backoff.
  if (!res.ok) {
    throw new Error(`wikipedia search failed: ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as WikipediaResponse;
  const pages = Object.values(body.query?.pages ?? {});

  return pages
    .filter((p) => p.title && p.extract)
    .map((p) => ({
      provider: "wikipedia" as const,
      title: p.title as string,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(
        (p.title as string).replace(/ /g, "_")
      )}`,
      extract: truncate(p.extract as string)
    }))
    .filter((s) => s.extract.length > 0);
}

type HackerNewsResponse = {
  hits?: Array<{
    objectID?: string;
    title?: string | null;
    url?: string | null;
    story_text?: string | null;
    points?: number | null;
    num_comments?: number | null;
  }>;
};

export async function searchHackerNews(
  query: string,
  limit = 3
): Promise<Source[]> {
  const url = new URL(HACKERNEWS_API);
  url.search = new URLSearchParams({
    query,
    tags: "story",
    hitsPerPage: String(limit)
  }).toString();

  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) {
    throw new Error(`hacker news search failed: ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as HackerNewsResponse;

  return (body.hits ?? [])
    .filter((h) => h.title && h.objectID)
    .map((h) => ({
      provider: "hackernews" as const,
      title: h.title as string,
      url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
      extract: truncate(
        h.story_text ??
          `Hacker News discussion: ${h.points ?? 0} points, ${
            h.num_comments ?? 0
          } comments.`
      )
    }));
}
