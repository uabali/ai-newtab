/**
 * Input schemas (JSON Schema) for every tool the model can call. The caps live
 * in the schema, not just the handler, so the model can see the ceiling it is
 * working against.
 */

/** A JSON Schema object, as sent in an OpenAI-compatible `tools[].function.parameters`. */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  [k: string]: unknown;
}

export const GET_HISTORY_SCHEMA: ToolInputSchema = {
  type: "object",
  properties: {
    daysToAnalyze: {
      type: "integer",
      minimum: 1,
      maximum: 90,
      description: "How many days of history to analyze. Default 14.",
    },
    maxResults: {
      type: "integer",
      minimum: 1,
      maximum: 50,
      description: "Top N domains by relevance score. Default 30.",
    },
  },
  required: [],
};

export const GET_PAGE_HTML_SCHEMA: ToolInputSchema = {
  type: "object",
  properties: {
    urls: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: { type: "string" },
      description:
        "URLs to load in real browser tabs. Authenticated, JS-rendered pages work — " +
        "this is the user's own logged-in browser, not a fetch from a datacenter.",
    },
    loadDelayMs: {
      type: "integer",
      minimum: 0,
      maximum: 30000,
      description: "Extra wait after load, for lazy-rendered content. Default 8000.",
    },
  },
  required: ["urls"],
};

export const READ_SCHEMA: ToolInputSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "A path returned by getPageHtml or glob, e.g. /pages/example_com_0.html." },
    offset: { type: "integer", minimum: 1, description: "First line to return (1-based). Default 1." },
    limit: { type: "integer", minimum: 1, maximum: 400, description: "How many lines to return. Default 150." },
  },
  required: ["path"],
};

export const GREP_SCHEMA: ToolInputSchema = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "JavaScript regular expression (falls back to a literal match if invalid)." },
    path: { type: "string", description: "A file, a directory, or a glob like /pages/*.html. Default: every file." },
    ignoreCase: { type: "boolean", description: "Case-insensitive. Default true." },
    maxResults: { type: "integer", minimum: 1, maximum: 200, description: "Cap on matching lines. Default 50." },
  },
  required: ["pattern"],
};

export const GLOB_SCHEMA: ToolInputSchema = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "Glob such as /pages/*.html or **/*.tsx. Default: every file." },
  },
  required: [],
};

export const WRITE_SCHEMA: ToolInputSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "/outputs/edition.json for the default Morning Tab look, or /outputs/homepage.tsx for a custom component.",
    },
    content: { type: "string", description: "The file contents: raw JSON or raw TSX, no markdown fence." },
    append: {
      type: "boolean",
      description: "Append to the file instead of replacing it. Lets you write a long component in several calls.",
    },
  },
  required: ["path", "content"],
};

export const DEFAULTS = {
  daysToAnalyze: 14,
  maxResults: 30,
  loadDelayMs: 8000,
  /** Cap on titles carried per domain in the digest. */
  sampleTitles: 5,
} as const;
