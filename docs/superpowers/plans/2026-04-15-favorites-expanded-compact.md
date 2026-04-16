# Favorites list view — compact expanded row — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In By-Activity and By-Area list views, expanding a row should reveal only the chart; the two unique controls (gear and ON/OFF toggle) move onto the
always-visible list row.

**Architecture:** A new `buildExpandedChartHTML` renderer replaces the duplicative `buildExpandedCircuitHTML`. The list row gains a gear button and a tappable
ON/OFF badge. A small shared `getCircuitStateClasses` helper keeps state-visualization classes consistent between the grid and the new chart-only expanded slot.

**Tech Stack:** TypeScript, Lit (lightly used here — this card uses manual innerHTML), Vitest, Rollup, CSS-in-JS via tagged template literals.

**Spec:** `docs/superpowers/specs/2026-04-15-favorites-expanded-compact-design.md`

---

## File map

**Create:**

- `src/core/circuit-state.ts` — shared `getCircuitStateClasses` helper.
- `tests/circuit-state.test.ts` — unit tests for the helper.

**Modify:**

- `src/core/grid-renderer.ts` — adopt `getCircuitStateClasses`.
- `src/core/list-renderer.ts` — add `buildExpandedChartHTML`, update `buildListRowHTML`, delete `buildExpandedCircuitHTML`.
- `src/core/list-view-controller.ts` — swap renderer calls, widen toggle selector, extend `updateCollapsedRows`.
- `src/core/dashboard-controller.ts` — widen `onToggleClick` pill selector to include `list-status-toggle`.
- `src/card/card-styles.ts` — add gear/badge/chart-only rules.

**Test:**

