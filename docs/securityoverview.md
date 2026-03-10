# PeerNS — Full Security Audit & Encryption Architecture
**Date:** March 2026  
**Scope:** p2p.ts, p2p-messaging.ts, p2p-group.ts, crypto.ts  

---

## 1. System Overview

PeerNS is a browser-based peer-to-peer communication platform using WebRTC DataChannels (via PeerJS) for direct peer connections. It supports 1:1 messaging, group chats, file transfer, and audio/video/screen calls. Identity is cryptographically established via ECDSA P-521 key pairs. Shared secrets for encryption are derived via ECDH. All persistent state is stored in `localStorage` and `IndexedDB`.

---

## 2. Current Cryptographic Architecture

### 2.1 Key Types In Use

| Key | Algorithm | Purpose | Where Generated | Where Stored |
|---|---|---|---|---|
| ECDSA private key | P-521 | Sign messages, prove identity | `generateKeyPair()` on first run | `localStorage` — **plaintext base64** |
| ECDSA public key | P-521 | Verify signatures, shared with peers | Same | `localStorage` — plaintext (acceptable) |
| ECDH private key | P-521 (re-imported) | Derive shared secrets | Derived from ECDSA private key at runtime | Memory only |
| Pairwise shared key | AES-256-GCM | Encrypt 1:1 messages | `deriveSharedKey()` per contact | Memory only (fingerprint cached to localStorage) |
| Group key | AES-256-GCM | Encrypt group messages | `generateGroupKey()` on group creation | `localStorage` — **plaintext base64** via `groupKeyBase64` |
| Group key history | AES-256-GCM (array) | Decrypt pre-rotation messages | Archived on key rotation | Memory only |

### 2.2 Key Derivation Chain (Current)

```
ECDSA P-521 keypair (localStorage, plaintext)
    │
    ├─► signData() / verifySignature()        [identity]
    │
    └─► ecdsaToECDHPrivate()                  [runtime only]
            │
            └─► deriveSharedKey(myECDH, theirECDH)
                    │
                    └─► HKDF-SHA256 → AES-256-GCM shared key  [memory only]
                                │
                                └─► encryptMessage() / decryptMessage()  [1:1 messages]

Group key (localStorage, plaintext base64)
    └─► encryptMessage() / decryptMessage()   [group messages]
    └─► encryptGroupKeyForPeer()              [key distribution, pairwise encrypted]
```

---

## 3. Full Data Inventory — At Rest

All data is stored in the browser via `localStorage` or `IndexedDB` (files via `saveFile()`).

### 3.1 localStorage Keys

| Key | Contents | Sensitivity | Currently Encrypted |
|---|---|---|---|
| `${APP_PREFIX}-sk` | ECDSA private key (base64 PKCS8) | **CRITICAL** | ❌ Plaintext |
| `${APP_PREFIX}-pk` | ECDSA public key (base64 SPKI) | Low (public) | ❌ Plaintext (acceptable) |
| `${APP_PREFIX}-pid` | PeerJS persistent ID | Medium | ❌ Plaintext |
| `${APP_PREFIX}-name` | User display name | Medium | ❌ Plaintext |
| `${APP_PREFIX}-disc-uuid` | Discovery UUID | Medium | ❌ Plaintext |
| `${APP_PREFIX}-contacts` | All contacts: names, PIDs, public keys, fingerprints, shared key fingerprints | **HIGH** | ❌ Plaintext |
| `${APP_PREFIX}-chats` | All 1:1 message history — fully decrypted content | **HIGH** | ❌ Plaintext |
| `${APP_PREFIX}-groups` | All group info: member lists, public keys, PIDs, group key base64 | **CRITICAL** | ❌ Plaintext |
| `${APP_PREFIX}-group-msgs-{id}` | All group message history — fully decrypted content | **HIGH** | ❌ Plaintext |
| `${APP_PREFIX}-lastread` | Per-contact read timestamps | Low | ❌ Plaintext |
| `${APP_PREFIX}-custom-ns` | Custom namespace names | Low | ❌ Plaintext |
| `${APP_PREFIX}-pid-history` | Historical PeerJS IDs | Low | ❌ Plaintext |
| `${APP_PREFIX}-offline` | Offline mode flag | None | ❌ Plaintext (acceptable) |
| `${APP_PREFIX}-fp-migrated` | Migration flag | None | ❌ Plaintext (acceptable) |
| `${APP_PREFIX}-ns-offline` | Namespace offline flag | None | ❌ Plaintext (acceptable) |
| `${APP_PREFIX}-credential-created` | WebAuthn setup flag (proposed) | None | N/A |

