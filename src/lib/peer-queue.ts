import { Peer } from 'peerjs';

/**
 * Global PeerJS signaling queue.
 *
 * Every `new Peer(id)` opens a WebSocket to 0.peerjs.com.
 * This queue enforces rate limits to prevent IP-based bans from the
 * signaling server. It also detects throttling (signaling errors when
 * network is up) and adaptively backs off.
 *
 * IMPORTANT: Uses a callback-based API (not promise-based) so that
 * `new Peer()` and event handler attachment happen in the SAME synchronous
 * tick. A promise-based approach would attach handlers in a microtask,
 * causing PeerJS 'open'/'error' events to fire before handlers exist.
 *
 * Usage:
 *   peerQueue.schedule(() => {
 *     const peer = new Peer('my-id');
 *     peer.on('open', ...);   // attached synchronously — never missed
 *     peer.on('error', ...);
 *   });
 */

interface QueueEntry {
  fn: () => void;
  priority: 'high' | 'normal';
}

// ─── Tuning constants ────────────────────────────────────────────────────────

/** Base minimum delay between consecutive `new Peer()` calls (ms) */
const BASE_INTERVAL = 1500;

/** When throttled, multiply interval by this factor */
const THROTTLE_MULTIPLIER = 3;

/** Max interval cap when throttled (ms) — don't wait longer than 15s */
const MAX_INTERVAL = 15000;

/** How long a throttle penalty lasts before decaying (ms) */
const THROTTLE_DECAY = 60000;

/** URL to probe for network connectivity */
const STUN_PROBE_URL = 'https://www.gstatic.com/generate_204';

/** How often we can probe network (ms) — don't spam the probe */
const PROBE_COOLDOWN = 10000;

class PeerQueue {
  private queue: QueueEntry[] = [];
  private lastCreate = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  // ─── Throttle detection ──────────────────────────────────────────────────

  /** Number of signaling failures while network was up */
  private throttleCount = 0;

  /** Timestamp of last throttle event */
  private lastThrottleTs = 0;

  /** Last network probe result + timestamp */
  private lastProbeTs = 0;
  private lastProbeResult: boolean | null = null;

  /** Total peers created (for logging) */
  private totalCreated = 0;

  /** True when network is confirmed down — pauses queue processing */
  private networkDown = false;

  /** Listeners for state changes */
  private listeners: ((state: QueueState) => void)[] = [];

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Schedule a callback to run through the rate-limited queue.
   * The callback is invoked synchronously when it's this entry's turn,
   * so `new Peer()` + event handlers happen in the same tick.
   *
   * @param fn - Callback that creates a Peer and attaches handlers
   * @param priority - 'high' for persistent peer (jumps queue), 'normal' for everything else
   */
  schedule(fn: () => void, priority: 'high' | 'normal' = 'normal') {
    const entry: QueueEntry = { fn, priority };
    if (priority === 'high') {
      // Insert after any existing high-priority entries but before normal ones
      const firstNormal = this.queue.findIndex(e => e.priority === 'normal');
      if (firstNormal === -1) this.queue.push(entry);
      else this.queue.splice(firstNormal, 0, entry);
    } else {
      this.queue.push(entry);
    }
    this.flush();
  }

  /**
   * Report a signaling failure. Call this when:
   * - Persistent peer fires 'disconnected'
   * - Persistent peer fires 'close' unexpectedly
   * - Any peer creation results in immediate disconnect
   *
   * The queue will probe the network. If network is up, this counts
   * as a throttle event and the interval increases.
   */
  reportSignalingError() {
    this.probeNetwork().then(networkUp => {
      if (networkUp) {
        this.networkDown = false;
        this.throttleCount++;
        this.lastThrottleTs = Date.now();
        console.log(`[PeerQueue] Throttle detected (count=${this.throttleCount}, interval=${this.currentInterval}ms)`);
        this.emitState();
      } else {
        this.networkDown = true;
        // Clear the queue — everything will fail anyway. They'll be re-queued when online.
        const hadItems = this.queue.length;
        this.queue = [];
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        if (hadItems) console.log(`[PeerQueue] Network down — cleared ${hadItems} queued items`);
        else console.log('[PeerQueue] Signaling error but network is down — paused');
        this.emitState();
      }
    });
  }

