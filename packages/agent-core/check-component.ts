import { transform } from "sucrase";

/**
 * Cheap pre-flight for a generated component, run before it is saved: does it
 * compile, does it export a default, does it import only React? Runtime errors
 * are caught later, in the page that renders it.
 *
 * Returns a message for the model, or null when the component looks renderable.
 */
export function checkComponent(code: string): string | null {
  if (!code.trim()) return "The file is empty.";
  try {
    transform(code, { transforms: ["typescript", "imports", "jsx"], filePath: "homepage.tsx" });
  } catch (err) {
    return `Syntax error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 600);
  }
  if (!/\bexport\s+default\b/.test(code)) return "The component has no `export default`.";
  const imports = [...code.matchAll(/(?:^|\n)\s*import\s+(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["']/g)].map((m) => m[1]!);
  const extra = [...new Set(imports.filter((spec) => spec !== "react"))];
  if (extra.length) return `Only 'react' may be imported; remove: ${extra.join(", ")}.`;
  return null;
}
