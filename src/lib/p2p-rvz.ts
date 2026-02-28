import { DataConnection } from 'peerjs';
import { APP_PREFIX, RVZ_WINDOW, NSConfig } from './types';
import { makeRendezvousRouterID, makeRendezvousDiscID, makeRendezvousPeerSlotID } from './discovery';
import { deriveRendezvousSlug, signData, importPublicKey, verifySignature } from './crypto';
import { saveContacts } from './store';
import type { P2PManager } from './p2p';
import { NSState, makeNSState } from './p2p-types';

/**
 * Parallel rendezvous discovery.
 *
 * Each offline contact gets its own rvz namespace — a deterministic router ID
 * derived from the pairwise ECDH shared key + current 10-minute time window.
 * Both peers derive the same slug, so whoever comes online first claims the
 * router; the second peer joins as a member and finds the first in the registry.
 *
 * All rvz namespaces run simultaneously (peerQueue handles rate limiting).
 * When the persistent DataConnection is established (hello handshake),
 * rvzContactConnected() tears down that contact's rvz namespace.
 */

// ─── Lifecycle ──────────────────────────────────────────────────────────────

export function rvzStart(mgr: P2PManager) {
    if (mgr.rvzSweepTimer) clearInterval(mgr.rvzSweepTimer);
    // Sweep every 60s to pick up newly-disconnected contacts
    mgr.rvzSweepTimer = setInterval(() => mgr.rvzSweep(), 60000);
    // Immediate sweep — rvz is the primary discovery path for saved contacts
    if (mgr.rvzInitTimer) clearTimeout(mgr.rvzInitTimer);
    mgr.rvzInitTimer = setTimeout(() => { mgr.rvzInitTimer = null; mgr.rvzSweep(); }, 3000);
  }

/**
 * Scan all contacts: spin up an rvz namespace for each offline one that
 * has a publicKey (needed for slug derivation). Skip already-active ones.
 */
export function rvzSweep(mgr: P2PManager) {
    if (mgr.offlineMode) return;
    if (!mgr.persPeer || mgr.persPeer.destroyed) return;

    Object.keys(mgr.contacts).forEach(key => {
      const c = mgr.contacts[key];
      if (c.conn?.open) return;            // already connected
      if (c.pending) return;               // not yet accepted
      if (!c.publicKey) return;            // need pubkey for slug derivation
      if (mgr.rvzMap.has(key)) return;     // already has an active rvz namespace
      rvzActivate(mgr, key);
    });

    // Also tear down rvz namespaces for contacts that have since connected
    mgr.rvzMap.forEach((_, key) => {
      if (mgr.contacts[key]?.conn?.open) {
        rvzDeactivate(mgr, key);
      }
    });
  }

/**
 * Spin up an rvz namespace for a single contact.
 */
async function rvzActivate(mgr: P2PManager, contactKey: string) {
    const contact = mgr.contacts[contactKey];
    if (!contact?.publicKey) return;

    const sk = await mgr.getOrDeriveSharedKey(contactKey);
    if (!sk) return;

    const timeWindow = Math.floor(Date.now() / RVZ_WINDOW);
    let slug: string;
    try {
      slug = await deriveRendezvousSlug(sk.key, timeWindow);
    } catch (e) {
      mgr.log(`Rendezvous: slug derivation failed for ${contact.friendlyName}: ${e}`, 'err');
      return;
    }

    // Check if already connected while we were async
    if (contact.conn?.open || mgr.rvzMap.has(contactKey)) return;

    const fname = contact.friendlyName || contactKey.slice(-8);
    mgr.log(`Rendezvous: activating namespace for ${fname}`, 'info');

    const cfg: NSConfig = {
      label: `rvz:${fname.slice(0, 12)}`,
      makeRouterID: (level) => makeRendezvousRouterID(slug, level),
      makeDiscID: (uuid) => makeRendezvousDiscID(slug, uuid),
      makePeerSlotID: () => makeRendezvousPeerSlotID(slug),
    };

    const state = makeNSState();

    // Window rotation: when the current 10-min window expires, tear down and
    // re-activate with the new slug (both peers rotate at the same wall-clock time)
    const remaining = RVZ_WINDOW - (Date.now() % RVZ_WINDOW);
    const windowTimer = setTimeout(() => {
      mgr.log(`Rendezvous: window rotated for ${fname} — re-activating`, 'info');
      rvzDeactivate(mgr, contactKey);
      // Re-activate with new window's slug (only if still offline)
      if (mgr.contacts[contactKey] && !mgr.contacts[contactKey].conn?.open) {
        rvzActivate(mgr, contactKey);
      }
    }, remaining + 2000);

    mgr.rvzMap.set(contactKey, { state, cfg, windowTimer });

    // Start the namespace (will claim router or join as peer)
    mgr.nsAttempt(state, cfg, 1);
  }

