/**
 * "The Morning Tab": the default look. The model fills in an edition (plain
 * JSON: stories, briefs, "Your day", almanac notes) and this fixed template turns
 * it into the component. A weak model then only has to get content right, and
 * every build looks the same: cream paper, serif type, a big masthead, columns,
 * thin rules. A user who asks for another look gets a hand-written component instead.
 */

export const EDITION_PATH = "/outputs/edition.json";

export interface EditionStory {
  kicker?: string;
  title: string;
  url?: string | null;
  summary?: string;
  source?: string;
  meta?: string;
}

export interface EditionBrief {
  title: string;
  url?: string | null;
  source?: string;
}

export interface EditionDayItem {
  /** When: "9:00", "Today", "Fri", "Nov 3". */
  when?: string;
  what: string;
  url?: string | null;
}

export interface EditionNote {
  label: string;
  value: string;
}

export interface Edition {
  tagline?: string;
  lead: EditionStory;
  stories: EditionStory[];
  briefs: EditionBrief[];
  yourDay: EditionDayItem[];
  almanac: EditionNote[];
}

/** The shape shown to the model in the system prompt. */
export const EDITION_EXAMPLE = `{
  "tagline": "All the news that fits your history.",
  "lead":    { "kicker": "Technology", "title": "…", "url": "https://…", "summary": "2–4 sentences.", "source": "Hacker News", "meta": "512 points · 230 comments" },
  "stories": [ { "kicker": "…", "title": "…", "url": "https://…", "summary": "1–3 sentences.", "source": "…", "meta": "…" } ],
  "briefs":  [ { "title": "…", "url": "https://…", "source": "…" } ],
  "yourDay": [ { "when": "Today", "what": "Release candidate due", "url": "https://…" } ],
  "almanac": [ { "label": "Most-read site", "value": "news.ycombinator.com" } ]
}`;

const LIMITS = { stories: 9, briefs: 12, yourDay: 6, almanac: 5 } as const;

