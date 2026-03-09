import { INTEGRATION_DOMAIN } from "../constants.js";

// ── Primary discovery via custom WebSocket API ───────────────────────────────

export async function discoverTopology(hass, deviceId) {
  const topology = await hass.callWS({
    type: `${INTEGRATION_DOMAIN}/panel_topology`,
    device_id: deviceId,
  });

  const panelSize = topology.panel_size || panelSizeFromCircuits(topology.circuits);
  if (!panelSize) {
    throw new Error("Topology response missing panel_size and no circuits found. Update the SPAN Panel integration.");
  }

  const devices = await hass.callWS({ type: "config/device_registry/list" });
  const panelDevice = devices.find(d => d.id === deviceId) || null;

  return { topology, panelDevice, panelSize };
}

// ── Backward-compatible panel size derivation ────────────────────────────────

function panelSizeFromCircuits(circuits) {
  let maxTab = 0;
  for (const circuit of Object.values(circuits || {})) {
    for (const tab of circuit.tabs || []) {
      if (tab > maxTab) maxTab = tab;
    }
  }
  return maxTab > 0 ? maxTab + (maxTab % 2) : 0;
}

// ── Fallback discovery from entity registry ──────────────────────────────────

export async function discoverEntitiesFallback(hass, deviceId) {
  const [devices, entities] = await Promise.all([hass.callWS({ type: "config/device_registry/list" }), hass.callWS({ type: "config/entity_registry/list" })]);

  const panelDevice = devices.find(d => d.id === deviceId) || null;
  if (!panelDevice) return { topology: null, panelDevice: null, panelSize: 0 };

  const allEntities = entities.filter(e => e.device_id === deviceId);
  const subDevices = devices.filter(d => d.via_device_id === deviceId);
  const subDeviceIds = new Set(subDevices.map(d => d.id));
  const subEntities = entities.filter(e => subDeviceIds.has(e.device_id));

  const circuits = {};
  const devName = panelDevice.name_by_user || panelDevice.name || "";

  for (const ent of [...allEntities, ...subEntities]) {
    const state = hass.states[ent.entity_id];
    if (!state || !state.attributes || !state.attributes.tabs) continue;

    const tabsAttr = state.attributes.tabs;
    if (!tabsAttr || !tabsAttr.startsWith("tabs [")) continue;
    const content = tabsAttr.slice(6, -1);
    let tabs;
    if (content.includes(":")) {
      tabs = content.split(":").map(Number);
    } else {
      tabs = [Number(content)];
    }
    if (!tabs.every(Number.isFinite)) continue;

    const uidParts = ent.unique_id.split("_");
    let circuitUuid = null;
    for (let i = 2; i < uidParts.length - 1; i++) {
      if (uidParts[i].length >= 16 && /^[a-f0-9]+$/i.test(uidParts[i])) {
        circuitUuid = uidParts[i];
        break;
      }
    }
    if (!circuitUuid) continue;

    let displayName = state.attributes.friendly_name || ent.entity_id;
    for (const suffix of [" Power", " Consumed Energy", " Produced Energy"]) {
      if (displayName.endsWith(suffix)) {
        displayName = displayName.slice(0, -suffix.length);
        break;
      }
    }
    if (devName && displayName.startsWith(devName + " ")) {
      displayName = displayName.slice(devName.length + 1);
    }

    const base = ent.entity_id.replace(/^sensor\./, "").replace(/_power$/, "");

    circuits[circuitUuid] = {
      tabs,
      name: displayName,
      voltage: state.attributes.voltage || (tabs.length === 2 ? 240 : 120),
      device_type: state.attributes.device_type || "circuit",
      relay_state: state.attributes.relay_state || "UNKNOWN",
      is_user_controllable: true,
      breaker_rating_a: null,
      entities: {
        power: ent.entity_id,
        switch: `switch.${base}_breaker`,
        breaker_rating: `sensor.${base}_breaker_rating`,
      },
    };
  }

  let serial = "";
  if (panelDevice.identifiers) {
    for (const pair of panelDevice.identifiers) {
      if (pair[0] === INTEGRATION_DOMAIN) serial = pair[1];
    }
  }

  let panelSize = 0;
  for (const ent of allEntities) {
    const state = hass.states[ent.entity_id];
    if (state && state.attributes && state.attributes.panel_size) {
      panelSize = state.attributes.panel_size;
      break;
    }
  }
  if (!panelSize) {
    panelSize = panelSizeFromCircuits(circuits);
  }
  if (!panelSize) {
    throw new Error("Could not determine panel_size. No circuits found and no panel_size attribute. Update the SPAN Panel integration.");
  }

  const subDeviceMap = {};
  for (const sub of subDevices) {
    const subEnts = entities.filter(e => e.device_id === sub.id);
    const isBess = (sub.model || "").toLowerCase().includes("battery") || (sub.identifiers || []).some(p => (p[1] || "").toLowerCase().includes("bess"));
    const isEvse = (sub.model || "").toLowerCase().includes("drive") || (sub.identifiers || []).some(p => (p[1] || "").toLowerCase().includes("evse"));

    const entMap = {};
    for (const e of subEnts) {
      entMap[e.entity_id] = {
        domain: e.entity_id.split(".")[0],
        original_name: hass.states[e.entity_id]?.attributes?.friendly_name || e.entity_id,
      };
    }

    subDeviceMap[sub.id] = {
      name: sub.name_by_user || sub.name || "",
      type: isBess ? "bess" : isEvse ? "evse" : "unknown",
      entities: entMap,
    };
  }

  const topology = {
    serial,
    firmware: panelDevice.sw_version || "",
    panel_size: panelSize,
    device_id: deviceId,
    device_name: panelDevice.name_by_user || panelDevice.name || "SPAN Panel",
    circuits,
    sub_devices: subDeviceMap,
  };

  return { topology, panelDevice, panelSize };
}
