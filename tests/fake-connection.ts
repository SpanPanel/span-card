import type { HomeAssistant } from "../src/types.js";

type Callback = (message: unknown) => void;

export interface FakeSubscription {
  /** The event type, or for `subscribeMessage` the message's `type`. */
  key: string;
  message: Record<string, unknown> | null;
  callback: Callback;
  unsubscribed: boolean;
}

/**
 * A websocket connection that records every subscription, so a test can count
 * the live ones: subscribe calls minus the unsubscribes that actually ran.
 *
 * With `hold` set, each subscribe promise stays pending until `release()`, which
 * is how a test lands a detach before a subscribe resolves.
 */
export class FakeConnection {
  readonly subscriptions: FakeSubscription[] = [];
  hold = false;
  private readonly _held: Array<() => void> = [];

  subscribeEvents = (callback: () => void, event: string): Promise<() => void> =>
    this._subscribe(event, null, callback, sub => () => {
      sub.unsubscribed = true;
    });

  subscribeMessage = <T>(callback: (message: T) => void, message: Record<string, unknown>): Promise<() => Promise<void>> =>
    this._subscribe(String(message.type), message, callback as Callback, sub => async () => {
      sub.unsubscribed = true;
    });

  live(key: string): number {
    return this.subscriptions.filter(s => s.key === key && !s.unsubscribed).length;
  }

  emit(key: string, message: unknown): void {
    for (const s of this.subscriptions) {
      if (s.key === key && !s.unsubscribed) s.callback(message);
    }
  }

  release(): void {
    for (const resolve of this._held.splice(0)) resolve();
  }

  private _subscribe<U>(key: string, message: Record<string, unknown> | null, callback: Callback, handle: (sub: FakeSubscription) => U): Promise<U> {
    const sub: FakeSubscription = { key, message, callback, unsubscribed: false };
    this.subscriptions.push(sub);
    const unsubscribe = handle(sub);
    if (!this.hold) return Promise.resolve(unsubscribe);
    return new Promise(resolve => this._held.push(() => resolve(unsubscribe)));
  }
}

export const ENTRY_RELOADS = "config_entries/subscribe";
export const ENTITY_REGISTRY = "entity_registry_updated";

export function hassWith(connection: FakeConnection, overrides: Partial<HomeAssistant> = {}): HomeAssistant {
  return {
    states: {},
    services: {},
    language: "en",
    callService: async () => undefined,
    callWS: async () => ({}),
    connection,
    ...overrides,
  } as unknown as HomeAssistant;
}

/** Let every pending promise callback run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}
