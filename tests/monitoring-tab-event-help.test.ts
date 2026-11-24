import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { MonitoringTab } from "../src/panel/tab-monitoring.js";
import { setLanguage } from "../src/i18n.js";
import type { HomeAssistant } from "../src/types.js";
import { ErrorStore } from "../src/core/error-store.js";

// With the Event Bus among its notify targets, the integration fires
// `span_panel_current_alert` for each alert. The Monitoring tab's notification
// settings name the event for whoever writes an automation on it, say in words
// what it carries, and link to the integration's documentation for its fields.

/** The integration's list of the event's fields, under the Monitoring view's Notification Settings. */
const FIELDS_URL = "https://github.com/SpanPanel/span/blob/main/frontend.md#notification-settings";

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

/** Render the tab in `language` and return the element holding the event's help. */
async function eventHelp(language: string): Promise<HTMLElement | null | undefined> {
  setLanguage(language);
  const host = document.createElement("div");
  document.body.appendChild(host);
  mounted.push(host);
  const container = document.createElement("div");
  host.attachShadow({ mode: "open" }).appendChild(container);

  await new MonitoringTab(new ErrorStore()).render(container, hass(), "entry-1", null);

  return [...container.querySelectorAll("code")].find(code => code.textContent === "span_panel_current_alert")?.parentElement;
}

describe("the Monitoring tab's help for the Event Bus", () => {
  it("names the event, says what it carries and links to its fields", async () => {
    const help = await eventHelp("en");

    expect(help?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "With the Event Bus selected, each alert also fires the span_panel_current_alert event, carrying the circuit's name, " +
        "the alert type, the current, the ratings and when it happened. See all of its fields."
    );
    // The event is the only name it shows: no list of the payload's keys.
    expect([...(help?.querySelectorAll("code") ?? [])].map(code => code.textContent)).toEqual(["span_panel_current_alert"]);
    const links = [...(help?.querySelectorAll("a") ?? [])];
    expect(links.map(link => [link.textContent, link.getAttribute("href"), link.getAttribute("target"), link.getAttribute("rel")])).toEqual([
      ["See all of its fields.", FIELDS_URL, "_blank", "noopener noreferrer"],
    ]);
  });

  it.each(["es", "fr", "ja", "pt"])("names the event and links to its fields in %s", async language => {
    const help = await eventHelp(language);

    expect(help?.textContent).not.toContain("{event}");
    expect([...(help?.querySelectorAll("code") ?? [])].map(code => code.textContent)).toEqual(["span_panel_current_alert"]);
    expect([...(help?.querySelectorAll("a") ?? [])].map(link => link.getAttribute("href"))).toEqual([FIELDS_URL]);
  });
});
