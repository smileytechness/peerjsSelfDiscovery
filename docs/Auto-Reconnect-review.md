# Auto-Reconnect Logic Audit — PeerNS

---

## 1. Inventory of All Reconnect Mechanisms

Before walking each scenario, here is every trigger that can cause a reconnect attempt for saved contacts, with the source file and exact condition.

| Mechanism | File | Trigger | Interval / Condition |
|---|---|---|---|
| `reconnectOfflineContacts` | p2p-signaling.ts | `persPeer.on('open')` | On every successful signaling re-open |
| `startContactSweep` | p2p-signaling.ts | `setInterval` | Every 30 s |
| `rvzSweep` → `rvzActivate` | p2p-rvz.ts | `setInterval` | Every 60 s + immediate 3 s after init |
| `handleOnline` | p2p-signaling.ts | `window.online`, `visibilitychange → visible`, `handleNetworkChange` | Event-driven |
| `handleNetworkChange` | p2p-signaling.ts | `navigator.connection.change` | Event-driven |
| `startHeartbeat` | p2p-signaling.ts | `setInterval` | Every 20 s |
| `startCheckinTimer` | p2p-signaling.ts | `setInterval` | Every 5 min |
| `schedulePersReconnect` | p2p-signaling.ts | `persPeer.on('disconnected')`, `persPeer.on('close')`, heartbeat | Exponential backoff |
| `nsHandleRouterConn` (checkin) | p2p-ns.ts | Peer checks in to our router | Event-driven — auto-connects known contact |
| `nsMergeRegistry` (auto-connect) | p2p-ns.ts | Registry update from router | Event-driven |

---

## 2. Scenario-by-Scenario Analysis

### Scenario A — Browser active, network drops completely then returns (same network)

**Step-by-step:**

1. `window.offline` fires → `persConnected = false`, `emitStatus()` only. **No reconnect attempt here.**
2. Shortly after, `persPeer` loses its WebSocket → fires `disconnected` → `schedulePersReconnect()` called.
3. `schedulePersReconnect`: exponential-backoff timer queued; sets `reconnectScheduled = true`.
4. `contactSweep` (next 30s tick): checks `if (!persPeer || persPeer.destroyed || persPeer.disconnected) return` → **aborts silently.**
5. `rvzSweep` (next 60s tick): only checks `if (!persPeer || persPeer.destroyed) return` — **does NOT check `.disconnected`**, so it proceeds to `rvzActivate`. Inside `rvzActivate` → `nsAttempt` → `peerQueue.schedule(() => new Peer(routerID))` — this creates a fresh WebSocket independently of `persPeer`, so it **may succeed or fail depending on network state**, but `nsTryJoin` inside will call `mgr.persPeer.connect(...)` which **will fail silently** because persPeer is disconnected.
6. Network returns → `window.online` fires → `handleOnline()` called.
7. `handleOnline`: persPeer is disconnected (not destroyed) → `reconnectBackoff = 0; persPeer.reconnect()`.
8. PeerJS re-registers → `persPeer.on('open')` fires → `reconnectOfflineContacts()` called.
9. `reconnectOfflineContacts`: clears `connectFailures`, iterates contacts, staggered 500 ms apart.
10. `connectPersistent(pid, fname)` called for each offline contact.

**⚠️ Deficiency A-1 — Zombie DataConnection bypasses reconnect:**
`reconnectOfflineContacts` checks `c.conn?.open`. If a DataConnection's WebRTC state is zombie (ICE has silently failed but `open` is still `true` because PeerJS hasn't received the `close` event yet), the contact is **skipped entirely**. The contact appears connected but is not. Neither peer knows.

**⚠️ Deficiency A-2 — rvzSweep runs while persPeer is disconnected, bypasses nsTryJoin:**
`rvzActivate` → `nsAttempt` → router election proceeds (new Peer, independent). When the elected router tries to probe or when the peer tries to join (`nsTryJoin`), it calls `mgr.persPeer.connect(...)`. `nsTryJoin` checks `if (!mgr.persPeer || mgr.persPeer.destroyed) return` but **not** `persPeer.disconnected`, so it attempts `persPeer.connect(...)` while signaling is down. This will silently fail or queue errored connection attempts.

