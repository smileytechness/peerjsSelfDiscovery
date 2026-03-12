# PeerNS — Revised Full Security Audit
**Date:** March 2026  
**Scope:** p2p.ts, p2p-messaging.ts, p2p-group.ts, p2p-handshake.ts, p2p-ns.ts, p2p-rvz.ts, crypto.ts  
**Revision note:** This document supersedes the original audit. Section 6 of the original audit incorrectly concluded that the static ECDH layer was redundant and recommended its removal. That recommendation is retracted. See §6 for full correction.

---

## 1. Security Category Framework

This audit evaluates all channels across three distinct threat categories. The original audit collapsed these into only two, which caused the flawed Phase 5 recommendation.

| Category | Definition |
|---|---|
| **Passive in-transit** | Attacker intercepts wire traffic but cannot modify or inject |
| **Active MITM / session spoofing** | Attacker terminates the DTLS session and substitutes themselves as a participant |
| **At-rest** | Attacker has direct access to localStorage and IndexedDB on the device |

---

## 2. Critical Distinction — ECDH Challenge vs ECDSA

Before evaluating individual channels, this distinction must be established clearly because the original audit confused these two tools throughout.

**ECDSA answers: "Who authored this specific piece of data?"**

ECDSA produces a signature over a specific payload. The receiver can verify that the holder of a particular private key signed that exact payload. This is the right tool for per-message authorship — proving that a specific message was written by a specific person, not just that the channel is theirs.

```typescript
// From sendEncryptedMessage() — ECDSA used correctly:
const { iv, ct } = await encryptMessage(sk.key, msg.content);
const sig = await signData(mgr.privateKey, ct);  // proves Alice authored this ciphertext
conn.send({ type: 'message', iv, ct, sig, e2e: true });
```

This is sound. Even if the ECDH session is somehow compromised or a relay injects traffic, the ECDSA signature on each ciphertext proves the specific message came from the holder of Alice's private key at that moment.

**ECDH challenge answers: "Are you who you claim to be right now?"**

An ECDH challenge proves live private key possession by requiring the peer to decrypt something only they can decrypt. The receiver encrypts a random secret to the peer's public key. Only the holder of the corresponding private key can decrypt it and respond correctly. No signature needed — the ability to decrypt is the proof.

```typescript
// Proposed challenge-response — ECDH used correctly for identity:
const randomSecret = crypto.getRandomValues(new Uint8Array(32));
const challenge = await ECDH_encrypt(theirPublicKey, randomSecret);
conn.send({ type: 'challenge', challenge });
// Only the real peer can decrypt this and send back randomSecret
```

**Why ECDSA alone fails for session identity:**

The current hello handshake uses ECDSA to sign a timestamp:
```typescript
const sig = await signData(mgr.privateKey, ts);
conn.send({ type: 'hello', publicKey, ts, signature: sig });
```

This is the wrong tool for the job. A timestamp signature is a static artifact — it is equally valid whether presented by Alice or by Mallory who captured it from Alice. ECDSA correctly answers "did Alice sign this timestamp?" but the question that needs answering is "is Alice on the other end of this connection right now?" Those are fundamentally different questions and ECDSA cannot answer the second one without a fresh challenge to sign.

**The rule going forward:**

| Use case | Correct tool | Wrong tool |
|---|---|---|
| Session identity — "are you who you claim to be?" | ECDH challenge | ECDSA on static data |
| Message authorship — "did you write this specific message?" | ECDSA on message content | ECDH challenge |

Every instance of ECDSA in the codebase is evaluated against this rule below.

---

## 3. Current Cryptographic Architecture

### 3.1 What Is Already In Place

**DTLS 1.2/1.3** is mandatory for all WebRTC DataChannels and MediaConnections. It is enforced by the browser and cannot be disabled. Every channel in the system — 1:1, group, discovery, namespace, calls — already has DTLS transport encryption. This is not in question and does not need to be added anywhere.

**ECDSA P-521 identity keys** are generated on first run and stored in localStorage. Every outgoing persistent connection sends a `hello` packet signed with the private key. The receiving peer verifies the signature before proceeding. As established in §2, this is the wrong tool for session identity — ECDH challenge is needed here instead.

**ECDH shared key derivation** uses the same P-521 curve points re-imported for ECDH. Both peers independently derive the same AES-256-GCM key from their private key and the peer's public key. This key encrypts 1:1 message content at the application layer on top of DTLS, and is the last line of defense against active MITM attacks.

**Group AES-256-GCM key** is generated per group, encrypted pairwise via ECDH, and distributed over the group namespace connection. Group messages are encrypted with this key at the application layer.

### 3.2 The Hello Handshake — Wrong Tool, Right Instinct

The hello handshake correctly identifies that session identity needs cryptographic verification. But it uses ECDSA on a static timestamp, which as established in §2 is replayable. The instinct to verify identity is correct; the implementation needs replacing with an ECDH challenge.

Additionally, no timestamp freshness check exists in the current code — `handlePersistentData()` verifies the signature is valid but never checks whether `ts` is recent. A captured hello from a previous session passes verification indefinitely. This is a partial mitigation worth adding, but does not address the fundamental problem since a live MITM receives the hello in real time anyway.

---

## 4. Full Channel Security Inventory — In-Transit

### 4.1 1:1 Messaging

