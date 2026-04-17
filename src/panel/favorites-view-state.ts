const FAVORITES_VIEW_STATE_KEY = "span_panel_favorites_view_state";

export interface FavoritesViewState {
  activeTab?: "activity" | "area" | "monitoring";
  expanded: { activity: string[]; area: string[] };
  searchQuery?: string;
}

export function defaultFavoritesViewState(): FavoritesViewState {
  return { expanded: { activity: [], area: [] } };
}

/**
 * Load the Favorites view state from localStorage. Returns defaults
 * when the slot is empty, unparseable, or shaped unexpectedly. Every
 * access is wrapped so quota/storage errors degrade gracefully.
 */
export function loadFavoritesViewState(): FavoritesViewState {
  try {
    const raw = localStorage.getItem(FAVORITES_VIEW_STATE_KEY);
    if (!raw) return defaultFavoritesViewState();
    const parsed = JSON.parse(raw) as Partial<FavoritesViewState> | null;
    if (!parsed || typeof parsed !== "object") return defaultFavoritesViewState();
    const expanded = parsed.expanded ?? { activity: [], area: [] };
    return {
      activeTab: parsed.activeTab,
      expanded: {
        activity: Array.isArray(expanded.activity) ? expanded.activity : [],
        area: Array.isArray(expanded.area) ? expanded.area : [],
      },
      searchQuery: typeof parsed.searchQuery === "string" ? parsed.searchQuery : undefined,
    };
  } catch {
    return defaultFavoritesViewState();
  }
}

export function saveFavoritesViewState(viewState: FavoritesViewState): void {
  try {
    localStorage.setItem(FAVORITES_VIEW_STATE_KEY, JSON.stringify(viewState));
  } catch {
    // LocalStorage quota or disabled — non-fatal; state doesn't persist.
  }
}

export function clearFavoritesViewState(): void {
  try {
    localStorage.removeItem(FAVORITES_VIEW_STATE_KEY);
  } catch {
    // non-fatal
  }
}
