# PeerNS — Up Next

## Priority: Immediate (Build 19+)

### 1. Group Chats & Group Video Conferencing
Self-healing "floating" groups with multi-party video/audio/screen sharing for conference meetings. No server — the group infrastructure floats between participants.

- **Group = Topic Router.** Group ID: `peerns-group-{groupUUID}-1`
- **Router election:** Creator becomes router. If they leave, remaining members claim the slot via jitter + election (same ns* protocol as namespaces).
- **Star topology with relay:** Router relays messages and media streams between all participants.
- **Group video/audio/screen:** Each participant opens MediaConnections to the router. Router forwards streams to all others (SFU-style via the elected router peer).
- **Screen sharing in calls:** Any participant can share screen alongside camera. Multiple simultaneous streams supported.
- **Host migration:** Router drops → members detect via `close` event → random jitter (0-3s) → first to claim `peerns-group-{uuid}-1` becomes new router → all others reconnect. Media streams re-established automatically.
- **Group chat persistence:** Messages stored locally per group UUID. Each member has full history. New members receive backfill from router on join.
- **UI:** Group list in sidebar, group creation modal, group video call view with participant grid, screen share overlay.

### 2. Geo-Spatial Discovery ("Stadium Mode")
Discovery by physical proximity — find people near you across different networks (WiFi vs 5G). Critical for conference/event use cases.

- **Geohash routing:** 7-char geohash (~150m radius). Router ID: `peerns-geo-{geohash}-1`
- **Border problem:** Calculate 4 surrounding coordinates + center, hash all 5, enroll in unique hashes (typically 1-2). Limits network overhead.
- **Registry data:** Each peer's GPS coordinate included in checkin. Client sorts all peers from all geohash routers by distance.
- **Conference mode:** Combine geo discovery with group creation — "Create a meeting room for everyone nearby."
- **Privacy:** Geohash is coarse (~150m). Exact GPS only shared within the namespace registry, never stored permanently.

### 3. Public Key Re-Keying
Contacts and chats currently keyed by PeerJS persistent ID. Re-key by **public key fingerprint** so identity survives PID changes.

- Storage keys: `contacts[fingerprint]`, `chats[fingerprint]`
- Chat UI shows friendly name + public key hash, never PID
- ContactModal shows current PeerJS PID as a routing detail only
- Migration path: on first load, re-key existing contacts from PID to fingerprint
- Detailed plan exists at `.claude/plans/validated-questing-grove.md`

### 4. Trusted Contacts & Trust Levels
Saved contacts become **trusted** by default. Trust is tied to the public key. Trust levels control capabilities.

| Level | Label | Capabilities |
|:------|:------|:-------------|
| 0 | Blocked | No connections accepted |
| 1 | Known | Messages + file transfer (current behavior) |
| 2 | Trusted | + Calls, presence visibility, group invites, future RPC |
| 3 | Full Access | + RPC command execution (see below) |

- Default on save: Level 2 (Trusted)
- UI: ContactModal shows trust badge + level selector

---

## Priority: Next Phase

### 5. Remote API / RPC Framework
Evolve the protocol from messaging to **Remote Procedure Calls** (JSON-RPC). Trusted contacts (Level 3) can send signed commands that execute in the browser without human intervention.

- **Protocol:**
  - Request: `{ type: 'RPC', method: 'fs.list', params: { path: '/shared' }, id: '...', signature: '...' }`
  - Response: `{ type: 'RPC_RES', id: '...', result: [...] }`
  - Error: `{ type: 'RPC_RES', id: '...', error: { code: 403, message: 'Scope denied' } }`
- **Security:** Signature verified against stored public key. Method checked against granted scopes.
- **Scopes:** Path-based ACL syntax (`category:action:resource`)

| Category | Scope Syntax | Example | Use Case |
|:---------|:-------------|:--------|:---------|
| **Filesystem** | `fs:{action}:{path}` | `fs:read:/public/photos/*` | Browse shared folder |
| **Database** | `db:{action}:{key}` | `db:read:messages:timestamp>17000` | Sync new messages to another device |
| **Media** | `media:{action}:{source}` | `media:stream:camera:environment` | Baby monitor / sentinel mode |
| **System** | `sys:{action}` | `sys:status:battery` | Remote device health dashboard |

- **"Self-Hosted" Mesh Cloud:** Desktop at home with `fs:write:/incoming/*` granted to Phone. Phone sends photo via RPC. Desktop stores in OPFS. Serverless encrypted backup.

### 6. Signaling Resilience
- Debounce `handleNetworkChange` on desktop
- Cap total `new Peer()` calls per minute
- Clear UI indicator for rate-limited vs genuinely offline

---

## Completed (Build 18)

- Stale DataConnection fix (handleNetworkChange invalidates all conns)
- Message retry on reconnect (failed + unacked messages)
- Contact dedup by public key (migrateContact merges chats)
- File delete in chat UI
- Call logs in chat history (audio/video/screen, duration, missed/cancelled)
- nsTryJoin 8s timeout (fixes -p1 peer slot fallback)
- Namespace modal with join status + sequence steps
- Reconnect dedup (prevents 429 rate limit storms)
- ServiceWorker notifications for mobile PWA
- Learn More / Version buttons moved to sidebar footer
