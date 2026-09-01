import { INTEGRATION_DOMAIN } from "../constants.js";
import { escapeHtml } from "../helpers/sanitize.js";
import { t, tf } from "../i18n.js";
import {
  appliedSeed,
  buildSavePlan,
  coerceRegistrySeed,
  filterGroups,
  humanizeClass,
  registryPayload,
  seedForm,
  sensorOptions,
  sensorOptionsDirty,
  showsDisplayUnit,
  statisticsConfirmation,
} from "../core/adopted-model.js";
import type { CurationForm, RegistrySeed } from "../core/adopted-model.js";
import type { AdoptedCurateResponse, AdoptedDeviceGroup, AdoptedListResponse, AdoptedRow, HomeAssistant } from "../types.js";

/** Display precisions offered beside Core's own choice. */
const PRECISION_CHOICES = ["0", "1", "2", "3", "4", "5", "6"];

/**
 * How long after a save to re-read the list. The curate command schedules a
 * reload of the entry, so an immediate re-read would race the teardown and be
 * refused; this waits for the entry to come back with the saved record applied.
 */
const REFRESH_AFTER_SAVE_MS = 2000;

const MUTED = "var(--secondary-text-color,#999)";
const ACCENT = "var(--primary-color,#4dd9af)";
const WARN = "var(--warning-color,#ff9800)";
const SURFACE = "var(--card-background-color,#1c1c1c)";
const RAISED = "var(--secondary-background-color,#232323)";
const LINE = "var(--divider-color,#333)";

const SELECT_STYLE = `background:${RAISED};border:1px solid ${LINE};color:var(--primary-text-color);border-radius:4px;padding:4px 8px;font-size:0.85em;`;
const INPUT_STYLE = `${SELECT_STYLE}min-width:0;`;
const FIELD_ROW = "display:flex;align-items:center;gap:12px;flex-wrap:wrap;";
const FIELD_LABEL = `font-size:0.85em;color:${MUTED};min-width:130px;`;
const NOTE = `color:${MUTED};font-size:0.75em;`;
const BUTTON = `background:none;border:1px solid ${LINE};color:var(--primary-text-color);border-radius:6px;padding:6px 12px;font-size:0.8em;cursor:pointer;`;

/** One row's editor while it is open. Only the expanded row has one. */
interface EditorState {
  form: CurationForm;
  /** Core's registry state for the row, or null when it has no readable entry. */
  seed: RegistrySeed | null;
  /** Core's convertible units for the chosen device class; empty when it converts none. */
  units: string[];
  /** The display-unit control, ``""`` for "as published". */
  unit: string;
  /** The precision control, ``""`` for Core's own choice. */
  precision: string;
  /** The statistics consequence awaiting confirmation, if any. */
  confirm: "total_increasing" | "clearing" | null;
  /** Whether the pending confirmation is a clear rather than a save. */
  confirmClears: boolean;
  /** True while a fetch or a save is in flight — the actions are held. */
  busy: boolean;
  error: string | null;
  notices: string[];
}

function badgeHTML(label: string, accent: boolean): string {
  const color = accent ? ACCENT : MUTED;
  return `<span style="background:color-mix(in srgb,${color} 15%,transparent);color:${color};border:1px solid color-mix(in srgb,${color} 25%,transparent);border-radius:4px;padding:2px 8px;font-size:0.7em;font-weight:600;">${escapeHtml(label)}</span>`;
}

