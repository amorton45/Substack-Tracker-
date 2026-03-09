import RSSParser from "rss-parser";
import { convert } from "html-to-text";
import type { SubstackSource, CollectedPost, CollectionResult } from "./types.js";

const MAX_CONTENT_LENGTH = 3000;
const THIN_CONTENT_THRESHOLD = 200;
const THIN_CONTENT_PHRASES = [
  "subscribe to",
  "read more",
  "this post is for paid subscribers",
  "this post is for paying subscribers",
];
const FEED_DELAY_MS = 1000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isThinContent(text: string): boolean {
  if (text.length < THIN_CONTENT_THRESHOLD) return true;
  const lower = text.toLowerCase();
  return THIN_CONTENT_PHRASES.some((phrase) => lower.includes(phrase));
}

function htmlToPlainText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
    ],
  });
}

function truncateContent(text: string): string {
  if (text.length <= MAX_CONTENT_LENGTH) return text;
  return text.slice(0, MAX_CONTENT_LENGTH) + "...";
}

interface SubstackApiPost {
  title: string;
  subtitle?: string;
  post_date: string;
  canonical_url: string;
  body_html?: string;
  slug: string;
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 1,
  backoffMs = 3000
): Promise<Response> {
  try {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } catch (err) {
    if (retries <= 0) throw err;
    await sleep(backoffMs);
    return fetchWithRetry(url, options, retries - 1, backoffMs);
  }
}

async function fetchViaRss(
  source: SubstackSource,
  since: Date,
  sid?: string
): Promise<{ posts: CollectedPost[]; usedCookie: boolean }> {
  const feedUrl = `https://${source.slug}.substack.com/feed`;
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (sid) {
    headers["Cookie"] = `substack.sid=${sid}`;
  }

  const response = await fetchWithRetry(feedUrl, { headers });
  const xml = await response.text();

  const parser = new RSSParser();
  const feed = await parser.parseString(xml);

  const posts: CollectedPost[] = [];
  for (const item of feed.items) {
    const pubDate = item.pubDate ? new Date(item.pubDate) : null;
    if (!pubDate || pubDate < since) continue;

    const rawContent = item["content:encoded"] || item.content || item.contentSnippet || "";
    const plainText = htmlToPlainText(rawContent);
    const truncated = isThinContent(plainText);

    posts.push({
      author: source.name,
      slug: source.slug,
      title: item.title || "Untitled",
      content: truncated
        ? plainText + "\n\n[Teaser only — full post requires active subscription or fresh session cookie]"
        : truncateContent(plainText),
      url: item.link || `https://${source.slug}.substack.com`,
      publishedAt: pubDate,
      isTruncated: truncated,
    });
  }

  return { posts, usedCookie: !!sid };
}

async function fetchViaApi(
  source: SubstackSource,
  since: Date,
  sid?: string
): Promise<CollectedPost[]> {
  const apiUrl = `https://${source.slug}.substack.com/api/v1/posts?limit=10`;
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (sid) {
    headers["Cookie"] = `substack.sid=${sid}`;
  }

  const response = await fetchWithRetry(apiUrl, { headers });
  const data: SubstackApiPost[] = await response.json() as SubstackApiPost[];

  const posts: CollectedPost[] = [];
  for (const post of data) {
    const pubDate = new Date(post.post_date);
    if (pubDate < since) continue;

    const rawContent = post.body_html || "";
    const plainText = htmlToPlainText(rawContent);
    const truncated = isThinContent(plainText);

    posts.push({
      author: source.name,
      slug: source.slug,
      title: post.title || "Untitled",
      content: truncated
        ? plainText + "\n\n[Teaser only — full post requires active subscription or fresh session cookie]"
        : truncateContent(plainText),
      url: post.canonical_url,
      publishedAt: pubDate,
      isTruncated: truncated,
    });
  }

  return posts;
}

async function collectFromSource(
  source: SubstackSource,
  since: Date,
  sid?: string
): Promise<{ posts: CollectedPost[]; warnings: string[] }> {
  const warnings: string[] = [];

  // Approach A: RSS with cookie (if available)
  try {
    const { posts } = await fetchViaRss(source, since, sid);
    if (posts.length > 0) {
      const truncatedPosts = posts.filter((p) => p.isTruncated);
      if (truncatedPosts.length > 0 && sid) {
        warnings.push(
          `SUBSTACK_SID may be expired — got truncated content for ${source.name}`
        );
      }
      return { posts, warnings };
    }
  } catch (err) {
    console.warn(`RSS fetch failed for ${source.name}: ${err}`);
  }

  // Approach B: JSON API fallback
  if (sid) {
    try {
      const posts = await fetchViaApi(source, since, sid);
      if (posts.length > 0) {
        const truncatedPosts = posts.filter((p) => p.isTruncated);
        if (truncatedPosts.length > 0) {
          warnings.push(
            `SUBSTACK_SID may be expired — got truncated content for ${source.name}`
          );
        }
        return { posts, warnings };
      }
    } catch (err) {
      console.warn(`API fetch failed for ${source.name}: ${err}`);
    }
  }

  // Approach C: Plain RSS (no cookie)
  if (sid) {
    try {
      const { posts } = await fetchViaRss(source, since);
      return { posts, warnings };
    } catch (err) {
      console.warn(`Plain RSS fetch failed for ${source.name}: ${err}`);
    }
  }

  warnings.push(`Failed to fetch: ${source.name}`);
  return { posts: [], warnings };
}

export async function collectSubstackPosts(
  sources: SubstackSource[],
  since: Date,
  sid?: string
): Promise<CollectionResult> {
  const allPosts: CollectedPost[] = [];
  const allWarnings: string[] = [];

  for (const source of sources) {
    console.log(`Fetching ${source.name} (${source.slug})...`);
    const { posts, warnings } = await collectFromSource(source, since, sid);
    allPosts.push(...posts);
    allWarnings.push(...warnings);

    // Be polite — delay between feeds
    await sleep(FEED_DELAY_MS);
  }

  return { posts: allPosts, warnings: allWarnings };
}
