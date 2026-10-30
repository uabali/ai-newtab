/**
 * Link hygiene for the generated homepage. The model must only link to URLs it
 * actually saw (a page it scraped, an href on one, or a domain from the history
 * digest). After a build, every literal link in the component is checked against
 * that set and anything else is unlinked. The new-tab page enforces the same
 * allowlist again at click time (see apps/extension/lib/link-bridge.ts).
 */

/** Most links kept from a build; a homepage with more than this is not a homepage. */
export const MAX_SEEN_URLS = 20_000;

const ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", "#39": "'", "#x27": "'", "#x2F": "/", "#47": "/" };

function decodeEntities(s: string): string {
  return s.replace(/&(amp|quot|apos|lt|gt|#39|#x27|#x2F|#47);/gi, (m, name: string) => ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? m);
}

/**
 * The comparison key for a link, or null when it isn't a usable link: absolute
 * http(s) only, no credentials, no fragment, no trailing slash on a non-root path.
 * `base` resolves relative hrefs found on scraped pages; the model's own links get
 * no base, so a relative or partial link there is simply invalid.
 *
 * Keep in sync with `key()` in apps/extension/lib/link-bridge.ts (a test checks both agree).
 */
export function linkKey(raw: unknown, base?: string): string | null {
  if (typeof raw !== "string") return null;
  const s = decodeEntities(raw.trim());
  if (!s) return null;
  if (!base && !/^https?:\/\//i.test(s)) return null;
  let u: URL;
  try {
    u = base ? new URL(s, base) : new URL(s);
  } catch {
    return null;
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname || u.username || u.password) return null;
  u.hash = "";
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  return u.href;
}

/** Every link (`<a href>`) on a scraped page, resolved against the page's URL. */
export function extractPageLinks(html: string, pageUrl: string): string[] {
  const out = new Set<string>();
  const re = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi;
  for (const m of html.matchAll(re)) {
    const key = linkKey(m[1] ?? m[2] ?? m[3] ?? "", pageUrl);
    if (key) out.add(key);
  }
  return [...out];
}

/** The set of URLs a build has seen, stored as plain keys so it checkpoints as JSON. */
export class SeenUrls {
  private readonly keys: Set<string>;
  constructor(initial: Iterable<string> = []) {
    this.keys = new Set(initial);
  }
  add(url: string, base?: string): void {
    if (this.keys.size >= MAX_SEEN_URLS) return;
    const key = linkKey(url, base);
    if (key) this.keys.add(key);
  }
  /** A domain from the history digest: its front page counts as seen. */
  addDomain(domain: string): void {
    const host = domain.trim().toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(host) || !host.includes(".")) return;
    this.add(`https://${host}/`);
    this.add(`http://${host}/`);
  }
  addPage(html: string, pageUrl: string): void {
    this.add(pageUrl);
    for (const key of extractPageLinks(html, pageUrl)) {
      if (this.keys.size >= MAX_SEEN_URLS) break;
      this.keys.add(key);
    }
  }
  has(url: string): boolean {
    const key = linkKey(url);
    return key !== null && this.keys.has(key);
  }
  get size(): number {
    return this.keys.size;
  }
  toJSON(): string[] {
    return [...this.keys];
  }
}

export interface RemovedLink {
  url: string;
  reason: "not-http" | "not-seen";
}

export interface LinkCheck {
  code: string;
  /** Keys of the links that stayed: the click allowlist for this homepage. */
  links: string[];
  removed: RemovedLink[];
}

/** Object keys that hold a link (unlinked when invalid); image-ish keys are left alone. */
const LINK_KEY = /^(?:url|href|link|permalink|[A-Za-z]*(?:Url|URL|Link|Href))$/;
const MEDIA_KEY = /img|image|thumb|icon|avatar|logo|photo|picture|src|media|video|favicon/i;

/**
 * Check every literal link in the component against what the build saw.
 *
 *   <a href="…">                   attribute removed (the text stays, unlinked)
 *   { url: "…" }, "href": "…"      value replaced with null (href={item.url} then renders no link)
 *
 * Links built at runtime can't be checked here; the new-tab page drops any link
 * outside the returned allowlist when it renders and when it is clicked.
 */
export function validateHomepageLinks(code: string, seen: { has(url: string): boolean }): LinkCheck {
  const kept = new Set<string>();
  const removed: RemovedLink[] = [];
  const judge = (raw: string): boolean => {
    const key = linkKey(raw);
    if (!key) {
      removed.push({ url: raw, reason: "not-http" });
      return false;
    }
    if (!seen.has(key)) {
      removed.push({ url: raw, reason: "not-seen" });
      return false;
    }
    kept.add(key);
    return true;
  };

  // JSX href with a literal value: href="…", href='…', href={"…"}, href={'…'}, href={`…`} (no ${}).
  let out = code.replace(
    /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*"([^"]*)"\s*\}|\{\s*'([^']*)'\s*\}|\{\s*`([^`$]*)`\s*\})/g,
    (match, ...groups: (string | undefined)[]) => {
      const raw = groups.slice(0, 5).find((g) => g !== undefined) ?? "";
      return judge(raw) ? match : "";
    },
  );

  // Data objects: url: "…", "href": '…', storyLink: `…` (no ${}).
  out = out.replace(
    /(^|[\s{,(])(["']?)([A-Za-z_$][\w$]*)\2(\s*:\s*)(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`([^`$\\]*)`)/g,
    (match, lead: string, q: string, key: string, colon: string, d?: string, s?: string, t?: string) => {
      if (!LINK_KEY.test(key) || MEDIA_KEY.test(key)) return match;
      const raw = (d ?? s ?? t ?? "").replace(/\\(.)/g, "$1");
      return judge(raw) ? match : `${lead}${q}${key}${q}${colon}null`;
    },
  );

  return { code: out, links: [...kept], removed };
}

/** Every absolute http(s) literal in a component, for homepages saved before link checks existed. */
export function literalLinks(code: string): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(/["'`](https?:\/\/[^"'`\s]+)["'`]/g)) {
    const key = linkKey(m[1]!);
    if (key) out.add(key);
  }
  return [...out];
}
