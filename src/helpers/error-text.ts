import type { HomeAssistant } from "../types.js";

/**
 * The text of a rejection. Home Assistant's websocket rejects with a plain
 * `{ code, message }` object rather than an `Error`, which `String()` turns
 * into "[object Object]".
 */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err && typeof err.message === "string") return err.message;
  return String(err);
}

/** Home Assistant's prefix on a ServiceValidationError's message, which says nothing to a user. */
const VALIDATION_PREFIX = "Validation error: ";

/** One string field of a rejection object, or undefined. */
function field(err: unknown, name: string): unknown {
  return typeof err === "object" && err !== null && name in err ? (err as Record<string, unknown>)[name] : undefined;
}

/** A rejection's translation placeholders, kept only where each is text or a number. */
function placeholders(err: unknown): Record<string, string | number> {
  const raw = field(err, "translation_placeholders");
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(raw)) if (typeof value === "string" || typeof value === "number") out[key] = value;
  return out;
}

/**
 * What to tell a user of a service call the integration refused. Home Assistant
 * hands the refusal over with its translation key and placeholders, and its
 * message in the server's language prefixed "Validation error: ". The message is
 * localised from `domain`'s exception translations, loaded as the frontend loads
 * them; where those cannot be had or hold no such key, it is the service's own
 * message without the prefix; where there is none, `fallback`.
 */
export async function serviceErrorMessage(hass: HomeAssistant | null, err: unknown, domain: string, fallback: string): Promise<string> {
  const key = field(err, "translation_key");
  if (hass && typeof key === "string" && field(err, "translation_domain") === domain) {
    const path = `component.${domain}.exceptions.${key}.message`;
    try {
      const localize = hass.loadBackendTranslation ? await hass.loadBackendTranslation("exceptions", domain) : hass.localize;
      const text = localize?.(path, placeholders(err));
      if (text) return text;
    } catch {
      // The translation could not be loaded; the message says it in the server's language.
    }
  }
  const detail = errorText(err);
  const message = detail.startsWith(VALIDATION_PREFIX) ? detail.slice(VALIDATION_PREFIX.length) : detail;
  return message && message !== "[object Object]" ? message : fallback;
}