---

### Scenario B — Browser active, network changes (e.g., WiFi → mobile data, or WiFi network swap)

**Step-by-step:**

1. `navigator.connection.change` event fires → `handleNetworkChange()` called.
2. **Explicitly closes all contact DataConnections and sets them to null.** ✅
3. Clears `connectingPIDs`, resets unacked messages.
4. Attempts `persPeer.disconnect()` then `persPeer.reconnect()`, or destroys and re-registers.
5. Detects IP change via `getPublicIP()`.
6. If IP changed → `failover()` on public namespace.
7. Restarts custom NS, group NS, geo NS (staggered).
8. Does **not** explicitly call `reconnectOfflineContacts` or `rvzSweep` — these will happen once `persPeer.on('open')` fires again.

**⚠️ Deficiency B-1 — `navigator.connection.change` does not always fire on network swap:**
On many mobile browsers and some desktop browsers, switching from WiFi-A to WiFi-B (same type, different network) does **not** fire `connection.change`. The `online`/`offline` events also do not fire in this case. The app may never detect the network change. `handleOnline` won't be called. The only thing that will catch this is the heartbeat (20s) if `persPeer` becomes disconnected, or `startCheckinTimer` (5 min).

**⚠️ Deficiency B-2 — IP change detection races against reconnect:**
`handleNetworkChange` awaits `getPublicIP()` (STUN + HTTP fallback, up to ~10s). During this window, `persPeer` may have already reconnected and `reconnectOfflineContacts` fired, all with the old IP. Namespace failover then happens after contacts were already reconnect-attempted with stale discovery state.

---

### Scenario C — Browser not active (backgrounded / tab hidden)

**What happens:**