| Protection Layer | Status | Notes |
|---|---|---|
| DTLS transport | ✅ Present | Mandatory WebRTC |
| ECDSA hello verification | ⚠️ Wrong tool | Present but replayable — ECDSA on timestamp proves nothing about live session identity. Needs ECDH challenge replacement. |
| ECDSA timestamp freshness | ❌ Missing | No `Math.abs(Date.now() - ts) > 30000` check — partial mitigation worth adding |
| ECDH message encryption | ✅ Correct | AES-256-GCM with HKDF-derived key — last line of defense against active MITM |
| ECDSA signature on ciphertext | ✅ Correct tool | Sender signs `ct` — this is message authorship, the right use of ECDSA. Receiver verifies before decrypt. |

**Verdict:** 1:1 messages have the strongest protection in the system. The ECDH encryption and per-message ECDSA authorship signatures are both correct and must be retained. The hello identity check needs replacing with an ECDH challenge — it is currently replayable and vulnerable to the hello proxy attack described in §6.

### 4.2 1:1 Files

| Protection Layer | Status | Notes |
|---|---|---|
| DTLS transport | ✅ Present | |
| Hello identity check | ⚠️ Wrong tool | Same replayable ECDSA hello as 1:1 messages |
| ECDH file encryption | ❌ Missing | `file-start`, `file-chunk`, `file-end` sent plaintext in `_sendFileNow()` |
| ECDSA authorship on file | ❌ Missing | No per-chunk or per-transfer signature |

**Verdict:** File content is fully exposed under active MITM. No application-layer encryption, no authorship proof. Protected against passive interception by DTLS only.

### 4.3 1:1 Calls

| Protection Layer | Status | Notes |
|---|---|---|
| DTLS-SRTP transport | ✅ Present | Mandatory WebRTC media |
| Call identity verification | ❌ None | Call identity inherits entirely from the hello handshake — if that was spoofed, the call is with the attacker. DTLS-SRTP encrypts to whoever is on the connection. |
| ECDH challenge on call token | ❌ Missing | No independent identity verification at call layer |

**Verdict:** Call content is fully exposed if the hello identity was spoofed via the proxy attack. DTLS-SRTP encrypts to whoever Bob believes is Alice — if that is Mallory, Mallory receives the call content. SRTP provides no protection once session identity is compromised. A signed call token would not help here either — a token signed with ECDSA is equally replayable. What is needed is an ECDH challenge at call initiation to independently verify identity.

**Locked-session interaction:** The ECDH challenge requires live private key access to decrypt. If the callee's device is locked when `call-notify` arrives, the private key is not in memory and the challenge cannot be answered. See §6.3 for the required two-phase call flow that gates the challenge behind the unlock step.

### 4.4 Group Messages

| Protection Layer | Status | Notes |
|---|---|---|
| DTLS transport | ✅ Present | All group hops are DTLS |
| ECDSA on group checkin | ❌ Missing | `groupSendCheckin()` sends `fingerprint`, `publicKey`, `pid` unsigned — wrong tool anyway, ECDH challenge needed for identity |
| Group AES-256-GCM encryption | ✅ Present | `groupSendMessage()` encrypts content with `state.groupKey` |
| Pairwise ECDH for key distribution | ✅ Correct | `group-key-distribute` uses pairwise ECDH — correct tool, distributes key securely |
| Group key rotation on member leave/kick | ✅ Present | `groupRotateKey()` called appropriately |

**Verdict:** Group message content is well protected. Even a spoofed checkin cannot obtain the group key — it is distributed encrypted pairwise via ECDH to verified member public keys, which the attacker cannot decrypt without the corresponding private key. The checkin identity weakness is a metadata issue (fake presence) rather than a content confidentiality issue. Group AES must not be removed. See §6.

### 4.5 Group Files

| Protection Layer | Status | Notes |
|---|---|---|
| DTLS transport | ✅ Present | |
| Sender identity verification | ❌ Missing | `group-file-start` carries `senderFP` and `senderName` unsigned and unverified |
| Application encryption | ❌ Missing | Chunks sent plaintext |

**Verdict:** Group file content fully exposed under active MITM. Same posture as 1:1 files.

### 4.6 Group Calls

| Protection Layer | Status | Notes |
|---|---|---|
| DTLS-SRTP transport | ✅ Present | |
| Call identity verification | ❌ None | Same problem as 1:1 calls — inherits spoofed session identity |
| ECDH challenge on call token | ❌ Missing | No independent identity verification at call layer |

**Verdict:** Identical posture to 1:1 calls. DTLS-SRTP encrypts to the attacker's session if identity was spoofed. Call content fully exposed under active MITM. Same locked-session constraint applies — see §6.3.

### 4.7 Namespace / Discovery

| Protection Layer | Status | Notes |
|---|---|---|
| DTLS transport | ✅ Present | |
| Identity verification | ❌ None (by design) | Discovery is a public bulletin board — verification here is redundant since the persistent connection hello (once fixed with ECDH challenge) is the real identity gate |
| Application encryption | ❌ None (by design) | Intentionally public |

**Verdict:** Namespace traffic is intentionally public. Adding identity verification here would be defending the lobby when the real security gate is the hello handshake at the persistent connection layer. Any spoofed namespace entry still has to pass the ECDH challenge hello to establish a usable session. Accepted design tradeoff.

