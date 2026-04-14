import { escapeHtml } from "../helpers/sanitize.js";

export interface TabDef {
  id: string;
  label: string;
  icon: string;
}

/**
 * Build an HTML string for a tab bar from the given tab definitions.
 */
export function buildTabBarHTML(tabs: TabDef[], activeTab: string, style: "text" | "icon"): string {
  const buttons = tabs
    .map(tab => {
      const activeClass = tab.id === activeTab ? " active" : "";
      const safeId = escapeHtml(tab.id);
      if (style === "icon") {
        return `<button class="shared-tab${activeClass}" data-tab="${safeId}" title="${escapeHtml(tab.label)}"><ha-icon icon="${escapeHtml(tab.icon)}" style="--mdc-icon-size:20px;"></ha-icon></button>`;
      }
      return `<button class="shared-tab${activeClass}" data-tab="${safeId}">${escapeHtml(tab.label)}</button>`;
    })
    .join("");

  return `<div class="shared-tab-bar">${buttons}</div>`;
}

/**
 * Attach a delegated click handler to `container` for `.shared-tab` buttons.
 * Returns a cleanup function that removes the listener.
 */
export function bindTabBarEvents(container: Element, callback: (tabId: string) => void): () => void {
  const handler = (ev: Event): void => {
    const target = ev.target as HTMLElement;
    const tab = target.closest(".shared-tab") as HTMLElement | null;
    if (tab) {
      const tabId: string | undefined = tab.dataset["tab"];
      if (tabId) {
        callback(tabId);
      }
    }
  };

  container.addEventListener("click", handler);

  return () => {
    container.removeEventListener("click", handler);
  };
}
