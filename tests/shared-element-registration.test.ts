import { describe, it, expect, vi } from "vitest";

/**
 * Regression test for the "blank span-panel view" bug.
 *
 * The card and panel are built as two separate bundles; each one carries its
 * own copy of every shared module (side-panel, error-banner, span-icon, etc.).
 * When both bundles load into the same page — the user was on a Lovelace
 * dashboard first (loads card bundle via its resource registration), then
 * switched to the Span Panel sidebar item (loads panel bundle) — the
 * second bundle's top-level ``customElements.define`` fires against tags
 * the first bundle already registered.
 *
 * If that define is unguarded, the browser throws ``DOMException: Failed to
 * execute 'define' on 'CustomElementRegistry': the name "span-error-banner"
 * has already been used``. That throw aborts the panel bundle's module
 * execution *before* ``@customElement("span-panel")`` runs, so the
 * ``<span-panel>`` tag in the sidebar stays an un-upgraded ``HTMLElement``
 * with no shadow root and no Lit state — a permanent blank view until a
 * hard refresh loads the panel bundle first.
 *
 * The fix: every shared module must use the guarded bottom-of-file pattern
 * (``if (!customElements.get(tag)) customElements.define(tag, Class);``
 * wrapped in ``try/catch``) instead of the ``@customElement`` decorator,
 * which calls ``define`` unconditionally.
 *
 * This test simulates the two-bundle scenario by importing each shared
 * module twice (with the module cache cleared between imports). The second
 * import re-runs the module's top-level code, which must not throw even
 * though the tag is already registered from the first import.
 */

const SHARED_MODULES = [
  { path: "../src/core/error-banner.js", tag: "span-error-banner" },
  { path: "../src/core/side-panel.js", tag: "span-side-panel" },
  { path: "../src/core/span-icon.js", tag: "span-icon" },
  { path: "../src/core/span-switch.js", tag: "span-switch" },
  { path: "../src/chart/span-chart.js", tag: "span-chart" },
] as const;

describe("shared custom element registration across bundles", () => {
  SHARED_MODULES.forEach(({ path, tag }) => {
    it(`${tag} module is safe to execute twice (card + panel bundles share it)`, async () => {
      await import(path);
      expect(customElements.get(tag)).toBeDefined();

      vi.resetModules();
      await expect(import(path)).resolves.toBeDefined();
    });
  });
});
