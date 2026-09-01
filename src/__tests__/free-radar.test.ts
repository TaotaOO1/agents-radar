import { describe, expect, it } from "vitest";
import {
  buildFreeRadarReport,
  deduplicateStories,
  normalizeUrl,
  rankStories,
  scoreStory,
} from "../free-radar.ts";
import type { HnStory } from "../hn.ts";

const NOW = new Date("2026-09-02T00:00:00.000Z");

function story(overrides: Partial<HnStory> = {}): HnStory {
  return {
    id: "1",
    title: "New AI agent framework",
    url: "https://example.com/agent",
    hnUrl: "https://news.ycombinator.com/item?id=1",
    points: 100,
    comments: 25,
    author: "alice",
    createdAt: "2026-09-01T22:00:00.000Z",
    ...overrides,
  };
}

describe("free radar", () => {
  it("normalizes tracking parameters and fragments", () => {
    expect(normalizeUrl("https://Example.com/post/?utm_source=x&b=2&a=1#part")).toBe(
      "https://example.com/post?a=1&b=2",
    );
  });

  it("deduplicates normalized URLs and keeps the more active item", () => {
    const result = deduplicateStories([
      story({ id: "1", points: 10, url: "https://example.com/post?utm_source=a" }),
      story({ id: "2", points: 50, url: "https://example.com/post" }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("2");
  });

  it("scores fresh and relevant stories transparently", () => {
    const score = scoreStory(story(), NOW);
    expect(score.freshness).toBe(25);
    expect(score.relevance).toBeGreaterThan(0);
    expect(score.total).toBe(score.popularity + score.discussion + score.freshness + score.relevance);
  });

  it("limits the candidate pool to 30 and renders five recommendations", () => {
    const stories = Array.from({ length: 35 }, (_, index) =>
      story({
        id: String(index),
        title: `AI agent story ${index}`,
        url: `https://example.com/${index}`,
        hnUrl: `https://news.ycombinator.com/item?id=${index}`,
        points: index + 1,
      }),
    );

    expect(rankStories(stories, NOW)).toHaveLength(30);
    const report = buildFreeRadarReport(stories, NOW);
    expect(report.match(/^### \d+\./gm)).toHaveLength(5);
    expect(report).toContain("去重后保留 30 条候选");
    expect(report).toContain("无需 API Key");
  });
});