/**
 * Tear down an rvz namespace for a single contact.
 */
function rvzDeactivate(mgr: P2PManager, contactKey: string) {
    const entry = mgr.rvzMap.get(contactKey);
    if (!entry) return;
    if (entry.windowTimer) clearTimeout(entry.windowTimer);
    mgr.nsTeardown(entry.state);
    mgr.rvzMap.delete(contactKey);
  }

// ─── Contact connected callback ─────────────────────────────────────────────

/**
 * Called when a contact connects successfully (from any path — direct, rvz, or namespace).
 * Tears down that contact's rvz namespace since it's no longer needed.
 */
export function rvzContactConnected(mgr: P2PManager, contactKey: string) {
    if (mgr.rvzMap.has(contactKey)) {
      const fname = mgr.contacts[contactKey]?.friendlyName || contactKey.slice(-8);
      mgr.log(`Rendezvous: ${fname} connected — tearing down rvz`, 'ok');
      rvzDeactivate(mgr, contactKey);
    }
  }

// ─── Registry check — called from nsMergeRegistry for every registry update ─

/**
 * Check if any rvz namespace's registry contains the target contact.
 * If found, initiate PID exchange → persistent connection.
 */
export function rvzCheckRegistry(mgr: P2PManager, s: NSState) {
    // Find which contact this rvz namespace belongs to
    let matchedKey: string | null = null;
    mgr.rvzMap.forEach((entry, key) => {
      if (entry.state === s) matchedKey = key;
    });
    if (!matchedKey) return; // not an rvz namespace

    const contact = mgr.contacts[matchedKey];
    if (!contact?.publicKey) return;

    // Look for a registry entry with matching publicKey (not our own)
    const match = Object.values(s.registry).find(
      r => !r.isMe && r.publicKey && r.publicKey === contact.publicKey
    );
    if (!match) return;

    mgr.log(`Rendezvous: found ${contact.friendlyName} in namespace — exchanging PIDs`, 'ok');

    // Connect to their discovery peer and send rvz-exchange
    const entry = mgr.rvzMap.get(matchedKey)!;
    const peer = entry.state.discPeer || mgr.persPeer;
    if (!peer || peer.destroyed) return;

    const conn = peer.connect(match.discoveryID, { reliable: true });
    conn.on('open', async () => {
      const ts = Date.now().toString();
      const signature = mgr.privateKey ? await signData(mgr.privateKey, ts) : '';
      conn.send({
        type: 'rvz-exchange',
        persistentID: mgr.persistentID,
        friendlyName: mgr.friendlyName,
        publicKey: mgr.publicKeyStr,
        ts,
        signature,
      });
    });

    conn.on('data', (d: any) => {
      if (d.type === 'rvz-exchange') {
        rvzHandleExchange(mgr, d, conn);
      }
    });

    conn.on('error', () => {
      mgr.log(`Rendezvous: failed to connect to ${contact.friendlyName}'s disc peer`, 'err');
    });
  }

// ─── PID exchange ───────────────────────────────────────────────────────────

// Track connections that have already sent a reply to prevent ping-pong
const rvzRepliedConns = new WeakSet<DataConnection>();

