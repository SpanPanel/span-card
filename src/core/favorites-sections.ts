import type { FavoriteRef, PanelTopology } from "../types.js";

/**
 * Per-panel info needed to build a Favorites-mode sidebar section. Held
 * in a map keyed by panelDeviceId. The configEntryId is carried here
 * (rather than pulled from each FavoriteRef) so all favorites on the
 * same panel route to the same entry without N identical reads.
 */
export interface FavoritesPanelInfo {
  panelName: string;
  topology: PanelTopology;
  configEntryId: string | null;
}

/**
 * Intermediate grouping shape — one entry per contributing panel. The
 * graph settings are attached by the caller after this pure step (fetch
 * is async and involves hass).
 */
export interface FavoritesPanelGroup {
  panelDeviceId: string;
  panelName: string;
  topology: PanelTopology;
  configEntryId: string | null;
  favoriteCircuitUuids: Set<string>;
}

/**
 * Group favorited circuit refs by their source panel and sort groups
 * alphabetically by panelName for a stable sidebar ordering. Sub-device
 * refs are filtered out — the Favorites sidebar only lists circuits.
 * Refs whose panelDeviceId isn't present in `perPanelInfo` are dropped
 * (defensive — stale ref from a panel that's no longer loaded).
 */
export function groupFavoritesByPanel(favRefs: Record<string, FavoriteRef>, perPanelInfo: ReadonlyMap<string, FavoritesPanelInfo>): FavoritesPanelGroup[] {
  const byPanel = new Map<string, FavoritesPanelGroup>();
  for (const ref of Object.values(favRefs)) {
    if (ref.kind !== "circuit") continue;
    const info = perPanelInfo.get(ref.panelDeviceId);
    if (info === undefined) continue;
    let group = byPanel.get(ref.panelDeviceId);
    if (group === undefined) {
      group = {
        panelDeviceId: ref.panelDeviceId,
        panelName: info.panelName,
        topology: info.topology,
        configEntryId: info.configEntryId,
        favoriteCircuitUuids: new Set(),
      };
      byPanel.set(ref.panelDeviceId, group);
    }
    group.favoriteCircuitUuids.add(ref.targetId);
  }
  return Array.from(byPanel.values()).sort((a, b) => a.panelName.localeCompare(b.panelName));
}
