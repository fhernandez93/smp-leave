/**
 * Post-build: turn Vite's single-file dist/index.html into the page body the
 * Artifact publish expects (the platform wraps it in its own doctype/head/body
 * skeleton), and write the capabilities declaration next to it.
 *
 *   dist/artifact.html      → publish this file
 *   dist/capabilities.json  → pass as `capabilities` on publish
 *
 * Run with: node scripts/artifact.ts   (Node ≥ 23 strips the types natively)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { CAPABILITIES } from "../src/platform/capabilities.ts";

const html = readFileSync("dist/index.html", "utf8");

const pick = (re: RegExp, what: string): string[] => {
  const m = [...html.matchAll(re)].map((x) => x[0]);
  if (!m.length) throw new Error(`post-build: no ${what} found in dist/index.html`);
  return m;
};

const title = pick(/<title>[\s\S]*?<\/title>/g, "title")[0]!;
const links = pick(/<link\b[^>]*>/g, "font links");
const styles = pick(/<style\b[^>]*>[\s\S]*?<\/style>/g, "style");
const scripts = pick(/<script\b[^>]*>[\s\S]*?<\/script>/g, "script");
const body = /<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? "";
const bodyMarkup = body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "").trim();

for (const l of links) {
  if (!/fonts\.(googleapis|gstatic)\.com/.test(l)) throw new Error(`post-build: unexpected external link ${l}`);
}
if (/<script\b[^>]*\bsrc=/.test(scripts.join(""))) throw new Error("post-build: external script left in the bundle");

const out = [title, ...links, ...styles, bodyMarkup, ...scripts].join("\n") + "\n";
writeFileSync("dist/artifact.html", out);
writeFileSync("dist/capabilities.json", JSON.stringify(CAPABILITIES, null, 2) + "\n");
console.log(`dist/artifact.html ${(out.length / 1024).toFixed(1)} kB, dist/capabilities.json written`);
