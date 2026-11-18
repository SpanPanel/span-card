import { describe, it, expect, afterEach, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTROLS_NOT_KNOWN,
  CONTROLS_OPERABLE,
  ControlChangeRefused,
  circuitControlAccess,
  controlAccess,
  controlAccessHint,
  controlNoteHTML,
  controlWrites,
  favoritesPanelAccess,
  reportControlFailure,
  titleControl,
  viewControlAccess,
  type ControlWrites,
} from "../src/core/control-access.js";
import { ErrorStore } from "../src/core/error-store.js";
import { setLanguage } from "../src/i18n.js";
import type { ControlAccess, FavoriteRef, FavoritesTopology, HomeAssistant, PanelTopology } from "../src/types.js";

type Message = Record<string, unknown>;

/**
 * Every service of Home Assistant's that changes a relay, a shedding priority or
 * the control lock, each of which a switch or a select of the integration's
 * takes. The card sends only the first three.
 */
const CONTROL_SERVICES = ["turn_on", "turn_off", "toggle", "select_option", "select_next", "select_previous", "select_first", "select_last"] as const;

/** The ones the card sends. */
const SENT: ReadonlySet<string> = new Set(["turn_on", "turn_off", "select_option"]);

/** The module that alone sends them, each only where the user may operate the panel's controls. */
const ACCESS_MODULE = "core/control-access.ts";

const ADMIN_ONLY: ControlAccess = { mayOperate: false, reason: "admin_only" };
const SWITCHED_OFF: ControlAccess = { mayOperate: false, reason: "control_disabled" };
const READ_ONLY: ControlAccess = { mayOperate: false, reason: "read_only" };
const ADMIN_ONLY_HINT = "Only an administrator can operate this panel's controls.";

/** Every controls key, as each locale says it. */
const HINTS_BY_LANGUAGE: Record<string, Record<string, string>> = {
  en: {
    "controls.admin_only": "Only an administrator can operate this panel's controls.",
    "controls.disabled": "Control of this panel is switched off in its options.",
    "controls.read_only": "Your Home Assistant account can't operate this panel's controls.",
    "controls.entity_unauthorized": "Your Home Assistant account can't operate this control.",
    "controls.not_operable": "You can't operate this panel's controls.",
  },
  es: {
    "controls.admin_only": "Solo un administrador puede operar los controles de este panel.",
    "controls.disabled": "El control de este panel está desactivado en sus opciones.",
    "controls.read_only": "Su cuenta de Home Assistant no puede operar los controles de este panel.",
    "controls.entity_unauthorized": "Su cuenta de Home Assistant no puede operar este control.",
    "controls.not_operable": "No puede operar los controles de este panel.",
  },
  fr: {
    "controls.admin_only": "Seul un administrateur peut utiliser les commandes de ce panneau.",
    "controls.disabled": "La commande de ce panneau est désactivée dans ses options.",
    "controls.read_only": "Votre compte Home Assistant ne peut pas utiliser les commandes de ce panneau.",
    "controls.entity_unauthorized": "Votre compte Home Assistant ne peut pas utiliser cette commande.",
    "controls.not_operable": "Vous ne pouvez pas utiliser les commandes de ce panneau.",
  },
  ja: {
    "controls.admin_only": "このパネルのコントロールを操作できるのは管理者のみです。",
    "controls.disabled": "このパネルのコントロールはオプションで無効になっています。",
    "controls.read_only": "お使いのHome Assistantアカウントでは、このパネルのコントロールを操作できません。",
    "controls.entity_unauthorized": "お使いのHome Assistantアカウントでは、このコントロールを操作できません。",
    "controls.not_operable": "このパネルのコントロールは操作できません。",
  },
  pt: {
    "controls.admin_only": "Somente um administrador pode operar os controles deste painel.",
    "controls.disabled": "O controle deste painel está desativado nas suas opções.",
    "controls.read_only": "Sua conta do Home Assistant não pode operar os controles deste painel.",
    "controls.entity_unauthorized": "Sua conta do Home Assistant não pode operar este controle.",
    "controls.not_operable": "Você não pode operar os controles deste painel.",
  },
};
const READ_ONLY_HINT = "Your Home Assistant account can't operate this panel's controls.";

