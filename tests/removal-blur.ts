/**
 * Chromium fires blur on a focused element as the DOM holding it is removed or
 * replaced, before it is detached; happy-dom fires none. `blurOnRemoval` makes the
 * DOM methods the card replaces or clears content with do what Chromium does, so a
 * test sees the blur a redraw causes. It returns the undo.
 */

type Patch = () => void;

/** The deepest focused element, through open shadow roots, or null. */
function deepActive(): HTMLElement | null {
  let active: Element | null = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active instanceof HTMLElement ? active : null;
}

/** Whether `inner` is `outer` or inside it, across shadow roots. */
function within(outer: Node, inner: Node): boolean {
  for (let node: Node | null = inner; node; node = node.parentNode ?? (node instanceof ShadowRoot ? node.host : null)) {
    if (node === outer) return true;
  }
  return false;
}

/** Blur the focused element where it is inside `removed` (its children only, with `childrenOnly`). */
function blurInside(removed: Node, childrenOnly: boolean): void {
  const active = deepActive();
  if (!active || (childrenOnly && active === removed) || !within(removed, active)) return;
  active.dispatchEvent(new FocusEvent("blur"));
}

/** The prototype on `start`'s chain that defines `name`, with its descriptor. */
function ownerOf(start: object, name: string): [object, PropertyDescriptor] {
  for (let proto: object | null = start; proto; proto = Object.getPrototypeOf(proto)) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (descriptor) return [proto, descriptor];
  }
  throw new Error(`no ${name} on the chain`);
}

function patchSetter(start: object, name: string, before: (target: Node) => void): Patch {
  const [owner, descriptor] = ownerOf(start, name);
  const set = descriptor.set!;
  Object.defineProperty(owner, name, {
    ...descriptor,
    set(this: Node, value: unknown) {
      before(this);
      set.call(this, value);
    },
  });
  return () => Object.defineProperty(owner, name, descriptor);
}

function patchMethod(start: object, name: string, before: (target: Node, args: unknown[]) => void): Patch {
  const [owner, descriptor] = ownerOf(start, name);
  const method = descriptor.value as (...args: unknown[]) => unknown;
  Object.defineProperty(owner, name, {
    ...descriptor,
    value(this: Node, ...args: unknown[]) {
      before(this, args);
      return method.apply(this, args);
    },
  });
  return () => Object.defineProperty(owner, name, descriptor);
}

export function blurOnRemoval(): () => void {
  const host = document.createElement("div");
  const shadow = host.attachShadow({ mode: "open" });
  const patches: Patch[] = [
    patchSetter(host, "innerHTML", target => blurInside(target, true)),
    patchSetter(shadow, "innerHTML", target => blurInside(target, true)),
    patchSetter(host, "textContent", target => blurInside(target, true)),
    patchMethod(host, "replaceChildren", target => blurInside(target, true)),
    patchMethod(host, "remove", target => blurInside(target, false)),
    patchMethod(host, "replaceWith", target => blurInside(target, false)),
    patchMethod(host, "removeChild", (_target, [child]) => {
      if (child instanceof Node) blurInside(child, false);
    }),
  ];
  return () => {
    for (const undo of patches.reverse()) undo();
  };
}
