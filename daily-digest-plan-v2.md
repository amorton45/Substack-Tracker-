# Daily Digest: Substack Summary System (V2)

## Goal

Build a Node.js service that runs every morning, collects posts from your Substack subscriptions (including paid/paywalled content), summarizes each Substack individually with Claude, and emails you a digest.

---

## Architecture Overview

```
[Cron / Scheduler]
      │
      ▼
[Substack Collector]
  ├── RSS feeds (free content)
  └── Substack API + session cookie (paywalled content)
      │
      ▼
[Summarizer] ── Claude API (batched per author)
      │
      ▼
[Email Sender] ── Resend
      │
      ▼
[My Inbox]
```

---

## Project Structure

```
daily-digest/
├── src/
│   ├── index.ts              # Entry point & orchestrator
│   ├── config.ts             # Load env vars + source lists
│   ├── collector.ts          # Substack fetcher (RSS + API)
│   ├── summarizer.ts         # Claude API summarization (per-author batching)
│   ├── email.ts              # Email composition & sending
│   └── types.ts              # Shared types
├── config/
│   └── sources.json          # List of Substacks to follow
├── .env                      # API keys (gitignored)
├── package.json
└── tsconfig.json
```

---

## Step-by-Step Implementation

### 1. Project Setup

Init a Node.js + TypeScript project. Install dependencies:

- `rss-parser` — for Substack RSS feeds
- `@anthropic-ai/sdk` — for Claude summarization
- `resend` — for email delivery
- `node-fetch` — for Substack API calls (if not using Node 18+ native fetch)
- `html-to-text` — for stripping HTML to plain text (do NOT use regex for this)
- `marked` — for converting Claude's markdown summary to HTML for email
- `date-fns` — for date filtering and formatting
- `dotenv` — for env config
- `zod` — for config validation

### 2. Configuration

#### `config/sources.json`

```json
{
  "substacks": [
    { "name": "Matt Levine", "slug": "mattlevine" },
    { "name": "Lenny's Newsletter", "slug": "lennysnewsletter" },
    { "name": "Stratechery", "slug": "stratechery" }
  ]
}
```

#### `.env`

```
ANTHROPIC_API_KEY=sk-ant-...
RESEND_API_KEY=re_...
EMAIL_TO=me@example.com
EMAIL_FROM=digest@yourdomain.com
SUBSTACK_SID=                   # Optional: your substack.sid cookie for paywalled content
DIGEST_TIMEZONE=America/New_York  # Your local timezone for "last 24 hours" calculation
```

### 3. Accessing Paywalled Content

Substack doesn't have an official subscriber API, but there's a practical workaround using your browser session cookie.

#### How It Works

When you're logged into Substack, your browser stores a session cookie called `substack.sid`. If you include this cookie in HTTP requests to Substack, you get access to the full content of any publication you're subscribed to — including paid posts.

There are two approaches, and the collector should try both in order:

#### Approach A: RSS with Cookie (try first)

Substack RSS feeds at `https://{slug}.substack.com/feed` return full content for paid subscribers when the `substack.sid` cookie is included in the request headers:

```ts
const response = await fetch(`https://${slug}.substack.com/feed`, {
  headers: {
    Cookie: `substack.sid=${process.env.SUBSTACK_SID}`,
  },
});
```

This is the simplest path — it uses the same RSS parsing logic you'd use for free content, just with an added cookie header.

#### Approach B: Substack JSON API (fallback)

Substack has undocumented API endpoints that return JSON instead of XML. These are more reliable for getting structured post data:

```ts
// Get recent posts for a publication
const response = await fetch(
  `https://${slug}.substack.com/api/v1/posts?limit=10`,
  {
    headers: {
      Cookie: `substack.sid=${process.env.SUBSTACK_SID}`,
    },
  }
);
const posts = await response.json();
// Each post has: title, subtitle, post_date, canonical_url, body_html
```

The JSON response includes `body_html` with the full post content for publications you're subscribed to.

#### Getting Your Session Cookie

1. Go to substack.com and log in.
2. Open browser DevTools → Application tab → Cookies → `substack.com`.
3. Find the cookie named `substack.sid` and copy its value.
4. Paste it into your `.env` file.

**Important caveats:**
- The cookie expires periodically (typically every few weeks). When it does, the collector should detect thin/empty content and log a warning like: `"SUBSTACK_SID may be expired — got truncated content for [publication]. Re-grab your cookie."`
- If no `SUBSTACK_SID` is set, the collector should fall back gracefully to public RSS (which gives full content for free posts, teaser-only for paid).
- Never commit the cookie to source control.

### 4. Substack Collector (`src/collector.ts`)

#### Core Logic

For each Substack in the config:

1. **Try RSS with cookie** (if `SUBSTACK_SID` is set): Fetch `https://{slug}.substack.com/feed` with the cookie header. Parse with `rss-parser`.
2. **Fall back to JSON API** if RSS gives truncated content or if the cookie is missing/expired.
3. **Fall back to plain RSS** if both above fail.
4. Filter items where publication date is within the last 24 hours (using `DIGEST_TIMEZONE` for correct local-time boundary).
5. Extract: title, link, author, date, and content.
6. Strip HTML to plain text using `html-to-text` (NOT regex — regex mangles content).
7. Truncate to ~3000 chars per post.

#### Detecting Thin Content

Some posts will return only a teaser. Detect this by checking:
- Content is under 200 characters.
- Content contains phrases like "Subscribe to", "Read more", "This post is for paid subscribers".

If thin content is detected and `SUBSTACK_SID` is set, log a warning that the cookie may be expired. Include the post in the digest anyway, but mark it: `"[Teaser only — full post requires active subscription or fresh session cookie]"`.

#### Return Type

```ts
interface CollectedPost {
  author: string;        // e.g., "Matt Levine"
  slug: string;          // e.g., "mattlevine" — used for grouping
  title: string;
  content: string;       // Plain text, truncated to ~3000 chars
  url: string;
  publishedAt: Date;
  isTruncated: boolean;  // True if we only got a teaser
}
```

#### Error Handling

- If a feed fails (404, timeout, DNS error): log a warning, skip it, continue with other feeds. Do NOT crash the entire run for one bad feed.
- Retry each feed once with a 3-second backoff before giving up.
- Track which feeds failed and include a note in the digest email: `"Failed to fetch: [list]"`.

### 5. Summarizer (`src/summarizer.ts`)

#### Per-Author Batching Strategy

Do NOT send all posts in one giant API call. Instead, batch by author:

```
For each author with posts:
  → One Claude API call summarizing all of that author's posts from today
Then:
  → One final Claude API call to generate "Top 3 highlights" across all authors
```

This approach is better because:
- If one call fails, you only lose one author's summaries, not the whole digest.
- You can retry individual failures.
- Each call stays well within context limits.
- The summaries are more focused — Claude can give better per-author context.

#### Per-Author Call

**Model:** `claude-sonnet-4-20250514` (cost-efficient for summarization).

**Prompt:**

```
System:
You are a daily briefing assistant. Summarize the following posts from
{author_name} concisely. For each post:
- A 1-2 sentence summary of the key argument or news
- One sentence on why it matters or what's interesting about it

Be direct. Skip filler and meta-commentary. If a post appears to be
truncated (marked as [Teaser only]), say so and summarize what's available.

Output format: Markdown. Use ### for each post title (linked to the URL).

User:
## {author_name}

### "{post_title}" — {date}
{post_content_plain_text, max 3000 chars}

### "{post_title_2}" — {date}
{post_content_2}
```

**Settings:** `max_tokens: 1024` per author call. Most authors will have 1-3 posts per day; this is plenty.

#### Highlights Call (after all per-author calls complete)

```
System:
You are a daily briefing assistant. Given the following summaries of today's
posts across multiple authors, pick the 2-3 most important or interesting
items and write a brief "Today's Highlights" section. Each highlight should
be 1-2 sentences. Lead with the most important.

Output format: Markdown bullet list.

User:
{concatenated per-author summaries}
```

**Settings:** `max_tokens: 512`.

#### Error & Retry Handling