function chevronHTML(open: boolean): string {
  const transform = open ? ' style="transform:rotate(180deg);"' : "";
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${MUTED}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${transform}><polyline points="6 9 12 15 18 9"></polyline></svg>`;
}

function selectHTML(field: string, options: { value: string; label: string }[], selected: string): string {
  const rendered = options
    .map(option => `<option value="${escapeHtml(option.value)}"${option.value === selected ? " selected" : ""}>${escapeHtml(option.label)}</option>`)
    .join("");
  return `<select data-field="${escapeHtml(field)}" style="${SELECT_STYLE}">${rendered}</select>`;
}

/** The one-line summary a collapsed row carries: its platform and its unit. */
function rowSubtitle(row: AdoptedRow): string {
  return row.unit ? `${row.platform} · ${row.unit}` : row.platform;
}

/** What the panel says about this row, in its own vocabulary. */
function wireLine(row: AdoptedRow): string {
  const parts = [row.path, row.datatype];
  if (row.unit) parts.push(row.unit);
  parts.push(row.settable ? t("adopted.settable") : t("adopted.read_only"));
  return parts.join(" · ");
}

function warningText(code: string): string {
  if (code === "total_increasing") return t("adopted.warn_total_increasing");
  if (code === "statistics_removed") return t("adopted.warn_statistics_removed");
  return code;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

/**
 * The Adopted tab: every property the panel publishes that nobody modelled,
 * grouped by the device it renders on, each row expandable into an editor.
 *
 * The editor writes to two places, because two places own the answer. A name,
 * enabled-ness and a display unit are Core's registry state, written through
 * Core's own admin command; a device class, a state class and prominence have
 * nowhere in the registry to live and go to the integration's curation store.
 * The split is the design's, not an implementation detail: ``buildSavePlan``
 * decides it, and this class only issues what it decided.
 *
 * What Core's own entity settings dialog already does well, this tab does not
 * restate. The icon is the case in point: it was offered here, wrote through
 * the same registry command, and gave a user a second place to set one thing.
 *
 * DOM only. Every decision that can be made without a document —- what to
 * filter, what to write, what to warn about -— lives in ``core/adopted-model``
 * where it is tested without one.
 */
export class AdoptedTab {
  private _container: HTMLElement | null = null;
  private _hass: HomeAssistant | null = null;
  private _deviceId: string | null = null;

  private _groups: AdoptedDeviceGroup[] = [];
  private _loadError: string | null = null;
  private _query = "";
  private _expandedKey: string | null = null;
  private _editor: EditorState | null = null;

  /** Core's convertible units per device class, so re-picking one is free. */
  private _unitsCache = new Map<string, string[]>();
  private _refreshTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly _onClick = (e: Event): void => {
    void this._handleClick(e);
  };
  private readonly _onInput = (e: Event): void => {
    this._handleInput(e);
  };
  private readonly _onChange = (e: Event): void => {
    void this._handleChange(e);
  };

  stop(): void {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
    this._unbind();
  }

  async render(container: HTMLElement, hass: HomeAssistant, deviceId?: string): Promise<void> {
    const nextDeviceId = deviceId === undefined ? this._deviceId : deviceId || null;
    if (nextDeviceId !== this._deviceId) {
      // Another panel's rows: an open editor and a filter belong to the
      // panel they were opened on, and a key from one panel resolves to
      // nothing on the next.
      this._deviceId = nextDeviceId;
      this._expandedKey = null;
      this._editor = null;
      this._query = "";
    }
    this._unbind();
    this._container = container;
    this._hass = hass;
    await this._fetchList(hass, false);
    this._paint();
  }

  // ── Data ────────────────────────────────────────────────────────────

  /**
   * Load the curatable rows for the selected panel. ``keepOnError`` holds the
   * rows already on screen: the post-save re-read runs while the entry is
   * reloading, and a refusal there means "not yet", not "nothing to show".
   */
  private async _fetchList(hass: HomeAssistant, keepOnError: boolean): Promise<void> {
    if (!this._deviceId) {
      this._groups = [];
      this._loadError = null;
      return;
    }
    try {
      const response = await hass.callWS<AdoptedListResponse>({
        type: `${INTEGRATION_DOMAIN}/adopted/list`,
        device_id: this._deviceId,
      });
      this._groups = Array.isArray(response?.devices) ? response.devices : [];
      this._loadError = null;
    } catch (err) {
      if (keepOnError) return;
      this._groups = [];
      this._loadError = errorText(err);
    }
  }

  /** Core's registry entry for a row, or null when it has none to read. */
  private async _fetchSeed(hass: HomeAssistant, entityId: string): Promise<RegistrySeed | null> {
    try {
      return coerceRegistrySeed(await hass.callWS({ type: "config/entity_registry/get", entity_id: entityId }));
    } catch {
      return null;
    }
  }

  /**
   * The units Core will convert a device class between — its own answer, asked
   * rather than restated here, so the display controls appear exactly when
   * Core's converter gate would honour them.
   */
  private async _fetchUnits(hass: HomeAssistant, deviceClass: string): Promise<string[]> {
    if (!deviceClass) return [];
    const cached = this._unitsCache.get(deviceClass);
    if (cached) return cached;
    try {
      const response = await hass.callWS<{ units: unknown }>({
        type: "sensor/device_class_convertible_units",
        device_class: deviceClass,
      });
      const units = Array.isArray(response?.units) ? response.units.filter((unit): unit is string => typeof unit === "string") : [];
      this._unitsCache.set(deviceClass, units);
      return units;
    } catch {
      return [];
    }
  }

  private _findRow(key: string): AdoptedRow | null {
    for (const group of this._groups) {
      for (const row of group.rows) {
        if (row.key === key) return row;
      }
    }
    return null;
  }

  // ── Painting ────────────────────────────────────────────────────────

  private _paint(): void {
    const container = this._container;
    if (!container) return;

    container.innerHTML = `
      <div style="padding:16px;">
        <h2 style="margin:0 0 4px 0;">${t("adopted.heading")}</h2>
        <p style="color:${MUTED};margin:0 0 20px 0;font-size:0.85em;max-width:640px;">${t("adopted.description")}</p>

        <div style="display:flex;align-items:center;gap:8px;background:${SURFACE};border:1px solid ${LINE};border-radius:8px;padding:8px 12px;margin:0 0 20px 0;max-width:420px;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${MUTED}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
          <input id="adopted-filter" type="text" value="${escapeHtml(this._query)}" placeholder="${escapeHtml(t("adopted.filter_placeholder"))}"
                 style="flex:1;background:none;border:none;outline:none;color:var(--primary-text-color);font-size:0.85em;padding:0;">
        </div>

        <div id="adopted-groups">${this._groupsHTML()}</div>
      </div>
    `;
    this._bind();
  }

  /** Repaint the groups alone, leaving the filter box (and its focus) intact. */
  private _paintGroups(): void {
    const groups = this._container?.querySelector("#adopted-groups");
    if (groups) groups.innerHTML = this._groupsHTML();
  }

  private _groupsHTML(): string {
    if (this._loadError !== null) {
      return `<p style="color:var(--error-color);font-size:0.85em;">${escapeHtml(t("adopted.load_failed"))} — ${escapeHtml(this._loadError)}</p>`;
    }
    if (this._groups.length === 0) return `<p style="color:${MUTED};font-size:0.85em;">${t("adopted.none")}</p>`;

    const visible = filterGroups(this._groups, this._query);
    if (visible.length === 0) return `<p style="color:${MUTED};font-size:0.85em;">${t("adopted.no_results")}</p>`;
    return visible.map(group => this._groupHTML(group)).join("");
  }

  private _groupHTML(group: AdoptedDeviceGroup): string {
    const badge = group.adopted_device ? badgeHTML(t("adopted.adopted_device"), false) : badgeHTML(t("adopted.vendor_readings"), true);
    const count = tf("adopted.count", { count: String(group.rows.length) });
    const subtitle = group.adopted_device ? `${t("adopted.via_panel")} · ${count}` : count;
    return `
      <div style="display:flex;align-items:center;gap:10px;margin:0 0 8px 0;">
        <span style="font-size:1.0em;font-weight:500;">${escapeHtml(group.name ?? "")}</span>
        ${badge}
        <span style="${NOTE}">${escapeHtml(subtitle)}</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:24px;">
        ${group.rows.map(row => this._rowHTML(row)).join("")}
      </div>
    `;
  }

  private _rowHTML(row: AdoptedRow): string {
    const open = this._expandedKey === row.key;
    const editor = open && this._editor ? this._editorHTML(row, this._editor) : "";
    const headerStyle = open
      ? `display:flex;align-items:center;padding:12px 16px;gap:10px;background:${RAISED};border:1px solid ${LINE};border-bottom-color:transparent;border-radius:8px 8px 0 0;cursor:pointer;`
      : `display:flex;align-items:center;padding:12px 16px;gap:10px;background:${SURFACE};border:1px solid ${LINE};border-radius:8px;cursor:pointer;`;

    return `
      <div>
        <div class="adopted-row-header" data-key="${escapeHtml(row.key)}" style="${headerStyle}">
          <span style="flex:1;font-size:0.9em;${open ? "font-weight:500;" : ""}">${escapeHtml(row.name)}</span>
          <span style="${NOTE}">${escapeHtml(rowSubtitle(row))}</span>
          ${Object.keys(row.curation).length > 0 ? badgeHTML(t("adopted.curated"), true) : ""}
          ${row.stale_fields.length > 0 ? badgeHTML(t("adopted.stale"), false) : ""}
          ${chevronHTML(open)}
        </div>
        ${editor}
      </div>
    `;
  }

  private _editorHTML(row: AdoptedRow, editor: EditorState): string {
    const sections: string[] = [];

    if (editor.seed !== null) {
      sections.push(this._enableHTML(editor));
      sections.push(this._identityHTML(editor));
    } else {
      sections.push(`<div style="${NOTE}">${t("adopted.registry_unavailable")}</div>`);
    }

    if (row.allowed_device_classes.length > 0) sections.push(this._deviceClassHTML(row, editor));
    if (row.allowed_state_classes.length > 0) sections.push(this._stateClassHTML(row, editor));
    sections.push(this._prominenceHTML(editor));

    if (editor.seed !== null && showsDisplayUnit(editor.form.deviceClass, row.allowed_device_classes, editor.units)) {
      sections.push(this._displayHTML(row, editor));
    }

    if (row.stale_fields.length > 0) {
      sections.push(`<div style="color:${WARN};font-size:0.75em;">${escapeHtml(tf("adopted.stale_note", { fields: row.stale_fields.join(", ") }))}</div>`);
    }

    sections.push(this._actionsHTML(editor));
    if (editor.confirm !== null) sections.push(this._confirmHTML(row, editor));
    if (editor.error !== null) {
      sections.push(`<div style="color:var(--error-color);font-size:0.8em;">${escapeHtml(editor.error)}</div>`);
    }
    for (const notice of editor.notices) {
      sections.push(`<div style="color:${MUTED};font-size:0.8em;">${escapeHtml(notice)}</div>`);
    }
    sections.push(`<div style="color:${MUTED};opacity:0.75;font-size:0.7em;font-family:monospace;">${escapeHtml(wireLine(row))}</div>`);

    return `
      <div style="background:${SURFACE};border:1px solid ${LINE};border-top:none;border-radius:0 0 8px 8px;padding:16px;display:flex;flex-direction:column;gap:14px;">
        ${sections.join("")}
      </div>
    `;
  }

  private _enableHTML(editor: EditorState): string {
    const enabled = editor.form.enabled;
    const color = enabled ? ACCENT : MUTED;
    return `
      <div style="${FIELD_ROW}">
        <span style="${FIELD_LABEL}">${t("adopted.enable_entity")}</span>
        <button type="button" data-action="toggle-enable"
                style="display:inline-flex;align-items:center;gap:6px;padding:2px 6px;border:none;border-radius:10px;font-size:0.65em;font-weight:600;cursor:pointer;background:color-mix(in srgb,${color} 25%,transparent);color:${color};">
          <span>${enabled ? t("adopted.enabled") : t("adopted.disabled")}</span>
          <span style="width:14px;height:14px;border-radius:50%;background:${color};"></span>
        </button>
        <span style="${NOTE}">${t("adopted.enable_note")}</span>
      </div>
    `;
  }

  private _identityHTML(editor: EditorState): string {
    return `
      <div style="${FIELD_ROW}">
        <span style="${FIELD_LABEL}">${t("adopted.name")}</span>
        <input type="text" data-field="name" value="${escapeHtml(editor.form.name)}" style="${INPUT_STYLE}width:260px;">
      </div>
    `;
  }

  private _deviceClassHTML(row: AdoptedRow, editor: EditorState): string {
    const options = [{ value: "", label: t("adopted.no_device_class") }, ...row.allowed_device_classes.map(value => ({ value, label: humanizeClass(value) }))];
    const note = row.unit ? tf("adopted.device_class_note", { unit: row.unit }) : t("adopted.device_class_note_unitless");
    return `
      <div style="${FIELD_ROW}">
        <span style="${FIELD_LABEL}">${t("adopted.device_class")}</span>
        ${selectHTML("device_class", options, editor.form.deviceClass)}
        <span style="${NOTE}">${escapeHtml(note)}</span>
      </div>
    `;
  }

  private _stateClassHTML(row: AdoptedRow, editor: EditorState): string {
    const options = [{ value: "", label: t("adopted.no_statistics") }, ...row.allowed_state_classes.map(value => ({ value, label: humanizeClass(value) }))];
    return `
      <div style="${FIELD_ROW}">
        <span style="${FIELD_LABEL}">${t("adopted.statistics_class")}</span>
        ${selectHTML("state_class", options, editor.form.stateClass)}
        <span style="${NOTE}">${t("adopted.statistics_note")}</span>
      </div>
    `;
  }

  private _prominenceHTML(editor: EditorState): string {
    const segment = (value: string, label: string, active: boolean): string =>
      `<button type="button" data-action="prominence" data-value="${value}" aria-pressed="${active}"
               style="padding:4px 10px;border:none;font-size:0.75em;font-weight:600;cursor:pointer;${active ? `background:${ACCENT};color:var(--text-primary-color,#111);` : `background:none;color:${MUTED};`}">${escapeHtml(label)}</button>`;
    return `
      <div style="${FIELD_ROW}">
        <span style="${FIELD_LABEL}">${t("adopted.prominence")}</span>
        <span style="display:inline-flex;background:${RAISED};border-radius:6px;overflow:hidden;">
          ${segment("diagnostic", t("adopted.diagnostic"), !editor.form.promote)}
          ${segment("standard", t("adopted.standard"), editor.form.promote)}
        </span>
      </div>
    `;
  }

  private _displayHTML(row: AdoptedRow, editor: EditorState): string {
    const asPublished = row.unit ? `${row.unit} — ${t("adopted.unit_as_published")}` : t("adopted.unit_as_published");
    const unitOptions = [{ value: "", label: asPublished }, ...editor.units.map(unit => ({ value: unit, label: unit }))];
    const precisionOptions = [{ value: "", label: t("adopted.precision_default") }, ...PRECISION_CHOICES.map(value => ({ value, label: value }))];
    return `
      <div style="${FIELD_ROW}">
        <span style="${FIELD_LABEL}">${t("adopted.display_unit")}</span>
        ${selectHTML("unit", unitOptions, editor.unit)}
        <span style="font-size:0.85em;color:${MUTED};">${t("adopted.precision")}</span>
        ${selectHTML("precision", precisionOptions, editor.precision)}
      </div>
    `;
  }

  private _actionsHTML(editor: EditorState): string {
    const held = editor.busy ? " disabled" : "";
    return `
      <div style="border-top:1px solid ${LINE};padding-top:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <button data-action="save"${held} style="background:${ACCENT};color:var(--text-primary-color,#111);border:none;border-radius:6px;padding:6px 16px;font-size:0.8em;font-weight:600;cursor:pointer;">${t("adopted.save")}</button>
        <button data-action="clear"${held} style="${BUTTON}">${t("adopted.clear")}</button>
        <span style="${NOTE}margin-left:auto;">${t("adopted.reload_note")}</span>
      </div>
    `;
  }

  private _confirmHTML(row: AdoptedRow, editor: EditorState): string {
    const clearing = editor.confirm === "clearing";
    const subject = clearing
      ? tf("adopted.confirm_clearing_subject", { name: row.name })
      : tf("adopted.confirm_setting", { name: row.name, value: humanizeClass(editor.form.stateClass) });
    const body = clearing ? t("adopted.confirm_clearing") : t("adopted.confirm_total_increasing");
    return `
      <div style="background:${RAISED};border:1px solid ${WARN};border-radius:8px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${WARN}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
          <span style="font-size:0.95em;font-weight:500;">${t("adopted.confirm_heading")}</span>
        </div>
        <p style="margin:0;font-size:0.85em;line-height:1.5;">${escapeHtml(subject)}</p>
        <p style="margin:0;font-size:0.85em;color:${MUTED};line-height:1.5;">${body}</p>
        <div style="display:flex;justify-content:flex-end;gap:10px;">
          <button data-action="confirm-cancel" style="${BUTTON}">${t("adopted.cancel")}</button>
          <button data-action="confirm-save" style="background:${WARN};color:var(--text-primary-color,#111);border:none;border-radius:6px;padding:6px 16px;font-size:0.8em;font-weight:600;cursor:pointer;">${t("adopted.save_anyway")}</button>
        </div>
      </div>
    `;
  }

  // ── Events ──────────────────────────────────────────────────────────

  private _bind(): void {
    const container = this._container;
    if (!container) return;
    container.addEventListener("click", this._onClick);
    container.addEventListener("input", this._onInput);
    container.addEventListener("change", this._onChange);
  }

  private _unbind(): void {
    const container = this._container;
    if (!container) return;
    container.removeEventListener("click", this._onClick);
    container.removeEventListener("input", this._onInput);
    container.removeEventListener("change", this._onChange);
  }

  private async _handleClick(e: Event): Promise<void> {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    const action = target.closest<HTMLElement>("[data-action]");
    if (action) {
      await this._handleAction(action);
      return;
    }

    const header = target.closest<HTMLElement>(".adopted-row-header");
    const key = header?.dataset.key;
    if (!key) return;
    if (this._expandedKey === key) {
      this._expandedKey = null;
      this._editor = null;
      this._paintGroups();
      return;
    }
    await this._openEditor(key);
  }

  private async _handleAction(element: HTMLElement): Promise<void> {
    const editor = this._editor;
    if (!editor) return;

    switch (element.dataset.action) {
      case "toggle-enable":
        editor.form = { ...editor.form, enabled: !editor.form.enabled };
        this._paintGroups();
        return;
      case "prominence":
        editor.form = { ...editor.form, promote: element.dataset.value === "standard" };
        this._paintGroups();
        return;
      case "save":
        if (!editor.busy) await this._save(false);
        return;
      case "clear":
        if (!editor.busy) await this._save(true);
        return;
      case "confirm-cancel":
        editor.confirm = null;
        this._paintGroups();
        return;
      case "confirm-save": {
        const clears = editor.confirmClears;
        editor.confirm = null;
        await this._commit(clears);
        return;
      }
      default:
        return;
    }
  }

  private _handleInput(e: Event): void {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    if (target.id === "adopted-filter") {
      this._query = (target as HTMLInputElement).value;
      this._paintGroups();
      return;
    }

    const editor = this._editor;
    const field = target.dataset.field;
    if (!editor || !field) return;
    const value = (target as HTMLInputElement).value;
    if (field === "name") editor.form = { ...editor.form, name: value };
  }

  private async _handleChange(e: Event): Promise<void> {
    const target = e.target as HTMLSelectElement | null;
    const editor = this._editor;
    const field = target?.dataset.field;
    if (!target || !editor || !field) return;

    switch (field) {
      case "device_class": {
        editor.form = { ...editor.form, deviceClass: target.value };
        // A device class decides whether Core will convert the reading at
        // all, so the display controls have to be re-asked, not re-guessed.
        editor.units = this._hass ? await this._fetchUnits(this._hass, target.value) : [];
        this._paintGroups();
        return;
      }
      case "state_class":
        editor.form = { ...editor.form, stateClass: target.value };
        return;
      case "unit":
        editor.unit = target.value;
        return;
      case "precision":
        editor.precision = target.value;
        return;
      default:
        return;
    }
  }

  // ── Editing ─────────────────────────────────────────────────────────

  private async _openEditor(key: string): Promise<void> {
    const row = this._findRow(key);
    const hass = this._hass;
    if (!row || !hass) return;

    this._expandedKey = key;
    this._editor = {
      form: seedForm(row, null),
      seed: null,
      units: [],
      unit: "",
      precision: "",
      confirm: null,
      confirmClears: false,
      busy: true,
      error: null,
      notices: [],
    };
    this._paintGroups();

    const seed = row.entity_id === null ? null : await this._fetchSeed(hass, row.entity_id);
    if (this._expandedKey !== key) return;
    const form = seedForm(row, seed);
    const units = await this._fetchUnits(hass, form.deviceClass);
    if (this._expandedKey !== key) return;

    this._editor = {
      form,
      seed,
      units,
      unit: seed?.unit ?? "",
      precision: seed?.precision ?? "",
      confirm: null,
      confirmClears: false,
      busy: false,
      error: null,
      notices: [],
    };
    this._paintGroups();
  }

  /**
   * Start a save, or a clear. Either can carry a statistics consequence, so
   * both go through the same confirmation before anything is written.
   */
  private async _save(clears: boolean): Promise<void> {
    const editor = this._editor;
    const row = this._expandedKey === null ? null : this._findRow(this._expandedKey);
    if (!editor || !row) return;

    const confirmation = statisticsConfirmation(row, this._formFor(editor, clears));
    if (confirmation !== null) {
      editor.confirm = confirmation;
      editor.confirmClears = clears;
      editor.error = null;
      editor.notices = [];
      this._paintGroups();
      return;
    }
    await this._commit(clears);
  }

  /** The form a save writes: the edited one, or an emptied one for a clear. */
  private _formFor(editor: EditorState, clears: boolean): CurationForm {
    return clears ? { ...editor.form, deviceClass: "", stateClass: "", promote: false } : editor.form;
  }

  /**
   * Issue the writes, in the order the design settles: Core's registry first,
   * then the curate command, whose reload picks up everything Core's own
   * delayed reload would have.
   *
   * What that registry write may say is ``registryPayload``'s decision: it is
   * null when nothing registry-owned moved, and it drops ``disabled_by``
   * whenever the enable control did not move, so neither a curation-only save
   * nor a rename can rewrite the disabler of an entity nobody enabled. A clear
   * touches the registry not at all: it removes a record, and a record is not
   * a name or an enabled entity.
   */
  private async _commit(clears: boolean): Promise<void> {
    const editor = this._editor;
    const hass = this._hass;
    const row = this._expandedKey === null ? null : this._findRow(this._expandedKey);
    if (!editor || !hass || !row || !this._deviceId) return;

    const form = this._formFor(editor, clears);
    const plan = buildSavePlan(row, form);
    editor.busy = true;
    editor.error = null;
    editor.notices = [];
    this._paintGroups();

    // Held locally so each write updates the seed the next one compares
    // against, and a second save of the same form writes nothing again.
    let seed = editor.seed;
    try {
      const payload = clears || seed === null ? null : registryPayload(plan, seed, form);
      if (payload !== null && seed !== null) {
        await hass.callWS(payload);
        seed = appliedSeed(seed, form);
        editor.seed = seed;
      }
      if (
        !clears &&
        seed !== null &&
        row.entity_id !== null &&
        showsDisplayUnit(form.deviceClass, row.allowed_device_classes, editor.units) &&
        sensorOptionsDirty(seed, editor.unit, editor.precision)
      ) {
        await hass.callWS({
          type: "config/entity_registry/update",
          entity_id: row.entity_id,
          options_domain: "sensor",
          options: sensorOptions(editor.unit, editor.precision),
        });
        seed = { ...seed, unit: editor.unit, precision: editor.precision };
        editor.seed = seed;
      }
      const result = await hass.callWS<AdoptedCurateResponse>({
        type: `${INTEGRATION_DOMAIN}/adopted/curate`,
        device_id: this._deviceId,
        key: plan.curate.key,
        record: plan.curate.record,
      });
      row.curation = result?.record ?? {};
      editor.form = form;
      editor.notices = [t("adopted.saved"), ...(Array.isArray(result?.warnings) ? result.warnings.map(warningText) : [])];
    } catch (err) {
      editor.error = errorText(err);
      editor.busy = false;
      this._paintGroups();
      return;
    }

    editor.busy = false;
    this._paintGroups();
    this._scheduleRefresh();
  }

  /**
   * Re-read the list once the reload a save triggered has landed, so the
   * badges and the stale-field notices catch up with what was stored. The open
   * editor is left as it is — it already holds what was just saved.
   */
  private _scheduleRefresh(): void {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      const hass = this._hass;
      if (!hass) return;
      void this._fetchList(hass, true).then(() => this._paintGroups());
    }, REFRESH_AFTER_SAVE_MS);
  }
}
