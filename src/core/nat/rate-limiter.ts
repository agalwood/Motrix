export interface TokenBucketOptions {
  capacity: number
  refillPerSec: number
  now?: () => number // injected for deterministic tests
}

export class TokenBucket {
  private tokens: number
  private lastRefillMs: number
  private readonly capacity: number
  private readonly refillPerSec: number
  private readonly now: () => number

  constructor(opts: TokenBucketOptions) {
    this.capacity = opts.capacity
    this.refillPerSec = opts.refillPerSec
    this.now = opts.now ?? (() => Date.now())
    this.tokens = opts.capacity
    this.lastRefillMs = this.now()
  }

  tryAcquire(count = 1): boolean {
    if (count > this.capacity) {
      throw new RangeError(
        `TokenBucket.tryAcquire: count ${count} exceeds capacity ${this.capacity}`
      )
    }
    this.refill()
    if (this.tokens >= count) {
      this.tokens -= count
      return true
    }
    return false
  }

  timeUntilNextToken(): number {
    this.refill()
    if (this.tokens >= 1) return 0
    const deficit = 1 - this.tokens
    return Math.ceil((deficit / this.refillPerSec) * 1000)
  }

  private refill(): void {
    const nowMs = this.now()
    const elapsedSec = Math.max(0, (nowMs - this.lastRefillMs) / 1000)
    this.tokens = Math.min(
      this.capacity,
      this.tokens + elapsedSec * this.refillPerSec
    )
    this.lastRefillMs = nowMs
  }
}
