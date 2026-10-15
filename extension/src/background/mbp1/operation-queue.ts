/**
 * A serialized async queue: each operation starts only after the previous one
 * settles, so read-modify-write sequences against the same `storage.local` key
 * cannot interleave and clobber each other.
 *
 * ## The scope is the caller's decision, and it is load-bearing
 *
 * This factory deliberately returns a queue rather than exporting a shared one,
 * because *where you call it* is what decides which callers are serialized:
 *
 * - **Module scope** (`const enqueue = createOperationQueue()` at the top of a
 *   module) serializes every caller in the realm, including independent call
 *   sites that share no object. That is what `client-installation-id` and
 *   `first-pair-backoff` need: an MV3 service worker really does get concurrent
 *   invocations, and a first-write-wins or read-increment-write rule that only
 *   held between callers sharing a handle would not hold at all.
 * - **Instance scope** (a class field) serializes only callers holding that
 *   object. That is enough when exactly one instance provably exists, and it is
 *   the shape `CredentialStore` and `PinStore` use — but note that nothing in
 *   those classes enforces the one-instance premise, so whoever wires them owns
 *   it.
 *
 * The distinction used to live in a comment claiming the four sites had the
 * "same queue shape", which was true of the chaining logic and false of the
 * scope — the half that closes the race. Now the shape is this function and the
 * scope is visible at the call site.
 */
export type OperationQueue = <T>(operation: () => Promise<T>) => Promise<T>

export function createOperationQueue(): OperationQueue {
  let tail: Promise<void> = Promise.resolve()
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation)
    // Swallow into the tail only: the queue stays usable after a rejection
    // while the rejection itself still reaches the operation's own caller.
    tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}
