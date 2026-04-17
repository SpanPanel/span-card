const LIST_COLUMNS_KEY = "span_panel_list_columns";

/**
 * Read the user's preferred number of list-view columns from
 * localStorage. Returns 1 when the setting is unset or invalid so the
 * list falls back to the historical single-column stack.
 */
export function loadListColumns(): number {
  try {
    const raw = localStorage.getItem(LIST_COLUMNS_KEY);
    if (!raw) return 1;
    const n = parseInt(raw, 10);
    if (n === 1 || n === 2 || n === 3) return n;
    return 1;
  } catch {
    return 1;
  }
}

/** Persist the user's preferred number of list-view columns. */
export function saveListColumns(n: number): void {
  try {
    localStorage.setItem(LIST_COLUMNS_KEY, String(n));
  } catch {
    // non-fatal
  }
}