> **Feature Note — Trusted Namespaces (Conceptual)**
>
> A password-protected namespace variant could allow automatic mutual contact establishment for all verified members, bypassing the manual per-contact persistent connection setup while reusing the existing ECDH challenge infrastructure. Would be vulnerable to offline password hashing.
>
> **Out of scope for this audit.** Recorded here as a design direction.

### 4.8 Rendezvous (p2p-rvz.ts)

| Protection Layer | Status | Notes |
|---|---|---|
| DTLS transport | ✅ Present | |
| ECDSA on rvz-exchange | ⚠️ Wrong tool | Same problem as hello — ECDSA on a timestamp is replayable. A captured rvz-exchange can be replayed to poison Bob's PID mapping for Alice, setting up the hello proxy attack. |
| Content sensitivity | ❌ None | Only PIDs and public keys exchanged — public data, nothing to encrypt |

**Verdict:** The ECDSA signature on the rvz-exchange is the wrong tool for the same reason as the hello — it proves Alice once signed a timestamp, not that Alice is present right now. A replayed exchange poisons Bob's PID mapping and triggers a reconnect to the attacker's PID, which then sets up the hello proxy attack. Needs ECDH challenge replacement. Practical exploitability is low since finding the rvz namespace requires either PeerJS server access or knowledge of the pairwise ECDH shared key, but the structural weakness is the same.

---

## 5. In-Transit Security Summary Table

| Channel | Passive Intercept | Active MITM — Content | Active MITM — Identity |
|---|---|---|---|
| 1:1 messages | ✅ DTLS | ✅ ECDH (last line of defense) | ⚠️ ECDSA present but wrong tool — replayable, needs ECDH challenge |
| 1:1 files | ✅ DTLS | ❌ Plaintext exposed | ⚠️ ECDSA present but wrong tool — replayable |
| 1:1 calls | ✅ DTLS-SRTP | ❌ Fully exposed if identity spoofed — SRTP encrypts to attacker's session | ❌ No independent verification — inherits spoofed hello identity |
| Group messages | ✅ DTLS | ✅ Group AES (last line of defense) | ⚠️ Checkin identity unverified — spoofed checkin possible, but group key is pairwise ECDH encrypted so attacker cannot decrypt it |
| Group files | ✅ DTLS | ❌ Plaintext exposed | ❌ No verification on file sender |
| Group calls | ✅ DTLS-SRTP | ❌ Fully exposed if identity spoofed — SRTP encrypts to attacker's session | ❌ No independent verification — inherits spoofed hello identity |
| Namespace/discovery | ✅ DTLS | ❌ None (by design) | ❌ None (by design — identity gate is at hello layer) |
| Rendezvous | ✅ DTLS | ❌ Public data only | ⚠️ ECDSA present but wrong tool — replayable, PID poisoning possible though low practical risk |

---

## 6. At-Rest Security Inventory

All sensitive data is stored in plaintext. There is no encryption at rest. This is the highest priority remediation item.

| Data | Storage | Sensitivity | Currently Encrypted |
|---|---|---|---|
| ECDSA private key (`-sk`) | localStorage | **CRITICAL** — full identity compromise | ❌ Plaintext base64 |
| All 1:1 message history (`-chats`) | localStorage | **HIGH** | ❌ Plaintext |
| All group message history (`-group-msgs-*`) | localStorage | **HIGH** | ❌ Plaintext |
| Contact records including public keys (`-contacts`) | localStorage | **HIGH** | ❌ Plaintext |
| Group info (`-groups`) | localStorage | **HIGH** | ❌ Plaintext |
| File blobs | IndexedDB | **HIGH** | ❌ Plaintext |
| PeerJS ID, display name, flags | localStorage | Low | ❌ Plaintext (acceptable) |
| Discovery UUID, PID history | localStorage | None — public identifiers | ❌ Plaintext (acceptable) |

**Note on group key at rest:** The group AES key is stored plaintext in `groupKeyBase64` alongside the group info. This is irrelevant to at-rest security — group messages are themselves stored in plaintext, so an attacker with localStorage access already has the content directly without needing the key. The group AES key only matters for in-transit protection and preventing spoofed checkins from decrypting relayed messages.

### **Proposed remediation for data-at-rest:** 
WebAuthn PRF-derived master key (AES-256-GCM) encrypts all HIGH/CRITICAL tier storage. PBKDF2 password fallback for browsers without PRF support. Full tiered model below.

### 6.1 Tiered Storage Model

#### Tier 1 — Always Plaintext
No sensitivity. Public identifiers or operational flags.
```
${APP_PREFIX}-offline
${APP_PREFIX}-ns-offline
${APP_PREFIX}-fp-migrated
${APP_PREFIX}-credential-created
${APP_PREFIX}-name              (display name — not sensitive)
${APP_PREFIX}-pid               (PeerJS ID — broadcast openly to signaling server)
${APP_PREFIX}-pid-history       (historical PeerJS IDs — public network identifiers)
${APP_PREFIX}-disc-uuid         (discovery UUID — broadcast openly to all namespace routers)
${APP_PREFIX}-custom-ns         (namespace names — broadcast openly during discovery)
```

#### Tier 2 — Plaintext Metadata (pre-unlock notifications only)
Minimal data needed to render contact list and show notification sender name while session is locked. No PIDs, no public keys, no fingerprints, no message content.
```
Key: ${APP_PREFIX}-contact-meta
Contents: { [contactKey]: { friendlyName, lastMessageTs, unreadCount } }
```