export async function rvzHandleExchange(mgr: P2PManager, d: any, conn: DataConnection) {
    // Verify signature
    if (d.publicKey && d.signature && d.ts && window.crypto?.subtle) {
      try {
        const key = await importPublicKey(d.publicKey);
        const valid = await verifySignature(key, d.signature, d.ts);
        if (!valid) {
          mgr.log('Rendezvous: invalid signature on exchange', 'err');
          conn.close();
          return;
        }
      } catch {
        mgr.log('Rendezvous: signature verification error', 'err');
        conn.close();
        return;
      }
    }

    const newPID = d.persistentID;
    const fname = d.friendlyName || d.friendlyname || 'Unknown';

    // Find the contact by publicKey match — returns fingerprint key
    const contactKey = d.publicKey ? mgr.findContactByPublicKey(d.publicKey) : null;

    if (contactKey && mgr.contacts[contactKey]) {
      // Update the contact's PID
      const c = mgr.contacts[contactKey];
      if (c.currentPID !== newPID) {
        mgr.log(`Rendezvous: ${fname} PID updated → ${newPID.slice(-8)}`, 'info');
        c.currentPID = newPID;
        if (!c.knownPIDs?.includes(newPID)) c.knownPIDs = [...(c.knownPIDs || []), newPID];
        mgr.pidToFP.set(newPID, contactKey);
        saveContacts(mgr.contacts);
      }
    } else if (!contactKey && newPID) {
      mgr.log(`Rendezvous: unexpected peer ${fname} (${newPID.slice(-8)})`, 'info');
    }

    // Send our exchange back only once per connection (prevents ping-pong)
    if (conn.open && !rvzRepliedConns.has(conn)) {
      rvzRepliedConns.add(conn);
      const ts = Date.now().toString();
      const signature = mgr.privateKey ? await signData(mgr.privateKey, ts) : '';
      conn.send({
        type: 'rvz-exchange',
        persistentID: mgr.persistentID,
        friendlyName: mgr.friendlyName,
        publicKey: mgr.publicKeyStr,
        ts,
        signature,
      });
      setTimeout(() => { try { conn.close(); } catch {} }, 1000);
    }

    // Tear down rvz namespace for this contact
    if (contactKey) rvzDeactivate(mgr, contactKey);

    // Connect via persistent channel with updated PID
    const ck = contactKey || newPID;
    if (mgr.contacts[ck]) {
      delete mgr.connectFailures[newPID];
      mgr.connectPersistent(newPID, fname);
    }
  }

// ─── Queue-based fallback (kept for backward compat with rvzEnqueue calls) ──

export function rvzEnqueue(mgr: P2PManager, contactKey: string) {
    if (!mgr.contacts[contactKey]?.publicKey) return;
    // In the parallel model, just activate immediately
    if (mgr.rvzMap.has(contactKey)) return;
    rvzActivate(mgr, contactKey);
  }

// ─── Teardown ───────────────────────────────────────────────────────────────

export function rvzTeardown(mgr: P2PManager) {
    mgr.rvzMap.forEach((entry, key) => {
      if (entry.windowTimer) clearTimeout(entry.windowTimer);
      mgr.nsTeardown(entry.state);
    });
    mgr.rvzMap.clear();
    if (mgr.rvzSweepTimer) { clearInterval(mgr.rvzSweepTimer); mgr.rvzSweepTimer = null; }
    if (mgr.rvzInitTimer) { clearTimeout(mgr.rvzInitTimer); mgr.rvzInitTimer = null; }
  }

// ─── Legacy stubs (kept so old callers don't break) ─────────────────────────

export function rvzProcessNext(_mgr: P2PManager) { /* no-op in parallel model */ }
export function rvzOnWindowExpire(_mgr: P2PManager) { /* no-op in parallel model */ }
export function rvzCleanupActive(mgr: P2PManager) {
    // Legacy — clean up the old single-state fields if somehow set
    if (mgr.rvzState) { mgr.nsTeardown(mgr.rvzState); mgr.rvzState = null; }
    mgr.rvzCfg = null;
    mgr.rvzActive = null;
    if (mgr.rvzWindowTimer) { clearTimeout(mgr.rvzWindowTimer); mgr.rvzWindowTimer = null; }
  }

// Legacy — rvzSweep and rvzStart are already exported above with new implementations