  /**
   * Report a signaling success. Call this when the persistent peer
   * fires 'open'. Decays the throttle counter.
   */
  reportSignalingSuccess() {
    if (this.networkDown) {
      this.networkDown = false;
      console.log('[PeerQueue] Network back — resuming');
    }
    if (this.throttleCount > 0) {
      this.throttleCount = Math.max(0, this.throttleCount - 1);
    }
    this.emitState();
    this.flush(); // resume processing if items were queued while paused
  }

  /** Cancel all queued (not yet started) callbacks */
  cancelAll() {
    this.queue = [];
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /** Subscribe to state changes */
  onStateChange(fn: (state: QueueState) => void) {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(l => l !== fn); };
  }

  /** Current queue state for UI/debugging */
  get state(): QueueState {
    return {
      pending: this.queue.length,
      totalCreated: this.totalCreated,
      currentInterval: this.currentInterval,
      throttleCount: this.throttleCount,
      isThrottled: this.throttleCount > 0,
      lastThrottleTs: this.lastThrottleTs,
      networkUp: this.lastProbeResult,
      networkDown: this.networkDown,
    };
  }

  /** How many items are queued */
  get pending(): number {
    return this.queue.length;
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  /** Current effective interval, accounting for throttle state */
  private get currentInterval(): number {
    // Decay throttle after THROTTLE_DECAY ms of no new throttle events
    if (this.throttleCount > 0 && Date.now() - this.lastThrottleTs > THROTTLE_DECAY) {
      this.throttleCount = Math.max(0, this.throttleCount - 1);
    }

    if (this.throttleCount === 0) return BASE_INTERVAL;

    // Exponential backoff: base * multiplier^count, capped
    const interval = BASE_INTERVAL * Math.pow(THROTTLE_MULTIPLIER, Math.min(this.throttleCount, 4));
    return Math.min(interval, MAX_INTERVAL);
  }

  private flush() {
    if (this.queue.length === 0) return;
    if (this.networkDown) return; // paused — will resume on reportSignalingSuccess

    const interval = this.currentInterval;
    const now = Date.now();
    const elapsed = now - this.lastCreate;

    if (elapsed < interval) {
      // Schedule next flush after the remaining wait
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.flush();
        }, interval - elapsed);
      }
      return;
    }

    // Process next entry
    const entry = this.queue.shift()!;
    this.lastCreate = Date.now();
    this.totalCreated++;

    // Run the callback synchronously — this is the whole point.
    // new Peer() + .on('open'/'error') happen in the same tick.
    try {
      entry.fn();
    } catch (err) {
      console.error('[PeerQueue] Callback error:', err);
    }

    this.emitState();

    // Continue flushing with delay
    if (this.queue.length > 0 && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.currentInterval);
    }
  }

  /**
   * Probe network connectivity by hitting a lightweight URL.
   * Uses Google's generate_204 endpoint (returns 204 No Content, ~0 bytes).
   * Result is cached for PROBE_COOLDOWN ms.
   */
  private async probeNetwork(): Promise<boolean> {
    const now = Date.now();
    if (now - this.lastProbeTs < PROBE_COOLDOWN && this.lastProbeResult !== null) {
      return this.lastProbeResult;
    }

    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 5000);
      await fetch(STUN_PROBE_URL, {
        method: 'HEAD',
        mode: 'no-cors',
        cache: 'no-store',
        signal: ctrl.signal,
      });
      clearTimeout(timeout);
      this.lastProbeTs = now;
      this.lastProbeResult = true;
      return true;
    } catch {
      this.lastProbeTs = now;
      this.lastProbeResult = false;
      return false;
    }
  }

  private emitState() {
    const s = this.state;
    this.listeners.forEach(fn => { try { fn(s); } catch {} });
  }
}

export interface QueueState {
  pending: number;
  totalCreated: number;
  currentInterval: number;
  throttleCount: number;
  isThrottled: boolean;
  lastThrottleTs: number;
  networkUp: boolean | null;
  networkDown: boolean;
}

/** Global singleton — import this everywhere instead of `new Peer()` directly */
export const peerQueue = new PeerQueue();
