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
