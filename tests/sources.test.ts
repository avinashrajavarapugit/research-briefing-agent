import { afterEach, describe, expect, it, vi } from "vitest";
import { searchHackerNews, searchWikipedia } from "../src/sources";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(body: unknown, init: ResponseInit = { status: 200 }) {
  const spy = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        ...init,
        headers: { "content-type": "application/json" }
      })
  );
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

describe("searchWikipedia", () => {
  it("maps search results to sources with article URLs", async () => {
    mockFetch({
      query: {
        pages: {
          "123": {
            pageid: 123,
            title: "Durable Objects",
            extract: "  Durable Objects are\n\nstateful  primitives.  "
          }
        }
      }
    });

    const [source] = await searchWikipedia("durable objects");

    expect(source.provider).toBe("wikipedia");
    expect(source.title).toBe("Durable Objects");
    expect(source.url).toBe("https://en.wikipedia.org/wiki/Durable_Objects");
    expect(source.extract).toBe("Durable Objects are stateful primitives.");
  });

  it("throws on a rate limit so the workflow step retries", async () => {
    mockFetch({}, { status: 429, statusText: "Too Many Requests" });
    await expect(searchWikipedia("anything")).rejects.toThrow(/429/);
  });

  it("throws on a server error so the workflow step retries", async () => {
    mockFetch({}, { status: 503, statusText: "Service Unavailable" });
    await expect(searchWikipedia("anything")).rejects.toThrow(/503/);
  });

  it("skips pages with no extract instead of emitting empty sources", async () => {
    mockFetch({
      query: { pages: { "1": { title: "Stub", extract: "" }, "2": {} } }
    });
    expect(await searchWikipedia("stub")).toEqual([]);
  });

  it("sends a descriptive User-Agent, as Wikimedia policy requires", async () => {
    const spy = mockFetch({ query: { pages: {} } });
    await searchWikipedia("policy");

    const init = spy.mock.calls[0][1] as RequestInit;
    expect(
      (init.headers as Record<string, string>)["User-Agent"]
    ).toContain("research-briefing-agent");
  });

  it("encodes the query rather than interpolating it into the URL", async () => {
    const spy = mockFetch({ query: { pages: {} } });
    await searchWikipedia("a&b=c d");

    const url = new URL(String(spy.mock.calls[0][0]));
    expect(url.origin).toBe("https://en.wikipedia.org");
    expect(url.searchParams.get("gsrsearch")).toBe("a&b=c d");
  });
});

describe("searchHackerNews", () => {
  it("maps hits and keeps the story URL", async () => {
    mockFetch({
      hits: [
        {
          objectID: "42",
          title: "Cloudflare Workflows",
          url: "https://example.invalid/post",
          story_text: null,
          points: 120,
          num_comments: 30
        }
      ]
    });

    const [source] = await searchHackerNews("workflows");

    expect(source.provider).toBe("hackernews");
    expect(source.url).toBe("https://example.invalid/post");
    expect(source.extract).toContain("120 points");
  });

  it("falls back to the discussion permalink when a hit has no URL", async () => {
    mockFetch({
      hits: [{ objectID: "99", title: "Ask HN: agents?", url: null }]
    });

    const [source] = await searchHackerNews("agents");
    expect(source.url).toBe("https://news.ycombinator.com/item?id=99");
  });

  it("throws on a failed request so the workflow step retries", async () => {
    mockFetch({}, { status: 500, statusText: "Internal Server Error" });
    await expect(searchHackerNews("anything")).rejects.toThrow(/500/);
  });

  it("returns an empty list when there are no hits", async () => {
    mockFetch({ hits: [] });
    expect(await searchHackerNews("no results")).toEqual([]);
  });
});