#### Tier 3 — Encrypted with Master Key
All sensitive data. Encrypted before write, decrypted after authentication.
```
${APP_PREFIX}-sk                  ECDSA private key
${APP_PREFIX}-contacts            full contact records including public keys
${APP_PREFIX}-chats               all 1:1 message history
${APP_PREFIX}-groups              group info and member lists
${APP_PREFIX}-group-msgs-{id}     group message history
IndexedDB file blobs              encrypted before write, decrypted on load
```

### 6.2 Master Key Derivation and Session Lifecycle

```
Device Authenticator (Touch ID / Face ID / Windows Hello / PIN)
    │
    └─► WebAuthn PRF output [32 bytes, never stored, computed in hardware]
            │
            └─► HKDF-SHA256 → Master AES-256-GCM key [memory only, non-extractable]
                    │
                    ├─► Decrypt ECDSA private key → available for ECDH challenges + message signing
                    │
                    ├─► Encrypt/decrypt all Tier 3 localStorage values
                    │
                    └─► Encrypt/decrypt all IndexedDB file blobs

Session Lifecycle:
    App opens
        Load Tier 1 + Tier 2 → show contact list, unread counts
        WebAuthn prompt → biometric / PIN
        PRF → HKDF → master key (memory only)
        Decrypt Tier 3 → full app available

    Idle 15 min / tab hidden / explicit lock
        masterKey = null
        UI shows lock screen

    Incoming message while locked
        DataChannel still open (WebRTC persists)
        Store raw payload — cannot decrypt
        Notify: "[Name]: New message" (Tier 2 only)
        On unlock → re-process stored payloads

    Incoming call while locked
        See §6.3 — call flow requires special handling distinct from messages.
        call-notify stored and surfaced via Tier 2 metadata only.
        ECDH challenge deferred until user taps Answer and unlock completes.

    User unlocks
        WebAuthn prompt again → same PRF output → same master key
        Decrypt pending payloads → full access restored
        Resume any deferred call challenge-response flows

Fallback (WebAuthn PRF unavailable — older browsers):
    PBKDF2(userPassword, storedSalt, 600_000 iterations, SHA-256) → master key
    Same tiered model applies
    Weaker: offline dictionary attack possible if storage + salt stolen
    Salt stored plaintext in Tier 1
```

### 6.3 Locked-Session Call Handling — Two-Phase Flow

Incoming calls present a specific conflict with the ECDH challenge requirement: the challenge requires the callee's private key to decrypt, but the private key is not in memory while the session is locked. The call flow must be split into two distinct phases with the unlock gate between them.

**Phase 1 — Notification (no private key required)**
- `call-notify` arrives on locked device over the persistent open DataChannel
- Stored as a pending call payload; cannot be cryptographically processed yet
- Lock screen renders caller name and call UI using Tier 2 metadata only
- No challenge is issued or answered at this stage

**Phase 2 — Answer gate (private key required, fires before media opens)**
- User taps Answer → WebAuthn prompt fires immediately
- Biometric/PIN → PRF → master key → private key decrypted into memory
- ECDH challenge-response executes now, proving both sides' live key possession
- Only on successful challenge completion does the call DataChannel and media negotiation proceed
- Challenge failure → call rejected, no media flows, user notified

```
Caller                              Callee (locked)
──────                              ───────────────
send call-notify ──────────────►  store payload, show lock screen UI
                                            │
                                      user taps Answer
                                            │
                                      WebAuthn unlock
                                            │
                                      private key in memory
                                            │
◄────────── call-answer ────────────────────┘
send ECDH challenge ───────────►
◄────── challenge-response ─────  decrypt challenge, sign, respond
verify response
        │
    [pass] → open media channel
    [fail] → reject, notify both sides
```

**Implementation notes:**
- The caller must hold an extended "awaiting answer" state. The ring timeout must not start from `call-notify` receipt but from when the callee's app acknowledges it — giving the user time to notice and tap Answer. From Answer tap to connected, the expected latency is under 1 second: biometric prompt typically completes in ~300ms, and the ECDH challenge-response is a handful of crypto operations over an already-open DataChannel. The ring timeout is a UX concern; the challenge itself is not a meaningful source of delay.
- DTLS-SRTP negotiation may proceed in parallel with the challenge, but the media channel must not open until the challenge completes successfully. Negotiation and identity verification are independent steps; completion of DTLS alone is not sufficient.
- A challenge timeout on an incoming call from a known contact should surface a visible failure notice — not a silent drop. A proxy attack attempting to answer on Alice's behalf would stall at the challenge step; surfacing this failure is useful signal to the user.
- The ECDSA authorship signature on `call-notify` is still valuable here: even before unlock, the lock screen can confirm that Alice's key produced the notification, providing Tier 2-level authenticity on the caller display name.

---

## 7. Why DTLS + Current ECDSA Alone Is Insufficient — The Hello Proxy Attack

### 7.1 The Attack Requires No Server Compromise

**This attack does not require compromising PeerJS or any network infrastructure.** Because PeerNS is open source, any technically capable actor can clone the repository, add approximately 20 lines of code, and execute this attack against any two contacts they share. The attacker needs only to be a mutual contact of both Alice and Bob — a completely normal social condition in any messaging app.

The attack in plain terms:

1. Mallory is a saved contact of both Alice and Bob — two ordinary, legitimate connections
2. Alice connects to Mallory and sends her `hello` — Mallory receives it in plaintext over their legitimate DTLS channel
3. Mallory opens her own legitimate DTLS connection to Bob
4. Mallory forwards Alice's `hello` packet verbatim to Bob
5. Bob's app runs `verifySignature()` — it passes, because Alice genuinely did sign that timestamp
6. Bob's app stores the connection as Alice and begins communicating. He is talking to Mallory.

No PeerJS modification. No network interception. No cryptographic attack. Just modified app code proxying a hello across two legitimate connections.

### 7.2 Sample Exploit — Modified p2p-messaging.ts

The following demonstrates precisely how the current codebase would be modified to execute this attack. The addition is minimal. The false verification follows directly from the existing `verifySignature()` call in `handlePersistentData()`, which has no way to detect the substitution.

```typescript
// ─── EXPLOIT: hello-proxy attack ─────────────────────────────────────────
// Mallory adds this map at module scope to cache incoming hellos from contacts
const capturedHellos: Map<string, any> = new Map();

// ─── STEP 1: Mallory intercepts Alice's hello on her legitimate connection ──
// This runs inside Mallory's handlePersistentData() when Alice connects.
// No modification to the hello processing itself — Mallory just caches it.
if (d.type === 'hello') {
  // Store Alice's complete hello packet indexed by her public key fingerprint
  capturedHellos.set(d.publicKey, d);
  // ... normal hello processing continues unchanged ...
}

// ─── STEP 2: Mallory proxies Alice's hello to Bob ───────────────────────────
// Mallory calls this after Alice's hello arrives and Bob's connection opens.
async function proxyHelloToContact(
  malloryMgr: P2PManager,
  alicePublicKey: string,   // Alice's pubkey — used to look up her captured hello
  bobContactKey: string     // Bob's contact key in Mallory's contact list
) {
  const aliceHello = capturedHellos.get(alicePublicKey);
  if (!aliceHello) return;

  const bobContact = malloryMgr.contacts[bobContactKey];
  if (!bobContact?.conn?.open) return;

  // Forward Alice's hello packet byte-for-byte to Bob's open connection.
  // Mallory does NOT send her own hello — she sends Alice's.
  bobContact.conn.send({
    type:         'hello',
    friendlyname: aliceHello.friendlyname,  // Alice's display name
    publicKey:    aliceHello.publicKey,     // Alice's actual public key
    ts:           aliceHello.ts,            // Alice's original timestamp
    signature:    aliceHello.signature,     // Alice's valid ECDSA signature
  });
}

// ─── STEP 3: Bob's unmodified app false-verifies ────────────────────────────
// The following is the EXISTING unmodified code in Bob's handlePersistentData().
// No changes needed on Bob's side — the exploit works against the stock app.

// From p2p-messaging.ts (existing, unmodified):
if (d.publicKey && d.signature && d.ts) {
  if (window.crypto?.subtle) {
    try {
      const key = await importPublicKey(d.publicKey);              // Alice's real pubkey ✅
      const valid = await verifySignature(key, d.signature, d.ts); // Alice's real sig ✅
      if (!valid) {
        mgr.log(`Invalid signature from ${d.friendlyname}`, 'err');
        conn.close();  // ← This never fires. Signature is genuinely valid.
        return;
      }
      // Bob's app reaches here and concludes: "Alice is verified."
      // The connection is stored under Alice's fingerprint.
      // Bob is talking to Mallory.
      mgr.contacts[contactKey].publicKey = d.publicKey;
      mgr.log(`Verified identity for ${d.friendlyname}`, 'ok'); // ← Logs: verified ✅
      mgr.getOrDeriveSharedKey(contactKey); // Derives ECDH key to Alice's pubkey — useless to Mallory
    } catch { }
  }
}
```

### 7.3 What Mallory Obtains From This Attack

```
Bob sends Mallory (believing she is Alice):

  ✅ All file transfers        — file-start/chunk/end are plaintext, fully readable
  ✅ All incoming calls        — call-notify arrives, Mallory answers
  ✅ All call content          — DTLS-SRTP encrypts to Mallory's session, not Alice's
  ✅ All call metadata         — who is calling, what kind, timing
  ✅ Group file transfers      — same plaintext exposure
  ✅ All unsigned metadata     — name updates, read receipts, call notifications

  ❌ 1:1 message content      — encrypted to Alice's public key via ECDH
                                 Mallory cannot derive the shared key without Alice's private key
  ❌ Group message content     — encrypted with group AES key distributed via pairwise ECDH
                                 Mallory was not a member when the key was distributed
```

The ECDH encryption on messages and the group AES layer are what prevent this from being a complete session compromise. They must not be removed.

### 7.4 Why Timestamp Freshness Does Not Close This Gap

Adding a 30-second timestamp freshness check shrinks replay windows for stored old sessions but has no effect on this attack. Mallory receives Alice's hello in real time on their legitimate connection. The forwarded hello is therefore always fresh — its timestamp is seconds old, well within any reasonable window. The check is worth adding as defense-in-depth but does not address the structural problem.

### 7.5 The ECDH Challenge Solution

As established in §2, ECDH challenge is the correct tool for session identity because it requires live private key possession to produce a valid response. A captured hello cannot respond to a fresh challenge it has never seen:

```typescript
// Step 1 — Bob → Alice: fresh challenge encrypted to Alice's public key
const randomSecret = crypto.getRandomValues(new Uint8Array(32));
const challenge = await ECDH_encrypt(alicePublicKey, randomSecret);
conn.send({ type: 'challenge', challenge });

// Step 2 — Alice → Bob: decrypts and signs the secret (proving both possession and authorship)
const decrypted = await ECDH_decrypt(myPrivateKey, challenge);
const response = await signData(myPrivateKey, decrypted);
conn.send({ type: 'challenge-response', response });

// Step 3 — Bob verifies:
const valid = await verifySignature(alicePublicKey, response, randomSecret);
if (!valid) conn.close();
```

Mallory cannot execute the proxy attack against this. She receives a challenge encrypted to Alice's public key. She cannot decrypt it. She cannot produce a valid response. The connection closes.

Note that ECDSA still appears in step 2 — but now in its correct role, signing the decrypted challenge to prove authorship of the response, not signing a static timestamp. The ECDH decryption proves live key possession; the ECDSA signature proves the response was actively produced by the same key, not just forwarded.

### 7.6 ECDH Message Encryption Must Be Retained

Until the ECDH challenge handshake is deployed, the ECDH application-layer encryption on messages is the only control preventing full content exposure under the hello proxy attack. Even after the challenge handshake is deployed, ECDH encryption provides independent defense-in-depth against any authentication bypass not yet anticipated. Removing a working encryption layer because authentication improved is not sound security practice.

**The ECDH layer must not be removed under any circumstances.**

### 7.7 Group AES Encryption Must Be Retained

The group AES layer serves the same role for group channels. Without it, any peer that succeeds in spoofing group channel identity would receive group message content in plaintext. The pairwise ECDH protection on key distribution means a spoofed checkin still cannot obtain the group key — but the AES layer is the final guarantee that even relayed ciphertext is opaque without that key.

**The group AES layer must not be removed under any circumstances.**

---

## 8. Remediation Priority Order

| Priority | Item | Impact | Category |
|---|---|---|---|
| P0 | Encrypt ECDSA private key at rest (WebAuthn PRF master key) | Full identity compromise without this | At-rest |
| P0 | Encrypt all message history and contact records at rest | Full conversation history exposed | At-rest |
| P0 | Encrypt group info at rest | Group metadata and member lists exposed | At-rest |
| P1 | Replace ECDSA timestamp hello with ECDH challenge-response | Closes hello proxy attack — the most accessible active MITM vector | In-transit |
| P1 | Replace ECDSA timestamp on rvz-exchange with ECDH challenge-response | Closes PID poisoning attack that sets up hello proxy | In-transit |
| P1 | Add ECDH challenge to group namespace checkin | Closes fake checkin identity — though group AES already protects content | In-transit |
| P2 | ECDH encryption for 1:1 file transfer | Files currently fully exposed to active MITM | In-transit |
| P2 | ECDH encryption for group file transfer | Same as above for group files | In-transit |
| P2 | ECDH challenge on call initiation — unlock-gated per §6.3 | Independent identity verification at call layer; implementation must follow two-phase flow to handle locked-session devices | In-transit |
| P2 | Add timestamp freshness check to hello and rvz-exchange | Partial defense-in-depth against stored replay — does not close live MITM | In-transit |
| P2 | Locked-session incoming message handling | Enables secure operation while screen locked | At-rest |
| P3 | File encryption at rest (IndexedDB) | File blobs fully exposed at rest | At-rest |
| P3 | PBKDF2 fallback for browsers without WebAuthn PRF | Coverage for older Safari and Firefox | At-rest |
| P3 | Safety number UI for contact verification | Hardens TOFU first-contact window | In-transit |
| P4 | Idle session auto-lock | Reduces at-rest exposure window | At-rest |
| P4 | Self-hosted PeerJS | Eliminates social graph visibility at signaling server | Architecture |
| P5 | Double Ratchet (optional) | Per-message forward secrecy within sessions | In-transit |

---

## 9. PeerNS vs. Signal vs. iMessage — Security Posture Comparison

### 9.1 Structural Note on Server Custody

PeerNS uses PeerJS only for WebRTC signaling (SDP exchange). Once connected, all traffic travels directly peer-to-peer over DTLS DataChannels — PeerJS never has custody of message content at any point, even transiently. Signal and iMessage both route messages through their respective servers, holding encrypted payloads until the recipient comes online.

**Why X3DH is not relevant to PeerNS:** X3DH (Extended Triple Diffie-Hellman) exists to establish a shared secret with an *offline* peer by fetching prekeys from a server. PeerNS requires both peers to be reachable for a WebRTC connection — messages queue on-device and transmit when the peer reconnects over a fresh DTLS session. There is no offline prekey server to design around. X3DH solves a structural problem PeerNS does not have.

### 9.2 1:1 In-Transit Comparison

