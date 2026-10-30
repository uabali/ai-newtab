import { describe, expect, test } from "bun:test";
import { SeenUrls, extractPageLinks, linkKey, literalLinks, validateHomepageLinks } from "@homepage/agent-core";

describe("linkKey", () => {
  test("accepts only absolute http(s) URLs", () => {
    expect(linkKey("https://example.com/a")).toBe("https://example.com/a");
    expect(linkKey("http://example.com")).toBe("http://example.com/");
    for (const bad of ["/item?id=2", "item?id=2", "example.com/a", "//example.com/a", "javascript:alert(1)", "data:text/html,x", "mailto:a@b.c", "#top", "", "https://", 42, null]) {
      expect(linkKey(bad)).toBeNull();
    }
  });

  test("ignores fragments and trailing slashes, refuses credentials", () => {
    expect(linkKey("https://example.com/a/#comments")).toBe("https://example.com/a");
    expect(linkKey("https://user:pw@example.com/")).toBeNull();
  });

  test("resolves relative links only against a base", () => {
    expect(linkKey("/item?id=2", "https://news.ycombinator.com/")).toBe("https://news.ycombinator.com/item?id=2");
    expect(linkKey("javascript:void 0", "https://news.ycombinator.com/")).toBeNull();
  });
});

test("extractPageLinks resolves a page's anchors and drops non-http ones", () => {
  const html = `<a href="https://a.com/x">x</a><a href='/y?a=1&amp;b=2'>y</a><a href="mailto:z@z.z">z</a><a href="javascript:void 0">j</a><a href="#top">t</a>`;
  // "#top" is the page itself.
  expect(extractPageLinks(html, "https://site.org/news/")).toEqual(["https://a.com/x", "https://site.org/y?a=1&b=2", "https://site.org/news"]);
});

test("SeenUrls holds scraped pages, their links and history domains", () => {
  const seen = new SeenUrls();
  seen.addPage(`<a href="item?id=7">s</a>`, "https://news.ycombinator.com/");
  seen.addDomain("github.com");
  expect(seen.has("https://news.ycombinator.com/")).toBe(true);
  expect(seen.has("https://news.ycombinator.com/item?id=7")).toBe(true);
  expect(seen.has("https://github.com/")).toBe(true);
  expect(seen.has("https://github.com/made/up")).toBe(false);
  expect(new SeenUrls(seen.toJSON()).has("https://news.ycombinator.com/item?id=7")).toBe(true);
});

describe("validateHomepageLinks", () => {
  const seen = new SeenUrls(["https://news.ycombinator.com/item?id=1", "https://github.com/"]);

  test("keeps seen links and unlinks invented, relative and non-http ones", () => {
    const code = `export default function P() {
  return <div>
    <a href="https://news.ycombinator.com/item?id=1#c">ok</a>
    <a className="x" href="https://news.ycombinator.com/item?id=999">invented</a>
    <a href='/relative'>relative</a>
    <a href={"javascript:alert(1)"}>js</a>
  </div>;
}`;
    const out = validateHomepageLinks(code, seen);
    expect(out.links).toEqual(["https://news.ycombinator.com/item?id=1"]);
    expect(out.removed).toEqual([
      { url: "https://news.ycombinator.com/item?id=999", reason: "not-seen" },
      { url: "/relative", reason: "not-http" },
      { url: "javascript:alert(1)", reason: "not-http" },
    ]);
    expect(out.code).toContain(`<a href="https://news.ycombinator.com/item?id=1#c">ok</a>`);
    expect(out.code).toContain(`<a className="x">invented</a>`);
    expect(out.code).toContain(`<a>relative</a>`);
    expect(out.code).toContain(`<a>js</a>`);
  });

  test("nulls invalid URLs in data objects but leaves images alone", () => {
    const code = `const ITEMS = [
  { title: "a", url: "https://github.com/" },
  { title: "b", url: "https://github.com/invented/repo", image: "https://img.example/x.png" },
  { title: "c", link: "news/item" },
];`;
    const out = validateHomepageLinks(code, seen);
    expect(out.code).toContain(`url: "https://github.com/"`);
    expect(out.code).toContain(`url: null, image: "https://img.example/x.png"`);
    expect(out.code).toContain(`link: null`);
    expect(out.links).toEqual(["https://github.com/"]);
    expect(out.removed.map((r) => r.reason)).toEqual(["not-seen", "not-http"]);
  });

  test("literalLinks lists the absolute links a component uses", () => {
    expect(literalLinks(`<a href="https://a.com/x">x</a> {url: "https://b.com/"} <a href="/rel">r</a>`)).toEqual([
      "https://a.com/x",
      "https://b.com/",
    ]);
  });
});
