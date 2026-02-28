# PeerNS

> Private, encrypted peer-to-peer messaging — no accounts, no servers.

PeerNS is a serverless P2P messaging PWA that connects users directly via WebRTC. Messages, calls, and files are end-to-end encrypted and never touch a server. The app runs entirely in the browser — deploy it to any static host and it just works.

## Quick Start

**Prerequisites:** Node.js 18+

```bash
git clone https://github.com/smileytechness/peerns.git
cd peerns
npm install
npm run dev       # Dev server on http://localhost:3000
npm run build     # Production build → dist/
```

Deploy the `dist/` folder to any static host: Vercel, Netlify, GitHub Pages, Cloudflare Pages, or your own server.

## Configuration

### Signaling Server

By default, PeerNS uses the free public PeerJS server at `0.peerjs.com`.

To use a different signaling server, edit `src/lib/p2p-signaling.ts` line 22:

```ts
// Default:
mgr.persPeer = new Peer(mgr.persistentID);

// Custom server:
mgr.persPeer = new Peer(mgr.persistentID, {
  host: 'your-server.com',
  port: 443,
  path: '/peerjs',
  secure: true,
});
```

To self-host a PeerJS server: [github.com/peers/peerjs-server](https://github.com/peers/peerjs-server)

### STUN / TURN Servers

Default STUN servers are configured in `src/lib/discovery.ts` lines 18–21:

```ts
iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
]
```

To add TURN servers (required for symmetric NAT / restrictive firewalls), add entries to the `iceServers` array and pass the config when creating peers:

```ts
new Peer(id, {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'turn:your-turn.com:3478', username: 'user', credential: 'pass' },
    ]
  }
});
```

### IP Detection Endpoints

Public IP is used for same-network discovery. Detection methods:

1. **Primary:** STUN `srflx` candidate (lines 18–21 in `src/lib/discovery.ts`)
2. **Fallback:** HTTP APIs at `src/lib/discovery.ts` lines 75–76:
   ```ts
   'https://api.ipify.org?format=json'
   'https://api4.my-ip.io/ip.json'
   ```

Replace these with your own IP echo service if needed.

## Features

- **End-to-end encrypted** messages, calls, and files (AES-256-GCM + ECDH)
- **Cross-device file sharing** between Android, iPhone, and desktop — any network, no login
- **Same-network auto-discovery** via public IP namespace
- **GPS nearby discovery** using geohash-based proximity (opt-in)
- **Custom namespaces** — join by name, cross-network discovery
- **Encrypted group chats** with shared group keys and key rotation
- **1:1 and group calls** — voice, video, and screen share
- **Instant reconnect** via namespace routing and rendezvous
- **Installable PWA** with offline support and push notifications

## Architecture Overview

| Layer | Technology |
|-------|-----------|
| Transport | WebRTC via PeerJS |
| Signaling | PeerJS server (handshake only — no message relay) |
| Identity | ECDSA P-256 key pairs (Web Crypto API) |
| Encryption | AES-256-GCM (1:1 via ECDH, groups via shared key) |
| Storage | localStorage + IndexedDB (all local) |
| UI | React 19 + TypeScript + Tailwind CSS 4 + Vite |

### How discovery works

1. The app detects your public IP via STUN (or HTTP fallback)
2. Your IP becomes a namespace — e.g. `peerns-203-0-113-1`
3. One browser tab claims the router ID (`...-1`) via PeerJS "ID Taken" election
4. The router maintains a registry of all peers on that namespace
5. Peers check in, receive the full registry, and can connect to each other
6. If the router goes offline, a new one is elected automatically (jittered race)

Custom namespaces and GPS nearby work the same way — different namespace, same routing protocol.

### How encryption works

1. Each device generates an ECDSA P-256 key pair on first launch
2. Contacts are identified by their public key fingerprint (SHA-256, 16-char hex)
3. When two peers connect, they perform ECDH to derive a shared AES-256-GCM key
4. All messages, calls, and files are encrypted with this shared key
5. Group chats use a shared AES-256-GCM group key, distributed pairwise-encrypted to each member via ECDH
6. Key rotation occurs on member leave/kick

## Project Structure

| File | Description |
|------|-------------|
| `src/lib/p2p.ts` | Main P2PManager class — fields, init, keys, public API |
| `src/lib/p2p-signaling.ts` | PeerJS signaling connection and reconnect |
| `src/lib/p2p-ns.ts` | Namespace routing (18 methods) |
| `src/lib/p2p-messaging.ts` | Message handling and queue |
| `src/lib/p2p-handshake.ts` | Connection handshake protocol |
| `src/lib/p2p-group.ts` | Group chat + group calls (25+ methods) |
| `src/lib/p2p-geo.ts` | GPS nearby discovery (geohash) |
| `src/lib/p2p-rvz.ts` | Rendezvous reconnect (HMAC time slots) |
| `src/lib/crypto.ts` | All cryptography (ECDSA, ECDH, AES-GCM, group keys) |
| `src/lib/discovery.ts` | IP detection, STUN, ID factories |
| `src/lib/store.ts` | Persistence (localStorage + IndexedDB) |
| `src/lib/types.ts` | Type definitions and constants |
| `src/lib/geohash.ts` | Geohash encode/decode/neighbors/distance |
| `src/hooks/useP2P.ts` | React hook for P2PManager |
| `src/components/` | React UI components |

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Dev server on port 3000 |
| `npm run build` | Production build to `dist/` |
| `npm run preview` | Preview production build |
| `npm run lint` | TypeScript type check |
| `npm run clean` | Remove `dist/` |

## License

[GitHub](https://github.com/smileytechness/peerns) · Created by [ITQIX Technology](https://itqix.com)