- `tests/circuit-state.test.ts` (new, above).
- `tests/list-renderer.test.ts` (new — covers both renderers' new output shape).

**Sync (post-build):**

- `../../../HA/span/custom_components/span_panel/frontend/dist/` — via `scripts/build-frontend.sh` in the HA integration, or the `sync-frontend` skill.

---

## Task 1: Add shared `getCircuitStateClasses` helper

Extracts the `circuit-off` / `circuit-producer` / `circuit-alert` / `circuit-custom-monitoring` class logic that `renderCircuitSlot` computes inline today. Grid
and list will both call this so they stay in sync.

**Files:**

- Create: `src/core/circuit-state.ts`
- Create: `tests/circuit-state.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/circuit-state.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { getCircuitStateClasses } from "../src/core/circuit-state.js";
import type { Circuit, MonitoringPointInfo } from "../src/types.js";

const baseCircuit: Circuit = { name: "Test" };

describe("getCircuitStateClasses", () => {
  it("returns empty string when circuit is on, not producer, no monitoring info", () => {
    expect(getCircuitStateClasses(baseCircuit, null, true, false)).toBe("");
  });

  it("adds circuit-off when isOn is false", () => {
    expect(getCircuitStateClasses(baseCircuit, null, false, false)).toBe("circuit-off");
  });

  it("adds circuit-producer when isProducer is true", () => {
    expect(getCircuitStateClasses(baseCircuit, null, true, true)).toBe("circuit-producer");
  });

  it("adds both when off and producer", () => {
    const result = getCircuitStateClasses(baseCircuit, null, false, true);
    expect(result).toContain("circuit-off");
    expect(result).toContain("circuit-producer");
  });

  it("adds circuit-alert when monitoringInfo indicates alert", () => {
    const info: MonitoringPointInfo = { utilization_pct: 95, over_threshold_since: "2024-01-01T00:00:00Z" };
    const result = getCircuitStateClasses(baseCircuit, info, true, false);
    expect(result).toContain("circuit-alert");
  });

  it("adds circuit-custom-monitoring when continuous_threshold_pct is set", () => {
    const info: MonitoringPointInfo = { continuous_threshold_pct: 80 };
    const result = getCircuitStateClasses(baseCircuit, info, true, false);
    expect(result).toContain("circuit-custom-monitoring");
  });

  it("handles all classes together", () => {
    const info: MonitoringPointInfo = {
      utilization_pct: 99,
      over_threshold_since: "2024-01-01T00:00:00Z",
      continuous_threshold_pct: 80,
    };
    const result = getCircuitStateClasses(baseCircuit, info, false, true);
    expect(result).toContain("circuit-off");
    expect(result).toContain("circuit-producer");
    expect(result).toContain("circuit-alert");
    expect(result).toContain("circuit-custom-monitoring");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/bflood/projects/HA/cards/span-card && npx vitest run tests/circuit-state.test.ts`

Expected: FAIL with "Cannot find module '../src/core/circuit-state.js'".

- [ ] **Step 3: Implement the helper**

Create `src/core/circuit-state.ts`:

```ts
import { hasCustomOverrides, isAlertActive } from "./monitoring-status.js";
import type { Circuit, MonitoringPointInfo } from "../types.js";

/**
 * Build the set of state-visualization classes that apply to a circuit's
 * rendered slot. Shared by the breaker grid and the list view's
 * chart-only expanded slot so both render the same border/background
 * signaling.
 */
export function getCircuitStateClasses(_circuit: Circuit, monitoringInfo: MonitoringPointInfo | null, isOn: boolean, isProducer: boolean): string {
  const classes: string[] = [];
  if (!isOn) classes.push("circuit-off");
  if (isProducer) classes.push("circuit-producer");
  if (isAlertActive(monitoringInfo)) classes.push("circuit-alert");
  if (hasCustomOverrides(monitoringInfo)) classes.push("circuit-custom-monitoring");
  return classes.join(" ");
}
```

Note: `_circuit` is retained in the signature so future extensions (e.g. device-type specific classes) don't require a breaking change. The underscore prefix
tells ESLint it's intentionally unused.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/bflood/projects/HA/cards/span-card && npx vitest run tests/circuit-state.test.ts`

Expected: 7 passing tests.

- [ ] **Step 5: Typecheck**

Run: `cd /Users/bflood/projects/HA/cards/span-card && npm run typecheck`

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/bflood/projects/HA/cards/span-card
git add src/core/circuit-state.ts tests/circuit-state.test.ts
git commit -m "feat(core): extract shared getCircuitStateClasses helper"
```

---

## Task 2: Adopt `getCircuitStateClasses` in `renderCircuitSlot`

Replace the inline class computation in `renderCircuitSlot` with a call to the shared helper, so the grid and list stay in lockstep.

**Files:**

- Modify: `src/core/grid-renderer.ts`

- [ ] **Step 1: Read the current state-class logic**

Open `src/core/grid-renderer.ts`. Lines 193-195 currently contain:

```ts
const alertActive = isAlertActive(monitoringInfo);
const alertClass = alertActive ? "circuit-alert" : "";
const customClass = hasOverridesFlag ? "circuit-custom-monitoring" : "";
```

And line 202 uses them:

```ts
<div class="circuit-slot ${isOn ? "" : "circuit-off"} ${isProducer ? "circuit-producer" : ""} ${layoutClass} ${alertClass} ${customClass}"
```

- [ ] **Step 2: Refactor to use the shared helper**

At the top of `grid-renderer.ts`, add the import alongside the existing monitoring-status import:

```ts
import { getCircuitStateClasses } from "./circuit-state.js";
```

Remove these lines from `renderCircuitSlot`:

```ts
const alertActive = isAlertActive(monitoringInfo);
const alertClass = alertActive ? "circuit-alert" : "";
const customClass = hasOverridesFlag ? "circuit-custom-monitoring" : "";
```

Replace the `<div class="circuit-slot ...">` line with:

```ts
const stateClasses = getCircuitStateClasses(circuit, monitoringInfo, isOn, isProducer);
```

(add this line after the existing `const customClass` removal, before the template returns). Then change the opening div of the return template from:

```ts
<div class="circuit-slot ${isOn ? "" : "circuit-off"} ${isProducer ? "circuit-producer" : ""} ${layoutClass} ${alertClass} ${customClass}"
```

to:

```ts
<div class="circuit-slot ${stateClasses} ${layoutClass}"
```

Also remove the `isAlertActive` import from `./monitoring-status.js` **only if it has no other callers in this file** (grep the file first — keep the import if
other call sites remain).

- [ ] **Step 3: Typecheck**

Run: `cd /Users/bflood/projects/HA/cards/span-card && npm run typecheck`

Expected: no TypeScript errors.

- [ ] **Step 4: Run all tests**

Run: `cd /Users/bflood/projects/HA/cards/span-card && npm test`

Expected: all existing tests still pass, including `circuit-state.test.ts`.

- [ ] **Step 5: Commit**

```bash
cd /Users/bflood/projects/HA/cards/span-card
git add src/core/grid-renderer.ts
git commit -m "refactor(grid): use shared getCircuitStateClasses"
```

---

## Task 3: Add `buildExpandedChartHTML` renderer

Replace the full-circuit-slot expanded view with a minimal chart-only variant.

**Files:**

- Modify: `src/core/list-renderer.ts`
- Create: `tests/list-renderer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/list-renderer.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildExpandedChartHTML } from "../src/core/list-renderer.js";
import type { Circuit, HomeAssistant, CardConfig } from "../src/types.js";