| Property | PeerNS (post-remediation) | Signal | iMessage |
|---|---|---|---|
| Message relay | None — direct P2P DTLS | Signal servers (encrypted) | Apple servers (encrypted) |
| Server sees message content | ❌ Never — no server custody | ❌ Never — E2E encrypted | ❌ Never — E2E encrypted† |
| Server sees connection metadata | PeerJS sees connection graph; no message metadata | Signal sees sender/recipient/timing | Apple sees sender/recipient/timing |
| Transport encryption | DTLS (enforced by WebRTC) | TLS to Signal servers | TLS to Apple servers |
| Application-layer encryption | ECDH AES-256-GCM | Double Ratchet (AES-256) | AES-256 per recipient |
| Per-session forward secrecy | ✅ DTLS ephemeral keys per session | ✅ Double Ratchet | ✅ Per-message keys |
| Per-message forward secrecy | ❌ DTLS rotates per session, not per message | ✅ Every message | ✅ Every message |
| Session identity verification | ECDH challenge per connection | X3DH + signed prekeys | Apple PKI |
| Offline delivery | ❌ Queues on sender device | ✅ Server holds encrypted | ✅ Apple holds encrypted |
| Protocol open source | ✅ Yes | ✅ Yes (AGPL-3.0 — no commercial license required) | ❌ Proprietary |

† iCloud backup without Apple's Advanced Data Protection exposes stored message history to Apple.

### 9.3 Group In-Transit Comparison

| Property | PeerNS (post-remediation) | Signal (Sender Keys) | iMessage |
|---|---|---|---|
| Message relay | None — peer-elected namespace router; all hops are P2P DTLS | Signal servers | Apple servers |
| Server message custody | None — structurally impossible | Encrypted blobs held until recipient online | Encrypted blobs held until recipient online |
| Application-layer group encryption | AES-256-GCM group key, pairwise ECDH distributed | Sender Keys (per-sender ratchet) | Per-recipient AES via Apple PKI |
| Forward secrecy | Per-session (DTLS) + group AES layer | Per-message (Sender Keys ratchet) | Per-message |
| Offline delivery | ❌ No server to hold messages | ✅ Signal holds encrypted | ✅ Apple holds encrypted |
| Infrastructure required | None beyond PeerJS signaling | Signal server infrastructure | Apple infrastructure |

The group namespace router in PeerNS is not a server — it is a dynamically self-elected peer from whoever is online in the namespace, operating over the same DTLS + ECDH challenge stack as all other connections. No central node has custody of any message at any point.

### 9.4 At-Rest Comparison

At-rest compromise is broadly equivalent across all three platforms once device authentication is defeated. An attacker who bypasses biometric/PIN authentication obtains stored messages regardless of what the in-transit protocol provided. This is a device-layer problem, not a protocol-layer one, and should not be compared against in-transit properties.

| Property | PeerNS (post-remediation) | Signal | iMessage |
|---|---|---|---|
| Message history encrypted at rest | ✅ WebAuthn PRF master key (proposed) | ✅ SQLCipher | ✅ iOS Data Protection |
| Private key encrypted at rest | ✅ WebAuthn PRF master key (proposed) | ✅ Secure Enclave / keystore | ✅ Secure Enclave |
| Blast radius if device auth defeated | All stored messages | All stored messages | All stored messages |
| iCloud/backup exposure | N/A — no cloud sync in current design | ❌ Not backed up to cloud | ⚠️ Exposed without Advanced Data Protection |

## 10. Architectural Note — The Full-Circle Conclusion

The original audit's Phase 5 recommendation to remove application-layer ECDH encryption was conceptually correct but built on a false premise. It claimed ECDSA+DTLS closed the identity gap, making ECDH redundant. It does not — as the hello proxy attack demonstrates. So removing ECDH at that stage would have introduced a serious vulnerability.

However, if ECDH challenge-response is properly implemented to replace all current ECDSA timestamp signatures on session identity, the threat model changes significantly:

- **Passive interception** — DTLS handles it. Application-layer ECDH adds nothing.
- **Active MITM identity spoofing** — ECDH challenge handles it. The hello proxy attack collapses at step 2 because Mallory cannot decrypt a challenge encrypted to Alice's public key. Application-layer ECDH adds nothing here either.
- **Private key stolen** — everything is broken regardless. Both ECDH challenge and application-layer ECDH fail equally.

At that point the application-layer ECDH encryption on 1:1 messages and group AES encryption become redundant for in-transit and active MITM threat categories. The only remaining argument for keeping them is pure defense-in-depth — a backstop against an authentication bypass not yet anticipated. That is a legitimate engineering argument, but it is a different argument than "we need it right now."

The one thing worth retaining unconditionally regardless of how identity verification evolves is the **per-message ECDSA authorship signatures** on ciphertext. These are not about channel confidentiality — they prove that a specific message was actively authored by the holder of the sender's private key, which DTLS and ECDH challenge alone cannot provide.

So the correct long-term path is:
1. Replace all ECDSA timestamp signatures on session identity with ECDH challenge-response — this closes the hello proxy attack properly
2. Once ECDH challenge is deployed and verified, application-layer ECDH message encryption and group AES become optional defense-in-depth rather than mandatory controls
3. Per-message ECDSA authorship signatures stay regardless

The journey of this analysis ends up near where the original audit wanted to go — just via a completely different and actually sound path.

---

## 11. Note on Encryption Strength and Post-Quantum Vulnerability

**Current primitives:** ECDSA P-521 for identity keys; AES-256-GCM for message content and at-rest master key encryption. P-521 provides approximately 260 bits of classical security — stronger than P-256 or Curve25519 used by Signal, though all are considered adequate today. AES-256 provides 256-bit classical security.

**Classical brute force:** Not a practical threat for either primitive at current or foreseeable computational scales.

**Quantum threat by primitive:**