1. `visibilitychange → hidden` fires. **No handler in the codebase for the hidden case.** Nothing is torn down or paused (by design — offline mode toggle handles that).
2. Browser may throttle `setInterval` heavily — 30s sweep, 60s rvz sweep, 20s heartbeat, 45s keep-alive may all run at 1-min+ intervals or be suspended entirely on mobile.
3. The Web Lock API (`navigator.locks.request`) and Wake Lock are acquired — these reduce (but don't prevent) throttling.
4. If the device radio sleeps, the signaling WebSocket silently drops. This is not detected until the next heartbeat fires.
5. After WebSocket drops: `persPeer.on('disconnected')` fires → `schedulePersReconnect()` → exponential backoff timer, but this timer may itself be throttled.
6. If background > ~5 min: checkinTimer's `sendSignalingHeartbeat` will attempt to ping the signaling socket. If the socket is dead, no error is thrown (the internal send may silently fail). `schedulePersReconnect` is called only if `persPeer.disconnected || persPeer.destroyed`.

**⚠️ Deficiency C-1 — Silent WebSocket death not reliably detected in background:**
`sendSignalingHeartbeat` sends to `(persPeer as any).socket` via PeerJS's internal `socket.send(...)`. If the socket's underlying WebSocket is in a half-open zombie state, `send()` may not throw; it may queue the data. `persPeer.disconnected` remains `false`. Heartbeat will not trigger `schedulePersReconnect`. The peer effectively thinks it is connected when it is not.

**⚠️ Deficiency C-2 — `reconnectOfflineContacts` won't fire without `persPeer.on('open')`:**
In background the only path to `reconnectOfflineContacts` is through signaling reconnect. If signaling never detects it is dead (Deficiency C-1), `reconnectOfflineContacts` never fires.

---

### Scenario D — Browser reactivated (visible), same network, persPeer still connected

**Step-by-step:**

1. `visibilitychange → visible` fires → `handleOnline()` called + `acquireWakeLock()`.
2. `handleOnline`: `persPeer` is not destroyed, not disconnected (still "connected") → **falls through without doing anything for contacts.**
3. The condition `if (!mgr.publicIP || mgr.namespaceOffline || publicNS.isRouter || ...)` may trigger a namespace rejoin. That's all.
4. `reconnectOfflineContacts` is NOT called.
5. `rvzSweep` is NOT called.
6. Contacts that had their DataConnections silently die in the background are never reconnected until the 30s contact sweep fires.

**⚠️ Deficiency D-1 — `handleOnline` does not reconnect contacts when persPeer appears healthy:**
This is the most impactful bug for the "no page reload needed" regression. After backgrounding, contact DataConnections may be zombies. When foregrounded, `handleOnline` sees a healthy `persPeer` and does nothing for contacts. The only recovery path is the 30s `contactSweep` — but that skips contacts with `conn.open === true` (zombies). **There is no active check of DataConnection health on foreground.**

**⚠️ Deficiency D-2 — No ICE state check before skipping in `contactSweep`:**
`startContactSweep` checks `if (c.conn?.open) return false`. It never interrogates `c.conn?.peerConnection?.iceConnectionState` or `c.conn?.peerConnection?.connectionState`. A connection in ICE state `disconnected` or `failed` will still have `conn.open === true` until PeerJS fires the close event — which may be delayed by minutes or not happen at all on some browsers.

---

### Scenario E — Browser reactivated (visible), same network, persPeer disconnected (WebSocket died in background)

**Step-by-step:**

1. `visibilitychange → visible` → `handleOnline()`.
2. `persPeer.disconnected === true` → `reconnectBackoff = 0; persPeer.reconnect()`.
3. PeerJS reconnects to signaling → `persPeer.on('open')` → `reconnectOfflineContacts()`.
4. Contacts are re-connected. **This path works correctly, assuming no zombie DataConnections.**

**Minor issue:** All contact DataConnections are still in whatever state they were when backgrounded. If they are zombie (open but dead), they are skipped by `reconnectOfflineContacts`. Same as Deficiency A-1.

---

### Scenario F — Browser reactivated (visible), different network (e.g., was on home WiFi, woke on mobile data)

**Step-by-step:**

1. `visibilitychange → visible` → `handleOnline()`.
2. `persPeer` is likely disconnected (WebSocket from old network is dead).
3. `persPeer.reconnect()` is called. PeerJS reconnects on new network with same PID.
4. `persPeer.on('open')` fires → `reconnectOfflineContacts()` called.
5. BUT: `navigator.connection.change` may also fire → `handleNetworkChange()` called.
6. Race: `handleNetworkChange` closes all DataConnections (good) and detects IP change → failover. **But `reconnectOfflineContacts` may have already been called before DataConnections are closed**, meaning it skips them (they look open), and then the close happens, and then nothing calls reconnect again.
7. After `handleNetworkChange` teardown + failover → `persPeer.on('open')` should fire again if the network change caused a reconnect, calling `reconnectOfflineContacts` a second time.

**⚠️ Deficiency F-1 — Race between `handleOnline` and `handleNetworkChange`:**
Both can fire nearly simultaneously (`online` + `connection.change`). `handleOnline` may trigger `persPeer.reconnect()` while `handleNetworkChange` then calls `persPeer.disconnect()` + `persPeer.reconnect()` again. This can cause double-reconnect and potential signaling rate-limiting from `peerQueue`.

**⚠️ Deficiency F-2 — `reconnectOfflineContacts` fires before stale DataConnections are cleared:**
`reconnectOfflineContacts` (from `persPeer.on('open')`) runs before `handleNetworkChange`'s async IP detection finishes and closes DataConnections. Contacts with stale open DataConnections are skipped. After the close, nothing triggers reconnect for them.

---

### Scenario G — Peer B is actively online for a long time; Peer A goes offline briefly then returns. Peer B still holds Peer A's DataConnection as open.

This is the core "won't reconnect without reload" bug.

**What happens on Peer B's side:**

1. Peer A's DataConnection closes (WebRTC ICE fails) → `conn.on('close')` fires on Peer B → `contacts[key].conn = null`, `resetContactMessages(key)` called, `emitPeerListUpdate()`. ✅ This part works.
2. On next `contactSweep` (30s): Peer B tries `connectPersistent(pid, fname)` for Peer A.
3. But Peer A may not be back yet — `connectPersistent` gets `error: peer-unavailable` → `connectFailures[pid]++`.
4. After 3 failures, `markWaitingMessagesFailed` + `rvzEnqueue` called.
5. `rvzEnqueue` → `rvzActivate` → rendezvous namespace spun up for Peer A.

**What happens on Peer A's side (the one that went offline):**

1. Peer A's DataConnection to Peer B closes → `contacts[B].conn = null`. ✅
2. Peer A's `persPeer` reconnects → `reconnectOfflineContacts` → `connectPersistent(B_pid)`.
3. **If Peer B's signaling is alive:** connection is established. ✅
4. **If Peer B's PID has changed** (rotated during Peer A's absence): `peer-unavailable` → retry → fail → rvzEnqueue.

