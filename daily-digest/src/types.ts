export interface SubstackSource {
  name: string;
  slug: string;
}

export interface CollectedPost {
  author: string;
  slug: string;
  title: string;
  content: string;
  url: string;
  publishedAt: Date;
  isTruncated: boolean;
}

export interface CollectionResult {
  posts: CollectedPost[];
  warnings: string[];
}

export interface AuthorSummary {
  author: string;
  markdown: string;
}

export interface SummarizationResult {
  authorSummaries: AuthorSummary[];
  highlights: string;
  summaryWarnings: string[];
}

export interface Digest {
  markdown: string;
  html: string;
}

export interface AppConfig {
  anthropicApiKey: string;
  gmailUser: string;
  gmailAppPassword: string;
  emailTo: string;
  substackSid: string | undefined;
  timezone: string;
  substacks: SubstackSource[];
  dryRun: boolean;
}