const mockHass = {
  states: {
    "switch.circuit_a": { state: "on", attributes: {} },
    "sensor.circuit_a_power": { state: "150", attributes: {} },
  },
} as unknown as HomeAssistant;

const mockConfig = { chart_metric: "power" } as unknown as CardConfig;

const onCircuit: Circuit = {
  name: "Kitchen",
  tabs: [1],
  relay_state: "CLOSED",
  entities: { switch: "switch.circuit_a", power: "sensor.circuit_a_power" },
};

const offCircuit: Circuit = { ...onCircuit, relay_state: "OPEN", entities: { switch: undefined, power: "sensor.circuit_a_power" } };

describe("buildExpandedChartHTML", () => {
  it("produces a list-expanded-content wrapper with the circuit uuid", () => {
    const html = buildExpandedChartHTML("uuid-123", onCircuit, mockHass, mockConfig, null);
    expect(html).toContain('class="list-expanded-content"');
    expect(html).toContain('data-expanded-uuid="uuid-123"');
  });

  it("wraps a circuit-slot that carries the chart-only marker class and data-uuid", () => {
    const html = buildExpandedChartHTML("uuid-123", onCircuit, mockHass, mockConfig, null);
    expect(html).toContain("circuit-slot");
    expect(html).toContain("circuit-chart-only");
    expect(html).toContain('data-uuid="uuid-123"');
  });

  it("contains exactly one chart-container div", () => {
    const html = buildExpandedChartHTML("uuid-123", onCircuit, mockHass, mockConfig, null);
    const matches = html.match(/class="chart-container"/g);
    expect(matches?.length).toBe(1);
  });

  it("does NOT contain circuit-header or circuit-status duplicated content", () => {
    const html = buildExpandedChartHTML("uuid-123", onCircuit, mockHass, mockConfig, null);
    expect(html).not.toContain("circuit-header");
    expect(html).not.toContain("circuit-status");
    expect(html).not.toContain("toggle-pill");
    expect(html).not.toContain("breaker-badge");
    expect(html).not.toContain("power-value");
  });

  it("applies circuit-off class when circuit is off", () => {
    const off: Circuit = { ...onCircuit, relay_state: "OPEN", entities: { switch: undefined, power: "sensor.circuit_a_power" } };
    const html = buildExpandedChartHTML("uuid-123", off, mockHass, mockConfig, null);
    expect(html).toContain("circuit-off");
  });

  it("omits circuit-off class when circuit is on", () => {
    const html = buildExpandedChartHTML("uuid-123", onCircuit, mockHass, mockConfig, null);
    expect(html).not.toContain("circuit-off");
  });

  it("escapes unsafe uuids", () => {
    const html = buildExpandedChartHTML('"><script>alert(1)</script>', onCircuit, mockHass, mockConfig, null);
    expect(html).not.toContain("<script>");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/bflood/projects/HA/cards/span-card && npx vitest run tests/list-renderer.test.ts`

Expected: FAIL with "`buildExpandedChartHTML` is not exported" or similar.

- [ ] **Step 3: Implement `buildExpandedChartHTML` and delete `buildExpandedCircuitHTML`**

In `src/core/list-renderer.ts`, add this import alongside existing ones:

```ts
import { DEVICE_TYPE_PV } from "../constants.js";
import { getCircuitStateClasses } from "./circuit-state.js";
```

Replace the existing `buildExpandedCircuitHTML` function (lines 135-145) with:

```ts
/**
 * Build the chart-only expanded content for a list row. The collapsed
 * list row already shows breaker / name / shedding / utilization / status /
 * power, so the expanded area only needs to surface the chart. State-
 * visualization classes (off, producer, alert, custom monitoring) still
 * apply to the wrapping slot so border/background signaling is preserved.
 */
export function buildExpandedChartHTML(
  uuid: string,
  circuit: Circuit,
  hass: HomeAssistant,
  config: CardConfig,
  monitoringInfo: MonitoringPointInfo | null
): string {
  void config;
  const powerEid = circuit.entities?.power;
  const powerState = powerEid ? hass.states[powerEid] : null;
  const powerW = powerState ? parseFloat(powerState.state) || 0 : 0;
  const isProducer = circuit.device_type === DEVICE_TYPE_PV || powerW < 0;

  const switchEid = circuit.entities?.switch;
  const switchState = switchEid ? hass.states[switchEid] : null;
  const isOn = switchState
    ? switchState.state === "on"
    : ((powerState?.attributes?.relay_state as string | undefined) || circuit.relay_state) === RELAY_STATE_CLOSED;

  const stateClasses = getCircuitStateClasses(circuit, monitoringInfo, isOn, isProducer);
  const safeUuid = escapeHtml(uuid);

  return `
    <div class="list-expanded-content" data-expanded-uuid="${safeUuid}">
      <div class="circuit-slot circuit-chart-only ${stateClasses}" data-uuid="${safeUuid}">
        <div class="chart-container"></div>
      </div>
    </div>
  `;
}
```

Keep the `renderCircuitSlot` import removable — verify nothing else in `list-renderer.ts` references it, and drop the import if so.

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `cd /Users/bflood/projects/HA/cards/span-card && npx vitest run tests/list-renderer.test.ts`

Expected: all 7 tests pass.

- [ ] **Step 5: Typecheck**

Run: `cd /Users/bflood/projects/HA/cards/span-card && npm run typecheck`

Expected: errors about `buildExpandedCircuitHTML` being used in `list-view-controller.ts` (we fix that in Task 5). Note the errors — they will be resolved in
Task 5. **Do not commit yet.** Continue to Step 6.

- [ ] **Step 6: Leave the commit for the combined Task 5 commit**

Do NOT commit yet. Task 5 will update `list-view-controller.ts` to import and call `buildExpandedChartHTML`, which resolves the remaining typecheck failures.
Committing now would break the build at HEAD.

---

## Task 4: Add gear and tappable badge to `buildListRowHTML`

**Files:**

- Modify: `src/core/list-renderer.ts`
- Modify: `tests/list-renderer.test.ts` (append to the file from Task 3)

- [ ] **Step 1: Write the failing tests for the new list-row structure**

Append to `tests/list-renderer.test.ts`:

```ts
import { buildListRowHTML } from "../src/core/list-renderer.js";

const controllableCircuit: Circuit = {
  name: "Kitchen",
  tabs: [1],
  relay_state: "CLOSED",
  is_user_controllable: true,
  entities: { switch: "switch.circuit_a", power: "sensor.circuit_a_power" },
};

const nonControllableCircuit: Circuit = {
  name: "Solar",
  tabs: [2],
  relay_state: "CLOSED",
  is_user_controllable: false,
  entities: { power: "sensor.circuit_b_power" },
};

describe("buildListRowHTML gear and tappable badge", () => {
  it("adds a gear button with data-uuid", () => {
    const html = buildListRowHTML("uuid-42", controllableCircuit, mockHass, mockConfig, null, "unknown", false);
    expect(html).toContain("gear-icon");
    expect(html).toContain("circuit-gear");
    expect(html).toContain('data-uuid="uuid-42"');
  });

  it("puts the gear after list-power-value and before list-expand-toggle", () => {
    const html = buildListRowHTML("uuid-42", controllableCircuit, mockHass, mockConfig, null, "unknown", false);
    const valueIdx = html.indexOf("list-power-value");
    const gearIdx = html.indexOf("gear-icon");
    const toggleIdx = html.indexOf("list-expand-toggle");
    expect(valueIdx).toBeGreaterThan(-1);
    expect(gearIdx).toBeGreaterThan(valueIdx);
    expect(toggleIdx).toBeGreaterThan(gearIdx);
  });

  it("adds list-status-toggle class when circuit is user-controllable and has a switch entity", () => {
    const html = buildListRowHTML("uuid-42", controllableCircuit, mockHass, mockConfig, null, "unknown", false);
    expect(html).toContain("list-status-toggle");
  });

  it("omits list-status-toggle for non-controllable circuits", () => {
    const html = buildListRowHTML("uuid-42", nonControllableCircuit, mockHass, mockConfig, null, "unknown", false);
    expect(html).not.toContain("list-status-toggle");
  });

  it("omits list-status-toggle when circuit has no switch entity", () => {
    const noSwitch: Circuit = { ...controllableCircuit, entities: { power: "sensor.circuit_a_power" } };
    const html = buildListRowHTML("uuid-42", noSwitch, mockHass, mockConfig, null, "unknown", false);
    expect(html).not.toContain("list-status-toggle");
  });

  it("adds data-uuid on the list-row (needed by onToggleClick ancestor lookup)", () => {
    const html = buildListRowHTML("uuid-42", controllableCircuit, mockHass, mockConfig, null, "unknown", false);
    const rowMatch = html.match(/<div class="list-row[^"]*"([^>]*)>/);
    expect(rowMatch).not.toBeNull();
    const attrs = rowMatch?.[1] ?? "";
    expect(attrs).toContain('data-uuid="uuid-42"');
    expect(attrs).toContain('data-row-uuid="uuid-42"');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/bflood/projects/HA/cards/span-card && npx vitest run tests/list-renderer.test.ts`

Expected: the 6 new tests fail; the 7 from Task 3 still pass.

- [ ] **Step 3: Import `MONITORING_COLORS` and update `buildListRowHTML`**

In `src/core/list-renderer.ts`, extend the constants import:

```ts
import { RELAY_STATE_CLOSED, SHEDDING_PRIORITIES, MONITORING_COLORS } from "../constants.js";
```

Add an import for `hasCustomOverrides`:

```ts
import { getUtilizationClass, hasCustomOverrides } from "./monitoring-status.js";
```

Inside `buildListRowHTML`, compute the gear color and toggleability block. After the `utilizationHTML` block (around line 110) but before the `statusBadge`
line, add:

```ts
// Gear — matches the breaker-grid's gear so onGearClick handles it unchanged.
const hasOverridesFlag = monitoringInfo ? hasCustomOverrides(monitoringInfo) : false;
const gearColor = hasOverridesFlag ? MONITORING_COLORS.custom : "#555";
const gearHTML = `<button class="gear-icon circuit-gear"
  data-uuid="${escapeHtml(uuid)}" style="color:${gearColor};"
  title="${t("grid.configure")}">
  <ha-icon icon="mdi:cog" style="--mdc-icon-size:16px;"></ha-icon>
</button>`;

// Make the status badge tappable only when the circuit can actually be
// toggled. Uses the same gate as the breaker-grid toggle-pill.
const isToggleable = circuit.is_user_controllable !== false && !!circuit.entities?.switch;
const toggleClass = isToggleable ? " list-status-toggle" : "";
```

Replace the existing `statusBadge` definition:

```ts
const statusBadge = isOn
  ? `<span class="list-status-badge list-status-on${toggleClass}">ON</span>`
  : `<span class="list-status-badge list-status-off${toggleClass}">OFF</span>`;
```

Replace the return template's opening row div and insert the gear before the expand toggle:

```ts
return `
  <div class="list-row ${isOn ? "" : "circuit-off"} ${isExpanded ? "list-row-expanded" : ""}"
       data-row-uuid="${escapeHtml(uuid)}" data-uuid="${escapeHtml(uuid)}">
    ${breakerLabel ? `<span class="breaker-badge">${breakerLabel}</span>` : ""}
    <span class="list-circuit-name">${name}</span>
    ${sheddingHTML}
    ${utilizationHTML}
    ${statusBadge}
    <span class="list-power-value">
      ${valueHTML}
    </span>
    ${gearHTML}
    <button class="list-expand-toggle ${isExpanded ? "expanded" : ""}" data-expand-uuid="${escapeHtml(uuid)}">
      <ha-icon icon="mdi:chevron-down" style="--mdc-icon-size:18px;"></ha-icon>
    </button>
  </div>
`;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/bflood/projects/HA/cards/span-card && npx vitest run tests/list-renderer.test.ts`

Expected: all 13 tests pass.

- [ ] **Step 5: Typecheck**

Run: `cd /Users/bflood/projects/HA/cards/span-card && npm run typecheck`

Expected: TypeScript errors remaining from Task 3 about `list-view-controller.ts` calling the deleted `buildExpandedCircuitHTML`. The list-renderer.ts itself
should be clean.

- [ ] **Step 6: Do not commit yet — continue to Task 5**

Task 5 closes out the list-renderer changes by updating the controller to call the new function.

---

## Task 5: Update `ListViewController`

Swap renderer calls, widen the toggle selector, and update `updateCollapsedRows` to keep the `list-status-toggle` class in sync with controllability.

**Files:**

- Modify: `src/core/list-view-controller.ts`

- [ ] **Step 1: Update the import**

Change the list-renderer import line near the top of `src/core/list-view-controller.ts`:

```ts
import { buildSearchBarHTML, buildListRowHTML, buildExpandedChartHTML, buildAreaHeaderHTML } from "./list-renderer.js";
```

(Drop `buildExpandedCircuitHTML` from the import list.)

- [ ] **Step 2: Swap the three call sites**

Replace every `buildExpandedCircuitHTML(uuid, circuit, hass, config, monitoringInfo, sheddingPriority)` call with
`buildExpandedChartHTML(uuid, circuit, hass, config, monitoringInfo)`. The three sites are in `renderActivityView`, `renderAreaView`, and `_toggleExpand`.

- [ ] **Step 3: Widen the toggle selector**

In `_bindEvents`, change:

```ts
const togglePill = target.closest(".toggle-pill");
if (togglePill) {
```

to:

```ts
const togglePill = target.closest(".toggle-pill, .list-status-toggle");
if (togglePill) {
```

- [ ] **Step 4: Update `updateCollapsedRows` to keep badge class in sync**

In `updateCollapsedRows`, after the existing `statusBadge.classList.toggle("list-status-on", isOn); statusBadge.classList.toggle("list-status-off", !isOn);`
block, add:

```ts
if (statusBadge) {
  const circuit2 = circuit; // already in scope
  const isToggleable = circuit2.is_user_controllable !== false && !!circuit2.entities?.switch;
  statusBadge.classList.toggle("list-status-toggle", isToggleable);
}
```

(The existing `if (statusBadge)` block can be extended in place — just inline the toggleable class update into it instead of introducing a second `if`.)

- [ ] **Step 5: Typecheck**

Run: `cd /Users/bflood/projects/HA/cards/span-card && npm run typecheck`

Expected: no TypeScript errors.

- [ ] **Step 6: Run all tests**

Run: `cd /Users/bflood/projects/HA/cards/span-card && npm test`

Expected: all tests pass.

- [ ] **Step 7: Commit Tasks 3–5 together**

```bash
cd /Users/bflood/projects/HA/cards/span-card
git add src/core/list-renderer.ts src/core/list-view-controller.ts tests/list-renderer.test.ts
git commit -m "feat(list): chart-only expanded rows; gear + tappable badge on list row"
```

---

## Task 6: Widen `onToggleClick` to accept `.list-status-toggle`

`DashboardController.onToggleClick` hardcodes `target.closest(".toggle-pill")` — without this change, taps on the new tappable badge are swallowed.

**Files:**

- Modify: `src/core/dashboard-controller.ts`

- [ ] **Step 1: Locate the selector**

Open `src/core/dashboard-controller.ts`. Around line 330 you'll see:

```ts
onToggleClick(ev: Event, root: DOMRoot): void {
  const target = ev.target as HTMLElement | null;
  const pill = target?.closest(".toggle-pill");
  if (!pill) return;
```

- [ ] **Step 2: Widen the selector**

Change the `.toggle-pill` closest call to:

```ts
const pill = target?.closest(".toggle-pill, .list-status-toggle");
```

No other changes — the ancestor `.closest("[data-uuid]")` already finds the list row because Task 4 added `data-uuid` to `.list-row`.

- [ ] **Step 3: Typecheck**

Run: `cd /Users/bflood/projects/HA/cards/span-card && npm run typecheck`

Expected: no errors.

- [ ] **Step 4: Run all tests**

Run: `cd /Users/bflood/projects/HA/cards/span-card && npm test`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/bflood/projects/HA/cards/span-card
git add src/core/dashboard-controller.ts
git commit -m "fix(dashboard): accept .list-status-toggle as a toggle target"
```

---

## Task 7: CSS — gear, tappable badge, chart-only slot

**Files:**

- Modify: `src/card/card-styles.ts`

- [ ] **Step 1: Read the current expanded-content styles**

Open `src/card/card-styles.ts`. Locate the two blocks added in the Favorites feature:

```css
.list-expanded-content {
  padding: 12px;
  background: var(--card-background-color, #1c1c1c);
  ...
}

.list-expanded-content .circuit-slot {
  border: none;
  margin: 0;
  ...
}
```

And note the current `.chart-container` height rule for the list view (search for `.list-expanded-content .chart-container` or the general `.chart-container`
rule). Record the current height so the new chart-only rule matches it.

- [ ] **Step 2: Add the new rules and remove the redundant override**

Inside the styles template string, add these rules (place them near the existing `.list-expanded-content` block so related styles stay adjacent):

```css
/* ── List row gear ─────────────────────────────────────── */
.list-row .gear-icon {
  background: transparent;
  border: none;
  padding: 2px;
  cursor: pointer;
  color: #555;
  display: inline-flex;
  align-items: center;
}
.list-row .gear-icon:hover {
  color: var(--primary-text-color);
}

/* ── Tappable status badge ─────────────────────────────── */
.list-status-badge.list-status-toggle {
  cursor: pointer;
  user-select: none;
}
.list-status-badge.list-status-toggle:hover {
  filter: brightness(1.15);
}

/* ── Chart-only expanded slot ──────────────────────────── */
.circuit-slot.circuit-chart-only {
  border: none;
  padding: 8px 12px;
  margin: 0;
  /* Existing .circuit-alert / .circuit-custom-monitoring rules still apply. */
}
.circuit-slot.circuit-chart-only .chart-container {
  width: 100%;
  /* Keep chart height equal to the pre-change value (see Step 1). */
  height: <VALUE_FROM_STEP_1>;
}
```

Update `.list-expanded-content` padding from `12px` to `0`:

```css
.list-expanded-content {
  padding: 0;
  background: var(--card-background-color, #1c1c1c);
  /* keep other existing properties */
}
```

Delete the now-redundant:

```css
.list-expanded-content .circuit-slot {
  border: none;
  margin: 0;
}
```

(Its behaviors are subsumed by the new `.circuit-slot.circuit-chart-only` rule.)

- [ ] **Step 3: Build and visually verify**

Run:

```bash
cd /Users/bflood/projects/HA/cards/span-card
npm run build
```

Expected: build succeeds with no typecheck or rollup errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/bflood/projects/HA/cards/span-card
git add src/card/card-styles.ts
git commit -m "style: list-row gear, tappable badge, chart-only slot"
```

---

## Task 8: Sync built bundle into the HA integration and smoke-test

**Files:**

- Modify: `/Users/bflood/projects/HA/span/custom_components/span_panel/frontend/dist/*` (generated)

- [ ] **Step 1: Sync the built bundle**

Use the `sync-frontend` skill (preferred), or run the HA-side script:

```bash
cd /Users/bflood/projects/HA/span
./scripts/build-frontend.sh
```

Expected: `custom_components/span_panel/frontend/dist/span-card.js` is updated.

- [ ] **Step 2: Commit the synced bundle in the HA repo**

```bash
cd /Users/bflood/projects/HA/span
git add custom_components/span_panel/frontend/dist/
git commit -m "build: sync span-card bundle (compact expanded list rows)"
```

- [ ] **Step 3: Manual smoke tests (from the spec's test plan)**

Reload the Home Assistant dashboard and the Favorites panel, then verify:

1. **By-Activity view, Favorites panel:** expand a row — only the chart appears, no duplicated header/status. Chart height matches the previous layout.
2. **By-Area view, Favorites panel:** same.
3. **By-Activity / By-Area in the regular dashboard card:** same.
4. **Gear on list row:** tap it — side panel opens for that circuit.
5. **Tappable ON/OFF badge (controllable circuit):** tap it — after arming the panel-level "Enable switches" slide-to-confirm, the badge toggles state; row
   re-sorts according to new state.
6. **Non-controllable circuit (PV):** the badge shows ON/OFF but has no hover cursor, and taps do nothing.
7. **Alert signaling:** a circuit with an active alert shows the alert border on the expanded chart slot.
8. **Favorites state persistence:** reload the page — previously expanded rows remain expanded with their charts rendered.
9. **Breaker grid view:** unchanged visually and behaviorally.

- [ ] **Step 4: If smoke tests pass, you're done**

If any smoke test fails, capture the failure mode and open a follow-up issue or fix in place before wrapping.

---

## Self-review notes

- **Spec coverage:** §1 (list row) → Task 4. §2 (expanded content) → Task 3. §3 (shared helper) → Tasks 1 & 2. §4 (controller wiring) → Tasks 5 & 6. §5 (CSS) →
  Task 7. Verification points §1/§2/§3 → covered explicitly in Tasks 6, 4, and 7 respectively.
- **Placeholders:** one intentional placeholder in Task 7 Step 2 (`<VALUE_FROM_STEP_1>`) — this is an instruction to read-and-replace a runtime value from the
  current CSS, not a TBD for later.
- **Type consistency:** `getCircuitStateClasses` signature matches across Task 1 definition, Task 2 call, and Task 3 call. `buildExpandedChartHTML` signature
  defined in Task 3 matches import and call sites in Task 5.
