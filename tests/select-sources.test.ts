import { describe, expect, it } from "vitest";
import { selectSources } from "../src/workflows/research";
import type { Source } from "../src/sources";

const source = (
  provider: Source["provider"],
  title: string,
  extract = ""
): Source => ({
  provider,
  title,
  url: `https://example.invalid/${encodeURIComponent(title)}`,
  extract
});

const QUESTION = "How do Cloudflare Workflows handle retries?";

describe("selectSources", () => {
  it("drops results that share no meaningful term with the question", () => {
    const picked = selectSources(
      QUESTION,
      [
        source("wikipedia", "Email"),
        source("wikipedia", "Kodachi OS"),
        source("wikipedia", "Cloudflare", "Cloudflare is a CDN provider.")
      ],
      []
    );

    expect(picked.map((s) => s.title)).toEqual(["Cloudflare"]);
  });

  it("takes from both providers instead of letting one crowd the other out", () => {
    const wikipedia = Array.from({ length: 6 }, (_, i) =>
      source("wikipedia", `Cloudflare article ${i}`)
    );
    const hackernews = [
      source("hackernews", "Cloudflare Workflows launch"),
      source("hackernews", "Retries in Cloudflare")
    ];

    const picked = selectSources(QUESTION, wikipedia, hackernews, 4);

    expect(picked).toHaveLength(4);
    expect(picked.filter((s) => s.provider === "hackernews")).toHaveLength(2);
    expect(picked.filter((s) => s.provider === "wikipedia")).toHaveLength(2);
  });

  it("matches on the extract, not just the title", () => {
    const picked = selectSources(
      QUESTION,
      [source("wikipedia", "Durable execution", "Steps can be retries-aware.")],
      []
    );
    expect(picked).toHaveLength(1);
  });

  it("removes duplicate URLs", () => {
    const dupe = source("wikipedia", "Cloudflare");
    expect(selectSources(QUESTION, [dupe, { ...dupe }], [])).toHaveLength(1);
  });

  it("returns nothing when every result is irrelevant", () => {
    expect(selectSources(QUESTION, [source("wikipedia", "Email")], [])).toEqual(
      []
    );
  });
});
