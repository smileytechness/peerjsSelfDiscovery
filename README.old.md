
perwitwi# Serverless P2P Mesh Chat

A proof-of-concept Serverless P2P application that utilizes WebRTC for transport and self-organizing "routers" within the browser to facilitate local network discovery without a dedicated backend.

## 💡 Core Concept & Novelty

This project demonstrates a zero-infrastructure deployment model. It replaces what would conventionally require a hosted signaling server, a discovery service, and a presence registry with an application-level mesh that emerges from two stateless, public services.

1.  **STUN as Namespace Discovery:** Google's STUN server (`stun.l.google.com`) is used not just for NAT traversal, but to extract the client's Public IP via `srflx` ICE candidates. This IP becomes the shared namespace key (`myapp-{ip}-...`) for "local" discovery.
2.  **Protocol-Based Leader Election:** The PeerJS "ID Taken" error—normally a failure condition—is repurposed as a protocol primitive for router election. If `myapp-{ip}-1` is taken, the client joins as a peer; if free, it becomes the router.

## 🏗 Architecture

### Transport & Signaling
*   **Transport:** WebRTC via [PeerJS](https://peerjs.com).
*   **Signaling:** Public PeerJS server (`0.peerjs.com`).
*   **Deployment:** Static PWA (HTML/JS/CSS only), zero backend logic.

### IP Detection Strategy
To group peers on the same network, the app needs the Public IP.
1.  **Primary (WebRTC STUN):** Queries `stun.l.google.com:19302`. The returned `srflx` candidate contains the device's real public IP. This works on most networks (unless UDP 19302 is blocked).
2.  **Fallback (HTTP):** If STUN fails (e.g., corporate proxies), the app falls back to `api.ipify.org`.
3.  **Cellular:** On cellular connections, discovery is disabled due to NAT volatility. The app defaults to "Persistent ID" mode only.

---

## 🆔 Identity System

The app distinguishes between *finding* a peer and *trusting* a peer.

| ID Type | Format | Visibility | Purpose |
| :--- | :--- | :--- | :--- |
| **Router ID** | `myapp-{ip}-1` | Public | Deterministic anchor for the network mesh. |
| **Discovery ID** | `myapp-{ip}-{discoveryUUID}` | Public | Broadcast to the router. Opaque (no name included). |
| **Persistent ID** | `myapp-{persistentUUID}` | Private | Long-term identity. Only exchanged *after* connection acceptance. |

### The "Duplicate Peer" Fix
To prevent a saved contact from appearing as a stranger in the discovery list:
1.  **discoveryUUID** is generated once on first launch and stored locally.
2.  The Discovery ID (`myapp-{ip}-{discoveryUUID}`) is anonymous.
3.  When a peer checks in with the Router, they send their `friendlyName` and `discoveryUUID` as data payload.
4.  **Merging Logic:** The client parses the incoming registry. It extracts the `UUID` suffix from the Discovery ID and checks it against `localStorage` contacts.
    *   **Match Found:** The peer is marked as `onNetwork: true` in the **Saved Contacts** list.
    *   **No Match:** The peer appears in the **New Peers** list.

---

## ⚡ Router Logic (Self-Organizing)

The "Router" is simply a browser tab that won the race to claim the deterministic ID `myapp-{ip}-1`.

### Election Process (DHCP-style)
1.  **Attempt to register** `myapp-{ip}-1`.
2.  **Success:** You are the Router. Initialize empty registry.
3.  **Fail (ID Taken):** Connect to `myapp-{ip}-1` as a standard peer.

### Router Responsibilities
*   **Maintain Registry:** Stores `{ discoveryID, friendlyname, lastSeen, discoveryUUID }`.
*   **Check-in:** On new peer connection, add to registry and **push full registry** to all connected peers.
*   **Heartbeat:** Pings all peers every 60s. Removes non-responders and pushes updated registry.

### Failover & Resilience
*   **Local Cache:** All peers maintain a full copy of the registry.
*   **TTL:** Cache entries have a 90s TTL.
*   **Re-Election:** If the router goes offline (ping fails):
    1.  Peers wait a random **jitter delay** (0–3s).
    2.  Peers attempt to claim `myapp-{ip}-1`.
    3.  **Winner:** Becomes new router, imports its *local cache* as the new source of truth, and requests re-checkins.
    4.  **Losers:** Re-connect to the new router.

---

## 📡 Connection Flow

### 1. Discovery (On Network)
Peers automatically discover each other via the Router registry push.

### 2. Handshake (Peer-to-Peer)
A connection request is made to a **Discovery ID**.
*   **Peer A** sends: `{ type: 'request', friendlyname: 'John' }`
*   **Peer B** prompts user (Accept/Reject).
*   **On Accept:**
    *   **Peer B** sends: `{ type: 'accepted', persistentID: 'myapp-uuid-B', discoveryUUID: '...' }`
    *   **Peer A** responds: `{ type: 'confirm', persistentID: 'myapp-uuid-A', discoveryUUID: '...' }`
*   *Result:* Both peers store each other's **Persistent ID** and **Discovery UUID**. All future communication occurs via Persistent ID.

### 3. Saved Contacts (Offline/Remote)
If a known peer is not on the local network (Router registry):
*   They appear under **Saved Contacts**.
*   User can click **Ping**.
*   App attempts a direct WebRTC connection to their stored `Persistent ID`.

---

## 💻 UI Structure

The peer list is strictly divided to handle the visibility logic:

**🌐 ON THIS NETWORK**
> Contains both known contacts (merged via UUID match) and unknown strangers.
*   💬 **John** `[● on network]` `[Open Chat]`
*   👤 **Unknown** `[Connect]`

**💾 SAVED CONTACTS**
> Contacts stored in localStorage but not currently in the local registry.
*   💬 **Mike** `[○ offline]` `[Ping]`
*   💬 **Sarah** `[○ offline]` `[Ping]`

---

## 🛠 Message Protocol

**Peer → Router**
```javascript
{ type: 'checkin', discoveryID: '...', friendlyname: '...' }
{ type: 'ping' } // Keepalive
```
=======================================================================================================================
=======================================================================================================================
NEW IDEADS:

# 🚀 Protocol Roadmap: Zero-Trust & Resilience

This document outlines the architectural evolution from simple P2P ID sharing to a robust, cryptographic Zero-Trust model with self-healing connectivity.

---

## 1. Zero-Trust Cryptographic Identity

We are fundamentally changing the security model. We no longer rely on PeerJS IDs for persistence or trust. Instead, we adopt a system where **Transport is Ephemeral** and **Identity is Cryptographic**.

*   **The Principle:** A PeerJS ID is just a temporary "IP address." A user's ECDSA Key Pair is their permanent "Passport."

### Identity Verification Handshake
Trust is established strictly through cryptographic proof, not ID ownership.
1.  **Challenge:** When Alice connects to Bob (regardless of which PeerJS ID she uses), she sends her **Public Key** and a **Digital Signature** of that key.
2.  **Verification:** Bob verifies the signature. This mathematically proves the sender possesses the Private Key associated with that identity.
3.  **Result:** If valid, Bob updates his local contact list: *"The identity [AlicePubKey] is currently located at Transport ID [myapp-random-123]."*

### The New ID Schema
The concept of a "Persistent PeerJS ID" is deprecated.

| Type | Format | Visibility | Purpose |
| :--- | :--- | :--- | :--- |
| **Transport ID** | `myapp-{randomUUID}` | **Public** | An ephemeral, session-specific routing address. Semi-persistent; only changes if fails to re-register on peerjs. **No trust value.** |
| **Discovery ID** | `myapp-{namespace}-{randomUUID}`| **Public** | A temporary address used to announce presence to a *local* discovery router (IP/Geo), and inform it of its current transport id. |
| **Identity** | `<base64-PublicKey>` | **Private** | The user's permanent identity. Exchanged via Transport IDs after a trusted handshake. |

---

## 2. Time-Based Algorithmic Rendezvous (TOTP)

This feature is an **opt-in backup mechanism** for "Special Contacts." It allows trusted peers to find each other even if their Transport IDs are lost, squatted, or changed, without requiring a central server.

*   **The Concept:** Two peers generate a **Shared Secret** during their initial connection. This secret is used to calculate a predictable, rotating **Rendezvous Namespace** based on the current time.
*   **Mesh Router Integration:** Crucially, this calculated string functions exactly like a **Discovery Namespace**.
    *   Peers do not just "connect" to the ID.
    *   They utilize the app's existing **Router Election Logic** within this private namespace (e.g., claiming `{RendezvousHash}-1`).
    *   This ensures that even if both peers come online simultaneously (use jitter 1-3s to avoid crashes), one becomes the Router and the other acts as the Peer, guaranteeing a successful meeting.

### The Mechanism
1.  **Shared Secret:** A 256-bit secret exchanged once during setup.
2.  **Universal Time Slots:** Fixed 10-minute UTC intervals (e.g., `xx:00`, `xx:10`, `xx:20`).
3.  **Namespace Generation:**
    ```javascript
    const timeSlot = 'UTC-YYYY-MM-DD-HH-' + Math.floor(minutes / 10);
    const rendezvousHash = HMAC_SHA256(SharedSecret, timeSlot);
    const namespace = `rendezvous-${rendezvousHash}`;
    // Router ID becomes: myapp-{namespace}-1
    ```

### The Connection State Machine
Clients maintain a strict state for each Special Contact.

#### State 1: Connected (Primary)
*   **Rule:** The client communicates directly via the contact's last known **Transport ID**. The rendezvous system is idle.

#### State 2: Reconnecting (Offline/Lost)
*   **Trigger:** Direct connection to the Transport ID fails.
*   **Action:** The client calculates the current **Rendezvous Namespace** and attempts to join it (either as Router or Peer).
*   **Goal:** Find the contact in this private mesh, exchange new Transport IDs, and return to State 1.

#### State 3: Recovering (Squatted)
*   **Trigger:** The contact's Transport ID returns a valid PeerJS connection but fails the **Cryptographic Identity** check (Imposter/Squatter).
*   **Action:** The Transport ID is blacklisted. The client immediately forces a switch to the **Rendezvous Namespace** to re-establish a secure link.

#### State 4: Proactive Update
*   **Trigger:** The client's own Transport ID changes.
*   **Action:** It immediately announces the new Transport ID to all online contacts. For offline contacts, it joins the current Rendezvous Namespace to "leave a note" with its new address.

#### Housekeeping
*   **Rule:** If a Special Contact is unseen for >30 days, the app prompts the user to pause the rendezvous contract to save background resources.

---

## 3. Origin-Signed Namespace (Spam Mitigation)

This feature replaces the static `myapp` root prefix with a dynamic, server-verified token.

*   **The Concept:** The application derives its root namespace variable from a cryptographic signature provided by the origin web server headers (`X-Mesh-Beacon`).
*   **The Goal:** Mitigation, not perfection. It raises the barrier to entry for spammers, unauthorized bot clones, and generic PeerJS scanners.

### How it works
1.  **The Beacon:** The web server signs the current timestamp with a private key and attaches it to response headers.
2.  **The Check:** The server only provides this header if the request `Origin` matches the official domain (CORS).
3.  **The Namespace:** The client uses this signature as the root prefix (e.g., `sig8a2b-{ip}-1` instead of `myapp-{ip}-1`).

### Limitation
*   **Not a DRM Solution:** A determined attacker can manually extract the token and share it, or build a proxy to leak it. However, because the token rotates periodically (e.g., every 10 minutes), an attacker must maintain active infrastructure to bypass it, preventing low-effort scripts and "saved-to-disk" local copies from flooding the public mesh.