### 3.2 IndexedDB (File Storage)

| Data | Contents | Sensitivity | Currently Encrypted |
|---|---|---|---|
| File blobs | Raw file content from transfers | **HIGH** | ❌ Plaintext |
| File metadata | Name, size, timestamp, transfer ID | Medium | ❌ Plaintext |

### 3.3 Critical Finding — Group Key Exposure

The group encryption key is exported and stored plaintext in `localStorage`:

```typescript
// groupCreate() — p2p-group.ts
const groupKeyBase64 = await exportGroupKey(groupKey);
const info: GroupInfo = { ..., groupKeyBase64 };  // stored plaintext

// groupRestore() — on every app load
groupKey = await importGroupKey(info.groupKeyBase64);  // read from plaintext
```

This means anyone with localStorage access can decrypt **all past and future group messages** for every group the user belongs to, including post-rotation keys stored in `groupKeyHistory`.

---

## 4. Full Data Inventory — In Transit

All WebRTC DataChannel traffic is protected by **DTLS 1.2/1.3** at the transport layer (mandatory for WebRTC). The analysis below concerns **application-layer encryption** — i.e. protection that survives even if the transport layer were compromised.

### 4.1 PeerJS Signaling Server (`0.peerjs.com`)

**Transport:** TLS  
**Application E2E:** ❌ None — server is a trusted broker

| Data Visible to PeerJS | Notes |
|---|---|
| Your `persistentID` | Required for routing |
| Your IP address | Inherent to TCP connection |
| Who you connect to (PIDs) | Required for connection brokering |
| Timing of connections | Metadata/traffic analysis possible |

**Risk:** PeerJS can construct a social graph of who communicates with whom. Message content is not visible. This is an architectural constraint of the current design.

### 4.2 1:1 Messaging (DataChannel)

| Message Type | Wire Contents | App-Layer Encrypted | Signed |
|---|---|---|---|
| `hello` | `friendlyname`, `publicKey`, `ts`, `signature` | ❌ No | ✅ Yes (timestamp) |
| `message` (E2E path) | `iv`, `ct`, `sig`, `ts`, `id`, `e2e:true` | ✅ AES-256-GCM | ✅ Yes (ciphertext) |
| `message` (fallback) | `content`, `ts`, `id` | ❌ Plaintext | ❌ No |
| `message-ack` | `id` | ❌ No (metadata only) | ❌ No |
| `message-edit` (E2E) | `id`, `iv`, `ct`, `sig`, `e2e:true` | ✅ AES-256-GCM | ✅ Yes |
| `message-edit` (fallback) | `id`, `content` | ❌ Plaintext | ❌ No |
| `message-delete` | `id`, `tid` | ❌ No (metadata only) | ❌ No |
| `file-start` | `tid`, `name`, `size`, `total` | ❌ Plaintext | ❌ No |
| `file-chunk` | `tid`, `index`, raw `chunk` bytes | ❌ Plaintext | ❌ No |
| `file-end` | `tid` | ❌ No | ❌ No |
| `file-ack` | `tid` | ❌ No | ❌ No |
| `call-notify` | `kind`, `from` | ❌ Plaintext | ❌ No |
| `call-received/answered/rejected` | `kind` | ❌ Plaintext | ❌ No |
| `name-update` | `name` | ❌ Plaintext | ❌ No |
| `group-invite` | `groupId`, `groupName`, `inviterName`, `inviterFP`, full `info`, encrypted group key | Partial — group key encrypted pairwise ✅ | ❌ No |

### 4.3 Group Messaging (DataChannel via Router)

| Message Type | Wire Contents | App-Layer Encrypted | Notes |
|---|---|---|---|
| `group-checkin` | `fingerprint`, `friendlyName`, `publicKey`, `pid`, `sinceTs` | ❌ Plaintext | Discovery metadata |
| `group-message` | msg object with `iv`, `ct`, `e2e:true` OR plaintext fallback | ✅ AES-256-GCM (when key available) | Routed via group router node |
| `group-relay` | Same as above, opaque relay | ✅ Preserved from sender | Router relays without decrypting |
| `group-message-edit` | `msgId`, `iv`, `ct`, `e2e` OR plaintext | ✅ When key available | |
| `group-message-delete` | `msgId`, `senderFP` | ❌ Plaintext | |
| `group-file-start` | `tid`, `name`, `size`, `total`, `senderFP`, `senderName` | ❌ Plaintext | File name exposed |
| `group-file-chunk` | `tid`, `index`, `data` (base64) | ❌ Plaintext | Raw bytes, no encryption |
| `group-file-end` | `tid` | ❌ No | |
| `group-key-distribute` | `iv`, `ct` (group key encrypted pairwise) | ✅ AES-256-GCM pairwise | Secure distribution |
| `group-key-rotate` | `iv`, `ct` (new group key encrypted pairwise) | ✅ AES-256-GCM pairwise | Triggered on member leave/kick |
| `group-info-update` | Full `GroupInfo` including member PIDs, public keys | ❌ Plaintext | Broadcast by router |
| `group-backfill` | Historical messages (encrypted blobs if E2E) | ✅ Preserved encryption | |
| `group-call-start/join/leave` | `callId`, `kind`, `fingerprint`, `pid`, `name` | ❌ Plaintext | Call metadata only |
| `group-call-signal` | Call state, participant list with PIDs | ❌ Plaintext | |