**⚠️ Deficiency G-1 — PID change not detected without rvz or namespace:**
If Peer B's PID changed while Peer A was offline (e.g., Peer B had an `unavailable-id` rotation), Peer A has a stale PID in `contacts[B].currentPID`. Direct `connectPersistent` will fail. The rvz system is the only recovery path (shared-key slug derivation), but it only activates after `MAX_CONNECT_RETRIES` (3) direct failures. With backoff delays of 5s, 10s, 15s per retry, that's up to 30s before rvz activates.

**⚠️ Deficiency G-2 — Peer A's `connFailures` not cleared on re-registration:**
When Peer A comes back and `persPeer.on('open')` fires, `reconnectOfflineContacts` clears `connectFailures = {}`. ✅ That's correct. But if `schedulePersReconnect` is called and the timer fires *before* the `open` event and some contacts fail during that window, those failure counts are stale and not cleared.

---

### Scenario H — Both peers backgrounded simultaneously, both wake up

Both go through Scenario D or E. The outcome depends on which peer reconnects to signaling first. Once both are registered, the first `contactSweep` (30s) or `reconnectOfflineContacts` will establish the connection. **This scenario works correctly, just slowly (up to 30s delay).**

---

### Scenario I — Peer is online, no network issue, but DataConnection silently degrades (TURN relay churn, ICE restart needed)

WebRTC can silently degrade — ICE candidates change, TURN relay routes change. The ICE connection state goes `connected → disconnected → failed`. PeerJS fires `conn.on('close')` when this happens. **This should work** as the close triggers reconnect. But if ICE state is `disconnected` (not yet `failed`), WebRTC has a timeout (typically 5s) before failing. During this window `conn.open` may still be `true`.

**⚠️ Deficiency I-1 — No proactive ICE health monitoring:**
There is no code checking `conn.peerConnection.iceConnectionState` periodically. Transient ICE issues that self-resolve are handled by WebRTC. Issues that don't self-resolve rely entirely on PeerJS firing `close`. If PeerJS's internal error handling swallows or delays the close event (a known PeerJS bug on some browsers), the zombie connection persists indefinitely.

---

## 3. Root Cause Summary Table

| # | Deficiency | Affected Scenarios | Severity |
|---|---|---|---|
| 1 | `conn.open` used as sole liveness indicator — no ICE state check | A, D, E, F, G, I | **Critical** |
| 2 | `handleOnline` does nothing when `persPeer` appears healthy but contacts are zombie | D | **Critical** |
| 3 | No explicit `reconnectOfflineContacts` or `rvzSweep` call on `visibilitychange → visible` when persPeer healthy | D | **Critical** |
| 4 | `nsTryJoin` doesn't guard against `persPeer.disconnected` | A, B | High |
| 5 | `navigator.connection.change` not reliable for same-type network swap | B | High |
| 6 | Race: `reconnectOfflineContacts` fires before `handleNetworkChange` clears DataConnections | F | High |
| 7 | Silent WebSocket zombie in background not detected by heartbeat | C | High |
| 8 | `rvzSweep` permits `nsAttempt` when `persPeer.disconnected` | A | Medium |
| 9 | `contactSweep` limited to 3 contacts per tick — large contact lists reconnect slowly | All | Medium |
| 10 | No contact-level DataConnection ping/heartbeat | All | Medium |
| 11 | PID change only detected after MAX_CONNECT_RETRIES, not proactively | G | Medium |
| 12 | `sendSignalingHeartbeat` uses internal PeerJS API that may silently queue on zombie socket | C | Medium |

