/**
 * Contracts shared by every host that can drive the homepage agent.
 *
 * The orchestrator is deliberately ignorant of *where* it runs. The extension
 * supplies a bridge backed by `chrome.history` / `chrome.tabs`; the Node test
 * harness supplies one backed by fixtures and `fetch`. Nothing in this package
 * may import `chrome`, `browser`, or `node:*`.
 */

/** One domain's worth of browsing history, narrowed to fit in a context window. */
export interface SiteDigest {
  domain: string;
  visits: number;
  pages: number;
  /** ISO 8601 — the model reasons about dates, not epoch milliseconds. */
  lastVisit: string;
  score: number;
  /** Capped. `urls[]` is dropped entirely. */
  sampleTitles: string[];
}

export interface GetHistoryResult {
  windowDays: number;
  /** What the model is *not* seeing. Without this it assumes the digest is exhaustive. */
  totalSitesSeen: number;
  sites: SiteDigest[];
}

/** A page whose HTML now lives in the build's in-memory workspace rather than in context. */
export interface PageRef {
  url: string;
  title: string;
  /** The workspace path the page was saved at (e.g. `/pages/example_com_0.html`). Use it verbatim with read/grep. */
  mountPath: string;
  /** Characters stored. Lets the model choose grep-first over read-whole. */
  bytes: number;
}

export interface GetPageHtmlResult {
  pages: PageRef[];
  /** Surfaced, never swallowed: partial failure is information the model needs. */
  failed: Array<{ url: string; reason: string }>;
}

/** Raw per-domain history, as a BrowserBridge returns it — before `buildHistoryDigest` narrows it. */
export interface RawSiteMetadata {
  domain: string;
  totalVisits: number;
  uniquePages: number;
  lastVisitTime: number;
  averageVisitsPerDay: number;
  titles: string[];
  urls: string[];
  relevanceScore: number;
}

export interface ScrapedPage {
  url: string;
  /** Where the page ended up after redirects, when the host can tell. */
  finalUrl?: string;
  /** The address the browser connected to for the page, when the host can tell it is not a proxy's. */
  ip?: string;
  title: string;
  html: string;
}

/**
 * The two capabilities only a real browser has. Everything else the agent needs
 * (a filesystem, grep, read) is supplied by agent-core's in-memory Workspace.
 */
export interface BrowserBridge {
  getHistory(args: {
    daysToAnalyze: number;
    maxResults: number;
  }): Promise<{ sites: RawSiteMetadata[]; totalSitesSeen: number }>;

  getPageHtml(args: {
    urls: string[];
    loadDelayMs?: number;
  }): Promise<{ pages: ScrapedPage[]; failed: Array<{ url: string; reason: string }> }>;
}

/** Minimal persistence. `chrome.storage.local` in the extension, a JSON file in Node. */
export interface KVStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export type RunPhase =
  | "setup"
  | "session-create"
  | "thinking"
  | "history"
  | "scraping"
  | "analyzing"
  | "writing"
  | "cleanup"
  | "done"
  | "error";

export interface RunCallbacks {
  onPhase?(phase: RunPhase, detail?: string): void;
  /** Streamed assistant prose, for a progress panel. */
  onText?(text: string): void;
  onLog?(line: string): void;
}

export interface HomepageBuildResult {
  code: string;
  /** The local build id (kept under this name so hosts written for the hosted version still work). */
  sessionId: string;
  /**
   * Where the code came from: the written component, the Morning Tab template
   * filled from edition.json, a fenced block in the final message, or a repair.
   */
  source: "session-output" | "edition" | "message-fence" | "repair";
  /** Link keys left in the code after the link check: the click allowlist. */
  links: string[];
  /** Links the check removed, with why. */
  removedLinks: Array<{ url: string; reason: "not-http" | "not-seen" }>;
  /** Whether the one repair attempt was used. */
  repaired: boolean;
}
