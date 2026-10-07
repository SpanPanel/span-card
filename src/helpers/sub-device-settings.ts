import { subDeviceCharts } from "./sub-device-power.js";
import type { SubDevice } from "../types.js";

/**
 * The entity a sub-device is favorited through. The favorites service
 * resolves any entity to its SPAN panel and sub-device, so any one works;
 * a sensor is preferred. `null` when the sub-device has no entities, which
 * leaves it nothing to favorite through.
 */
export function subDeviceFavoriteEntityId(entities: Record<string, { domain: string }> | undefined): string | null {
  if (!entities) return null;
  let fallback: string | null = null;
  for (const [entityId, info] of Object.entries(entities)) {
    if (info.domain === "sensor") return entityId;
    if (!fallback) fallback = entityId;
  }
  return fallback;
}

/**
 * Whether a sub-device's side panel has anything to offer: a graph horizon
 * for the charts its tile draws, or a favorite heart where the view shows
 * favorites. Its tile draws a gear only then, so a gear never opens an
 * empty panel.
 */
export function subDeviceHasSettings(sub: SubDevice, showFavorites: boolean): boolean {
  if (subDeviceCharts(sub).length > 0) return true;
  return showFavorites && subDeviceFavoriteEntityId(sub.entities) !== null;
}