---

## 4. Specific Code Locations and Proposed Fixes

### Fix 1 — Replace `conn.open` with an ICE-aware liveness helper

**New utility (add to a shared file):**
```ts
export function isDataConnAlive(conn: any): boolean {
  if (!conn || !conn.open) return false;
  const ice = conn.peerConnection?.iceConnectionState;
  if (!ice) return true; // can't check, assume ok
  return ice !== 'disconnected' && ice !== 'failed' && ice !== 'closed';
}
```

Replace all `c.conn?.open` checks in:
- `p2p-signaling.ts` → `reconnectOfflineContacts`, `startContactSweep`
- `p2p-rvz.ts` → `rvzSweep`
- `p2p-ns.ts` → `nsHandleRouterConn` auto-connect block, `nsMergeRegistry` auto-connect block

When `isDataConnAlive` returns `false` but `conn.open` is `true`, explicitly close and null the connection before retrying.

---

### Fix 2 — `handleOnline` must always probe contact health

In `p2p-signaling.ts` → `handleOnline`, after the persPeer reconnect block, add:

```ts
// Force-close any zombie DataConnections, then reconnect
Object.keys(mgr.contacts).forEach(key => {
  const c = mgr.contacts[key];
  if (c.conn && !isDataConnAlive(c.conn)) {
    try { c.conn.close(); } catch {}
    c.conn = null;
    mgr.resetContactMessages(key);
  }
});
// If persPeer is already connected, reconnect contacts now directly
if (mgr.persPeer && !mgr.persPeer.destroyed && !mgr.persPeer.disconnected) {
  mgr.reconnectOfflineContacts();
}
```

---

### Fix 3 — `visibilitychange → visible` must call rvzSweep and contact probe

In `p2p-signaling.ts` → `watchNetwork`:

```ts
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    mgr.log('App foregrounded — checking connections', 'info');
    mgr.handleOnline();          // already there ✅
    mgr.acquireWakeLock();       // already there ✅
    // ADD:
    setTimeout(() => mgr.rvzSweep(), 1500); // let signaling settle first
  }
});
```

---

### Fix 4 — Guard `nsTryJoin` against disconnected persPeer

In `p2p-ns.ts` → `nsTryJoin`, change:

```ts
// Before
if (!mgr.persPeer || mgr.persPeer.destroyed) return;

// After
if (!mgr.persPeer || mgr.persPeer.destroyed || mgr.persPeer.disconnected) return;
```

Same fix in `connectPersistent` — already has this guard ✅, but `nsTryJoin` does not.

---

### Fix 5 — Reliable signaling health check in heartbeat

In `p2p-signaling.ts` → `startHeartbeat`, instead of only checking `persPeer.disconnected`:

```ts
mgr.heartbeatTimer = setInterval(() => {
  if (mgr.offlineMode) return;
  const peer = mgr.persPeer;
  if (!peer || peer.destroyed) {
    mgr.persConnected = false;
    mgr.emitStatus();
    if (!mgr.reconnectScheduled) mgr.registerPersistent();
    return;
  }
  // Check ICE/WebSocket health via an explicit ping attempt
  const socketAlive = sendSignalingHeartbeat(mgr);
  const connected = !peer.disconnected && socketAlive;
  if (connected !== mgr.persConnected) {
    mgr.persConnected = connected;
    mgr.emitStatus();
  }
  if (!connected && !peer.destroyed && !mgr.reconnectScheduled) {
    mgr.log('Heartbeat: signaling lost — reconnecting', 'info');
    mgr.schedulePersReconnect();
  }
}, 20000);
```

