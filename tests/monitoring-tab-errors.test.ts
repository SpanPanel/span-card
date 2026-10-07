import { describe, it, expect, vi } from "vitest";
import { MonitoringTab } from "../src/panel/tab-monitoring.js";
import type { HomeAssistant } from "../src/types.js";

/** Monitoring enabled; every settings save is rejected the way Home Assistant rejects: a plain { code, message }. */
function hassRejectingSaves(): HomeAssistant {
  const callWS = vi.fn(async (msg: Record<string, unknown>) => {
    if (msg.service === "get_monitoring_status") {
      return {
        response: {
          enabled: true,
          global_settings: { continuous_threshold_pct: 80, spike_threshold_pct: 100, window_duration_m: 15, cooldown_duration_m: 15 },
        },
      };
    }
    throw { code: "service_validation_error", message: "Monitoring is not configured" };
  });
  return { states: {}, services: {}, language: "en", callService: async () => undefined, callWS } as unknown as HomeAssistant;
}

describe("the monitoring tab's errors", () => {
  it("shows Home Assistant's message when a settings save is rejected", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    await new MonitoringTab().render(container, hassRejectingSaves(), "entry-1");
    const enabled = container.querySelector<HTMLInputElement>("#monitoring-enabled")!;

    enabled.checked = false;
    enabled.dispatchEvent(new Event("change"));

    await vi.waitFor(() => expect(container.querySelector("#global-status")!.textContent).toContain("Monitoring is not configured"));
    container.remove();
  });
});
