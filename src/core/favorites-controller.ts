// src/core/favorites-controller.ts
import { discoverTopology } from "../card/card-discovery.js";
import type { FavoriteRef, FavoritesMap, FavoritesTopology, HomeAssistant, PanelDevice, PanelTopology } from "../types.js";

const COMPOSITE_SEPARATOR = "|";

/** Build the composite circuit id used by the Favorites view. */
export function buildCompositeId(panelDeviceId: string, circuitUuid: string): string {
  return `${panelDeviceId}${COMPOSITE_SEPARATOR}${circuitUuid}`;
}

export interface FavoritesPanelStatsInfo {
  panelDeviceId: string;
  panelName: string;
  topology: PanelTopology;
}

export interface FavoritesBuildResult {
  topology: FavoritesTopology;
  /** Unique contributing config entry ids (for monitoring tab stacking). */
  entryIds: string[];
  /**
   * Per-contributing-panel info used to render the Favorites view's
   * panel-status grid. Each entry carries the originating topology so
   * ``updatePanelStatsBlock`` can pull values from the correct panel's
   * entities without re-fetching.
   */
  perPanelStats: FavoritesPanelStatsInfo[];
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
    const entryIds = new Set<string>();
    const perPanelStats: FavoritesPanelStatsInfo[] = [];

    for (const { panelDeviceId, panel, topology } of contributing) {
      if (!topology) continue;
      const configEntryId = panel.config_entries?.[0] ?? null;
      if (configEntryId) entryIds.add(configEntryId);

      const panelLabel = panel.name_by_user ?? panel.name ?? topology.device_name ?? "";
      perPanelStats.push({ panelDeviceId, panelName: panelLabel, topology });
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
      perPanelStats,
    };
  }
}