The key addition: if `sendSignalingHeartbeat` returns `false` (internal socket not available), treat as disconnected immediately rather than waiting for the PeerJS disconnected event.

---

### Fix 6 — Debounce `handleOnline` / `handleNetworkChange` race

In `p2p-signaling.ts`, add a debounce guard:

```ts
// In P2PManager class
/** @internal */ public networkChangeDebounce: any = null;
```

In `watchNetwork`:
```ts
window.addEventListener('online', () => {
  if (mgr.networkChangeDebounce) clearTimeout(mgr.networkChangeDebounce);
  mgr.networkChangeDebounce = setTimeout(() => mgr.handleOnline(), 300);
});
```

In `handleNetworkChange`, cancel the online debounce at the top since it takes precedence.

---

### Fix 7 — Add periodic contact-level DataConnection health ping

Add to `startCheckinTimer` (every 5 min) or a new separate 2-min timer:

```ts
// After the existing flush logic, add:
Object.keys(mgr.contacts).forEach(key => {
  const c = mgr.contacts[key];
  if (c.conn && c.conn.open) {
    const ice = c.conn.peerConnection?.iceConnectionState;
    if (ice === 'failed' || ice === 'closed' || ice === 'disconnected') {
      mgr.log(`Contact ${c.friendlyName} DataConnection ICE=${ice} — closing zombie`, 'info');
      try { c.conn.close(); } catch {}
      c.conn = null;
      mgr.resetContactMessages(key);
      mgr.emitPeerListUpdate();
      // Now reconnect
      const pid = c.currentPID || key;
      if (!mgr.connectingPIDs.has(pid)) mgr.connectPersistent(pid, c.friendlyName);
    }
  }
});
```

---

### Fix 8 — `rvzSweep` must guard `persPeer.disconnected`

In `p2p-rvz.ts` → `rvzSweep`:

```ts
// Before
if (mgr.offlineMode) return;
if (!mgr.persPeer || mgr.persPeer.destroyed) return;

// After
if (mgr.offlineMode) return;
if (!mgr.persPeer || mgr.persPeer.destroyed || mgr.persPeer.disconnected) return;
```

---

### Fix 9 — `reconnectOfflineContacts` must close zombies before checking

In `p2p-signaling.ts` → `reconnectOfflineContacts`, at the top of the contact filter:

```ts
// Before filtering, close any zombie connections
Object.keys(mgr.contacts).forEach(key => {
  const c = mgr.contacts[key];
  if (c.conn && !isDataConnAlive(c.conn)) {
    try { c.conn.close(); } catch {}
    c.conn = null;
    mgr.resetContactMessages(key);
  }
});
// Then existing filter logic follows...
```

---

## 5. The "No Checkin Listener" Question

There is **no dedicated "are you still alive" request-response cycle** between saved contacts over their persistent DataConnections. The contact channel is message-only (hello, message, ack, edit, delete, file-*).

The namespace system has `ping`/`pong` between router and members (in `nsStartPingTimer`), but this is for the discovery overlay, not for the persistent contact channel.

**What exists:** PeerJS DataConnections are built on SCTP/WebRTC. If the ICE path dies, `conn.on('close')` fires. This is the only liveness signal.

**What's missing:** A lightweight `{ type: 'dc-ping' }` / `{ type: 'dc-pong' }` exchange on the persistent connection, sent every ~60s. If no pong arrives within 10s, close the connection and reconnect. This would catch all zombie DataConnection scenarios.

Add to `handlePersistentData` in `p2p-messaging.ts`:
```ts
if (d.type === 'dc-ping') {
  if (conn.open) conn.send({ type: 'dc-pong' });
}
if (d.type === 'dc-pong') {
  if (mgr.contacts[ck]) mgr.contacts[ck].lastSeen = Date.now();
}
```

