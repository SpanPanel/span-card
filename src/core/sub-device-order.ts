import { SUB_DEVICE_TYPE_PV } from "../constants.js";
import type { FavoritesTopology, PanelTopology, SubDevice } from "../types.js";

/**
 * The order tiles are drawn and editor groups listed in.
 *
 * Every non-solar device keeps the order the topology gave it. Each panel's
 * solar devices go as one group, where that panel's first one was: the site
 * tile, then each inverter by name. `panelOf` names a device's panel; on a
 * single panel's topology every device has the same one. The side panel's
 * graph-settings list keeps its own name sort, which is harmless there.
 */
export function orderSubDevices(entries: [string, SubDevice][], panelOf: (devId: string) => string = () => ""): [string, SubDevice][] {
  const rank = (sub: SubDevice): number => (sub.solar?.role === "site" ? 0 : 1);
  const groups = new Map<string, [string, SubDevice][]>();
  for (const entry of entries) {
    if (entry[1].type !== SUB_DEVICE_TYPE_PV) continue;
    const panel = panelOf(entry[0]);
    const group = groups.get(panel);
    if (group) group.push(entry);
    else groups.set(panel, [entry]);
  }
  for (const group of groups.values()) {
    group.sort(([, a], [, b]) => rank(a) - rank(b) || (a.name ?? "").localeCompare(b.name ?? ""));
  }
  const ordered: [string, SubDevice][] = [];
  const placed = new Set<string>();
  for (const entry of entries) {
    if (entry[1].type !== SUB_DEVICE_TYPE_PV) {
      ordered.push(entry);
      continue;
    }
    const panel = panelOf(entry[0]);
    if (placed.has(panel)) continue;
    placed.add(panel);
    ordered.push(...(groups.get(panel) ?? []));
  }
  return ordered;
}

function isFavoritesTopology(topology: PanelTopology): topology is FavoritesTopology {
  return "_favoriteRefs" in topology;
}

/** The panel each sub-device belongs to: from its ref on a favorites topology, else the one panel. */
export function panelOfSubDevice(topology: PanelTopology): (devId: string) => string {
  if (!isFavoritesTopology(topology)) return () => "";
  const refs = topology._favoriteRefs;
  return (devId: string): string => refs[devId]?.panelDeviceId ?? "";
}