| Primitive | Algorithm at risk | Mechanism | Impact |
|---|---|---|---|
| AES-256-GCM | Grover's algorithm | Grover's provides a quadratic speedup over brute force key search — it finds a key in √(keyspace) operations rather than keyspace operations. Against AES-256 this halves the effective security level from 256 to ~128 bits. | Weakened but survives — 128-bit security remains NIST-approved |
| DTLS 1.2/1.3 handshake (ECDHE) | Shor's algorithm | DTLS negotiates a session key via ECDHE: both sides generate ephemeral EC keypairs, exchange public keys over the wire, and derive the same shared secret via scalar multiplication. Shor's solves the elliptic curve discrete logarithm in polynomial time — a quantum attacker observing the handshake applies it to either ephemeral public key to recover its private key, then derives the identical session secret. Every byte of the session is then decryptable. Enables **harvest-now-decrypt-later**: a passive attacker can record DTLS traffic today and decrypt it retroactively once a capable quantum computer exists. | **Complete break** of transport layer — all channels exposed |
| ECDH challenge-response | Shor's algorithm | The challenge is encrypted to the peer's long-term EC public key. Shor's recovers the corresponding private key from the observed public key directly, allowing the attacker to decrypt any challenge and produce a valid response without possessing the actual private key. | **Complete break** of session identity verification |
| ECDSA P-521 authorship signatures | Shor's algorithm | ECDSA security rests on the same elliptic curve discrete logarithm problem as ECDH. Shor's recovers the signing private key from the observed public key, enabling forgery of any per-message authorship signature. P-521, P-256, and Curve25519 are equally broken — curve size does not help against Shor's. | **Complete break** of message authorship |
| RSA (not used here) | Shor's algorithm | Shor's also solves integer factorization, which RSA depends on. | Complete break — same reason |

**What breaks and where:**

*In-transit:*
- **DTLS transport layer** — broken as above. The session key is fully recoverable from the observed ECDHE handshake. Harvest-now-decrypt-later applies to all recorded traffic.
- **ECDH challenge-response** — broken as above. Identity verification collapses; a quantum attacker impersonates any peer.
- **ECDSA authorship signatures** — broken as above. Per-message authorship is forgeable.
- **AES-256-GCM message content** — survives at ~128-bit effective security. The only in-transit component that holds under quantum attack — but it is only reachable after DTLS and ECDH are already broken, so in practice it provides no meaningful residual protection in a post-quantum threat scenario.

*At-rest:*
- **WebAuthn PRF → HKDF → AES-256-GCM master key** — the PRF output and HKDF are symmetric/hash operations, not EC-based. This derivation chain is quantum-resistant. The master key itself is AES-256 and survives Grover's at ~128-bit effective security.
- **ECDSA private key stored encrypted under master key** — the storage encryption holds. However, the key being protected is an EC private key whose corresponding public key has been broadcast. If the public key was observed, Shor's recovers the private key directly, making the at-rest encryption of it somewhat beside the point — the attacker doesn't need to steal it from storage.
- **All AES-256-GCM encrypted Tier 3 storage** — survives. Message history, contact records, and file blobs encrypted under the master key remain protected at ~128-bit effective security under Grover's.

**Roadmap — post-quantum remediation requires two separate schemes:**

| Layer | Quantum fix |
|---|---|
| ECDH session key derivation (challenge + message encryption) | **ML-KEM** (CRYSTALS-Kyber, NIST-standardized) — run hybrid alongside ECDH; shared key derived from both outputs. Quantum-resistant if either primitive holds. Browser-compatible libraries available today. |
| DTLS handshake | Browser/WebRTC platform must adopt post-quantum DTLS — not addressable at the application layer. Chrome has begun deploying ML-KEM for TLS 1.3; WebRTC DataChannels are expected to follow. No app-level workaround exists in the interim. |
| ECDSA authorship signatures | **ML-DSA** (CRYSTALS-Dilithium, NIST-standardized) — replaces ECDSA for per-message signing. Cannot reuse ML-KEM here; KEM and signature are distinct schemes requiring separate primitives. Browser-compatible libraries available today. |

ML-KEM for ECDH and ML-DSA for authorship signatures are both implementable today at the application layer. DTLS post-quantum support is a platform dependency with no application-layer workaround. For most consumer deployments this full remediation is premature; for high-sensitivity use it is a concrete roadmap rather than a theoretical one.

## 12. Accepted Residual Risks (Post-Remediation)

| Risk | Severity | Notes |
|---|---|---|
| TOFU on first contact | Medium | ECDH challenge hardens subsequent connections. First connection still relies on PeerJS not substituting the public key. Safety numbers UI addresses this for high-security use. |
| PeerJS social graph visibility | Medium | PeerJS sees who connects to whom. Self-hosting eliminates this entirely. |
| No intra-session per-message forward secrecy | Medium | DTLS rotates keys per connection, not per message. Double Ratchet addresses this if required. |
| WebAuthn PRF browser support gaps | Medium | PBKDF2 fallback covers this at reduced security. |
| Same-origin malicious browser extension | Low-Medium | Can read localStorage and invoke app functions. WebAuthn PRF binds key material to device authenticator, limiting exposure. |
| JS memory cannot be zeroed | Low | Browser platform constraint. Non-extractable CryptoKey objects limit export exposure. |
| Namespace/discovery presence exposure | Low | By design — discovery requires presence metadata. |
| Call participant metadata visible | Low | Timing and participant list visible even with content protected. |
