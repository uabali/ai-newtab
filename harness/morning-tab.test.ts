import { expect, test } from "bun:test";
import {
  EDITION_PATH,
  HOMEPAGE_SYSTEM_PROMPT,
  buildKickoffMessage,
  checkComponent,
  editionFacts,
  parseEdition,
  renderMorningTab,
  sanitizeEdition,
} from "@homepage/agent-core";

const NOW = new Date(2026, 9, 30, 7, 15);

const RAW = {
  tagline: "MOCK: all the news that fits your history",
  lead: { kicker: "Technology", title: "Rust 2.0 released", url: "https://news.ycombinator.com/item?id=1", summary: "Big news.", source: "Hacker News", meta: "512 points" },
  stories: [
    { kicker: "Open source", title: "A story", url: "https://github.com/", summary: "Something.", source: "GitHub" },
    { headline: "Uses aliases", link: "https://news.ycombinator.com/item?id=2", source: "Hacker News" },
    { title: "" },
    "not an object",
  ],
  briefs: [{ title: "Brief", url: "https://lobste.rs/", source: "Lobsters" }],
  yourDay: [{ when: "Today", what: "Release due", url: null }],
  almanac: [{ label: "Most-read site", value: 42 }],
};

test("sanitizeEdition keeps well-formed items and coerces the rest", () => {
  const e = sanitizeEdition(RAW);
  expect(e.lead.title).toBe("Rust 2.0 released");
  expect(e.stories.map((s) => s.title)).toEqual(["A story", "Uses aliases"]);
  expect(e.stories[1]!.url).toBe("https://news.ycombinator.com/item?id=2");
  expect(e.almanac[0]!.value).toBe("42");
  expect(() => sanitizeEdition({ stories: [] })).toThrow();
});

test("a missing lead falls back to the first story", () => {
  const e = sanitizeEdition({ stories: [{ title: "Only one" }, { title: "Two" }] });
  expect(e.lead.title).toBe("Only one");
  expect(e.stories.map((s) => s.title)).toEqual(["Two"]);
});

test("parseEdition tolerates a ```json fence and explains bad JSON", () => {
  expect(parseEdition("```json\n" + JSON.stringify(RAW) + "\n```").lead.title).toBe("Rust 2.0 released");
  expect(() => parseEdition("{ nope")).toThrow(/not valid JSON/);
});

test("the template prints computed facts the model can't get wrong", () => {
  const f = editionFacts(sanitizeEdition(RAW), NOW);
  expect(f.issue).toBe("Vol. I · No. 303");
  expect(f.date).toBe("Friday, October 30, 2026");
  expect(f.edition).toBe("Morning Edition");
  expect(f.tally).toBe("4 stories from 3 sources");
  expect(f.almanac).toEqual([
    { label: "Day of the year", value: "303 of 365" },
    { label: "Days left", value: "62" },
  ]);
});

test("renderMorningTab produces a valid, React-only component with the newspaper layout", () => {
  const code = renderMorningTab(sanitizeEdition(RAW), NOW);
  expect(checkComponent(code)).toBeNull();
  for (const s of ["The Morning Tab", "#f3efe4", "Your day", "The Almanac", "In brief", "serif", "export default function PersonalizedHomepage"]) {
    expect(code).toContain(s);
  }
  expect(code).toContain("MOCK: all the news that fits your history");
});

test("checkComponent catches what would break the preview", () => {
  expect(checkComponent("")).not.toBeNull();
  expect(checkComponent("export default function P() { return <div>; }")).toMatch(/.+/);
  expect(checkComponent("function P() { return <div/>; }")).toMatch(/export default/);
  expect(checkComponent("import x from 'lodash';\nexport default function P() { return <div/>; }")).toMatch(/lodash/);
  expect(checkComponent("import React, { useState } from 'react';\nexport default function P() { return <div/>; }")).toBeNull();
});

test("the prompt makes The Morning Tab the default, and the user's instructions win", () => {
  expect(HOMEPAGE_SYSTEM_PROMPT).toContain(EDITION_PATH);
  expect(HOMEPAGE_SYSTEM_PROMPT).toContain("The Morning Tab");
  expect(HOMEPAGE_SYSTEM_PROMPT).toMatch(/only URLs|Only use URLs|only use URLs/i);
  expect(buildKickoffMessage({ now: NOW, userSystemPrompt: "" })).toContain("The Morning Tab");
  const custom = buildKickoffMessage({ now: NOW, userSystemPrompt: "Dark mode, one column." });
  expect(custom).toContain("Dark mode, one column.");
});
