import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { convert } from "html-to-text";
import type { SubstackSource, CollectedPost, CollectionResult } from "./types.js";

const MAX_CONTENT_LENGTH = 3000;

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

function extractSubstackUrl(html: string): string | null {
  // Look for the canonical post link in the email HTML
  // Substack emails contain links like https://{slug}.substack.com/p/{post-slug}
  const match = html.match(
    /https:\/\/[a-zA-Z0-9-]+\.substack\.com\/p\/[a-zA-Z0-9-]+/
  );
  if (match) return match[0];

  // Also check for custom domain links that contain /p/
  const customMatch = html.match(
    /https?:\/\/[a-zA-Z0-9.-]+\/p\/[a-zA-Z0-9-]+/
  );
  if (customMatch) return customMatch[0];

  return null;
}

function matchSourceFromEmail(
  fromAddress: string,
  fromName: string,
  subject: string,
  html: string,
  sources: SubstackSource[]
): SubstackSource | null {
  const fromLower = fromAddress.toLowerCase();
  const nameLower = fromName.toLowerCase();
  const subjectLower = subject.toLowerCase();

  // Try to match by slug in the from address or email HTML
  for (const source of sources) {
    const slugLower = source.slug.toLowerCase();
    const sourceName = source.name.toLowerCase();

    if (fromLower.includes(slugLower)) return source;
    if (nameLower.includes(sourceName)) return source;
    if (nameLower.includes(slugLower)) return source;
  }

  // Try matching by URL in the HTML body
  if (html) {
    for (const source of sources) {
      if (html.toLowerCase().includes(`${source.slug}.substack.com`)) {
        return source;
      }
    }
  }

  return null;
}

export async function collectSubstackPosts(
  sources: SubstackSource[],
  since: Date,
  config: { user: string; password: string }
): Promise<CollectionResult> {
  const posts: CollectedPost[] = [];
  const warnings: string[] = [];

  const client = new ImapFlow({
    host: "outlook.office365.com",
    port: 993,
    secure: true,
    auth: {
      user: config.user,
      pass: config.password,
    },
    logger: false,
  });

  try {
    await client.connect();
    console.log("Connected to Outlook IMAP.");

    const lock = await client.getMailboxLock("INBOX");

    try {
      // Search for emails from Substack since the cutoff date
      const sinceDate = new Date(since);
      sinceDate.setHours(0, 0, 0, 0); // IMAP SINCE uses date only

      const searchResult = await client.search({
        since: sinceDate,
        from: "substack.com",
      });

      const messageIds = searchResult === false ? [] : searchResult;

      console.log(`Found ${messageIds.length} Substack emails since ${sinceDate.toISOString()}.`);

      if (messageIds.length === 0) {
        return { posts, warnings };
      }

      // Fetch each message
      for await (const msg of client.fetch(messageIds, {
        envelope: true,
        source: true,
      })) {
        try {
          const parsed = await simpleParser(msg.source!);

          const fromAddress = (parsed as any).from?.value?.[0]?.address || "";
          const fromName = (parsed as any).from?.value?.[0]?.name || "";
          const subject = (parsed as any).subject || "";
          const emailDate = (parsed as any).date || new Date();
          const html = ((parsed as any).html || "") as string;
          const textContent = (parsed as any).text || "";

          // Skip if before our actual cutoff (IMAP SINCE is date-only)
          if (emailDate < since) continue;

          // Check if this is from Substack
          if (!fromAddress.toLowerCase().includes("substack")) continue;

          // Match to a source
          const source = matchSourceFromEmail(
            fromAddress,
            fromName,
            subject,
            html,
            sources
          );

          if (!source) {
            // Not from a tracked source, skip
            continue;
          }

          // Extract content
          const plainText = html
            ? htmlToPlainText(html)
            : textContent;

          const postUrl = extractSubstackUrl(html) || "";

          posts.push({
            author: source.name,
            slug: source.slug,
            title: subject,
            content: truncateContent(plainText),
            url: postUrl,
            publishedAt: emailDate,
            isTruncated: false,
          });
        } catch (err) {
          console.warn(`Failed to parse email: ${err}`);
        }
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    console.error(`IMAP connection error: ${err}`);
    warnings.push(`Failed to connect to Outlook IMAP: ${err}`);
  } finally {
    await client.logout().catch(() => {});
  }

  console.log(
    `Collected ${posts.length} posts from ${new Set(posts.map((p) => p.author)).size} authors.`
  );

  return { posts, warnings };
}
