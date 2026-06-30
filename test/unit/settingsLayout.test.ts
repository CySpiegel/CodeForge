import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Contract test for the settings modal layout. The settings surface is a CSS grid whose
// grid-template-rows must declare exactly one track per direct child, with the single flexible
// (scrolling) track mapped to the content pane. A mismatch (more children than tracks) silently
// pushes the flexible `1fr` onto the wrong row: that row then collapses to 0 in a short/narrow
// webview (the default VS Code sidebar), so its buttons overlap the opaque content pane and become
// unclickable while still visible. That exact off-by-one shipped once and made the settings tabs
// unclickable, so this test pins the invariant. No browser/layout engine is needed — it is a pure
// structural check on the source markup and stylesheet.

const ROOT = path.resolve(__dirname, "../../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

// Split a grid-template-rows value into tracks, keeping function calls like `minmax(0, 1fr)` whole.
function splitTracks(value: string): string[] {
  const tracks: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value.trim()) {
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
    }
    if (/\s/.test(char) && depth === 0) {
      if (current) {
        tracks.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) {
    tracks.push(current);
  }
  return tracks;
}

function gridTemplateRows(css: string, selector: string): string[] {
  const ruleStart = css.indexOf(`${selector} {`);
  assert.notEqual(ruleStart, -1, `expected a "${selector}" rule in styles.css`);
  const ruleEnd = css.indexOf("}", ruleStart);
  const rule = css.slice(ruleStart, ruleEnd);
  const match = /grid-template-rows:\s*([^;]+);/.exec(rule);
  assert.ok(match, `expected grid-template-rows on "${selector}"`);
  return splitTracks(match[1]);
}

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"
]);

// Return the class attribute of each *direct* child element of the first element matching `openTag`.
// A tiny void-aware tag walker — robust to reformatting/indentation, unlike a regex over whole lines.
function directChildClasses(html: string, openTag: string): string[] {
  const start = html.indexOf(openTag);
  assert.notEqual(start, -1, `expected "${openTag}" in the markup`);
  const scanFrom = html.indexOf(">", start) + 1;
  const tagPattern = /<(\/?)([a-zA-Z][\w-]*)\b([^>]*?)(\/?)>/g;
  tagPattern.lastIndex = scanFrom;
  const classes: string[] = [];
  let level = 0;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(html))) {
    const [, closing, name, attributes, selfClosing] = match;
    if (closing) {
      if (level === 0) {
        break; // the closing tag of the container itself
      }
      level -= 1;
      continue;
    }
    if (VOID_ELEMENTS.has(name.toLowerCase()) || selfClosing === "/") {
      continue; // void/self-closing elements do not open a new nesting level
    }
    if (level === 0) {
      classes.push(/class="([^"]*)"/.exec(attributes)?.[1] ?? "");
    }
    level += 1;
  }
  return classes;
}

test("settings surface declares one grid row per child with the flexible track on the content pane", () => {
  const css = read("media/styles.css");
  const markup = read("src/ui/codeForgeViewProvider.ts");

  const tracks = gridTemplateRows(css, ".settings-surface");
  const children = directChildClasses(markup, '<div class="settings-surface">');

  assert.equal(
    tracks.length,
    children.length,
    `grid-template-rows has ${tracks.length} tracks but .settings-surface has ${children.length} children ` +
      `(${children.join(", ")}); they must match or the flexible track lands on the wrong row and collapses.`
  );

  const flexIndexes = tracks
    .map((track, index) => (/\bfr\b|fr\)/.test(track) ? index : -1))
    .filter((index) => index !== -1);
  assert.equal(flexIndexes.length, 1, "exactly one settings-surface row should be flexible (the scrolling content pane)");

  const flexChild = children[flexIndexes[0]] ?? "";
  assert.ok(
    flexChild.split(/\s+/).includes("settings-content"),
    `the flexible row must be the content pane, but it maps to "${flexChild}" — the tabs row must never be flexible/collapsible.`
  );

  const tabsIndex = children.findIndex((cls) => cls.split(/\s+/).includes("settings-tabs"));
  assert.ok(tabsIndex !== -1, "expected a .settings-tabs child");
  assert.ok(
    !/\bfr\b|fr\)/.test(tracks[tabsIndex] ?? ""),
    "the .settings-tabs row must be sized to content (auto), never flexible."
  );
});
