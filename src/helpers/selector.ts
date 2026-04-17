/**
 * Escape a value for safe use inside a CSS attribute selector string.
 * Circuit UUIDs and HA entity IDs are hex/alphanumeric in practice, but
 * the Favorites view's composite ids use ``|`` as a separator and any
 * user-surfaced identifier could in principle contain characters that
 * need escaping. Using ``CSS.escape`` keeps ``querySelector`` calls
 * correct regardless of what the identifier actually contains.
 */
export function attrSelectorValue(value: string): string {
  if (typeof (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS?.escape === "function") {
    return CSS.escape(value);
  }
  // Minimal fallback: escape the characters that are unsafe inside
  // a double-quoted attribute selector. Production browsers ship CSS.escape.
  return value.replace(/["\\]/g, "\\$&");
}
