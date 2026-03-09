// ── Entity descriptor table ──────────────────────────────────────────────────
//
// Each entry describes how to locate a specific sensor entity within a
// sub-device's entity map by matching on the friendly name or unique_id suffix.

const ENTITY_DESCRIPTORS = {
  power: { names: ["power", "battery power"], suffixes: ["_power"] },
  soc: { names: ["battery level", "battery percentage"], suffixes: ["_battery_level", "_battery_percentage"] },
  soe: { names: ["state of energy"], suffixes: ["_soe_kwh"] },
  capacity: { names: ["nameplate capacity"], suffixes: ["_nameplate_capacity"] },
};

function findSubDeviceEntity(subDevice, descriptor) {
  if (!subDevice.entities) return null;
  for (const [entityId, info] of Object.entries(subDevice.entities)) {
    if (info.domain !== "sensor") continue;
    const name = (info.original_name || "").toLowerCase();
    if (descriptor.names.some(n => name === n)) return entityId;
    if (info.unique_id && descriptor.suffixes.some(s => info.unique_id.endsWith(s))) return entityId;
  }
  return null;
}

export function findSubDevicePowerEntity(subDevice) {
  return findSubDeviceEntity(subDevice, ENTITY_DESCRIPTORS.power);
}

export function findBatteryLevelEntity(subDevice) {
  return findSubDeviceEntity(subDevice, ENTITY_DESCRIPTORS.soc);
}

export function findBatterySoeEntity(subDevice) {
  return findSubDeviceEntity(subDevice, ENTITY_DESCRIPTORS.soe);
}

export function findBatteryCapacityEntity(subDevice) {
  return findSubDeviceEntity(subDevice, ENTITY_DESCRIPTORS.capacity);
}
