import { describe, it, expect, afterEach, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTROLS_OPERABLE,
  ControlChangeRefused,
  circuitControlAccess,
  controlAccess,
  controlAccessHint,
  controlNoteHTML,
  controlWrites,
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
const READ_ONLY_HINT = "Your Home Assistant account can't operate this panel's controls.";

/** The card's source files, by their path under `src/`. The path is taken apart by hand: happy-dom's `URL` reads no file URL. */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const SOURCES: ReadonlyArray<readonly [string, string]> = readdirSync(SRC, { recursive: true, encoding: "utf8" })
  .filter(path => path.endsWith(".ts"))
  .map(path => [path.split(sep).join("/"), readFileSync(join(SRC, path), "utf8")] as const);

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

function favorites(refs: Record<string, FavoriteRef>): FavoritesTopology {
  return { circuits: {}, _favoriteRefs: refs } as unknown as FavoritesTopology;
}

function circuitRef(panelDeviceId: string, access?: ControlAccess): FavoriteRef {
  return { panelDeviceId, kind: "circuit", targetId: "kitchen", configEntryId: `entry-${panelDeviceId}`, ...(access ? { controlAccess: access } : {}) };
}

afterEach(() => {
  setLanguage("en");
  vi.restoreAllMocks();
});

describe("the services that change a panel's controls", () => {
  it.each(CONTROL_SERVICES)("%s is named nowhere in the card's source but the module that sends it only where the user may", service => {
    // Quoted, as a service is named; a name with an underscore also bare, which nothing else in the card is called. "toggle" bare is a class name.
    const named = new RegExp(service.includes("_") ? `(["'\`])${service}\\1|\\b${service}\\b(?!_)` : `(["'\`])${service}\\1`);
    const naming = SOURCES.filter(([, text]) => named.test(text)).map(([path]) => path);
    expect(naming).toEqual(SENT.has(service) ? [ACCESS_MODULE] : []);
  });

  it("are sent to no switch, select or lock but by the module", () => {
    const sendsTo = /callService\(\s*["'](switch|select|lock)["']|domain:\s*["'](switch|select|lock)["']/;
    expect(SOURCES.filter(([, text]) => sendsTo.test(text)).map(([path]) => path)).toEqual([]);
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

  it("are refused where there is no Home Assistant yet to send them to", async () => {
    for (const err of await refusalsOf(controlWrites(null, CONTROLS_OPERABLE))) expect(err).toBeInstanceOf(ControlChangeRefused);
  });

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

  it("is the circuit's own panel's in the Favorites view, and operable where that is not known", () => {
    const merged = favorites({
      "panel-1|kitchen": circuitRef("panel-1", ADMIN_ONLY),
      "panel-2|kitchen": circuitRef("panel-2", CONTROLS_OPERABLE),
      "panel-3|kitchen": circuitRef("panel-3"),
    });
    expect(circuitControlAccess(merged, "panel-1|kitchen")).toEqual(ADMIN_ONLY);
    expect(circuitControlAccess(merged, "panel-2|kitchen")).toEqual(CONTROLS_OPERABLE);
    expect(circuitControlAccess(merged, "panel-3|kitchen")).toEqual(CONTROLS_OPERABLE);
    expect(circuitControlAccess(merged, "panel-9|gone")).toEqual(CONTROLS_OPERABLE);
  });
});

describe("viewControlAccess", () => {
  it("is the panel's for a panel's own view", () => {
    expect(viewControlAccess(topology({ may_operate: false, reason: "control_disabled" }))).toEqual(SWITCHED_OFF);
    expect(viewControlAccess(topology())).toEqual(CONTROLS_OPERABLE);
  });

  it("is operable in the Favorites view where the user may operate any favorite's panel", () => {
    expect(viewControlAccess(favorites({ a: circuitRef("panel-1", ADMIN_ONLY), b: circuitRef("panel-2", CONTROLS_OPERABLE) }))).toEqual(CONTROLS_OPERABLE);
    expect(viewControlAccess(favorites({}))).toEqual(CONTROLS_OPERABLE);
  });

  it("is not operable in the Favorites view where the user may operate none, saying why as the first panel does", () => {
    expect(viewControlAccess(favorites({ a: circuitRef("panel-1", SWITCHED_OFF), b: circuitRef("panel-2", ADMIN_ONLY) }))).toEqual(SWITCHED_OFF);
  });

  it("leaves a favorite sub-device, which has no relay, out of it", () => {
    const subDevice: FavoriteRef = { panelDeviceId: "panel-2", kind: "sub_device", targetId: "bess", configEntryId: "entry-2" };
    expect(viewControlAccess(favorites({ a: circuitRef("panel-1", ADMIN_ONLY), b: subDevice }))).toEqual(ADMIN_ONLY);
  });
});

describe("why controls cannot be operated", () => {
  it("is nothing where they can", () => {
    expect(controlAccessHint(CONTROLS_OPERABLE)).toBe("");
    expect(controlNoteHTML(CONTROLS_OPERABLE)).toBe("");
  });

  it.each([
    ["en", ADMIN_ONLY_HINT],
    ["es", "Solo un administrador puede operar los controles de este panel."],
    ["fr", "Seul un administrateur peut utiliser les commandes de ce panneau."],
    ["ja", "このパネルのコントロールを操作できるのは管理者のみです。"],
    ["pt", "Somente um administrador pode operar os controles deste painel."],
  ])("is said in the user's language (%s)", (language, text) => {
    setLanguage(language);
    expect(controlAccessHint(ADMIN_ONLY)).toBe(text);
  });

  it.each([
    ["en", READ_ONLY_HINT],
    ["es", "Su cuenta de Home Assistant no puede operar los controles de este panel."],
    ["fr", "Votre compte Home Assistant ne peut pas utiliser les commandes de ce panneau."],
    ["ja", "お使いのHome Assistantアカウントでは、このパネルのコントロールを操作できません。"],
    ["pt", "Sua conta do Home Assistant não pode operar os controles deste painel."],
  ])("is said for a read-only account in the user's language (%s)", (language, text) => {
    setLanguage(language);
    expect(controlAccessHint(READ_ONLY)).toBe(text);
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

  async function reported(hass: HomeAssistant | null, err: unknown, control: "relay" | "priority"): Promise<Array<[string, string, string]>> {
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
    expect(await reported(null, err, "priority")).toEqual([["service:shedding", "error", "Only a Home Assistant administrator may operate this SPAN panel."]]);
  });

  it("says why the card sent nothing", async () => {
    expect(await reported(null, new ControlChangeRefused(ADMIN_ONLY), "relay")).toEqual([["service:relay", "error", ADMIN_ONLY_HINT]]);
  });

  it("says the change could not be made where nothing says why", async () => {
    expect(await reported(null, {}, "relay")).toEqual([["service:relay", "error", "Unable to toggle relay"]]);
    expect(await reported(null, {}, "priority")).toEqual([["service:shedding", "error", "Unable to update shedding priority"]]);
  });
});
