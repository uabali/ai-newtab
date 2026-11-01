/**
 * An in-memory filesystem for one build. Replaces the hosted sandbox the
 * original version mounted pages into: scraped pages are written here, the
 * model reads them with read / grep / glob, and writes its deliverable with
 * write. Nothing here touches the network or disk; a snapshot can be
 * checkpointed so an interrupted build resumes with its pages intact.
 */
export const PAGES_DIR = "/pages";
export const OUTPUTS_DIR = "/outputs";
/** Per page, after line-splitting. Sanitized HTML is usually far smaller. */
export const MAX_PAGE_CHARS = 400_000;
/** The written component. A homepage that needs more than this has failed already. */
export const MAX_OUTPUT_CHARS = 200_000;
/** Lines are cut to this in read / grep output, so one minified line can't blow the context. */
const MAX_LINE_CHARS = 500;
/** grep only scans this much of each line, which also bounds regex work per line. */
const MAX_SCAN_CHARS = 4_000;
const DEFAULT_READ_LINES = 150;
const MAX_READ_LINES = 400;
const DEFAULT_GREP_RESULTS = 50;
const MAX_GREP_RESULTS = 200;

const BLOCK_TAGS =
  "html|head|body|title|meta|link|div|section|article|main|header|footer|nav|aside|p|h[1-6]|ul|ol|li|dl|dt|dd|table|thead|tbody|tfoot|tr|td|th|blockquote|pre|form|figure|figcaption|details|summary|br|hr";
const BLOCK_START = new RegExp(`\\s*(<(?:${BLOCK_TAGS})\\b[^>]*>)`, "gi");
const LONG_LINE = 2000;

/**
 * Line-split HTML so `grep` and `read` return useful lines: a break before every
 * block-level opening tag keeps a headline's text and link on the same line as its
 * `<h2>` / `<a>`. Lines that are still very long (minified, span-only markup) are
 * split between tags as a fallback.
 */
export function prepareHtml(html: string): string {
  const text = html
    .replace(BLOCK_START, "\n$1")
    .split("\n")
    .map((line) => (line.length > LONG_LINE ? line.replace(/>\s*</g, ">\n<") : line))
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
  return text.length > MAX_PAGE_CHARS ? `${text.slice(0, MAX_PAGE_CHARS)}\n<!-- truncated: page exceeded ${MAX_PAGE_CHARS} chars -->` : text;
}

