import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { MonitoringTab } from "../src/panel/tab-monitoring.js";
import { setLanguage } from "../src/i18n.js";
import type { HomeAssistant } from "../src/types.js";
import { ErrorStore } from "../src/core/error-store.js";

// With the Event Bus among its notify targets, the integration fires
// `span_panel_current_alert` for each alert, and the Monitoring tab's notification
// settings list the keys of its payload for whoever writes an automation on it.

/** The keys of the payload `dispatch_alert` fires, in its order; the last two only where the alert has them. */
const PAYLOAD_KEYS = [
  "alert_source",
  "alert_id",
  "alert_name",
  "alert_display_name",
  "alert_type",
  "current_a",
  "breaker_rating_a",
  "monitoring_rating_a",
  "monitoring_rating_user_set",
  "package_ratings_a",
  "package_ratings_state",
  "threshold_pct",
  "utilization_pct",
  "panel_serial",
  "local_time",
  "window_duration_s",
  "over_threshold_since",
];

/** An administrator's Home Assistant whose panel has monitoring on, with the Event Bus among its targets. */
function hass(): HomeAssistant {
  const callWS = async (msg: Record<string, unknown>): Promise<unknown> => {
    if (msg.service === "get_monitoring_status") {
      return {
        response: {
          enabled: true,
          global_settings: {
            continuous_threshold_pct: 80,
            spike_threshold_pct: 100,
            window_duration_m: 15,
            cooldown_duration_m: 15,
            notify_targets: "event_bus",
          },
          circuits: {},
          mains: {},
        },
      };
    }
    return {};
  };
  return { states: {}, services: {}, language: "en", user: { is_admin: true }, callWS, callService: async () => undefined } as unknown as HomeAssistant;
}

const mounted: HTMLElement[] = [];
beforeEach(() => setLanguage("en"));
afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
});

describe("the Monitoring tab's help for the Event Bus", () => {
  it("names the event and lists every key of its payload, the circuit's name as Home Assistant shows it included", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    mounted.push(host);
    const container = document.createElement("div");
    host.attachShadow({ mode: "open" }).appendChild(container);

    await new MonitoringTab(new ErrorStore()).render(container, hass(), "entry-1", null);

    // The line that names the event, and holds the keys after it.
    const help = [...container.querySelectorAll("code")].find(code => code.textContent === "span_panel_current_alert")?.parentElement;
    expect(help?.textContent).toContain("Event Bus fires event type");
    const codes = [...(help?.querySelectorAll("code") ?? [])].map(code => code.textContent);
    expect(codes).toEqual(["span_panel_current_alert", ...PAYLOAD_KEYS]);
  });
});