### 4.4 Namespace / Discovery (DataChannel)

All namespace traffic is intentionally plaintext — it is discovery infrastructure analogous to DNS:

| Data | Encrypted | Notes |
|---|---|---|
| Router checkin (`discoveryID`, `friendlyname`, `publicKey`) | ❌ No | By design |
| Registry broadcasts (peer lists) | ❌ No | By design |
| Ping/pong | ❌ No | Keepalive only |
| Rendezvous exchange (PID updates) | ❌ No | Contact reconnection |
| Peer slot probes | ❌ No | NAT traversal |

**Risk Level:** Low-Medium. Namespace routers see peer identities and social graph but not message content. This is architecturally necessary for the discovery model.

### 4.5 Media (WebRTC MediaConnection)

| Type | Transport Encryption | App-Layer Encryption |
|---|---|---|
| Audio calls | ✅ DTLS-SRTP (mandatory WebRTC) | ❌ None |
| Video calls | ✅ DTLS-SRTP | ❌ None |
| Screen share | ✅ DTLS-SRTP | ❌ None |
| Group calls | ✅ DTLS-SRTP | ❌ None |

---

## 5. Threat Model Summary

### 5.1 Network Attacker (passive interception)
- **1:1 messages:** ✅ Protected — AES-256-GCM E2E
- **Group messages:** ✅ Protected — AES-256-GCM group key
- **Files:** ⚠️ DTLS only — not application E2E
- **Calls:** ⚠️ DTLS-SRTP only
- **Metadata (who talks to who):** ❌ Not protected

### 5.2 Local Device Attacker (localStorage access)
- **Private key:** ❌ Fully exposed — can impersonate user
- **All message history:** ❌ Fully readable
- **Group keys:** ❌ Fully exposed — can decrypt all group history
- **Contact list:** ❌ Fully readable
- **Files:** ❌ Fully readable from IndexedDB

### 5.3 Malicious Browser Extension
- **Same-origin extensions:** Can read all localStorage and IndexedDB
- **CryptoKey objects in memory:** Cannot export non-extractable keys but can invoke app functions
- **Mitigation available:** WebAuthn PRF binds key material to device authenticator

### 5.4 Compromised PeerJS Server
- **Message content:** ✅ Not visible (E2E encrypted)
- **Social graph:** ❌ Fully visible
- **Connection timing:** ❌ Visible

---

## 6. Proposed Solution: WebAuthn PRF + Tiered Encryption

### 6.1 Core Concept

Introduce a **master key** derived from a WebAuthn PRF credential bound to the device authenticator (Touch ID, Face ID, Windows Hello, device PIN). This master key:

- Never exists without user authentication
- Is derived deterministically — same output every authentication
- Is non-extractable from JavaScript memory
- Cannot be obtained from localStorage even if fully dumped
- Is cleared when the session locks

### 6.2 Revised Key Derivation Chain

```
Device Authenticator (Touch ID / Face ID / Windows Hello / PIN)
    │
    └─► WebAuthn PRF output (32 bytes, never stored)
            │
            └─► HKDF-SHA256 → Master AES-256-GCM key  [memory only, non-extractable]
                    │
                    ├─► Decrypt ECDSA private key from localStorage
                    │       │
                    │       └─► ecdsaToECDHPrivate()
                    │               │
                    │               └─► deriveSharedKey() → pairwise AES key  [memory]
                    │                       │
                    │                       └─► encrypt/decrypt 1:1 messages
                    │
                    ├─► Encrypt/decrypt all localStorage sensitive values
                    │
                    └─► Encrypt/decrypt group keys before localStorage write
```

### 6.3 Tiered Storage Model

