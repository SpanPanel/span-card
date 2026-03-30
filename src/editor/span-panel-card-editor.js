import { CHART_METRICS, DEFAULT_CHART_METRIC, INTEGRATION_DOMAIN } from "../constants.js";
import { t } from "../i18n.js";

export class SpanPanelCardEditor extends HTMLElement {
  constructor() {
    super();
    this._config = {};
    this._hass = null;
    this._panels = null;
    this._availableRoles = null;
    this._built = false;
  }

  setConfig(config) {
    this._config = { ...config };
    this._updateControls();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._panels) {
      this._discoverPanels();
    } else if (!this._built) {
      this._buildEditor();
    }
  }

  async _discoverPanels() {
    if (!this._hass) return;
    const devices = await this._hass.callWS({ type: "config/device_registry/list" });
    this._panels = devices
      .filter(d => (d.identifiers || []).some(pair => pair[0] === INTEGRATION_DOMAIN) && !d.via_device_id)
      .map(d => {
        const serial = (d.identifiers || []).find(p => p[0] === INTEGRATION_DOMAIN)?.[1] || "";
        const name = d.name_by_user || d.name || t("editor.panel_label");
        return { device_id: d.id, label: `${name} (${serial})` };
      });
    this._buildEditor();
  }

  _buildEditor() {
    this.innerHTML = "";
    this._built = true;

    const wrapper = document.createElement("div");
    wrapper.style.padding = "16px";

    const fieldStyle = `
      width: 100%;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid var(--divider-color, #333);
      background: var(--card-background-color, var(--secondary-background-color, #1c1c1c));
      color: var(--primary-text-color, #e0e0e0);
      font-size: 1em;
      cursor: pointer;
      appearance: auto;
      box-sizing: border-box;
    `;
    const labelStyle = "display: block; font-weight: 500; margin-bottom: 8px; color: var(--primary-text-color);";
    const groupStyle = "margin-bottom: 16px;";

    this._buildPanelSelector(wrapper, fieldStyle, labelStyle, groupStyle);
    this._buildTimeWindow(wrapper, fieldStyle, labelStyle, groupStyle);
    this._buildMetricSelector(wrapper, fieldStyle, labelStyle, groupStyle);
    this._buildSectionCheckboxes(wrapper, labelStyle, groupStyle);

    this.appendChild(wrapper);

    this._populateMetricSelect();
    if (this._config.device_id) {
      this._discoverAvailableRoles(this._config.device_id);
    }
  }

  _buildPanelSelector(wrapper, fieldStyle, labelStyle, groupStyle) {
    const group = document.createElement("div");
    group.style.cssText = groupStyle;
    const label = document.createElement("label");
    label.textContent = t("editor.panel_label");
    label.style.cssText = labelStyle;
    const select = document.createElement("select");
    select.style.cssText = fieldStyle;

    const emptyOpt = document.createElement("option");
    emptyOpt.value = "";
    emptyOpt.textContent = t("editor.select_panel");
    select.appendChild(emptyOpt);

    if (this._panels) {
      for (const panel of this._panels) {
        const opt = document.createElement("option");
        opt.value = panel.device_id;
        opt.textContent = panel.label;
        if (panel.device_id === this._config.device_id) opt.selected = true;
        select.appendChild(opt);
      }
    }

    select.addEventListener("change", () => {
      this._config = { ...this._config, device_id: select.value };
      this._fireConfigChanged();
      this._discoverAvailableRoles(select.value);
    });

    group.appendChild(label);
    group.appendChild(select);
    wrapper.appendChild(group);
    this._panelSelect = select;
  }

  _buildTimeWindow(wrapper, fieldStyle, labelStyle, groupStyle) {
    const group = document.createElement("div");
    group.style.cssText = groupStyle;
    const label = document.createElement("label");
    label.textContent = t("editor.chart_window");
    label.style.cssText = labelStyle;

    const row = document.createElement("div");
    row.style.cssText = "display: flex; gap: 12px; align-items: center; flex-wrap: wrap;";

    const inputStyle = fieldStyle + "width: 70px; cursor: text;";
    const spanStyle = "font-size: 0.9em; color: var(--secondary-text-color);";

    const createTimeField = (value, min, max, unitLabel) => {
      const wrap = document.createElement("div");
      wrap.style.cssText = "display: flex; align-items: center; gap: 6px;";
      const input = document.createElement("input");
      input.type = "number";
      input.min = min;
      input.max = max;
      input.value = String(value);
      input.style.cssText = inputStyle;
      const span = document.createElement("span");
      span.textContent = unitLabel;
      span.style.cssText = spanStyle;
      wrap.appendChild(input);
      wrap.appendChild(span);
      return { wrap, input };
    };

    const daysValue = parseInt(this._config.history_days) || 0;
    const hoursValue = parseInt(this._config.history_hours) || 0;
    const minsValue = parseInt(this._config.history_minutes) || 0;
    const days = createTimeField(daysValue, "0", "30", t("editor.days"));
    const hours = createTimeField(hoursValue, "0", "23", t("editor.hours"));
    const mins = createTimeField(minsValue, "0", "59", t("editor.minutes"));

    const fireTimeChange = () => {
      this._config = {
        ...this._config,
        history_days: parseInt(days.input.value) || 0,
        history_hours: parseInt(hours.input.value) || 0,
        history_minutes: parseInt(mins.input.value) || 0,
      };
      this._fireConfigChanged();
    };
    days.input.addEventListener("change", fireTimeChange);
    hours.input.addEventListener("change", fireTimeChange);
    mins.input.addEventListener("change", fireTimeChange);

    row.appendChild(days.wrap);
    row.appendChild(hours.wrap);
    row.appendChild(mins.wrap);
    group.appendChild(label);
    group.appendChild(row);
    wrapper.appendChild(group);

    this._daysInput = days.input;
    this._hoursInput = hours.input;
    this._minsInput = mins.input;
  }

  _buildMetricSelector(wrapper, fieldStyle, labelStyle, groupStyle) {
    const group = document.createElement("div");
    group.style.cssText = groupStyle;
    const label = document.createElement("label");
    label.textContent = t("editor.chart_metric");
    label.style.cssText = labelStyle;
    const select = document.createElement("select");
    select.style.cssText = fieldStyle;

    select.addEventListener("change", () => {
      this._config = { ...this._config, chart_metric: select.value };
      this._fireConfigChanged();
    });

    group.appendChild(label);
    group.appendChild(select);
    wrapper.appendChild(group);
    this._metricSelect = select;
  }

  _buildSectionCheckboxes(wrapper, labelStyle, groupStyle) {
    const group = document.createElement("div");
    group.style.cssText = groupStyle;
    const label = document.createElement("label");
    label.textContent = t("editor.visible_sections");
    label.style.cssText = labelStyle;
    group.appendChild(label);

    const checkboxStyle = "display: flex; align-items: center; gap: 8px; margin-bottom: 6px; cursor: pointer;";
    const cbLabelStyle = "font-size: 0.9em; color: var(--primary-text-color); cursor: pointer;";

    const sections = [
      { key: "show_panel", label: t("editor.panel_circuits"), subDeviceType: null },
      { key: "show_battery", label: t("editor.battery_bess"), subDeviceType: "bess" },
      { key: "show_evse", label: t("editor.ev_charger_evse"), subDeviceType: "evse" },
    ];

    this._checkboxes = {};
    this._entityContainers = {};

    for (const sec of sections) {
      const row = document.createElement("div");
      row.style.cssText = checkboxStyle;
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = this._config[sec.key] !== false;
      cb.style.cssText = "width: 18px; height: 18px; cursor: pointer; accent-color: var(--primary-color);";
      const lbl = document.createElement("span");
      lbl.textContent = sec.label;
      lbl.style.cssText = cbLabelStyle;
      row.appendChild(cb);
      row.appendChild(lbl);
      group.appendChild(row);
      this._checkboxes[sec.key] = cb;

      let entityContainer = null;
      if (sec.subDeviceType) {
        entityContainer = document.createElement("div");
        entityContainer.style.cssText = "padding-left: 26px;";
        entityContainer.style.display = cb.checked ? "block" : "none";
        group.appendChild(entityContainer);
        this._entityContainers[sec.subDeviceType] = entityContainer;
      }

      cb.addEventListener("change", () => {
        this._config = { ...this._config, [sec.key]: cb.checked };
        if (entityContainer) entityContainer.style.display = cb.checked ? "block" : "none";
        this._fireConfigChanged();
      });
    }

    wrapper.appendChild(group);
  }

  _isChartEntity(entityId, info, subDeviceType) {
    const name = (info.original_name || "").toLowerCase();
    const uid = info.unique_id || "";
    if (name === "power" || name === "battery power" || uid.endsWith("_power")) return true;
    if (subDeviceType === "bess") {
      if (name === "battery level" || name === "battery percentage" || uid.endsWith("_battery_level") || uid.endsWith("_battery_percentage")) return true;
      if (name === "state of energy" || uid.endsWith("_soe_kwh")) return true;
      if (name === "nameplate capacity" || uid.endsWith("_nameplate_capacity")) return true;
    }
    return false;
  }

  _populateEntityCheckboxes(subDevices) {
    const visibleEnts = this._config.visible_sub_entities || {};
    const checkboxStyle = "display: flex; align-items: center; gap: 8px; margin-bottom: 5px; cursor: pointer;";
    const cbLabelStyle = "font-size: 0.85em; color: var(--primary-text-color); cursor: pointer;";

    for (const [, sub] of Object.entries(subDevices)) {
      const container = this._entityContainers[sub.type];
      if (!container) continue;
      container.innerHTML = "";
      if (!sub.entities) continue;

      for (const [entityId, info] of Object.entries(sub.entities)) {
        if (info.domain === "sensor" && this._isChartEntity(entityId, info, sub.type)) continue;
        const row = document.createElement("div");
        row.style.cssText = checkboxStyle;
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = visibleEnts[entityId] === true;
        cb.style.cssText = "width: 16px; height: 16px; cursor: pointer; accent-color: var(--primary-color);";
        const lbl = document.createElement("span");
        let name = info.original_name || entityId;
        const devName = sub.name || "";
        if (name.startsWith(devName + " ")) name = name.slice(devName.length + 1);
        lbl.textContent = name;
        lbl.style.cssText = cbLabelStyle;
        row.appendChild(cb);
        row.appendChild(lbl);
        container.appendChild(row);

        cb.addEventListener("change", () => {
          const updated = { ...(this._config.visible_sub_entities || {}) };
          if (cb.checked) {
            updated[entityId] = true;
          } else {
            delete updated[entityId];
          }
          this._config = { ...this._config, visible_sub_entities: updated };
          this._fireConfigChanged();
        });
      }
    }
  }

  async _discoverAvailableRoles(deviceId) {
    if (!this._hass || !deviceId) return;
    try {
      const topo = await this._hass.callWS({
        type: `${INTEGRATION_DOMAIN}/panel_topology`,
        device_id: deviceId,
      });
      const roles = new Set();
      for (const circuit of Object.values(topo.circuits || {})) {
        for (const role of Object.keys(circuit.entities || {})) {
          roles.add(role);
        }
      }
      this._availableRoles = roles;
      this._populateMetricSelect();
      if (topo.sub_devices) {
        this._populateEntityCheckboxes(topo.sub_devices);
      }
    } catch {
      this._availableRoles = null;
      this._populateMetricSelect();
    }
  }

  _populateMetricSelect() {
    const select = this._metricSelect;
    if (!select) return;
    const current = this._config.chart_metric || DEFAULT_CHART_METRIC;
    select.innerHTML = "";
    for (const [key, def] of Object.entries(CHART_METRICS)) {
      if (this._availableRoles && !this._availableRoles.has(def.entityRole)) continue;
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = def.label();
      if (key === current) opt.selected = true;
      select.appendChild(opt);
    }
  }

  _updateControls() {
    if (this._panelSelect) this._panelSelect.value = this._config.device_id || "";
    if (this._daysInput) this._daysInput.value = String(parseInt(this._config.history_days) || 0);
    if (this._hoursInput) this._hoursInput.value = String(parseInt(this._config.history_hours) || 0);
    if (this._minsInput) this._minsInput.value = String(parseInt(this._config.history_minutes) || 0);
    if (this._metricSelect) this._metricSelect.value = this._config.chart_metric || DEFAULT_CHART_METRIC;
    if (this._checkboxes) {
      for (const [key, cb] of Object.entries(this._checkboxes)) {
        cb.checked = this._config[key] !== false;
      }
    }
  }

  _fireConfigChanged() {
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config } }));
  }
}
