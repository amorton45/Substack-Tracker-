import Anthropic from "@anthropic-ai/sdk";
import { format } from "date-fns";
import type { CollectedPost, AuthorSummary, SummarizationResult } from "./types.js";

const MODEL = "claude-sonnet-4-20250514";
const MAX_POSTS_PER_BATCH = 10;
const RETRY_DELAY_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function groupByAuthor(posts: CollectedPost[]): Map<string, CollectedPost[]> {
  const groups = new Map<string, CollectedPost[]>();
  for (const post of posts) {
    const existing = groups.get(post.author) || [];
    existing.push(post);
    groups.set(post.author, existing);
  }
  return groups;
}

function buildAuthorPrompt(author: string, posts: CollectedPost[]): string {
  let content = `## ${author}\n\n`;
  for (const post of posts) {
    const dateStr = format(post.publishedAt, "MMMM d, yyyy");
    content += `### "${post.title}" — ${dateStr}\n`;
    content += `${post.content}\n\n`;
  }
  return content;
}

async function summarizeAuthor(
  client: Anthropic,
  author: string,
  posts: CollectedPost[]
): Promise<string> {
  // Split into batches if an author has too many posts
  const batches: CollectedPost[][] = [];
  for (let i = 0; i < posts.length; i += MAX_POSTS_PER_BATCH) {
    batches.push(posts.slice(i, i + MAX_POSTS_PER_BATCH));
  }

  const summaries: string[] = [];

  for (const batch of batches) {
    const userContent = buildAuthorPrompt(author, batch);
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: `You are a daily briefing assistant. Summarize the following posts from ${author} concisely. For each post:
- A 1-2 sentence summary of the key argument or news
- One sentence on why it matters or what's interesting about it

Be direct. Skip filler and meta-commentary. If a post appears to be truncated (marked as [Teaser only]), say so and summarize what's available.

Output format: Markdown. Use ### for each post title (linked to the URL).`,
      messages: [{ role: "user", content: userContent }],
    });

    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    summaries.push(text);
  }

  return summaries.join("\n\n");
}

async function generateHighlights(
  client: Anthropic,
  allSummaries: string
): Promise<string> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: `You are a daily briefing assistant. Given the following summaries of today's posts across multiple authors, pick the 2-3 most important or interesting items and write a brief "Today's Highlights" section. Each highlight should be 1-2 sentences. Lead with the most important.

Output format: Markdown bullet list.`,
    messages: [{ role: "user", content: allSummaries }],
  });

  return response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export async function summarizeByAuthor(
  posts: CollectedPost[],
  apiKey: string
): Promise<SummarizationResult> {
  const client = new Anthropic({ apiKey });
  const authorGroups = groupByAuthor(posts);
  const authorSummaries: AuthorSummary[] = [];
  const summaryWarnings: string[] = [];
  let allSummaryText = "";

  for (const [author, authorPosts] of authorGroups) {
    console.log(`Summarizing ${authorPosts.length} post(s) from ${author}...`);
    try {
      const markdown = await summarizeAuthor(client, author, authorPosts);
      authorSummaries.push({ author, markdown });
      allSummaryText += `## ${author}\n${markdown}\n\n`;
    } catch (err) {
      console.warn(`First attempt failed for ${author}: ${err}`);
      // Retry once
      await sleep(RETRY_DELAY_MS);
      try {
        const markdown = await summarizeAuthor(client, author, authorPosts);
        authorSummaries.push({ author, markdown });
        allSummaryText += `## ${author}\n${markdown}\n\n`;
      } catch (retryErr) {
        console.error(`Summarization failed for ${author}: ${retryErr}`);
        summaryWarnings.push(`Summary unavailable for ${author} — API error`);
      }
    }
  }

  // Generate highlights
  let highlights = "";
  if (allSummaryText) {
    try {
      highlights = await generateHighlights(client, allSummaryText);
    } catch (err) {
      console.warn(`Highlights generation failed: ${err}`);
      // Retry once
      await sleep(RETRY_DELAY_MS);
      try {
        highlights = await generateHighlights(client, allSummaryText);
      } catch (retryErr) {
        console.warn(`Highlights retry failed: ${retryErr}`);
        summaryWarnings.push("Highlights generation failed — skipped");
      }
    }
  }

  // Fallback: if ALL author summaries failed, create raw list
  if (authorSummaries.length === 0 && posts.length > 0) {
    const fallbackMarkdown = posts
      .map((p) => `- **${p.title}** by ${p.author} — [link](${p.url})`)
      .join("\n");
    authorSummaries.push({
      author: "All Posts (unsummarized)",
      markdown: fallbackMarkdown,
    });
    summaryWarnings.push(
      "All summarization calls failed — showing raw post list"
    );
  }

  return { authorSummaries, highlights, summaryWarnings };
}