#### Tier 1 — Always Plaintext (no sensitivity)
```
${APP_PREFIX}-offline
${APP_PREFIX}-ns-offline  
${APP_PREFIX}-fp-migrated
${APP_PREFIX}-credential-created
${APP_PREFIX}-pid-history  (acceptable, no content)
```

#### Tier 2 — Plaintext Metadata (needed before unlock for notifications)
```
Structure: { contacts: { [key]: { friendlyName, lastMessageTs, unreadCount } } }
Key: ${APP_PREFIX}-contact-meta

Available without master key. No PIDs, no public keys, no fingerprints.
Used to show: contact list with names, unread badges, notification sender name.
```

#### Tier 3 — Encrypted with Master Key (requires authentication)
```
${APP_PREFIX}-sk          → encrypted ECDSA private key
${APP_PREFIX}-contacts    → encrypted full contact records
${APP_PREFIX}-chats       → encrypted message history
${APP_PREFIX}-groups      → encrypted group info (including groupKeyBase64)
${APP_PREFIX}-group-msgs-{id} → encrypted group message history
${APP_PREFIX}-disc-uuid   → encrypted discovery UUID
${APP_PREFIX}-name        → encrypted display name (or keep plaintext — judgment call)
IndexedDB file blobs      → encrypted with master key before write
```

### 6.4 Session Lifecycle

```
App Loads
    │
    ├─► Load Tier 1 + Tier 2 immediately
    │       Show contact list with names, unread counts
    │       DataChannels reopen (signaling reconnects)
    │
    ├─► WebAuthn prompt (biometric/PIN)
    │       First run: createAuthCredential() → register with PRF extension
    │       Subsequent: navigator.credentials.get() with PRF extension
    │
    ├─► PRF output → HKDF → master key (memory only)
    │
    ├─► Decrypt Tier 3 → full app state available
    │       Load private key, contacts, chats, group keys
    │
    ├─► [Normal operation]
    │
    ├─► Idle timeout (15 min) OR tab hidden OR explicit lock
    │       masterKey = null
    │       Dispatch 'session-locked' event
    │       UI shows lock screen
    │
    ├─► Incoming message while locked
    │       DataChannel still open (WebRTC survives lock)
    │       Cannot decrypt — store encrypted blob
    │       Notification: "[Contact Name]: New message" (from Tier 2 metadata)
    │       On unlock → decrypt stored blob → show content
    │
    └─► User taps notification → WebAuthn prompt → unlock → full access
```

### 6.5 Fallback Strategy (Browser Compatibility)

```
WebAuthn PRF available? (Chrome 116+, Edge 116+, partial Safari)
    ├── Yes → Full biometric/PIN protection (described above)
    └── No  → PBKDF2 from user password
                  PBKDF2(password, random salt, 600000 iterations, SHA-256)
                  → AES-256-GCM master key
                  Salt stored plaintext in localStorage
                  Password never stored
                  Same tiered storage model applies
                  Weaker: password can be brute-forced offline if storage is stolen
```

---

## 7. Implementation Strategy

### Phase 1 — Foundation (crypto.ts additions)

Add to `crypto.ts`:
- `createAuthCredential(userId)` — register WebAuthn credential with PRF
- `getMasterKeyMaterial()` — authenticate and retrieve PRF output
- `deriveMasterKey(prfOutput)` — HKDF to non-extractable AES-256 master key
- `encryptForStorage(masterKey, plaintext)` — AES-GCM, IV prepended to blob
- `decryptFromStorage(masterKey, blob)` — reverse of above
- `deriveMasterKeyFromPassword(password, salt)` — PBKDF2 fallback
- Browser capability detection helper

### Phase 2 — Store Layer (store.ts)

Modify all read/write functions to accept an optional `masterKey` parameter:
- `saveChats(chats, masterKey?)` — encrypt before write if key provided
- `loadChats(masterKey?)` — decrypt after read if key provided
- `saveContacts(contacts, masterKey?)` / `loadContacts(masterKey?)`
- `saveGroups(infos, masterKey?)` / `loadGroups(masterKey?)`
- `saveGroupMessages(id, msgs, masterKey?)` / `loadGroupMessages(id, masterKey?)`
- `saveFile(tid, blob, name, ts, masterKey?)` — encrypt blob before IndexedDB write
- New: `saveContactMeta(meta)` / `loadContactMeta()` — Tier 2 plaintext metadata

### Phase 3 — P2PManager Integration (p2p.ts)