/** Absolute, `..`-free. Also accepts the old sandbox paths (/mnt/session/uploads/...) models may still guess. */
export function normalizePath(raw: string): string {
  const s = String(raw ?? "").trim().replace(/\\/g, "/").replace(/^\/?mnt\/session\/(uploads\/)?/, "/");
  const parts: string[] = [];
  for (const seg of s.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join("/")}`;
}

/** `*` and `?` stay within a segment, `**` crosses them. A pattern with no `/` matches a basename anywhere. */
export function globToRegExp(pattern: string): RegExp {
  const trimmed = pattern.trim() || "**";
  const p = normalizePath(trimmed.includes("/") ? trimmed : `**/${trimmed}`);
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "*") {
      if (p[i + 1] === "*") {
        re += ".*";
        i++;
        if (p[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function clip(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [+${line.length - MAX_LINE_CHARS} chars]` : line;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export class Workspace {
  private readonly files = new Map<string, string>();

  constructor(init?: Record<string, string>) {
    for (const [path, text] of Object.entries(init ?? {})) this.files.set(normalizePath(path), text);
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.files);
  }

  get(path: string): string | undefined {
    return this.files.get(normalizePath(path));
  }

  list(): Array<{ path: string; bytes: number }> {
    return [...this.files].map(([path, text]) => ({ path, bytes: text.length })).sort((a, b) => a.path.localeCompare(b.path));
  }

  addPage(filename: string, html: string): { path: string; bytes: number } {
    const path = normalizePath(`${PAGES_DIR}/${filename}`);
    const text = prepareHtml(html);
    this.files.set(path, text);
    return { path, bytes: text.length };
  }

  private require(path: string): [string, string] {
    const p = normalizePath(path);
    const text = this.files.get(p);
    if (text === undefined) {
      const known = this.list().map((f) => f.path).join(", ") || "(none)";
      throw new Error(`No such file: ${p}. Files: ${known}`);
    }
    return [p, text];
  }

  read(input: { path: string; offset?: number; limit?: number }, maxChars: number): string {
    const [path, text] = this.require(input.path);
    const lines = text.split("\n");
    const start = clampInt(input.offset, 1, 1, Math.max(lines.length, 1));
    const limit = clampInt(input.limit, DEFAULT_READ_LINES, 1, MAX_READ_LINES);
    const out: string[] = [];
    let used = 0;
    let last = start - 1;
    for (let i = start - 1; i < Math.min(lines.length, start - 1 + limit); i++) {
      const row = `${i + 1}\t${clip(lines[i]!)}`;
      if (used + row.length > maxChars && out.length) break;
      out.push(row);
      used += row.length + 1;
      last = i + 1;
    }
    const more = last < lines.length ? ` Continue with offset=${last + 1}.` : "";
    return `${path} — lines ${start}-${last} of ${lines.length}.${more}\n${out.join("\n")}`;
  }

  grep(input: { pattern: string; path?: string; ignoreCase?: boolean; maxResults?: number }, maxChars: number): string {
    const pattern = String(input.pattern ?? "");
    if (!pattern) throw new Error("grep needs a pattern");
    const flags = input.ignoreCase === false ? "" : "i";
    let re: RegExp;
    try {
      re = new RegExp(pattern, flags);
    } catch {
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    }
    const cap = clampInt(input.maxResults, DEFAULT_GREP_RESULTS, 1, MAX_GREP_RESULTS);
    const targets = this.resolveTargets(input.path);
    const hits: string[] = [];
    let total = 0;
    let used = 0;
    for (const [path, text] of targets) {
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i]!.slice(0, MAX_SCAN_CHARS))) continue;
        total++;
        if (hits.length >= cap) continue;
        const row = `${path}:${i + 1}: ${clip(lines[i]!)}`;
        if (used + row.length > maxChars) continue;
        hits.push(row);
        used += row.length + 1;
      }
    }
    if (!total) return `No matches for /${pattern}/ in ${targets.length} file(s).`;
    const omitted = total - hits.length;
    return `${total} match(es) in ${targets.length} file(s)${omitted ? `, ${omitted} not shown — narrow the pattern or path` : ""}.\n${hits.join("\n")}`;
  }

  glob(input: { pattern?: string }): string {
    const re = globToRegExp(input.pattern ?? "**");
    const found = this.list().filter((f) => re.test(f.path));
    if (!found.length) return `No files match ${input.pattern ?? "**"}. Files: ${this.list().map((f) => f.path).join(", ") || "(none)"}`;
    return found.map((f) => `${f.path}\t${f.bytes} chars`).join("\n");
  }

  write(input: { path: string; content: string; append?: boolean }): string {
    const path = normalizePath(input.path);
    if (!path.startsWith(`${OUTPUTS_DIR}/`)) throw new Error(`write is only allowed under ${OUTPUTS_DIR}/ (use ${OUTPUTS_DIR}/homepage.tsx)`);
    if (!/\.(tsx|jsx|ts|js|json)$/.test(path)) throw new Error("write only accepts .json, .tsx, .jsx, .ts or .js files");
    if (typeof input.content !== "string") throw new Error("write needs a string `content`");
    const next = (input.append ? this.files.get(path) ?? "" : "") + input.content;
    if (next.length > MAX_OUTPUT_CHARS) throw new Error(`File would exceed ${MAX_OUTPUT_CHARS} chars; write a smaller component`);
    this.files.set(path, next);
    return `${input.append ? "Appended to" : "Wrote"} ${path} (${next.length} chars total).`;
  }

  private resolveTargets(path?: string): Array<[string, string]> {
    const all = [...this.files].sort(([a], [b]) => a.localeCompare(b));
    if (!path?.trim()) return all;
    if (/[*?]/.test(path)) {
      const re = globToRegExp(path);
      return all.filter(([p]) => re.test(p));
    }
    const p = normalizePath(path);
    if (this.files.has(p)) return [[p, this.files.get(p)!]];
    const dir = p === "/" ? "/" : `${p}/`;
    const under = all.filter(([f]) => f.startsWith(dir));
    if (!under.length) this.require(path);
    return under;
  }
}
