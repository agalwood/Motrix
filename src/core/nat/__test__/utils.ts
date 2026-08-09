/** Yield to the event loop so pending microtasks and setImmediate callbacks run. */
export const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
