import { createTransport } from "nodemailer";
import { marked } from "marked";
import { format } from "date-fns";
import { writeFile, mkdir } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { AuthorSummary, CollectedPost, Digest } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RETRY_DELAY_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function composeDigest(options: {
  highlights: string;
  authorSummaries: AuthorSummary[];
  posts: CollectedPost[];
  warnings: string[];
  date: Date;
}): Digest {
  const { highlights, authorSummaries, posts, warnings, date } = options;

  let markdown = "";

  // Highlights section
  if (highlights) {
    markdown += `# Today's Highlights\n\n${highlights}\n\n---\n\n`;
  }

  // Per-author summaries
  for (const summary of authorSummaries) {
    markdown += `## ${summary.author}\n\n${summary.markdown}\n\n`;
  }

  // Sources section
  if (posts.length > 0) {
    markdown += `---\n\n## Sources\n\n`;
    for (const post of posts) {
      markdown += `- "${post.title}" — ${post.author} — [link](${post.url})\n`;
    }
    markdown += "\n";
  }

  // Warnings section
  if (warnings.length > 0) {
    markdown += `## Warnings\n\n`;
    for (const warning of warnings) {
      markdown += `- ${warning}\n`;
    }
    markdown += "\n";
  }

  const html = marked(markdown) as string;

  return { markdown, html };
}

export async function saveDigest(
  markdown: string,
  date: Date
): Promise<string> {
  const digestsDir = resolve(__dirname, "../digests");
  await mkdir(digestsDir, { recursive: true });

  const filename = `${format(date, "yyyy-MM-dd")}.md`;
  const filepath = resolve(digestsDir, filename);
  await writeFile(filepath, markdown, "utf-8");

  return filepath;
}

export async function sendDigest(
  html: string,
  dateLabel: string,
  config: { gmailUser: string; gmailAppPassword: string; to: string }
): Promise<void> {
  const transporter = createTransport({
    service: "gmail",
    auth: {
      user: config.gmailUser,
      pass: config.gmailAppPassword,
    },
  });

  const subject = `Daily Digest — ${dateLabel}`;
  const mailOptions = {
    from: config.gmailUser,
    to: config.to,
    subject,
    html,
  };

  try {
    await transporter.sendMail(mailOptions);
  } catch (err) {
    console.warn(`Email send failed, retrying: ${err}`);
    await sleep(RETRY_DELAY_MS);
    await transporter.sendMail(mailOptions);
  }
}
