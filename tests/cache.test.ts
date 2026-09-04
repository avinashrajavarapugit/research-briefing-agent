import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cachedSearch, type CacheStats } from "../src/cache";
import type { Source } from "../src/sources";

const source = (title: string): Source => ({
  provider: "wikipedia",
  title,
  url: `https://example.invalid/${title}`,
  extract: "extract"
});

const freshStats = (): CacheStats => ({ hits: 0, misses: 0 });

afterEach(async () => {
  const { keys } = await env.SOURCE_CACHE.list();
  await Promise.all(keys.map((k) => env.SOURCE_CACHE.delete(k.name)));
});

describe("cachedSearch", () => {
  it("fetches on a miss and serves the second call from cache", async () => {
    const search = vi.fn(async () => [source("Raft")]);
    const stats = freshStats();

    const first = await cachedSearch(
      env.SOURCE_CACHE,
      "wikipedia",
      "raft",
      search,
      stats
    );
    const second = await cachedSearch(
      env.SOURCE_CACHE,
      "wikipedia",
      "raft",
      search,
      stats
    );

    expect(search).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(stats).toEqual({ hits: 1, misses: 1 });
  });

  it("normalises case and surrounding space to the same entry", async () => {
    const search = vi.fn(async () => [source("QUIC")]);

    await cachedSearch(env.SOURCE_CACHE, "wikipedia", "quic", search);
    await cachedSearch(env.SOURCE_CACHE, "wikipedia", "  QUIC  ", search);

    expect(search).toHaveBeenCalledTimes(1);
  });

  it("keeps providers in separate entries", async () => {
    const wiki = vi.fn(async () => [source("shared")]);
    const hn = vi.fn(async () => [source("shared")]);

    await cachedSearch(env.SOURCE_CACHE, "wikipedia", "shared", wiki);
    await cachedSearch(env.SOURCE_CACHE, "hackernews", "shared", hn);

    expect(wiki).toHaveBeenCalledTimes(1);
    expect(hn).toHaveBeenCalledTimes(1);
  });

  it("does not cache an empty result, so a blip is not pinned for the TTL", async () => {
    const search = vi.fn(async () => []);

    await cachedSearch(env.SOURCE_CACHE, "wikipedia", "nothing", search);
    await cachedSearch(env.SOURCE_CACHE, "wikipedia", "nothing", search);

    expect(search).toHaveBeenCalledTimes(2);
  });

  it("propagates upstream failures instead of caching them", async () => {
    const search = vi.fn(async () => {
      throw new Error("429 Too Many Requests");
    });

    await expect(
      cachedSearch(env.SOURCE_CACHE, "wikipedia", "boom", search)
    ).rejects.toThrow(/429/);
  });

  it("falls back to a direct fetch when no binding is present", async () => {
    const search = vi.fn(async () => [source("Raft")]);
    const result = await cachedSearch(undefined, "wikipedia", "raft", search);

    expect(result).toHaveLength(1);
    expect(search).toHaveBeenCalledTimes(1);
  });
});
