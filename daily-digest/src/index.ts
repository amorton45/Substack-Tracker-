import { subHours, format } from "date-fns";
import { loadConfig } from "./config.js";
import { collectSubstackPosts } from "./collector.js";
import { summarizeByAuthor } from "./summarizer.js";
import { composeDigest, saveDigest, sendDigest } from "./email.js";

async function main() {
  const config = loadConfig();
  const now = new Date();
  const since = subHours(now, 24);

  console.log(`Fetching posts since ${since.toISOString()}...`);

  // 1. Collect
  const { posts, warnings } = await collectSubstackPosts(
    config.substacks,
    since,
    config.substackSid
  );

  if (posts.length === 0) {
    console.log("No new posts in the last 24h. Skipping digest.");
    return;
  }

  const authorCount = new Set(posts.map((p) => p.author)).size;
  console.log(`Found ${posts.length} posts from ${authorCount} authors.`);

  // 2. Summarize
  const { authorSummaries, highlights, summaryWarnings } =
    await summarizeByAuthor(posts, config.anthropicApiKey);

  // 3. Compose digest
  const digest = composeDigest({
    highlights,
    authorSummaries,
    posts,
    warnings: [...warnings, ...summaryWarnings],
    date: now,
  });

  // 4. Save to file
  const archivePath = await saveDigest(digest.markdown, now);
  console.log(`Digest saved to ${archivePath}`);

  // 5. Send email (or dry run)
  if (config.dryRun) {
    console.log("\n--- DRY RUN: Digest content ---\n");
    console.log(digest.markdown);
    console.log("--- End of digest ---\n");
    console.log("Dry run complete. Email not sent.");
  } else {
    await sendDigest(digest.html, format(now, "MMMM d, yyyy"), {
      gmailUser: config.gmailUser,
      gmailAppPassword: config.gmailAppPassword,
      to: config.emailTo,
    });
    console.log(`Digest emailed to ${config.emailTo}.`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