- If a per-author Claude call fails (rate limit, 500 error, timeout): retry once after 5 seconds.
- If it fails again: skip that author's summary and include a note in the digest: `"Summary unavailable for {author} — API error."`
- If the highlights call fails: skip highlights. The per-author summaries are still useful on their own.
- If ALL calls fail: write the raw post titles + links to a fallback file and include them in the email unsummarized rather than sending nothing.

#### Token Estimation

Rough math to make sure individual calls stay safe:
- ~1 token per 4 characters.
- 3000 chars per post × 5 posts (busy author) = 15,000 chars = ~3,750 tokens input.
- With system prompt and formatting overhead: ~4,500 tokens per call.
- Well within the context window. No splitting needed at the per-author level.

If an author somehow has 20+ posts in a day (unlikely), split into batches of 10 posts per call.

### 6. Email Sender (`src/email.ts`)

Use Resend (free tier allows 100 emails/day — more than enough).

#### Email Structure

**Subject:** `Daily Digest — March 9, 2026`

**Body (HTML, converted from Markdown using `marked`):**

```
# Today's Highlights
- [highlight 1]
- [highlight 2]
- [highlight 3]

---

## Matt Levine
### "Banks Are Weird" — March 9, 2026
[summary...]

### "Crypto Update" — March 9, 2026
[summary...]

## Lenny Rachitsky
### "How to Measure Product-Market Fit" — March 9, 2026
[summary...]

---

## Sources
- "Banks Are Weird" — Matt Levine — [link]
- "Crypto Update" — Matt Levine — [link]
- "How to Measure Product-Market Fit" — Lenny Rachitsky — [link]

## Warnings
- Failed to fetch: stratechery (timeout)
- Summary unavailable for [author] — API error
- SUBSTACK_SID may be expired — got truncated content for [publication]
```

#### Fallback

Before sending the email, write the full digest content (Markdown) to a local file: `digests/{date}.md`. This way:
- If the email send fails, the digest isn't lost.
- You build an archive over time.
- You can re-send manually if needed.

If the email send fails: retry once after 5 seconds. If it fails again, log the error and exit (the file is saved).

### 7. Orchestrator (`src/index.ts`)

```ts
async function main() {
  const config = loadConfig();       // Validate with zod
  const now = new Date();
  const since = getSince(now, config.timezone); // 24h ago in local tz

  // 1. Collect
  console.log(`Fetching posts since ${since.toISOString()}...`);
  const { posts, warnings } = await collectSubstackPosts(
    config.substacks,
    since
  );

  if (posts.length === 0) {
    console.log("No new posts in the last 24h. Skipping digest.");
    return;
  }

  console.log(`Found ${posts.length} posts from ${new Set(posts.map(p => p.author)).size} authors.`);

  // 2. Summarize (per-author, then highlights)
  const { authorSummaries, highlights, summaryWarnings } =
    await summarizeByAuthor(posts);

  // 3. Compose digest
  const digest = composeDigest({
    highlights,
    authorSummaries,
    posts,           // For the Sources section
    warnings: [...warnings, ...summaryWarnings],
    date: now,
  });

  // 4. Save to file (fallback + archive)
  const archivePath = `digests/${format(now, "yyyy-MM-dd")}.md`;
  await fs.writeFile(archivePath, digest.markdown);
  console.log(`Digest saved to ${archivePath}`);

  // 5. Send email
  await sendDigest(digest.html, format(now, "MMMM d, yyyy"));
  console.log(`Digest emailed to ${config.emailTo}.`);
}
```

#### Test Mode

Support a `--dry-run` flag that:
- Runs the full pipeline (collect + summarize).
- Prints the digest to the console instead of emailing.
- Saves the file but skips the email send.

This is essential for development and prompt tuning. Check `process.argv` for `--dry-run`.

### 8. Timezone Handling

The "last 24 hours" boundary must be calculated in your local timezone, not UTC. This matters because:
- If you run at 7 AM Eastern on GitHub Actions (which runs in UTC), "24 hours ago" in UTC is 12 PM UTC yesterday, but 7 AM Eastern yesterday.
- Posts published at 8 AM Eastern yesterday would be missed if you calculate in UTC.

