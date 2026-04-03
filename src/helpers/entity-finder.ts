import type { SubDevice, EntityDescriptor } from "../types.js";

const ENTITY_DESCRIPTORS: Record<string, EntityDescriptor> = {
  power: { names: ["power", "battery power"], suffixes: ["_power"] },
  soc: { names: ["battery level", "battery percentage"], suffixes: ["_battery_level", "_battery_percentage"] },
  soe: { names: ["state of energy"], suffixes: ["_soe_kwh"] },
  capacity: { names: ["nameplate capacity"], suffixes: ["_nameplate_capacity"] },
};

function findSubDeviceEntity(subDevice: SubDevice, descriptor: EntityDescriptor): string | null {
  if (!subDevice.entities) return null;
  for (const [entityId, info] of Object.entries(subDevice.entities)) {
    if (info.domain !== "sensor") continue;
    const name = (info.original_name ?? "").toLowerCase();
    if (descriptor.names.some(n => name === n)) return entityId;
    if (info.unique_id && descriptor.suffixes.some(s => info.unique_id!.endsWith(s))) return entityId;
  }
  return null;
}

export function findSubDevicePowerEntity(subDevice: SubDevice): string | null {
  return findSubDeviceEntity(subDevice, ENTITY_DESCRIPTORS.power!);
}

export function findBatteryLevelEntity(subDevice: SubDevice): string | null {
  return findSubDeviceEntity(subDevice, ENTITY_DESCRIPTORS.soc!);
}

export function findBatterySoeEntity(subDevice: SubDevice): string | null {
  return findSubDeviceEntity(subDevice, ENTITY_DESCRIPTORS.soe!);
}

export function findBatteryCapacityEntity(subDevice: SubDevice): string | null {
  return findSubDeviceEntity(subDevice, ENTITY_DESCRIPTORS.capacity!);
}