In `loadState()`:
1. Load Tier 1 + Tier 2 immediately, emit preliminary status
2. Check `credential-created` flag
3. If not created: call `createAuthCredential()`, set flag
4. Call `getMasterKeyMaterial()` (triggers biometric/PIN prompt)
5. If PRF fails → try PBKDF2 fallback flow
6. If both fail → dispatch `'auth-required'` event, halt init
7. Store `masterKey` on `P2PManager` instance (memory only)
8. Decrypt Tier 3, continue normal init

Add to `P2PManager`:
- `public masterKey: CryptoKey | null = null`
- `public sessionLocked: boolean = false`
- `public lockSession()` — clears masterKey, emits `'session-locked'`
- `public async unlockSession()` — re-runs WebAuthn flow
- Idle timer with `visibilitychange` + pointer event reset
- `pagehide` handler to null out masterKey

### Phase 4 — Messaging Updates (p2p-messaging.ts)

When session is locked and a message arrives:
```typescript
if (!mgr.masterKey) {
  // Store raw encrypted payload — cannot decrypt now
  const pendingMsg = { id: d.id, encryptedPayload: d, ts: d.ts, ck };
  mgr.pendingEncrypted = mgr.pendingEncrypted || [];
  mgr.pendingEncrypted.push(pendingMsg);
  
  // Notify with metadata only (from Tier 2)
  const fname = loadContactMeta()[ck]?.friendlyName || 'Someone';
  mgr.notify(fname, 'New message', `msg-${ck}`);
  return;
}
// Normal decrypt flow continues...
```

On `unlockSession()` success:
```typescript
// Decrypt and process all pending payloads
for (const pending of mgr.pendingEncrypted || []) {
  await handlePersistentData(mgr, pending.encryptedPayload, pending.conn);
}
mgr.pendingEncrypted = [];
```

### Phase 5 — Group Key Protection (p2p-group.ts)

The `groupKeyBase64` field currently stored plaintext in `GroupInfo` must be encrypted:

- On `groupSave()`: encrypt `groupKeyBase64` with master key before writing
- On `groupRestore()`: decrypt `groupKeyBase64` with master key after reading
- `groupKeyHistory` (in-memory array of `CryptoKey`) — never persisted, acceptable
- Group key distribution messages (`group-key-distribute`, `group-key-rotate`) already use pairwise ECDH encryption — ✅ no change needed

### Phase 6 — File Encryption

For files stored in IndexedDB:
```typescript
// saveFile() with encryption
const iv = crypto.getRandomValues(new Uint8Array(12));
const encryptedBlob = await crypto.subtle.encrypt(
  { name: 'AES-GCM', iv },
  masterKey,
  await blob.arrayBuffer()
);
// Store: iv (12 bytes) + encrypted content
```

For file transfers — add application-layer encryption to `_sendFileNow()`:
```typescript
// Before chunking, encrypt the entire buffer with pairwise shared key
const sk = await mgr.getOrDeriveSharedKey(contactKey);
if (sk) {
  const { iv, ct } = await encryptFileBuffer(sk.key, buf);
  // Send iv in file-start, chunks are from encrypted ct
  // Receiver decrypts after reassembly
}
```

---

## 8. Remaining Accepted Risks (Post-Implementation)

| Risk | Severity | Accepted Reason |
|---|---|---|
| JS memory cannot be zeroed | Low | Browser limitation; non-extractable keys mitigate |
| Master key usable by same-origin extensions | Low-Medium | Requires malicious extension with host permission |
| PeerJS social graph visibility | Medium | Architectural; self-hosting PeerJS server eliminates |
| Call metadata visible to router peers | Low | Call content protected by DTLS-SRTP |
| Namespace discovery exposes display name | Low | By design for discovery |
| WebAuthn not available on all browsers | Medium | PBKDF2 fallback covers this |
| Group file transfers still transport-only | Low-Medium | Phase 6 addresses; complexity tradeoff |

---

## 9. Priority Order

| Priority | Item | Impact |
|---|---|---|
| P0 | Encrypt ECDSA private key at rest | Critical — full identity compromise possible |
| P0 | Encrypt group key at rest | Critical — all group history decryptable |
| P1 | Encrypt all message history at rest | High — full conversation history exposed |
| P1 | Encrypt contacts at rest | High — social graph + public keys exposed |
| P2 | Locked-session message handling | High — enables secure background operation |
| P2 | File encryption at rest (IndexedDB) | Medium-High |
| P3 | File transfer E2E encryption | Medium |
| P3 | PBKDF2 fallback for unsupported browsers | Medium |
| P4 | Idle session auto-lock | Low-Medium |
| P4 | Self-hosted PeerJS (eliminate social graph) | Low |