Use the `DIGEST_TIMEZONE` env var with `date-fns-tz` or the native `Intl.DateTimeFormat` to convert correctly:

```ts
function getSince(now: Date, timezone: string): Date {
  // Calculate 24 hours before "now" in the user's local timezone
  return subHours(now, 24);
}
```

In practice, `subHours(new Date(), 24)` works fine as long as you're comparing against `publishedAt` dates that are also in UTC (which RSS feeds and Substack's API both provide). The timezone config mainly matters for display formatting in the email subject/body.

### 9. Scheduling

#### Option A: GitHub Actions (recommended — free, no server)

```yaml
# .github/workflows/digest.yml
name: Daily Digest
on:
  schedule:
    - cron: '0 12 * * *'  # 12:00 UTC = 7:00 AM EST / 8:00 AM EDT
  workflow_dispatch: {}      # Manual trigger for testing

jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npx tsx src/index.ts
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          RESEND_API_KEY: ${{ secrets.RESEND_API_KEY }}
          EMAIL_TO: ${{ secrets.EMAIL_TO }}
          EMAIL_FROM: ${{ secrets.EMAIL_FROM }}
          SUBSTACK_SID: ${{ secrets.SUBSTACK_SID }}
          DIGEST_TIMEZONE: America/New_York
```

Note: GitHub Actions cron can be delayed by up to 15-30 minutes. If exact timing matters, use a VPS.

#### Option B: System cron (on a VPS or always-on machine)

```bash
0 7 * * * cd /path/to/daily-digest && npx tsx src/index.ts >> /var/log/digest.log 2>&1
```

#### Option C: Cloud function (Railway, Render cron, AWS Lambda + EventBridge)

Any of these work. The script is stateless and typically runs in under 30 seconds.

---

## Cost Estimates

| Component | Cost |
|-----------|------|
| Claude API (~5K input + 1K output tokens per author × ~10 authors/day) | ~$0.05-0.10/day |
| Resend email | Free tier (100/day) |
| GitHub Actions | Free tier (2000 min/mo) |
| **Total** | **~$2-3/month** |

---

## Implementation Order

1. **Config + types** — Set up the project, define types, validate config with zod.
2. **Collector (RSS only, no cookie)** — Get RSS fetching working for free Substacks.
3. **Summarizer (single author)** — Get one Claude call working for one author.
4. **Email sender** — Get a basic email sending with hardcoded content.
5. **Wire it together** — Orchestrator with `--dry-run` support.
6. **Test end-to-end** — Run manually, check the output, tune the prompt.
7. **Add cookie auth** — Add `SUBSTACK_SID` support for paywalled content.
8. **Add per-author batching + highlights** — Expand summarizer to full batching strategy.
9. **Add error handling + retries** — Harden the collector and summarizer.
10. **Add scheduling** — Set up GitHub Actions or cron.

---

## Known Limitations & Future Considerations

- **Cookie expiry:** The `substack.sid` cookie will expire. You'll need to manually refresh it every few weeks. A warning system is built into the collector to alert you when content looks truncated.
- **Substack rate limits:** No documented rate limits for RSS feeds, but be polite — add a 1-second delay between feed fetches. The JSON API may have stricter limits.
- **Substack API stability:** The `/api/v1/posts` endpoint is undocumented and could change at any time. The RSS approach is more stable.
- **No X/Twitter yet:** This version is Substack-only. X/Twitter can be added later as a separate collector module using the same `CollectedPost` interface. See V1 plan for options (RSS bridge, official API, or scraping).

---

## Optional Enhancements (Later)

- **Deduplication:** Hash titles to skip cross-posted content.
- **Priority ranking:** Already partially handled by the highlights call — can be expanded.
- **Category tags:** Add a field to the prompt asking Claude to tag each summary.
- **Digest archive search:** Save digests to SQLite and add a simple search CLI.
- **Slack/Discord output:** Add a webhook sender alongside email.
- **X/Twitter collector:** Add as a Phase 2 module.
- **Web dashboard:** Simple page showing today's + past digests.