/** The card's source files, by their path under `src/`. The path is taken apart by hand: happy-dom's `URL` reads no file URL. */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const SOURCES: ReadonlyArray<readonly [string, string]> = readdirSync(SRC, { recursive: true, encoding: "utf8" })
  .filter(path => path.endsWith(".ts"))
  .map(path => [path.split(sep).join("/"), readFileSync(join(SRC, path), "utf8")] as const);

/** The index of the brace that opens the object literal holding `at` in `text`, or -1. */
function openingBrace(text: string, at: number): number {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    if (text[i] === "}") depth++;
    else if (text[i] === "{") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/** The index of the brace that closes the one opening at `open` in `text`, or the text's end. */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  return text.length - 1;
}

/**
 * Each `call_service` message in `text`, as the object literal that holds it:
 * a `type` of `call_service`, its key bare or quoted and its value in any quotes.
 */
function callServiceMessages(text: string): string[] {
  return [...text.matchAll(/["'`]?type["'`]?\s*:\s*["'`]call_service["'`]/g)].map(match => {
    const open = openingBrace(text, match.index);
    return open < 0 ? match[0] : text.slice(open, closingBrace(text, open) + 1);
  });
}

/** Whether a `call_service` message names one domain, and that the integration's, as `domain: INTEGRATION_DOMAIN`. */
function namesIntegrationDomain(message: string): boolean {
  const domains = message.match(/["'`]?\bdomain["'`]?\s*:/g) ?? [];
  return domains.length === 1 && /(^|[\s{,])domain:\s*INTEGRATION_DOMAIN\s*[,}\n]/.test(message);
}

/**
 * Whether `text` names service `service`: quoted, as a service is named, alone or
 * after its domain or a REST path (`"switch.toggle"`, `"services/switch/toggle"`).
 * A name with an underscore is matched bare too, which nothing else in the card
 * is called; "toggle" bare is a class name and a DOM method.
 */
function namesService(service: string, text: string): boolean {
  const quoted = `["'\`./]${service}["'\`]`;
  return new RegExp(service.includes("_") ? `${quoted}|\\b${service}\\b(?!_)` : quoted).test(text);
}

/**
 * Each way `text` could send a service call that the guard does not see the
 * domain of. `call_service` may appear only as a message's `type`, so a message
 * built from a constant is seen; a message may hold no spread, which could
 * bring a domain in; and outside the controls module (`ownDomains` false) its
 * one domain is `INTEGRATION_DOMAIN`. Home Assistant's other ways to call a
 * service, `callService`, `callApi` and the `execute_script` command, appear
 * nowhere. A message changed after it is built is not seen.
 */
function unguardedSends(text: string, ownDomains = false): string[] {
  const reasons: string[] = [];
  const messages = callServiceMessages(text);
  if ((text.match(/call_service/g) ?? []).length !== messages.length) reasons.push("call_service named other than as a message's type");
  for (const message of messages) {
    if (message.includes("...")) reasons.push(`a spread in ${message.slice(0, 60)}`);
    if (!ownDomains && !namesIntegrationDomain(message)) reasons.push(`a domain not the integration's in ${message.slice(0, 60)}`);
  }
  if (/\.callService\(/.test(text)) reasons.push("callService");
  if (/\bcallApi\s*\(/.test(text)) reasons.push("callApi");
  if (/\bexecute_script\b/.test(text)) reasons.push("execute_script");
  return reasons;
}

/** A Home Assistant recording every message sent, which `answer` answers. */
function recording(answer: (msg: Message) => Promise<unknown> = async () => ({})): {
  hass: HomeAssistant;
  sent: Message[];
  callService: ReturnType<typeof vi.fn>;
} {
  const sent: Message[] = [];
  const callService = vi.fn(async () => undefined);
  const callWS = vi.fn(async (msg: Message): Promise<unknown> => {
    sent.push(msg);
    return answer(msg);
  });
  const hass = { states: {}, services: {}, language: "en", callService, callWS } as unknown as HomeAssistant;
  return { hass, sent, callService };
}

/** Each change `writes` offers, made once. */
async function makeEach(writes: ControlWrites): Promise<void> {
  await writes.setRelay("switch.kitchen_breaker", true);
  await writes.setRelay("switch.kitchen_breaker", false);
  await writes.setPriority("select.kitchen_circuit_priority", "off_grid");
}

/** Each change `writes` offers, each awaited to its refusal. */
async function refusalsOf(writes: ControlWrites): Promise<unknown[]> {
  const attempts = [writes.setRelay("switch.kitchen_breaker", true), writes.setRelay("switch.kitchen_breaker", false), writes.setPriority("select.x", "never")];
  return Promise.all(
    attempts.map(attempt =>
      attempt.then(
        () => null,
        (err: unknown) => err
      )
    )
  );
}

function topology(control_access?: unknown): PanelTopology {
  return { circuits: {}, ...(control_access === undefined ? {} : { control_access }) } as unknown as PanelTopology;
}

function favorites(refs: Record<string, FavoriteRef>, circuits: Record<string, unknown> = {}): FavoritesTopology {
  return { circuits, _favoriteRefs: refs } as unknown as FavoritesTopology;
}

function circuitRef(panelDeviceId: string, access: ControlAccess): FavoriteRef {
  return { panelDeviceId, kind: "circuit", targetId: "kitchen", configEntryId: `entry-${panelDeviceId}`, controlAccess: access };
}

/** Home Assistant's Unauthorized, in each shape it reaches the frontend: from a service, for a user it does not know, and from the websocket command. */
const UNAUTHORIZED = [
  { code: "home_assistant_error", message: "Unauthorized" },
  { code: "home_assistant_error", message: "UnknownUser" },
  { code: "unauthorized", message: "Unauthorized" },
] as const;

/** A Home Assistant with no exception translations to load, so a refusal says what its message says. */
const NO_TRANSLATIONS = {} as HomeAssistant;

afterEach(() => {
  setLanguage("en");
  vi.restoreAllMocks();
});

describe("the services that change a panel's controls", () => {
  it.each(CONTROL_SERVICES)("%s is named nowhere in the card's source but the module that sends it only where the user may", service => {
    const naming = SOURCES.filter(([, text]) => namesService(service, text)).map(([path]) => path);
    expect(naming).toEqual(SENT.has(service) ? [ACCESS_MODULE] : []);
  });

  it.each([
    ["quoted", `service: "toggle"`, true],
    ["after its domain", `service: "switch.toggle"`, true],
    ["in a REST path", `callApi("POST", "services/switch/toggle")`, true],
    ["as a class list's method", `pill.classList.toggle("toggle-on", isOn)`, false],
    ["inside a class name", `class="monitoring-toggle"`, false],
  ])("would see toggle named %s, and only as a service", (_how, text, named) => {
    expect(namesService("toggle", text)).toBe(named);
  });

  it("are never sent through Home Assistant's callService, which the card calls nowhere", () => {
    expect(SOURCES.filter(([, text]) => /\.callService\(/.test(text)).map(([path]) => path)).toEqual([]);
    // Named only where the frontend's type declares it, so no alias or destructured copy of it is called either.
    expect(SOURCES.filter(([, text]) => /\bcallService\b/.test(text)).map(([path]) => path)).toEqual(["types.ts"]);
  });

  it("are sent by no service call but the module's: every other call_service message is the integration's own", () => {
    const strays = SOURCES.flatMap(([path, text]) => unguardedSends(text, path === ACCESS_MODULE).map(reason => `${path}: ${reason}`));
    expect(strays).toEqual([]);
    // The module's sends are found the same way, so the scan sees a message wherever one is.
    expect(callServiceMessages(SOURCES.find(([path]) => path === ACCESS_MODULE)![1])).toHaveLength(1);
  });

  it.each([
    ["a domain held in a variable", `hass.callWS({ type: "call_service", domain, service: "turn_on" })`],
    ["a quoted domain key", `hass.callWS({ "type": "call_service", "domain": "switch", "service": "turn_on" })`],
    ["a domain in backticks", "hass.callWS({ type: `call_service`, domain: `switch`, service: x })"],
    ["a second domain after the integration's", `hass.callWS({ type: "call_service", domain: INTEGRATION_DOMAIN, service, "domain": "select" })`],
    ["its type held in a constant", `const KIND = "call_service";\nhass.callWS({ type: KIND, domain: "switch", service: "turn_on" })`],
    ["a spread, which can bring a domain in", `hass.callWS({ type: "call_service", domain: INTEGRATION_DOMAIN, ...overrides })`],
    ["a script run for it", `hass.callWS({ type: "execute_script", sequence: [{ action: next }] })`],
    ["the REST API", `hass.callApi("POST", path, data)`],
    ["Home Assistant's callService", `hass.callService(domain, service, data)`],
  ])("would find a service call sent with %s", (_what, source) => {
    expect(unguardedSends(source)).not.toEqual([]);
  });

  it("would let a call_service message to the integration pass", () => {
    const source = `hass.callWS({\n  type: "call_service",\n  domain: INTEGRATION_DOMAIN,\n  service: "get_favorites",\n  service_data: { config_entry_id: id },\n})`;
    expect(unguardedSends(source)).toEqual([]);
  });

  it("are each sent by one of the module's changes, over the websocket alone, where the user may operate the controls", async () => {
    const { hass, sent, callService } = recording();
    await makeEach(controlWrites(hass, CONTROLS_OPERABLE));

    expect(sent).toEqual([
      { type: "call_service", domain: "switch", service: "turn_on", service_data: {}, target: { entity_id: "switch.kitchen_breaker" } },
      { type: "call_service", domain: "switch", service: "turn_off", service_data: {}, target: { entity_id: "switch.kitchen_breaker" } },
      {
        type: "call_service",
        domain: "select",
        service: "select_option",
        service_data: { option: "off_grid" },
        target: { entity_id: "select.kitchen_circuit_priority" },
      },
    ]);
    expect(callService).not.toHaveBeenCalled();
  });

  it("are sent within the call, as calling the service directly sends one", () => {
    const { hass, sent } = recording();
    void controlWrites(hass, CONTROLS_OPERABLE).setRelay("switch.kitchen_breaker", false);
    expect(sent.map(msg => msg.service)).toEqual(["turn_off"]);
  });

  it.each([
    ["only an administrator may", ADMIN_ONLY, ADMIN_ONLY_HINT],
    ["control is switched off in the panel's options", SWITCHED_OFF, "Control of this panel is switched off in its options."],
    ["the user's Home Assistant permissions do not let them control the panel's entities", READ_ONLY, READ_ONLY_HINT],
    ["the integration gives no reason", { mayOperate: false, reason: null } satisfies ControlAccess, "You can't operate this panel's controls."],
  ])("are refused, with nothing sent, where %s, saying why", async (_where, access, why) => {
    const { hass, sent } = recording();
    const refusals = await refusalsOf(controlWrites(hass, access));
    for (const err of refusals) {
      expect(err).toBeInstanceOf(ControlChangeRefused);
      expect((err as Error).message).toBe(why);
    }
    expect(sent).toEqual([]);
  });

  it.each(UNAUTHORIZED)(
    "take Home Assistant's refusal for this one entity ($code, $message), whose English says nothing more, as the card's own, in the user's language",
    async refusal => {
      const { hass } = recording(async () => Promise.reject(refusal));
      setLanguage("pt");
      const sending = controlWrites(hass, CONTROLS_OPERABLE).setRelay("switch.kitchen_breaker", true);
      await expect(sending).rejects.toBeInstanceOf(ControlChangeRefused);
      await expect(sending).rejects.toThrow("Sua conta do Home Assistant não pode operar este controle.");
    }
  );

  it("pass on the integration's refusal as it gave it", async () => {
    const refusal = {
      code: "service_validation_error",
      message: "Validation error: locked",
      translation_domain: "span_panel",
      translation_key: "control_locked",
    };
    const { hass } = recording(async () => Promise.reject(refusal));
    await expect(controlWrites(hass, CONTROLS_OPERABLE).setRelay("switch.kitchen_breaker", true)).rejects.toBe(refusal);
  });
});

describe("controlAccess", () => {
  it("takes the controls as operable where the integration says nothing of them, as an older one and entity discovery do", () => {
    expect(controlAccess(topology())).toEqual(CONTROLS_OPERABLE);
    expect(controlAccess(null)).toEqual(CONTROLS_OPERABLE);
    expect(controlAccess(undefined)).toEqual(CONTROLS_OPERABLE);
  });

  it("takes the controls as operable where what it says cannot be read", () => {
    for (const wire of [null, "no", 0, {}, { may_operate: "false" }, { reason: "admin_only" }])
      expect(controlAccess(topology(wire))).toEqual(CONTROLS_OPERABLE);
  });

  it("is operable where the integration says the user may operate the controls", () => {
    expect(controlAccess(topology({ may_operate: true, reason: null }))).toEqual(CONTROLS_OPERABLE);
  });

  it("takes may_operate as the authority, whatever reason comes beside it", () => {
    expect(controlAccess(topology({ may_operate: true, reason: "admin_only" }))).toEqual(CONTROLS_OPERABLE);
    expect(controlAccess(topology({ may_operate: true, reason: "a_later_reason" }))).toEqual(CONTROLS_OPERABLE);
  });

  it.each([
    ["admin_only", "admin_only"],
    ["control_disabled", "control_disabled"],
    ["read_only", "read_only"],
    [null, null],
    ["a reason it does not know", null],
  ])("is not operable where the integration says the user may not, with the reason %s", (reason, read) => {
    expect(controlAccess(topology({ may_operate: false, reason }))).toEqual({ mayOperate: false, reason: read });
  });
});

describe("circuitControlAccess", () => {
  it("is the panel's in a panel's own topology", () => {
    expect(circuitControlAccess(topology({ may_operate: false, reason: "admin_only" }), "kitchen")).toEqual(ADMIN_ONLY);
    expect(circuitControlAccess(topology(), "kitchen")).toEqual(CONTROLS_OPERABLE);
  });

  it("is the circuit's own panel's in the Favorites view", () => {
    const merged = favorites({ "panel-1|kitchen": circuitRef("panel-1", ADMIN_ONLY), "panel-2|kitchen": circuitRef("panel-2", CONTROLS_OPERABLE) });
    expect(circuitControlAccess(merged, "panel-1|kitchen")).toEqual(ADMIN_ONLY);
    expect(circuitControlAccess(merged, "panel-2|kitchen")).toEqual(CONTROLS_OPERABLE);
  });

  it("is not operable in the Favorites view for a circuit with no circuit ref, which has no panel to say", () => {
    const subDevice: FavoriteRef = { panelDeviceId: "panel-2", kind: "sub_device", targetId: "bess", configEntryId: "entry-2" };
    const merged = favorites({ "panel-1|kitchen": circuitRef("panel-1", CONTROLS_OPERABLE), "panel-2|bess": subDevice });
    expect(circuitControlAccess(merged, "panel-9|gone")).toEqual(CONTROLS_NOT_KNOWN);
    expect(circuitControlAccess(merged, "panel-2|bess")).toEqual(CONTROLS_NOT_KNOWN);
    expect(CONTROLS_NOT_KNOWN.mayOperate).toBe(false);
  });
});

/** Favorited circuits by what they draw: a relay switch, a priority select, only a reading, or a switch the user may not control. */
const RELAY = { name: "Relay", tabs: [1], entities: { switch: "switch.relay" } };
const PRIORITY = { name: "Priority", tabs: [2], entities: { select: "select.priority" } };
const METERED = { name: "Metered", tabs: [3], entities: { power: "sensor.metered_power" } };
const LOCKED = { ...RELAY, is_user_controllable: false };

describe("favoritesPanelAccess", () => {
  it("is each panel the view draws a relay or a priority control of, with its access", () => {
    const merged = favorites({ a: circuitRef("panel-1", ADMIN_ONLY), b: circuitRef("panel-2", CONTROLS_OPERABLE) }, { a: RELAY, b: PRIORITY });
    expect([...favoritesPanelAccess(merged)]).toEqual([
      ["panel-1", ADMIN_ONLY],
      ["panel-2", CONTROLS_OPERABLE],
    ]);
  });

  it("leaves out a panel whose favorites draw no such control: only sub-devices, metered circuits, or a switch the user may not control", () => {
    const subDevice: FavoriteRef = { panelDeviceId: "panel-3", kind: "sub_device", targetId: "bess", configEntryId: "entry-3" };
    const merged = favorites(
      { a: circuitRef("panel-1", ADMIN_ONLY), b: circuitRef("panel-2", ADMIN_ONLY), c: subDevice, d: circuitRef("panel-4", SWITCHED_OFF) },
      { a: METERED, b: LOCKED, d: RELAY }
    );
    expect([...favoritesPanelAccess(merged)]).toEqual([["panel-4", SWITCHED_OFF]]);
  });
});

describe("viewControlAccess", () => {
  it("is the panel's for a panel's own view", () => {
    expect(viewControlAccess(topology({ may_operate: false, reason: "control_disabled" }))).toEqual(SWITCHED_OFF);
    expect(viewControlAccess(topology())).toEqual(CONTROLS_OPERABLE);
  });

  it("is operable in the Favorites view where the user may operate any favorite's panel", () => {
    expect(viewControlAccess(favorites({ a: circuitRef("panel-1", ADMIN_ONLY), b: circuitRef("panel-2", CONTROLS_OPERABLE) }, { a: RELAY, b: RELAY }))).toEqual(
      CONTROLS_OPERABLE
    );
    expect(viewControlAccess(favorites({}))).toEqual(CONTROLS_OPERABLE);
  });

  it("is not operable in the Favorites view where the user may operate none, saying why as the first panel does", () => {
    expect(viewControlAccess(favorites({ a: circuitRef("panel-1", SWITCHED_OFF), b: circuitRef("panel-2", ADMIN_ONLY) }, { a: RELAY, b: RELAY }))).toEqual(
      SWITCHED_OFF
    );
  });

  it("leaves a favorite sub-device, which has no relay, out of it", () => {
    const subDevice: FavoriteRef = { panelDeviceId: "panel-2", kind: "sub_device", targetId: "bess", configEntryId: "entry-2" };
    expect(viewControlAccess(favorites({ a: circuitRef("panel-1", ADMIN_ONLY), b: subDevice }, { a: RELAY }))).toEqual(ADMIN_ONLY);
  });

  it("leaves out a panel whose favorites draw only a priority select, which the slider arms nothing of, though its note counts it", () => {
    const merged = favorites({ a: circuitRef("panel-1", CONTROLS_OPERABLE), b: circuitRef("panel-2", ADMIN_ONLY) }, { a: PRIORITY, b: RELAY });
    expect(viewControlAccess(merged)).toEqual(ADMIN_ONLY);
    expect([...favoritesPanelAccess(merged)]).toEqual([
      ["panel-1", CONTROLS_OPERABLE],
      ["panel-2", ADMIN_ONLY],
    ]);
  });

  it("leaves out a panel whose favorites draw no relay or priority, so its access arms nothing", () => {
    const merged = favorites({ a: circuitRef("panel-1", CONTROLS_OPERABLE), b: circuitRef("panel-2", ADMIN_ONLY) }, { a: METERED, b: RELAY });
    expect(viewControlAccess(merged)).toEqual(ADMIN_ONLY);
  });
});

describe("why controls cannot be operated", () => {
  it("is nothing where they can", () => {
    expect(controlAccessHint(CONTROLS_OPERABLE)).toBe("");
    expect(controlNoteHTML(CONTROLS_OPERABLE)).toBe("");
  });

  it.each(Object.entries(HINTS_BY_LANGUAGE))(
    "is said in the user's language, for every reason and the refusal for one entity (%s)",
    async (language, hints) => {
      setLanguage(language);
      expect(controlAccessHint(ADMIN_ONLY)).toBe(hints["controls.admin_only"]);
      expect(controlAccessHint(SWITCHED_OFF)).toBe(hints["controls.disabled"]);
      expect(controlAccessHint(READ_ONLY)).toBe(hints["controls.read_only"]);
      expect(controlAccessHint({ mayOperate: false, reason: null })).toBe(hints["controls.not_operable"]);
      const { hass } = recording(async () => Promise.reject(UNAUTHORIZED[0]));
      await expect(controlWrites(hass, CONTROLS_OPERABLE).setPriority("select.x", "never")).rejects.toThrow(hints["controls.entity_unauthorized"]);
    }
  );

  it("covers every one of the card's controls keys in that table", () => {
    const source = readFileSync(join(SRC, "i18n.ts"), "utf8");
    const keys = [...new Set([...source.matchAll(/"(controls\.[a-z_]+)"/g)].map(match => match[1]))].sort();
    for (const hints of Object.values(HINTS_BY_LANGUAGE)) expect(Object.keys(hints).sort()).toEqual(keys);
  });

  it("is the generic hint for a reason the card does not know, which reads as no reason", () => {
    const later = controlAccess(topology({ may_operate: false, reason: "a_later_reason" }));
    expect(later).toEqual({ mayOperate: false, reason: null });
    expect(controlAccessHint(later)).toBe("You can't operate this panel's controls.");
  });

  it("is a note, said once", () => {
    const host = document.createElement("div");
    host.innerHTML = controlNoteHTML(ADMIN_ONLY);
    const note = host.querySelector<HTMLElement>('[data-role="controls-note"]')!;
    expect(note.getAttribute("role")).toBe("note");
    expect(note.textContent).toBe(ADMIN_ONLY_HINT);
    expect(host.children).toHaveLength(1);
  });

  it("titles a control that cannot be operated, and leaves one that can untitled", () => {
    const control = document.createElement("select");
    titleControl(control, ADMIN_ONLY);
    expect(control.title).toBe(ADMIN_ONLY_HINT);
    titleControl(control, CONTROLS_OPERABLE);
    expect(control.hasAttribute("title")).toBe(false);
  });
});

describe("reportControlFailure", () => {
  /** A Home Assistant whose frontend loads the integration's exception translations as `messages`. */
  function translating(messages: Record<string, string>): HomeAssistant {
    return { loadBackendTranslation: async () => (key: string) => messages[key] ?? "" } as unknown as HomeAssistant;
  }

  async function reported(hass: HomeAssistant, err: unknown, control: "relay" | "priority"): Promise<Array<[string, string, string]>> {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errors = new ErrorStore();
    const add = vi.spyOn(errors, "add");
    reportControlFailure(hass, errors, err, control);
    await vi.waitFor(() => expect(add).toHaveBeenCalled());
    return add.mock.calls.map(([entry]) => [entry.key, entry.level, entry.message]);
  }

  it("says why as the control gate says it, in the user's language", async () => {
    const hass = translating({ "component.span_panel.exceptions.control_locked.message": "Le verrou de commande est armé." });
    const err = { code: "service_validation_error", message: "Validation error: locked", translation_domain: "span_panel", translation_key: "control_locked" };
    expect(await reported(hass, err, "relay")).toEqual([["service:relay", "error", "Le verrou de commande est armé."]]);
  });

  it("says why as the gate's message gives it, where its translation cannot be had", async () => {
    const err = {
      code: "service_validation_error",
      message: "Validation error: Only a Home Assistant administrator may operate this SPAN panel.",
      translation_domain: "span_panel",
      translation_key: "admin_only_control",
    };
    expect(await reported(NO_TRANSLATIONS, err, "priority")).toEqual([
      ["service:shedding", "error", "Only a Home Assistant administrator may operate this SPAN panel."],
    ]);
  });

  it("says why the card sent nothing", async () => {
    expect(await reported(NO_TRANSLATIONS, new ControlChangeRefused(ADMIN_ONLY_HINT), "relay")).toEqual([["service:relay", "error", ADMIN_ONLY_HINT]]);
  });

  it("says, in the user's language, that the account cannot operate this one control, for Home Assistant's Unauthorized", async () => {
    setLanguage("fr");
    const { hass } = recording(async () => Promise.reject(UNAUTHORIZED[2]));
    const err = await controlWrites(hass, CONTROLS_OPERABLE)
      .setRelay("switch.kitchen_breaker", false)
      .catch((refused: unknown) => refused);
    expect(await reported(hass, err, "relay")).toEqual([["service:relay", "error", "Votre compte Home Assistant ne peut pas utiliser cette commande."]]);
  });

  it("says the change could not be made where nothing says why", async () => {
    expect(await reported(NO_TRANSLATIONS, {}, "relay")).toEqual([["service:relay", "error", "Unable to toggle relay"]]);
    expect(await reported(NO_TRANSLATIONS, {}, "priority")).toEqual([["service:shedding", "error", "Unable to update shedding priority"]]);
  });
});
