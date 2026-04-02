#!/usr/bin/env node
/* eslint-disable no-console, no-redeclare */
/**
 * Validate that every t() key used in source files exists in all translation
 * languages defined in src/i18n.js, and that English has no orphaned keys.
 *
 * Exit 0 on success, 1 on validation failure.
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const I18N_PATH = join(ROOT, "src", "i18n.ts");

// ── Extract translation keys from i18n.js ──────────────────────────────────

function extractTranslationKeys(source) {
  // Match the top-level `const translations = { ... };` object.
  // We parse it by importing as a module would be cleaner, but the file
  // uses runtime imports (t depends on module state) so we regex-extract
  // the key sets per language instead.

  const langBlocks = {};
  // Find each language block: `  en: {` ... `  },`
  const langRe = /^\s{2}(\w+):\s*\{/gm;
  let match;
  while ((match = langRe.exec(source)) !== null) {
    const lang = match[1];
    const startIdx = match.index + match[0].length;
    // Walk forward counting braces to find the closing `}`
    let depth = 1;
    let i = startIdx;
    while (i < source.length && depth > 0) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
      i++;
    }
    const block = source.slice(startIdx, i - 1);
    // Extract all quoted keys: `"some.key":`
    const keys = new Set();
    const keyRe = /"([^"]+)":/g;
    let km;
    while ((km = keyRe.exec(block)) !== null) {
      keys.add(km[1]);
    }
    langBlocks[lang] = keys;
  }
  return langBlocks;
}

// ── Scan source files for t() calls ────────────────────────────────────────

function collectSourceKeys(dir, results = new Map()) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      collectSourceKeys(full, results);
    } else if ((entry.endsWith(".ts") || entry.endsWith(".js")) && full !== I18N_PATH) {
      const content = readFileSync(full, "utf8");
      // Match t("key") and t('key') — both template and regular strings
      const re = /\bt\(\s*["']([^"']+)["']\s*\)/g;
      let m;
      while ((m = re.exec(content)) !== null) {
        const key = m[1];
        if (!results.has(key)) results.set(key, []);
        results.get(key).push(relative(ROOT, full));
      }
      // Match t(`...`) with template literals containing i18n keys
      const tmplRe = /\bt\(\s*`([^`]+)`\s*\)/g;
      while ((m = tmplRe.exec(content)) !== null) {
        // Template literals with ${} are dynamic — skip validation
        if (!m[1].includes("${")) {
          const key = m[1];
          if (!results.has(key)) results.set(key, []);
          results.get(key).push(relative(ROOT, full));
        }
      }
    }
  }
  return results;
}

// ── Main ───────────────────────────────────────────────────────────────────

const i18nSource = readFileSync(I18N_PATH, "utf8");
const langKeys = extractTranslationKeys(i18nSource);
const languages = Object.keys(langKeys);
const enKeys = langKeys.en;

if (!enKeys || enKeys.size === 0) {
  console.error("ERROR: No English translation keys found in src/i18n.ts");
  process.exit(1);
}

const srcDir = join(ROOT, "src");
const usedKeys = collectSourceKeys(srcDir);
const errors = [];

// 1. Every t() key must exist in English
for (const [key, files] of usedKeys) {
  if (!enKeys.has(key)) {
    errors.push(`  Missing in en: "${key}" (used in ${files[0]})`);
  }
}

// 2. Every English key must exist in all other languages
for (const lang of languages) {
  if (lang === "en") continue;
  const langSet = langKeys[lang];
  const missing = [];
  for (const key of enKeys) {
    if (!langSet.has(key)) {
      missing.push(key);
    }
  }
  if (missing.length > 0) {
    errors.push(`  ${lang}: ${missing.length} missing key(s) from en:`);
    for (const key of missing) {
      errors.push(`  - ${key}`);
    }
  }
}

// 3. No orphaned keys in non-English languages
for (const lang of languages) {
  if (lang === "en") continue;
  const langSet = langKeys[lang];
  const orphaned = [];
  for (const key of langSet) {
    if (!enKeys.has(key)) {
      orphaned.push(key);
    }
  }
  if (orphaned.length > 0) {
    errors.push(`  ${lang}: ${orphaned.length} orphaned key(s) not in en:`);
    for (const key of orphaned) {
      errors.push(`  - ${key}`);
    }
  }
}

// 4. Warn about unused English keys (not an error, but informational)
const unusedKeys = [];
for (const key of enKeys) {
  if (!usedKeys.has(key)) {
    unusedKeys.push(key);
  }
}

if (errors.length > 0) {
  console.error("i18n validation failed:");
  for (const e of errors) console.error(e);
  process.exit(1);
}

if (unusedKeys.length > 0) {
  console.warn(`i18n: ${unusedKeys.length} unused key(s) in en (not an error):`);
  for (const key of unusedKeys) console.warn(`  - ${key}`);
}

console.log("i18n validation OK");
