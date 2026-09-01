/**
 * API-key-free daily radar.
 *
 * Reuses the public Hacker News fetcher, removes duplicate links, applies a
 * deterministic and explainable score, and writes five recommendations plus
 * the complete candidate list. No LLM or paid service is involved.
 */

import fs from "fs";
import path from "path";
import { toCstDateStr } from "./date.ts";
import { fetchHnData, type HnStory } from "./hn.ts";

const CANDIDATE_LIMIT = 30;
const RECOMMENDATION_LIMIT = 5;
const TRACKING_PARAMS = new Set(["fbclid", "gclid", "mc_cid", "mc_eid", "ref", "source"]);
const RELEVANCE_PATTERNS = [
  /\bai\b/i,
  /\bllm(s)?\b/i,
  /machine learning/i,
  /language model/i,
  /\bagent(s)?\b/i,
  /openai/i,
  /anthropic/i,
  /claude/i,
  /chatgpt/i,
  /gemini/i,
  /copilot/i,
  /transformer/i,
  /\brag\b/i,
];

export interface ScoreBreakdown {
  popularity: number;
  discussion: number;
  freshness: number;
  relevance: number;
  total: number;
}

export interface ScoredStory extends HnStory {
  score: ScoreBreakdown;
}

export function normalizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMS.has(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/$/, "") || "/";
    return url.toString();
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

function normalizedTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function deduplicateStories(stories: HnStory[]): HnStory[] {
  const unique: HnStory[] = [];
  const indexByUrl = new Map<string, number>();
  const indexByTitle = new Map<string, number>();

  for (const story of stories) {
    const urlKey = normalizeUrl(story.url);
    const titleKey = normalizedTitle(story.title);
    const existingIndex = indexByUrl.get(urlKey) ?? indexByTitle.get(titleKey);
    const current = existingIndex === undefined ? undefined : unique[existingIndex];
    if (!current || story.points + story.comments > current.points + current.comments) {
      const index = existingIndex ?? unique.length;
      unique[index] = story;
      indexByUrl.set(urlKey, index);
      indexByTitle.set(titleKey, index);
    }
  }

  return unique;
}

export function scoreStory(story: HnStory, now = new Date()): ScoreBreakdown {
  const ageHours = Math.max(0, (now.getTime() - new Date(story.createdAt).getTime()) / 3_600_000);
  const popularity = Math.min(35, Math.round(Math.log2(story.points + 1) * 4.5));
  const discussion = Math.min(20, Math.round(Math.log2(story.comments + 1) * 3.5));
  const freshness = ageHours <= 6 ? 25 : ageHours <= 12 ? 20 : ageHours <= 24 ? 15 : ageHours <= 48 ? 8 : 2;
  const relevanceHits = RELEVANCE_PATTERNS.filter((pattern) =>
    pattern.test(`${story.title} ${story.url}`),
  ).length;
  const relevance = Math.min(20, relevanceHits * 5);

  return {
    popularity,
    discussion,
    freshness,
    relevance,
    total: popularity + discussion + freshness + relevance,
  };
}

export function rankStories(stories: HnStory[], now = new Date()): ScoredStory[] {
  return deduplicateStories(stories)
    .map((story) => ({ ...story, score: scoreStory(story, now) }))
    .sort((a, b) => b.score.total - a.score.total || b.points - a.points || b.comments - a.comments)
    .slice(0, CANDIDATE_LIMIT);
}

function escapeMarkdown(text: string): string {
  return text.replace(/([\\[\]*_`])/g, "\\$1");
}

function recommendationReason(story: ScoredStory): string {
  const strengths: string[] = [];
  if (story.score.popularity >= 28) strengths.push("社区热度高");
  if (story.score.discussion >= 14) strengths.push("讨论充分");
  if (story.score.freshness >= 20) strengths.push("发布时间新");
  if (story.score.relevance >= 10) strengths.push("与 AI 主题高度相关");
  return strengths.length > 0 ? strengths.slice(0, 3).join("、") : "综合热度、时效和主题相关性表现均衡";
}

export function buildFreeRadarReport(stories: HnStory[], now = new Date()): string {
  const ranked = rankStories(stories, now);
  const recommendations = ranked.slice(0, RECOMMENDATION_LIMIT);
  const date = toCstDateStr(now);
  const lines = [
    `# 📡 信息雷达 · ${date}`,
    "",
    `> 免费规则版：抓取 ${stories.length} 条，去重后保留 ${ranked.length} 条候选，生成 ${recommendations.length} 条推荐。无需 API Key。`,
    "",
    "## 今日 5 条推荐",
    "",
  ];

  recommendations.forEach((story, index) => {
    lines.push(
      `### ${index + 1}. [${escapeMarkdown(story.title)}](${story.url})`,
      "",
      `**推荐分：${story.score.total}/100** · HN ${story.points} points · ${story.comments} 条评论`,
      "",
      `推荐理由：${recommendationReason(story)}。评分由热度 ${story.score.popularity}/35、讨论 ${story.score.discussion}/20、时效 ${story.score.freshness}/25、AI 相关性 ${story.score.relevance}/20 组成。`,
      "",
      `[查看 Hacker News 讨论](${story.hnUrl})`,
      "",
    );
  });

  lines.push(
    "## 全部候选（最多 30 条）",
    "",
    "| 排名 | 推荐分 | 标题 | HN 热度 | 评论 |",
    "| ---: | ---: | --- | ---: | ---: |",
  );

  ranked.forEach((story, index) => {
    const title = escapeMarkdown(story.title).replace(/\|/g, "\\|");
    lines.push(
      `| ${index + 1} | ${story.score.total} | [${title}](${story.url}) | ${story.points} | ${story.comments} |`,
    );
  });

  lines.push(
    "",
    "## 评分说明",
    "",
    "- 热度：最高 35 分，使用 HN points 的对数刻度，避免头部文章完全碾压其他内容。",
    "- 讨论：最高 20 分，根据评论数计算。",
    "- 时效：最高 25 分，6 小时内得分最高，随后逐级衰减。",
    "- AI 相关性：最高 20 分，根据标题和链接中的 AI、LLM、Agent 等关键词计算。",
    "- 去重：规范化 URL，移除常见追踪参数；重复项保留互动量更高的一条。",
    "",
    "---",
    "*由 agents-radar 免费规则模式自动生成；评分透明、可复现，不调用任何付费模型。*",
    "",
  );

  return lines.join("\n");
}

async function main(): Promise<void> {
  const data = await fetchHnData();
  if (!data.fetchSuccess || data.stories.length === 0) {
    throw new Error("Hacker News 抓取失败或没有找到候选链接");
  }

  const now = new Date();
  const date = toCstDateStr(now);
  const outputDir = path.join("digests", date);
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "ai-picks.md");
  fs.writeFileSync(outputPath, buildFreeRadarReport(data.stories, now), "utf8");
  console.log(`free radar written: ${outputPath}`);
}

const isDirectRun =
  process.argv[1] && (process.argv[1].endsWith("free-radar.ts") || process.argv[1].endsWith("free-radar.js"));
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
