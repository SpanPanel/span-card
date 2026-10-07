import { orderSubDevices } from "../core/sub-device-order.js";
import { tileRenderedEntityIds } from "../helpers/sub-device-power.js";
import type { SubDevice } from "../types.js";

export interface SubEntityOption {
  entityId: string;
  label: string;
}

export interface SubEntityGroup {
  devId: string;
  name: string;
  entities: SubEntityOption[];
}

/**
 * The editor's entity checkboxes for one section, one group per device, in
 * the order the tiles are drawn. Whatever a tile draws itself is left out,
 * from the same set the renderer hides, so a checkbox always changes something.
 */
export function subEntityGroups(subDevices: Record<string, SubDevice>, type: string): SubEntityGroup[] {
  return orderSubDevices(Object.entries(subDevices))
    .filter(([, sub]) => sub.type === type)
    .map(([devId, sub]) => {
      const drawn = tileRenderedEntityIds(sub);
      const devName = sub.name ?? "";
      const entities: SubEntityOption[] = Object.entries(sub.entities ?? {})
        .filter(([entityId]) => !drawn.has(entityId))
        .map(([entityId, info]) => {
          let label = info.original_name ?? entityId;
          if (devName && label.startsWith(devName + " ")) label = label.slice(devName.length + 1);
          return { entityId, label };
        });
      return { devId, name: devName || devId, entities };
    });
}