And in `startCheckinTimer`, for each open contact connection:
```ts
Object.entries(mgr.contacts).forEach(([key, c]) => {
  if (c.conn?.open) {
    c.conn.send({ type: 'dc-ping' });
    // Set a timeout — if no dc-pong in 10s, declare dead
    // (use a Map<contactKey, timer> to track pending pings)
  }
});
```

---

## 7. Mobile Android Background Keep-Alive — Opt-In Audio Heartbeat

### Background

Tested on Android (Chrome): when the screen is locked and the browser is backgrounded, all `setInterval` timers, WebSocket activity, and WebRTC ICE keepalives are suspended by the OS within approximately **30 seconds**. The Web Lock API and Wake Lock API reduce this but do not eliminate it on all devices and Android versions.

**Observed behavior:** Playing any audio from the page — even a very short, very low volume tone — resets the browser's background suspension timer. A 5ms tone played every 29 seconds was confirmed to keep the page fully alive indefinitely with screen locked, all timers running, and incoming messages received and sounded.

This works because the browser classifies a page producing audio as an **active media session**, which Android's audio focus system prevents from being frozen. It is the Web Audio API output itself (not a system notification) that keeps the process alive.

---

### Proposed Implementation — `startAudioKeepAlive()`

This should be **opt-in only**, surfaced as a toggle in Settings/Profile. It must respect offline mode and should stop if the user manually disables it. A subtle UI indicator (e.g., a small 🔊 badge on the status bar) should show when active so users know why audio permissions are in use.

```ts
// In P2PManager (p2p.ts) — add these fields:
/** @internal */ public audioKeepAliveTimer: any = null;
/** @internal */ public audioKeepAliveCtx: AudioContext | null = null;
public audioKeepAliveEnabled: boolean = false;

/**
 * Plays a 5ms, near-silent tone via Web Audio API.
 * Frequency: 1 Hz effective (below human hearing threshold at this duration).
 * Volume: 0.001 — inaudible but nonzero so the browser counts it as audio output.
 * This resets Android Chrome's background process suspension timer.
 */
private _playKeepaliveTone() {
  try {
    if (!this.audioKeepAliveCtx) {
      this.audioKeepAliveCtx = new AudioContext();
    }
    const ctx = this.audioKeepAliveCtx;
    if (ctx.state === 'suspended') ctx.resume();

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.frequency.value = 440;                          // frequency doesn't matter at 5ms
    gain.gain.setValueAtTime(0.001, ctx.currentTime);   // near-silent
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.005);

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.005);                  // 5ms duration
  } catch (e) {
    this.log(`Audio keepalive tone failed: ${e}`, 'err');
  }
}

public startAudioKeepAlive() {
  if (this.audioKeepAliveTimer) return; // already running
  this.audioKeepAliveEnabled = true;
  localStorage.setItem(`${APP_PREFIX}-audio-keepalive`, '1');
  this.log('Audio keep-alive enabled (29s tone interval)', 'ok');

  // Play immediately to acquire audio session focus
  this._playKeepaliveTone();

  this.audioKeepAliveTimer = setInterval(() => {
    if (this.offlineMode) return;
    this._playKeepaliveTone();
  }, 29000); // 29s — safely under the 30s Android suspension threshold

  this.dispatchEvent(new CustomEvent('audio-keepalive-change', { detail: { enabled: true } }));
}

public stopAudioKeepAlive() {
  if (this.audioKeepAliveTimer) {
    clearInterval(this.audioKeepAliveTimer);
    this.audioKeepAliveTimer = null;
  }
  if (this.audioKeepAliveCtx) {
    this.audioKeepAliveCtx.close().catch(() => {});
    this.audioKeepAliveCtx = null;
  }
  this.audioKeepAliveEnabled = false;
  localStorage.removeItem(`${APP_PREFIX}-audio-keepalive`);
  this.log('Audio keep-alive disabled', 'info');
  this.dispatchEvent(new CustomEvent('audio-keepalive-change', { detail: { enabled: false } }));
}
```

### Restore on Init

In `_init()` (or at the end of `loadState()`), restore the preference:

```ts
if (localStorage.getItem(`${APP_PREFIX}-audio-keepalive`)) {
  // Defer until after first user gesture (required by browsers to start AudioContext)
  // Listen for the first interaction, then start
  const startOnGesture = () => {
    this.startAudioKeepAlive();
    document.removeEventListener('click', startOnGesture);
    document.removeEventListener('touchstart', startOnGesture);
  };
  document.addEventListener('click', startOnGesture, { once: true });
  document.addEventListener('touchstart', startOnGesture, { once: true });
}
```

### UI — Settings Toggle (add to ProfileModal or a Settings panel)

```tsx
// In ProfileModal.tsx or a dedicated Settings section:
const [audioKeepalive, setAudioKeepalive] = useState(
  !!localStorage.getItem(`${APP_PREFIX}-audio-keepalive`)
);

const toggleKeepalive = () => {
  if (audioKeepalive) {
    p2p.stopAudioKeepAlive();
    setAudioKeepalive(false);
  } else {
    p2p.startAudioKeepAlive();
    setAudioKeepalive(true);
  }
};

// Render:
<div className="flex items-center justify-between py-2">
  <div>
    <div className="text-sm font-medium text-gray-200">
      Background Keep-Alive {audioKeepalive && <span className="text-[10px] text-green-400 ml-1">● ACTIVE</span>}
    </div>
    <div className="text-[11px] text-gray-500 mt-0.5">
      Plays a silent audio tone every 29s to prevent Android from suspending
      the app. Keeps messages, calls, and reconnects working with screen locked.
    </div>
  </div>
  <button
    onClick={toggleKeepalive}
    className={clsx(
      'ml-4 shrink-0 w-10 h-6 rounded-full transition-colors relative',
      audioKeepalive ? 'bg-green-600' : 'bg-gray-700'
    )}
  >
    <span className={clsx(
      'absolute top-1 w-4 h-4 rounded-full bg-white transition-transform',
      audioKeepalive ? 'translate-x-5' : 'translate-x-1'
    )} />
  </button>
</div>
```

### Caveats and Notes

- **User gesture required.** `AudioContext` cannot be created or started without a prior user interaction. The restore-on-init path must wait for the first click/touch. On first enable (user taps the toggle), the gesture is implicit and `startAudioKeepAlive()` can run immediately.
- **Battery impact.** 5ms of oscillator synthesis every 29s is computationally negligible — the AudioContext graph is idle between tones. Real-world battery impact is dominated by the WebSocket and WebRTC keep-alives that are already running anyway. The tone itself adds nothing measurable.
- **Volume level.** `0.001` gain is below audible threshold on virtually all devices. If a user is on a call or playing audio, this tone is completely masked. It should not be perceptible under any normal circumstances.
- **This is not needed on desktop browsers** — they do not suspend background pages the same way. The feature can be shown only on mobile (detect via `navigator.userAgent` or `navigator.maxTouchPoints > 0`), or shown universally and left to the user.
- **iOS / Safari** — iOS has stricter audio session policies. An `AudioContext` may be suspended more aggressively even with a user gesture. This technique may not be reliable on iOS. Consider gating the feature behind a mobile platform check and labeling it "Android Chrome recommended."
---

## 6. Priority Order for Fixes

1. **Fix 1** (zombie detection helper) — foundational for all other fixes
2. **Fix 2 + Fix 9** (handleOnline + reconnectOfflineContacts close zombies) — fixes the main "no reload" bug
3. **Fix 3** (visibilitychange calls rvzSweep) — fixes the foregrounding scenario
4. **Fix 7** (periodic ICE health check in checkinTimer) — safety net
5. **Fix 5** (heartbeat sends signaling ping and validates socket health) — fixes background zombie WebSocket
6. **Fix 4 + Fix 8** (guard disconnected in nsTryJoin and rvzSweep) — prevents spurious failures
7. **Fix 6** (debounce online/networkchange race) — fixes the network-change overlap
8. **DC ping/pong** — belt-and-suspenders liveness for all persistent channels