function text(v: unknown, max: number): string {
  if (typeof v === "number") return String(v);
  if (typeof v !== "string") return "";
  const s = v.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function link(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function story(v: unknown): EditionStory | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const title = text(o.title ?? o.headline, 200);
  if (!title) return null;
  return {
    kicker: text(o.kicker ?? o.section ?? o.category, 40),
    title,
    url: link(o.url ?? o.href ?? o.link),
    summary: text(o.summary ?? o.description ?? o.dek, 600),
    source: text(o.source ?? o.site, 60),
    meta: text(o.meta, 80),
  };
}

function list<T>(v: unknown, map: (x: unknown) => T | null, max: number): T[] {
  return (Array.isArray(v) ? v : []).map(map).filter((x): x is T => x !== null).slice(0, max);
}

/**
 * Coerce whatever the model wrote into a well-typed edition: strings only, capped
 * lengths, no unknown fields. Throws when there is nothing to print.
 */
export function sanitizeEdition(raw: unknown): Edition {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("edition.json must be a JSON object");
  const o = raw as Record<string, unknown>;
  const stories = list(o.stories ?? o.articles, story, LIMITS.stories + 1);
  const lead = story(o.lead) ?? stories.shift();
  if (!lead) throw new Error('edition.json has no stories: set "lead" and/or "stories"');
  return {
    tagline: text(o.tagline, 120) || undefined,
    lead,
    stories: stories.slice(0, LIMITS.stories),
    briefs: list(
      o.briefs,
      (b) => {
        const s = story(b);
        return s ? { title: s.title, url: s.url, source: s.source } : null;
      },
      LIMITS.briefs,
    ),
    yourDay: list(
      o.yourDay ?? o.your_day,
      (d) => {
        if (!d || typeof d !== "object") return null;
        const x = d as Record<string, unknown>;
        const what = text(x.what ?? x.title ?? x.label, 120);
        return what ? { when: text(x.when ?? x.time, 24), what, url: link(x.url ?? x.href) } : null;
      },
      LIMITS.yourDay,
    ),
    almanac: list(
      o.almanac,
      (n) => {
        if (!n || typeof n !== "object") return null;
        const x = n as Record<string, unknown>;
        const label = text(x.label, 40);
        const value = text(x.value, 60);
        return label && value ? { label, value } : null;
      },
      LIMITS.almanac,
    ),
  };
}

/** Parse the model's edition.json (tolerating a ```json fence) and sanitize it. */
export function parseEdition(source: string): Edition {
  const fenced = source.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const body = (fenced ? fenced[1]! : source).trim();
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (err) {
    throw new Error(`edition.json is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  return sanitizeEdition(raw);
}

function dayOfYear(d: Date): number {
  return Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 0)) / 86_400_000);
}

function editionName(d: Date): string {
  const h = d.getHours();
  if (h >= 5 && h < 12) return "Morning Edition";
  if (h >= 12 && h < 17) return "Afternoon Edition";
  if (h >= 17 && h < 22) return "Evening Edition";
  return "Late Edition";
}

/** Fixed facts the template prints, computed here so the model can't get them wrong. */
export function editionFacts(edition: Edition, now: Date) {
  const sources = new Set(
    [edition.lead, ...edition.stories, ...edition.briefs].map((s) => s.source?.toLowerCase()).filter(Boolean),
  );
  const count = 1 + edition.stories.length + edition.briefs.length;
  const year = now.getFullYear();
  const daysInYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;
  const doy = dayOfYear(now);
  return {
    issue: `Vol. I · No. ${doy}`,
    date: now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }),
    edition: editionName(now),
    tally: `${count} ${count === 1 ? "story" : "stories"} from ${Math.max(sources.size, 1)} ${sources.size === 1 ? "source" : "sources"}`,
    printed: now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
    almanac: [
      { label: "Day of the year", value: `${doy} of ${daysInYear}` },
      { label: "Days left", value: String(daysInYear - doy) },
    ],
  };
}

/** The component. Data in, fixed layout out; it only imports React. */
export function renderMorningTab(edition: Edition, now: Date): string {
  const data = JSON.stringify({ ...edition, facts: editionFacts(edition, now) }, null, 2)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `import React from 'react';

// "The Morning Tab": fixed template, filled from the build's edition.json.
const EDITION = ${data};

const CSS = \`
.mt { min-height: 100vh; background: #f3efe4; color: #1d1b17; font-family: "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif; padding: 28px clamp(16px, 4vw, 56px) 56px; box-sizing: border-box; }
.mt *, .mt *::before, .mt *::after { box-sizing: border-box; }
.mt a { color: inherit; text-decoration: none; }
.mt a:hover { text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 3px; }
.mt-wrap { max-width: 1240px; margin: 0 auto; }
.mt-small { font: 600 11px/1.4 ui-sans-serif, -apple-system, "Helvetica Neue", Arial, sans-serif; letter-spacing: .14em; text-transform: uppercase; color: #5b554a; }
.mt-top { display: flex; justify-content: space-between; gap: 16px; padding: 0 0 10px; margin-right: 210px; border-bottom: 1px solid #cfc7b5; }
@media (max-width: 980px) { .mt-top { margin-right: 0; padding-top: 44px; } }
.mt-mast { text-align: center; font-family: "Didot", "Bodoni 72", "Times New Roman", Georgia, serif; font-weight: 700; font-size: clamp(52px, 9vw, 116px); line-height: .95; letter-spacing: -.02em; margin: 22px 0 6px; }
.mt-tag { text-align: center; font-style: italic; color: #4a453c; margin: 0 0 14px; }
.mt-date { display: flex; justify-content: space-between; gap: 16px; padding: 7px 0; border-top: 3px double #1d1b17; border-bottom: 2px solid #1d1b17; font-variant: small-caps; letter-spacing: .04em; font-size: 15px; }
.mt-grid { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(0, 1fr) minmax(220px, .72fr); gap: 0 32px; margin-top: 24px; }
.mt-col + .mt-col { border-left: 1px solid #cfc7b5; padding-left: 32px; }
.mt-kicker { font: 700 11px/1.3 ui-sans-serif, -apple-system, "Helvetica Neue", Arial, sans-serif; letter-spacing: .14em; text-transform: uppercase; color: #a3341f; margin-bottom: 8px; }
.mt-lead h1 { font-size: clamp(32px, 3.6vw, 50px); line-height: 1.04; margin: 0 0 16px; letter-spacing: -.01em; }
.mt-lead p { font-size: 18px; line-height: 1.6; margin: 0 0 12px; }
.mt-lead p::first-letter { float: left; font-size: 64px; line-height: .8; padding: 6px 8px 0 0; font-weight: 700; }
.mt-story { padding-bottom: 16px; margin-bottom: 16px; border-bottom: 1px solid #cfc7b5; }
.mt-story:last-child { border-bottom: 0; }
.mt-story h2 { font-size: 24px; line-height: 1.15; margin: 0 0 8px; }
.mt-story p { font-size: 15.5px; line-height: 1.55; margin: 0 0 8px; color: #2e2b25; }
.mt-box { border: 1px solid #1d1b17; background: #ebe5d6; padding: 14px 16px; margin-bottom: 20px; }
.mt-box h3 { margin: 0 0 10px; padding-bottom: 8px; border-bottom: 1px solid #1d1b17; }
.mt-row { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0; border-bottom: 1px dotted #b3a991; font-size: 14.5px; }
.mt-row:last-child { border-bottom: 0; }
.mt-row span:first-child { flex: 1 0 45%; }
.mt-row span:last-child { min-width: 0; text-align: right; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; color: #4a453c; }
.mt-section { margin-top: 30px; padding-top: 10px; border-top: 2px solid #1d1b17; }
.mt-more { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 0 32px; margin-top: 14px; }
.mt-briefs { columns: 3 260px; column-gap: 32px; column-rule: 1px solid #cfc7b5; margin-top: 14px; }
.mt-brief { break-inside: avoid; padding: 8px 0; border-bottom: 1px solid #ddd5c3; font-size: 16px; line-height: 1.35; }
.mt-foot { margin-top: 36px; padding-top: 10px; border-top: 1px solid #cfc7b5; text-align: center; }
@media (max-width: 980px) { .mt-grid { grid-template-columns: 1fr 1fr; } .mt-side { grid-column: 1 / -1; border-left: 0 !important; padding-left: 0 !important; display: grid; grid-template-columns: 1fr 1fr; gap: 0 24px; } }
@media (max-width: 640px) { .mt-grid, .mt-side { grid-template-columns: 1fr; } .mt-col + .mt-col { border-left: 0; padding-left: 0; } .mt-top, .mt-date { flex-direction: column; align-items: center; gap: 4px; } }
\`;

function Title({ item, as: Tag }) {
  const body = item.url ? <a href={item.url}>{item.title}</a> : item.title;
  return <Tag>{body}</Tag>;
}

function Byline({ item }) {
  const parts = [item.source && 'Via ' + item.source, item.meta].filter(Boolean);
  return parts.length ? <div className="mt-small">{parts.join(' · ')}</div> : null;
}

function Story({ item }) {
  return (
    <article className="mt-story">
      {item.kicker ? <div className="mt-kicker">{item.kicker}</div> : null}
      <Title item={item} as="h2" />
      {item.summary ? <p>{item.summary}</p> : null}
      <Byline item={item} />
    </article>
  );
}

export default function PersonalizedHomepage() {
  const e = EDITION;
  const f = e.facts;
  const column = e.stories.slice(0, 4);
  const more = e.stories.slice(4);
  const almanac = [...e.almanac, ...f.almanac];
  return (
    <div className="mt">
      <style>{CSS}</style>
      <div className="mt-wrap">
        <header>
          <div className="mt-top mt-small">
            <span>{f.issue}</span>
            <span>Your corner of the internet</span>
            <span>Price: one open tab</span>
          </div>
          <h1 className="mt-mast">The Morning Tab</h1>
          <p className="mt-tag">&ldquo;{e.tagline || 'All the news that fits your history.'}&rdquo;</p>
          <div className="mt-date">
            <span>{f.date}</span>
            <span>{f.edition}</span>
            <span>{f.tally}</span>
          </div>
        </header>

        <main className="mt-grid">
          <section className="mt-col mt-lead">
            {e.lead.kicker ? <div className="mt-kicker">{e.lead.kicker}</div> : null}
            <Title item={e.lead} as="h1" />
            {e.lead.summary ? <p>{e.lead.summary}</p> : null}
            <Byline item={e.lead} />
          </section>

          <section className="mt-col">
            {column.map((item, i) => <Story key={i} item={item} />)}
          </section>

          <aside className="mt-col mt-side">
            {e.yourDay.length ? (
              <div className="mt-box">
                <h3 className="mt-small">Your day</h3>
                {e.yourDay.map((d, i) => (
                  <div className="mt-row" key={i}>
                    <span>{d.url ? <a href={d.url}>{d.what}</a> : d.what}</span>
                    <span>{d.when}</span>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="mt-box">
              <h3 className="mt-small">The Almanac</h3>
              {almanac.map((n, i) => (
                <div className="mt-row" key={i}>
                  <span>{n.label}</span>
                  <span>{n.value}</span>
                </div>
              ))}
            </div>
          </aside>
        </main>

        {more.length ? (
          <section className="mt-section">
            <div className="mt-small">More from your feeds</div>
            <div className="mt-more">{more.map((item, i) => <Story key={i} item={item} />)}</div>
          </section>
        ) : null}

        {e.briefs.length ? (
          <section className="mt-section">
            <div className="mt-small">In brief</div>
            <div className="mt-briefs">
              {e.briefs.map((b, i) => (
                <div className="mt-brief" key={i}>
                  {b.url ? <a href={b.url}>{b.title}</a> : b.title}
                  {b.source ? <span className="mt-small"> · {b.source}</span> : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <footer className="mt-foot mt-small">Printed at {f.printed} from your own browsing</footer>
      </div>
    </div>
  );
}
`;
}
