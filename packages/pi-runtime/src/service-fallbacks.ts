/**
 * Fill in the members pi does not implement.
 *
 * `ProxyChannel.fromService` walks the service object by name and throws for
 * anything missing:
 *   - an unknown event → `Event not found: <name>`
 *   - an unknown method → `Method not found: <name>`
 *
 * Both throws happen inside the channel server with nothing to catch them, so a
 * single absent member takes the whole process down. ZCode's UI subscribes to a
 * dozen `onDynamic*` events during mount, which is why this layer exists.
 *
 * The layer is deliberately asymmetric:
 *   - events return a dangling subscription (silence is the honest answer for a
 *     source that will never fire — and an exception during mount is fatal);
 *   - methods reject with a name that says exactly what is missing (silence
 *     would let the UI act on fabricated data).
 */

/** `onXxx` / `onDynamicXxx` — the two event naming conventions in `@zcode/rpc`. */
export function isEventMember(name: string): boolean {
  if (name.startsWith("onDynamic") && name.length > 9) return true;
  return name.length >= 3 && name.startsWith("on") && name.charCodeAt(2) >= 65 && name.charCodeAt(2) <= 90;
}

/**
 * Wrap a service so every missing member exists.
 *
 * Frameworks probe arbitrary properties (`then`, symbols, `toJSON`), so those are
 * passed through untouched rather than being turned into fake members.
 */
export function withServiceFallbacks<T extends object>(service: T, label = "zcodeAgentService"): T {
  return new Proxy(service, {
    get(target, property, receiver) {
      const existing = Reflect.get(target, property, receiver);
      if (existing !== undefined) return existing;
      if (typeof property === "symbol") return undefined;

      const name = String(property);
      if (name === "then" || name === "toJSON" || name === "inspect") return undefined;

      if (isEventMember(name)) {
        // Two shapes exist in `@zcode/rpc`, and choosing the wrong one is fatal:
        //   - `onDynamicXxx(param)` returns an `Event<T>`, so the caller does
        //     `service.onDynamicFoo(param)(listener)` — TWO calls;
        //   - `onXxx` IS the `Event<T>` itself, so `service.onFoo(listener)` —
        //     ONE call.
        // The connection scope forwards dynamic events, which is why a
        // subscription object returned here surfaces as `source is not a
        // function`.
        if (name.startsWith("onDynamic")) {
          return (_arg?: unknown) => (_listener?: unknown) => ({ dispose() {} });
        }
        return (_listener?: unknown) => ({ dispose() {} });
      }

      return async () => {
        throw new Error(
          `fault.notImplemented: ${label}.${name} has no pi implementation yet`,
        );
      };
    },
  });
}
