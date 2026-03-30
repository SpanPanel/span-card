import { INTEGRATION_DOMAIN } from "../constants.js";
import { escapeHtml } from "../helpers/sanitize.js";

export class MonitoringTab {
  async render(container, hass) {
    let status;
    try {
      const resp = await hass.callService(INTEGRATION_DOMAIN, "get_monitoring_status", {}, undefined, true);
      status = resp?.response || null;
    } catch {
      container.innerHTML = `
        <div style="padding:16px;">
          <h2>Monitoring</h2>
          <p style="color:var(--secondary-text-color);">
            Monitoring is not enabled. Enable it in the integration's
            options flow (Settings &gt; Devices &amp; Services &gt;
            SPAN Panel &gt; Configure &gt; Monitoring).
          </p>
        </div>
      `;
      return;
    }

    const circuits = status?.circuits || {};
    const mains = status?.mains || {};
    const allEntries = [...Object.entries(circuits), ...Object.entries(mains)];

    const monitoredRows = allEntries
      .map(([entityId, info]) => {
        const name = escapeHtml(info.name || entityId);
        const continuous = info.continuous_threshold_pct;
        const spike = info.spike_threshold_pct;
        const window = info.window_duration_m;
        const isMains = Object.prototype.hasOwnProperty.call(mains, entityId);
        return `
          <tr>
            <td style="padding:8px;">${name}</td>
            <td style="padding:8px;">${continuous ?? "--"}%</td>
            <td style="padding:8px;">${spike ?? "--"}%</td>
            <td style="padding:8px;">${window ?? "--"}m</td>
            <td style="padding:8px;">
              <button class="reset-btn" data-entity="${escapeHtml(entityId)}"
                      data-type="${isMains ? "mains" : "circuit"}"
                      style="background:none;border:1px solid var(--divider-color);color:var(--primary-text-color);border-radius:4px;padding:4px 8px;cursor:pointer;font-size:0.8em;"
                      title="Reset to global default thresholds">
                Reset to Default
              </button>
            </td>
          </tr>
        `;
      })
      .join("");

    container.innerHTML = `
      <div style="padding:16px;">
        <h2 style="margin-top:0;">Monitoring</h2>
        <p style="color:var(--secondary-text-color);margin-bottom:16px;">
          Global monitoring thresholds are configured in the integration's options flow
          (Settings &gt; Devices &amp; Services &gt; SPAN Panel &gt; Configure &gt; Monitoring).
          Per-circuit overrides are listed below. Use <em>Reset to Default</em> to clear
          a custom override and restore the circuit to global defaults.
        </p>

        <h3>Monitored Points</h3>
        ${
          allEntries.length > 0
            ? `
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr style="text-align:left;border-bottom:1px solid var(--divider-color);">
                <th style="padding:8px;">Name</th>
                <th style="padding:8px;">Continuous</th>
                <th style="padding:8px;">Spike</th>
                <th style="padding:8px;">Window</th>
                <th style="padding:8px;"></th>
              </tr>
            </thead>
            <tbody>${monitoredRows}</tbody>
          </table>
        `
            : `
          <p style="color:var(--secondary-text-color);">
            All circuits using global defaults. No per-circuit overrides are configured.
          </p>
        `
        }
      </div>
    `;

    // Reset button handlers
    for (const btn of container.querySelectorAll(".reset-btn")) {
      btn.addEventListener("click", async () => {
        const entityId = btn.dataset.entity;
        const type = btn.dataset.type;
        const service = type === "mains" ? "clear_mains_threshold" : "clear_circuit_threshold";
        const param = type === "mains" ? { leg: entityId } : { circuit_id: entityId };
        await hass.callService(INTEGRATION_DOMAIN, service, param);
        await this.render(container, hass);
      });
    }
  }
}
