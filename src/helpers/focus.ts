/** The element holding keyboard focus in the document or shadow root `node` is drawn in, or null. */
export function activeElementOf(node: Node): Element | null {
  const root = node.getRootNode();
  return root instanceof Document || root instanceof ShadowRoot ? root.activeElement : null;
}

/** Whether `el` holds keyboard focus in the document or shadow root it is drawn in. */
export function isFocused(el: Element | null): boolean {
  return el !== null && activeElementOf(el) === el;
}

/** Whether keyboard focus is on `container` or inside it. */
export function focusWithin(container: Element | null): boolean {
  if (!container) return false;
  const active = activeElementOf(container);
  return active !== null && container.contains(active);
}

/** The focused element inside `container`, or null where focus is elsewhere. */
export function focusedIn(container: Element | null): HTMLElement | null {
  if (!container) return null;
  const active = activeElementOf(container);
  return active instanceof HTMLElement && container.contains(active) ? active : null;
}

/** The data-role of the focused control inside `container`, or null where focus is elsewhere. */
export function focusedRole(container: Element | null): string | null {
  return focusedIn(container)?.dataset.role ?? null;
}

/**
 * Call `leave` when the user leaves `field`, and never when the field is removed
 * or replaced while focused. Chromium fires blur on a focused element as the DOM
 * holding it goes, before it is detached, so a redraw, a panel opening on another
 * circuit, or the dashboard clearing a tab would read as the user leaving and
 * commit whatever was half typed. A removal is over by the next microtask, so the
 * field is still connected then only where the user left it.
 */
export function onLeave(field: HTMLElement, leave: () => void): void {
  field.addEventListener("blur", () => {
    queueMicrotask(() => {
      if (field.isConnected) leave();
    });
  });
}
