// src/core/favorites-controller.ts
import { discoverTopology } from "../card/card-discovery.js";
import type { FavoriteRef, FavoritesMap, FavoritesTopology, HomeAssistant, PanelDevice, PanelTopology } from "../types.js";

const COMPOSITE_SEPARATOR = "|";

/** Build the composite circuit id used by the Favorites view. */
export function buildCompositeId(panelDeviceId: string, circuitUuid: string): string {
  return `${panelDeviceId}${COMPOSITE_SEPARATOR}${circuitUuid}`;
}

/**
 * Parse a composite id back into its ``(panelDeviceId, circuitUuid)``
 * parts. Returns ``null`` when the input is not a composite id — callers
 * should treat a plain uuid as "use the current panel" in that case.
 */
export function parseCompositeId(id: string): { panelDeviceId: string; circuitUuid: string } | null {
  const idx = id.indexOf(COMPOSITE_SEPARATOR);
  if (idx <= 0 || idx === id.length - 1) return null;
  return {
    panelDeviceId: id.slice(0, idx),
    circuitUuid: id.slice(idx + 1),
  };
}

export interface FavoritesBuildResult {
  topology: FavoritesTopology;
  /** Unique contributing config entry ids (for monitoring tab stacking). */
  entryIds: string[];
  /**
   * Per-panel raw topologies, keyed by panel device id. Callers that
   * need to resolve a composite id to a real circuit (e.g. the side
   * panel's gear routing) can look up the originating topology here.
   */
  panelTopologies: Record<string, PanelTopology>;
}

/**
 * Aggregate the topologies of every panel that has at least one
 * favorited circuit into a single ``FavoritesTopology``. Circuit keys in
 * the merged topology are composite ids so uuids from different panels
 * cannot collide; ``_favoriteRefs`` records the origin of each.
 */
export class FavoritesController {
  async build(hass: HomeAssistant, favorites: FavoritesMap, panels: PanelDevice[]): Promise<FavoritesBuildResult> {
    const panelsById = new Map<string, PanelDevice>();
    for (const p of panels) panelsById.set(p.id, p);

    const fetches: Promise<{
      panelDeviceId: string;
      panel: PanelDevice;
      topology: PanelTopology | null;
    }>[] = [];
    for (const [panelDeviceId, entry] of Object.entries(favorites)) {
      const hasAny = (entry?.circuits?.length ?? 0) > 0 || (entry?.sub_devices?.length ?? 0) > 0;
      if (!hasAny) continue;
      const panel = panelsById.get(panelDeviceId);
      if (!panel) continue;
      fetches.push(
        (async () => {
          try {
            const result = await discoverTopology(hass, panelDeviceId);
            return { panelDeviceId, panel, topology: result.topology };
          } catch (err) {
            console.warn("SPAN Panel: favorites topology fetch failed", panelDeviceId, err);
            return { panelDeviceId, panel, topology: null };
          }
        })()
      );
    }

    const results = await Promise.all(fetches);
    const contributing = results.filter(r => r.topology !== null);
    const includePanelPrefix = contributing.length > 1;

    const mergedCircuits: FavoritesTopology["circuits"] = {};
    const mergedSubDevices: NonNullable<FavoritesTopology["sub_devices"]> = {};
    const refs: Record<string, FavoriteRef> = {};
    const panelTopologies: Record<string, PanelTopology> = {};
    const entryIds = new Set<string>();

    for (const { panelDeviceId, panel, topology } of contributing) {
      if (!topology) continue;
      panelTopologies[panelDeviceId] = topology;
      const configEntryId = panel.config_entries?.[0] ?? null;
      if (configEntryId) entryIds.add(configEntryId);

      const panelLabel = panel.name_by_user ?? panel.name ?? topology.device_name ?? "";
      const entry = favorites[panelDeviceId];
      const favoriteCircuitUuids = entry?.circuits ?? [];
      const favoriteSubDeviceIds = entry?.sub_devices ?? [];

      for (const uuid of favoriteCircuitUuids) {
        const circuit = topology.circuits?.[uuid];
        if (!circuit) continue;
        const compositeId = buildCompositeId(panelDeviceId, uuid);
        const name = includePanelPrefix && panelLabel ? `${panelLabel} \u00b7 ${circuit.name}` : circuit.name;
        mergedCircuits[compositeId] = { ...circuit, name };
        refs[compositeId] = {
          panelDeviceId,
          kind: "circuit",
          targetId: uuid,
          configEntryId,
        };
      }

      for (const subDevId of favoriteSubDeviceIds) {
        const sub = topology.sub_devices?.[subDevId];
        if (!sub) continue;
        const compositeId = buildCompositeId(panelDeviceId, subDevId);
        const name = includePanelPrefix && panelLabel && sub.name ? `${panelLabel} \u00b7 ${sub.name}` : (sub.name ?? subDevId);
        mergedSubDevices[compositeId] = { ...sub, name };
        refs[compositeId] = {
          panelDeviceId,
          kind: "sub_device",
          targetId: subDevId,
          configEntryId,
        };
      }
    }

    const topology: FavoritesTopology = {
      circuits: mergedCircuits,
      sub_devices: mergedSubDevices,
      panel_entities: {},
      device_name: "",
      _favoriteRefs: refs,
    };

    return {
      topology,
      entryIds: Array.from(entryIds),
      panelTopologies,
    };
  }
}
