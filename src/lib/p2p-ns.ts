import { Peer, DataConnection } from 'peerjs';
import { APP_PREFIX, PeerInfo, NSConfig, TTL, PING_IV } from './types';
import { makeDiscID, extractDiscUUID } from './discovery';
import { saveContacts } from './store';
import type { P2PManager } from './p2p';
import { NSState, CNSState } from './p2p-types';
import { peerQueue } from './peer-queue';

export function nsEmit(mgr: P2PManager, s: NSState) {
    mgr.emitPeerListUpdate();
    if (s === mgr.publicNS) {
      mgr.emitStatus();
    } else if (mgr.geoStates.includes(s as any)) {
      mgr.dispatchEvent(new CustomEvent('geo-update'));
    } else {
      mgr.dispatchEvent(new CustomEvent('custom-ns-update'));
      // Also fire group-update if this is a group namespace
      for (const [, gs] of mgr.groups) {
        if (gs === s) { mgr.dispatchEvent(new CustomEvent('group-update')); break; }
      }
    }
  }

export function nsAttempt(mgr: P2PManager, s: NSState, cfg: NSConfig, level: number) {
    if (s !== mgr.publicNS) {
      const cs = s as CNSState;
      if (cs.offline || mgr.offlineMode) return;
    } else {
      if (mgr.namespaceOffline) return;
    }
    if (!mgr.persPeer || mgr.persPeer.destroyed) return;
    if (level > mgr.MAX_NAMESPACE) {
      mgr.log(`[${cfg.label}] All namespace levels exhausted (1–${mgr.MAX_NAMESPACE}) — discovery offline`, 'err');
      return;
    }

    const rid = cfg.makeRouterID(level);
    mgr.log(`[${cfg.label}] Attempting router election at level ${level}: ${rid}`, 'info');

    if (s.routerPeer) { s.routerPeer.destroy(); s.routerPeer = null; }

    // Show "Electing" in UI while queued / waiting for signaling
    s.joinStatus = 'electing';
    s.joinAttempt = level;
    mgr.nsEmit(s);

    peerQueue.schedule(() => {
      s.routerPeer = new Peer(rid);

      s.routerPeer.on('open', (id) => {
        // Check if this namespace is still active (may have been torn down while queued)
        if (s !== mgr.publicNS) {
          let isRvz = false;
          mgr.rvzMap.forEach(entry => { if (entry.state === s) isRvz = true; });
          const isActive = ('slug' in s && mgr.cns.has((s as CNSState).slug))
            || ('geohash' in s && mgr.geoStates.includes(s as any))
            || ('groupId' in s && mgr.groups.has((s as any).groupId))
            || isRvz;
          if (!isActive) { s.routerPeer?.destroy(); return; }
        }
        s.isRouter = true;
        s.level = level;
        s.joinStatus = null;
        s.joinAttempt = 0;
        mgr.log(`[${cfg.label}] Elected as router at level ${level}: ${id}`, 'ok');
        s.routerPeer?.on('connection', (conn) => mgr.nsHandleRouterConn(s, cfg, conn));
        mgr.nsStartPingTimer(s, cfg);
        mgr.nsRegisterDisc(s, cfg);
        // Start peer slot probe (router probes for EDM NAT peers)
        mgr.nsStartPeerSlotProbe(s, cfg);
        if (level > 1) {
          mgr.nsStartMonitor(s, cfg);
        }
        mgr.nsEmit(s);
      });

      s.routerPeer.on('error', (e: any) => {
        if (e.type === 'unavailable-id') {
          mgr.log(`[${cfg.label}] Level ${level} router slot taken — trying to join`, 'info');
          s.routerPeer = null;
          mgr.nsTryJoin(s, cfg, level);
        } else if (e.type === 'network') {
          // No internet — don't escalate, just stop. Will retry when online.
          mgr.log(`[${cfg.label}] Network down at L${level} — pausing`, 'err');
          s.routerPeer = null;
          s.joinStatus = null;
          mgr.nsEmit(s);
        } else {
          mgr.log(`[${cfg.label}] Router error at L${level}: ${e.type} — escalating`, 'err');
          s.routerPeer = null;
          setTimeout(() => mgr.nsAttempt(s, cfg, level + 1), 2000 + Math.random() * 2000);
        }
      });
    });
  }

export function nsTryJoin(mgr: P2PManager, s: NSState, cfg: NSConfig, level: number, attempt: number = 0) {
    if (s !== mgr.publicNS) {
      const cs = s as CNSState;
      if (cs.offline || mgr.offlineMode) return;
    }
    if (!mgr.persPeer || mgr.persPeer.destroyed) return;

    const rid = cfg.makeRouterID(level);
    mgr.log(`[${cfg.label}] Connecting to level ${level} router (attempt ${attempt + 1}/${mgr.MAX_JOIN_ATTEMPTS}): ${rid}`, 'info');

    if (s.routerConn) { s.routerConn.close(); s.routerConn = null; }
    if (s.joinTimeout) { clearTimeout(s.joinTimeout); s.joinTimeout = null; }

    s.joinStatus = 'joining';
    s.joinAttempt = attempt + 1;
    mgr.nsEmit(s);

    s.routerConn = mgr.persPeer.connect(rid, { reliable: true });
    const conn = s.routerConn; // capture for closure identity check
    let connected = false;
    let settled = false; // prevent double-fire from timeout + error

    // Timeout: if connection hangs (NAT blocks WebRTC), treat as error
    s.joinTimeout = setTimeout(() => {
      if (settled || connected) return;
      settled = true;
      mgr.log(`[${cfg.label}] Join timeout at level ${level} (attempt ${attempt + 1}) — connection hung`, 'err');
      try { s.routerConn?.close(); } catch {}
      s.routerConn = null;
      if (attempt + 1 < mgr.MAX_JOIN_ATTEMPTS) {
        setTimeout(() => mgr.nsTryJoin(s, cfg, level, attempt + 1), 1500);
      } else {
        mgr.nsTryPeerSlot(s, cfg, level);
      }
    }, 8000);

    s.routerConn.on('open', () => {
      connected = true;
      settled = true;
      if (s.joinTimeout) { clearTimeout(s.joinTimeout); s.joinTimeout = null; }
      s.joinStatus = null;
      s.joinAttempt = 0;
      s.isRouter = false;
      s.level = level;
      const discID = cfg.makeDiscID(mgr.discoveryUUID);
      s.routerConn?.send({
        type: 'checkin',
        discoveryID: discID,
        friendlyname: mgr.friendlyName,
        publicKey: mgr.publicKeyStr,
      });
      mgr.log(`[${cfg.label}] Checked in to level ${level} router`, 'ok');
      mgr.nsRegisterDisc(s, cfg);
      if (level > 1) {
        mgr.nsStartMonitor(s, cfg);
      }
      mgr.nsEmit(s);
      // Send group checkin after namespace connection established
      if ('groupId' in s) {
        mgr.groupSendCheckin((s as any).groupId);
      }
    });

    s.routerConn.on('data', (d: any) => {
      if (d.type === 'registry') mgr.nsMergeRegistry(s, cfg, d.peers);
      if (d.type === 'ping') s.routerConn?.send({ type: 'pong' });
      if (d.type === 'migrate') {
        mgr.log(`[${cfg.label}] Router signaling migration to level ${d.level}`, 'info');
        mgr.nsMigrate(s, cfg, d.level);
      }
      // Forward group-specific messages to group handler
      if ('groupId' in s) {
        mgr.groupHandleNSData((s as any).groupId, d, s.routerConn);
      }
    });

    s.routerConn.on('close', () => {
      if (!connected) return;
      // Only failover if this is still the current router connection
      // (a new nsTryJoin call may have replaced it intentionally)
      if (s.routerConn !== null && s.routerConn !== conn) return;
      mgr.log(`[${cfg.label}] Router disconnected — failing over`, 'err');
      s.routerConn = null;
      mgr.nsClearMonitor(s);
      mgr.nsFailover(s, cfg);
    });

    s.routerConn.on('error', (err: any) => {
      if (settled) return;
      settled = true;
      if (s.joinTimeout) { clearTimeout(s.joinTimeout); s.joinTimeout = null; }
      mgr.log(`[${cfg.label}] Join error at level ${level}: ${err.type}`, 'err');
      s.routerConn = null;
      if (attempt + 1 < mgr.MAX_JOIN_ATTEMPTS) {
        setTimeout(() => mgr.nsTryJoin(s, cfg, level, attempt + 1), 1500);
      } else {
        // Try peer slot before escalating
        mgr.nsTryPeerSlot(s, cfg, level);
      }
    });
  }

export function nsHandleRouterConn(mgr: P2PManager, s: NSState, cfg: NSConfig, conn: DataConnection) {
    conn.on('data', (d: any) => {
      if (d.type === 'checkin') {
        const uuid = extractDiscUUID(d.discoveryID);

        // Dedup: remove stale entry for same device (same public key)
        if (d.publicKey) {
          const staleKey = Object.keys(s.registry).find(did =>
            did !== d.discoveryID && !!s.registry[did].publicKey && s.registry[did].publicKey === d.publicKey
          );
          if (staleKey) {
            mgr.log(`[${cfg.label}] Replaced stale disc entry: …${staleKey.slice(-8)} → …${d.discoveryID.slice(-8)}`, 'info');
            delete s.registry[staleKey];
          }
        }

        // Match existing contact by public key first, then by discoveryUUID
        const knownPID = Object.keys(mgr.contacts).find((pid) => {
          const c = mgr.contacts[pid];
          if (d.publicKey && c.publicKey && c.publicKey === d.publicKey) return true;
          return c.discoveryUUID === uuid;
        });

        if (knownPID) {
          mgr.contacts[knownPID].onNetwork = true;
          mgr.contacts[knownPID].networkDiscID = d.discoveryID;
          // Auto-connect if not already connected
          if (!mgr.offlineMode && mgr.persPeer && !mgr.persPeer.destroyed) {
            const c = mgr.contacts[knownPID];
            if (!c.conn?.open && !c.pending) {
              const pid = c.currentPID || knownPID;
              if (!mgr.connectingPIDs.has(pid)) {
                mgr.log(`[${cfg.label}] Auto-connecting to contact ${c.friendlyName} (checked in to our router)`, 'info');
                mgr.connectPersistent(pid, c.friendlyName);
              }
            }
          }
        }

        s.registry[d.discoveryID] = {
          discoveryID: d.discoveryID,
          friendlyName: d.friendlyname,
          lastSeen: Date.now(),
          conn,
          knownPID: knownPID || null,
          publicKey: d.publicKey || undefined,
        };
        mgr.log(`[${cfg.label}] Peer checked in at L${s.level}: ${d.discoveryID}`, 'ok');
        mgr.nsBroadcast(s, cfg);
        mgr.nsEmit(s);
      }
      if (d.type === 'pong') {
        const key = Object.keys(s.registry).find((k) => s.registry[k].conn === conn);
        if (key) s.registry[key].lastSeen = Date.now();
      }
      // Forward group-specific messages to group handler
      if ('groupId' in s) {
        mgr.groupHandleNSData((s as any).groupId, d, conn);
      }
    });
    conn.on('close', () => {
      const key = Object.keys(s.registry).find((k) => s.registry[k].conn === conn);
      if (key) {
        delete s.registry[key];
        mgr.nsBroadcast(s, cfg);
        mgr.nsEmit(s);
      }
    });
  }

export function nsBroadcast(mgr: P2PManager, s: NSState, _cfg: NSConfig) {
    const peers = Object.keys(s.registry).map((did) => ({
      discoveryID: did,
      friendlyname: s.registry[did].friendlyName,
      publicKey: s.registry[did].publicKey,
    }));
    Object.values(s.registry).forEach((r) => {
      if (r.conn && !r.isMe) {
        try {
          r.conn.send({ type: 'registry', peers });
        } catch {}
      }
    });
  }

export function nsMergeRegistry(mgr: P2PManager, s: NSState, cfg: NSConfig, peers: any[]) {
    mgr.log(`[${cfg.label}] Registry update: ${peers.length} peers`, 'info');
    const myDiscID = cfg.makeDiscID(mgr.discoveryUUID);

    const newRegistry: Record<string, PeerInfo> = {};
    const myEntry = Object.values(s.registry).find(r => r.isMe);
    if (myEntry) newRegistry[myEntry.discoveryID] = myEntry;

    // Reset all contacts onNetwork before rebuild — only for public NS
    if (s === mgr.publicNS) {
      Object.keys(mgr.contacts).forEach((pid) => {
        mgr.contacts[pid].onNetwork = false;
        mgr.contacts[pid].networkDiscID = null;
      });
    }

    peers.forEach((p) => {
      if (p.discoveryID === myDiscID) return;

      const uuid = extractDiscUUID(p.discoveryID);

      // Dedup: if we already have an entry for this same public key, remove older one
      if (p.publicKey) {
        const staleKey = Object.keys(newRegistry).find(did =>
          did !== p.discoveryID && !newRegistry[did].isMe && !!newRegistry[did].publicKey && newRegistry[did].publicKey === p.publicKey
        );
        if (staleKey) delete newRegistry[staleKey];
      }

      // Match by publicKey OR discoveryUUID
      const knownPID = Object.keys(mgr.contacts).find((pid) => {
        const c = mgr.contacts[pid];
        if (p.publicKey && c.publicKey && c.publicKey === p.publicKey) return true;
        return c.discoveryUUID === uuid;
      });

      if (knownPID) {
        mgr.contacts[knownPID].onNetwork = true;
        mgr.contacts[knownPID].networkDiscID = p.discoveryID;
        // Store public key if we receive it for the first time
        if (p.publicKey && !mgr.contacts[knownPID].publicKey) {
          mgr.contacts[knownPID].publicKey = p.publicKey;
          saveContacts(mgr.contacts);
        }
      }

      newRegistry[p.discoveryID] = {
        discoveryID: p.discoveryID,
        friendlyName: p.friendlyname,
        lastSeen: Date.now(),
        knownPID: knownPID || null,
        publicKey: p.publicKey || undefined,
      };
    });

    s.registry = newRegistry;
    mgr.nsEmit(s);
    // Check rendezvous registry for target contact
    mgr.rvzCheckRegistry(s);

    // Auto-connect to saved contacts discovered online but not yet connected
    if (!mgr.offlineMode && mgr.persPeer && !mgr.persPeer.destroyed) {
      Object.keys(mgr.contacts).forEach((key) => {
        const c = mgr.contacts[key];
        if (c.onNetwork && !c.conn?.open && !c.pending) {
          const pid = c.currentPID || key;
          if (!mgr.connectingPIDs.has(pid)) {
            mgr.log(`[${cfg.label}] Auto-connecting to contact ${c.friendlyName} (discovered in namespace)`, 'info');
            mgr.connectPersistent(pid, c.friendlyName);
          }
        }
      });
    }
  }

export function nsStartPingTimer(mgr: P2PManager, s: NSState, cfg: NSConfig) {
    if (s.pingTimer) clearInterval(s.pingTimer);
    s.pingTimer = setInterval(() => {
      const now = Date.now();
      Object.keys(s.registry).forEach((did) => {
        const r = s.registry[did];
        if (r.isMe) return;
        if (r.conn) {
          try { r.conn.send({ type: 'ping' }); } catch {}
        }
        if (now - r.lastSeen > TTL + 10000) {
          mgr.log(`[${cfg.label}] Peer timed out: ${did}`, 'err');
          delete s.registry[did];
          mgr.nsBroadcast(s, cfg);
          mgr.nsEmit(s);
        }
      });
    }, PING_IV);
  }

const MAX_DISC_RETRIES = 3;

export function nsRegisterDisc(mgr: P2PManager, s: NSState, cfg: NSConfig, discRetry: number = 0) {
    if (s !== mgr.publicNS) {
      const cs = s as CNSState;
      if (cs.offline || mgr.offlineMode) return;
    } else {
      if (mgr.namespaceOffline) return;
    }
    const discID = cfg.makeDiscID(mgr.discoveryUUID);

    // Reuse existing discPeer if still alive
    if (s.discPeer && !s.discPeer.destroyed) {
      if (!s.registry[discID]) {
        s.registry[discID] = {
          discoveryID: discID,
          friendlyName: mgr.friendlyName,
          lastSeen: Date.now(),
          isMe: true,
          publicKey: mgr.publicKeyStr || undefined,
        };
      }
      if (s.isRouter) mgr.nsBroadcast(s, cfg);
      mgr.nsEmit(s);
      return;
    }

    // Destroy old discPeer before creating new
    if (s.discPeer) { s.discPeer.destroy(); s.discPeer = null; }

    peerQueue.schedule(() => {
      s.discPeer = new Peer(discID);

      s.discPeer.on('open', (id) => {
        mgr.log(`[${cfg.label}] Discovery ID: ${id}`, 'ok');
        s.registry[id] = {
          discoveryID: id,
          friendlyName: mgr.friendlyName,
          lastSeen: Date.now(),
          isMe: true,
          publicKey: mgr.publicKeyStr || undefined,
        };

        if (s.isRouter) {
          mgr.nsBroadcast(s, cfg);
        }
        mgr.nsEmit(s);
      });

      s.discPeer.on('connection', (conn) => {
        conn.on('data', (d) => mgr.handleDiscData(d, conn));
      });

      s.discPeer.on('error', (e: any) => {
        mgr.log(`[${cfg.label}] Discovery error: ${e.type}`, 'err');
        if (e.type === 'unavailable-id') {
          if (discRetry >= MAX_DISC_RETRIES) {
            mgr.log(`[${cfg.label}] Discovery UUID collision retries exhausted`, 'err');
            return;
          }
          // UUID collision — regenerate (queue handles spacing)
          mgr.discoveryUUID = crypto.randomUUID().replace(/-/g, '');
          localStorage.setItem(`${APP_PREFIX}-disc-uuid`, mgr.discoveryUUID);
          if (s === mgr.publicNS) {
            mgr.discoveryID = makeDiscID(mgr.publicIP, mgr.discoveryUUID);
          }
          mgr.nsRegisterDisc(s, cfg, discRetry + 1);
        }
      });
    });
  }

export function nsStartMonitor(mgr: P2PManager, s: NSState, cfg: NSConfig) {
    mgr.nsClearMonitor(s);
    s.monitorTimer = setInterval(() => mgr.nsProbeLevel1(s, cfg), 30000);
  }

export function nsClearMonitor(mgr: P2PManager, s: NSState) {
    if (s.monitorTimer) {
      clearInterval(s.monitorTimer);
      s.monitorTimer = null;
    }
  }

export function nsProbeLevel1(mgr: P2PManager, s: NSState, cfg: NSConfig) {
    if (s.level <= 1) return;
    if (s !== mgr.publicNS) {
      const cs = s as CNSState;
      if (cs.offline || mgr.offlineMode) return;
    } else {
      if (!mgr.publicIP || mgr.namespaceOffline) return;
    }

    const rid = cfg.makeRouterID(1);
    const peer = s.discPeer || mgr.persPeer;
    if (!peer) return;

    mgr.log(`[${cfg.label}] Probing level 1 namespace availability...`, 'info');

    const testConn = peer.connect(rid, { reliable: true });
    let settled = false;

    const resolve = (routerFound: boolean) => {
      if (settled) return;
      settled = true;
      try { testConn.close(); } catch {}

      if (routerFound) {
        mgr.log(`[${cfg.label}] Level 1 router live — migrating from level ${s.level}`, 'info');
        if (s.isRouter) {
          mgr.nsBroadcastMigration(s, 1);
          setTimeout(() => mgr.nsMigrate(s, cfg, 1), 600);
        } else {
          mgr.nsMigrate(s, cfg, 1);
        }
      } else {
        // Level 1 is unclaimed
        if (s.isRouter) {
          mgr.log(`[${cfg.label}] Level 1 unclaimed — reclaiming from level ${s.level}`, 'info');
          mgr.nsBroadcastMigration(s, 1);
          setTimeout(() => {
            mgr.nsClearMonitor(s);
            if (s.routerPeer) { s.routerPeer.destroy(); s.routerPeer = null; }
            if (s.discPeer) { s.discPeer.destroy(); s.discPeer = null; }
            if (s.routerConn) { s.routerConn.close(); s.routerConn = null; }
            // Clear peer slot state
            if (s.peerSlotProbeTimer) { clearInterval(s.peerSlotProbeTimer); s.peerSlotProbeTimer = null; }
            if (s.peerSlotPeer && !s.peerSlotPeer.destroyed) { try { s.peerSlotPeer.destroy(); } catch {} s.peerSlotPeer = null; }
            if (s.peerSlotTimer) { clearTimeout(s.peerSlotTimer); s.peerSlotTimer = null; }
            s.isRouter = false;
            s.level = 0;
            const myEntry = Object.values(s.registry).find(r => r.isMe);
            s.registry = myEntry ? { [myEntry.discoveryID]: myEntry } : {};
            mgr.nsEmit(s);
            mgr.nsAttempt(s, cfg, 1);
          }, 600);
        }
      }
    };

    testConn.on('open', () => resolve(true));
    testConn.on('error', () => resolve(false));
    setTimeout(() => resolve(false), 4000);
  }

export function nsBroadcastMigration(mgr: P2PManager, s: NSState, level: number) {
    Object.values(s.registry).forEach((r) => {
      if (r.conn && !r.isMe) {
        try { r.conn.send({ type: 'migrate', level }); } catch {}
      }
    });
  }

export function nsMigrate(mgr: P2PManager, s: NSState, cfg: NSConfig, targetLevel: number) {
    if (s !== mgr.publicNS) {
      const cs = s as CNSState;
      if (cs.offline || mgr.offlineMode) return;
    } else {
      if (mgr.namespaceOffline) return;
    }
    mgr.log(`[${cfg.label}] Migrating to level ${targetLevel}`, 'info');
    mgr.nsClearMonitor(s);
    if (s.routerConn) { s.routerConn.close(); s.routerConn = null; }
    if (s.routerPeer) { s.routerPeer.destroy(); s.routerPeer = null; }
    if (s.discPeer) { s.discPeer.destroy(); s.discPeer = null; }
    // Clear peer slot state
    if (s.peerSlotProbeTimer) { clearInterval(s.peerSlotProbeTimer); s.peerSlotProbeTimer = null; }
    if (s.peerSlotPeer && !s.peerSlotPeer.destroyed) { try { s.peerSlotPeer.destroy(); } catch {} s.peerSlotPeer = null; }
    if (s.peerSlotTimer) { clearTimeout(s.peerSlotTimer); s.peerSlotTimer = null; }
    s.isRouter = false;
    s.level = 0;
    const myEntry = Object.values(s.registry).find(r => r.isMe);
    s.registry = myEntry ? { [myEntry.discoveryID]: myEntry } : {};
    mgr.nsEmit(s);
    setTimeout(() => mgr.nsAttempt(s, cfg, targetLevel), Math.random() * 2000);
  }

export function nsFailover(mgr: P2PManager, s: NSState, cfg: NSConfig) {
    if (s === mgr.publicNS && mgr.namespaceOffline) return;
    if (s !== mgr.publicNS) {
      const cs = s as CNSState;
      if (cs.offline || mgr.offlineMode) return;
    }

    const jitter = Math.random() * 3000;
    mgr.log(`[${cfg.label}] Failover in ${(jitter / 1000).toFixed(1)}s — restarting from L1`, 'info');
    mgr.nsClearMonitor(s);
    setTimeout(() => {
      if (s.routerPeer) { s.routerPeer.destroy(); s.routerPeer = null; }
      if (s.discPeer) { s.discPeer.destroy(); s.discPeer = null; }
      if (s.routerConn) { s.routerConn.close(); s.routerConn = null; }
      // Clear peer slot state
      if (s.peerSlotProbeTimer) { clearInterval(s.peerSlotProbeTimer); s.peerSlotProbeTimer = null; }
      if (s.peerSlotPeer && !s.peerSlotPeer.destroyed) { try { s.peerSlotPeer.destroy(); } catch {} s.peerSlotPeer = null; }
      if (s.peerSlotTimer) { clearTimeout(s.peerSlotTimer); s.peerSlotTimer = null; }
      s.isRouter = false;
      s.level = 0;

      const myEntry = Object.values(s.registry).find(r => r.isMe);
      s.registry = myEntry ? { [myEntry.discoveryID]: myEntry } : {};
      mgr.nsEmit(s);

      if (s === mgr.publicNS) {
        mgr.discoveryID = makeDiscID(mgr.publicIP, mgr.discoveryUUID);
      }
      mgr.nsAttempt(s, cfg, 1);
    }, jitter);
  }

export function nsTeardown(mgr: P2PManager, s: NSState, keepDisc = false) {
    if (s.pingTimer) { clearInterval(s.pingTimer); s.pingTimer = null; }
    if (s.monitorTimer) { clearInterval(s.monitorTimer); s.monitorTimer = null; }
    if (s.peerSlotProbeTimer) { clearInterval(s.peerSlotProbeTimer); s.peerSlotProbeTimer = null; }
    if (s.peerSlotPeer && !s.peerSlotPeer.destroyed) { try { s.peerSlotPeer.destroy(); } catch {} s.peerSlotPeer = null; }
    if (s.peerSlotTimer) { clearTimeout(s.peerSlotTimer); s.peerSlotTimer = null; }
    if (s.joinTimeout) { clearTimeout(s.joinTimeout); s.joinTimeout = null; }
    s.joinStatus = null;
    s.joinAttempt = 0;
    if (s.routerPeer && !s.routerPeer.destroyed) { try { s.routerPeer.destroy(); } catch {} s.routerPeer = null; }
    if (s.routerConn) { try { s.routerConn.close(); } catch {} s.routerConn = null; }
    if (!keepDisc && s.discPeer && !s.discPeer.destroyed) { try { s.discPeer.destroy(); } catch {} s.discPeer = null; }
  }

const MAX_PEER_SLOT_RETRIES = 5;

export function nsTryPeerSlot(mgr: P2PManager, s: NSState, cfg: NSConfig, level: number, peerSlotAttempt: number = 0) {
    if (s !== mgr.publicNS) {
      const cs = s as CNSState;
      if (cs.offline || mgr.offlineMode) return;
    } else {
      if (mgr.namespaceOffline) return;
    }
    const slotID = cfg.makePeerSlotID();
    mgr.log(`[${cfg.label}] Trying peer slot (-p1 reverse connect, attempt ${peerSlotAttempt + 1}/${MAX_PEER_SLOT_RETRIES}): ${slotID}`, 'info');

    // Clean up any previous peer slot attempt
    if (s.peerSlotPeer && !s.peerSlotPeer.destroyed) { try { s.peerSlotPeer.destroy(); } catch {} }
    if (s.peerSlotTimer) { clearTimeout(s.peerSlotTimer); s.peerSlotTimer = null; }

    s.joinStatus = 'peer-slot';
    s.joinAttempt = peerSlotAttempt + 1;
    mgr.nsEmit(s);

    peerQueue.schedule(() => {
      s.peerSlotPeer = new Peer(slotID);

      s.peerSlotPeer.on('open', () => {
        mgr.log(`[${cfg.label}] Peer slot claimed — waiting for router probe`, 'info');

        // Listen for incoming connection from router
        s.peerSlotPeer?.on('connection', (conn: DataConnection) => {
          conn.on('data', (d: any) => {
            if (d.type === 'reverse-welcome') {
              mgr.log(`[${cfg.label}] Router probed our peer slot — checking in via reverse connect`, 'ok');
              const discID = cfg.makeDiscID(mgr.discoveryUUID);
              conn.send({
                type: 'checkin',
                discoveryID: discID,
                friendlyname: mgr.friendlyName,
                publicKey: mgr.publicKeyStr,
              });

              // Use this connection as our router connection
              s.routerConn = conn;
              s.isRouter = false;
              s.level = level;
              s.joinStatus = null;
              s.joinAttempt = 0;
              mgr.nsRegisterDisc(s, cfg);
              // Send group checkin after peer-slot connection established
              if ('groupId' in s) {
                mgr.groupSendCheckin((s as any).groupId);
              }

              conn.on('data', (d2: any) => {
                if (d2.type === 'registry') mgr.nsMergeRegistry(s, cfg, d2.peers);
                if (d2.type === 'ping') conn.send({ type: 'pong' });
                if (d2.type === 'migrate') {
                  mgr.log(`[${cfg.label}] Router signaling migration to level ${d2.level}`, 'info');
                  mgr.nsMigrate(s, cfg, d2.level);
                }
                // Forward group-specific messages to group handler
                if ('groupId' in s) {
                  mgr.groupHandleNSData((s as any).groupId, d2, conn);
                }
              });

              conn.on('close', () => {
                mgr.log(`[${cfg.label}] Reverse-connect router dropped — failing over`, 'err');
                s.routerConn = null;
                mgr.nsClearMonitor(s);
                mgr.nsFailover(s, cfg);
              });

              // Disconnect (not destroy!) the peer slot peer to free the -p1 ID
              // on the signaling server while keeping our DataConnection alive
              if (s.peerSlotPeer && !s.peerSlotPeer.destroyed && !s.peerSlotPeer.disconnected) {
                try { s.peerSlotPeer.disconnect(); } catch {}
              }
              if (s.peerSlotTimer) { clearTimeout(s.peerSlotTimer); s.peerSlotTimer = null; }

              mgr.nsEmit(s);
            }
          });
        });

        // 30s timeout: give up and escalate
        s.peerSlotTimer = setTimeout(() => {
          mgr.log(`[${cfg.label}] Peer slot timeout — escalating to level ${level + 1}`, 'info');
          if (s.peerSlotPeer && !s.peerSlotPeer.destroyed) {
            try { s.peerSlotPeer.destroy(); } catch {}
          }
          s.peerSlotPeer = null;
          s.peerSlotTimer = null;
          s.joinStatus = null;
          s.joinAttempt = 0;
          mgr.nsAttempt(s, cfg, level + 1);
        }, 30000);
      });

      s.peerSlotPeer.on('error', (e: any) => {
        if (e.type === 'unavailable-id') {
          s.peerSlotPeer = null;
          if (peerSlotAttempt + 1 < MAX_PEER_SLOT_RETRIES) {
            // Slot occupied by another peer — retry with backoff
            mgr.log(`[${cfg.label}] Peer slot occupied — retrying (${peerSlotAttempt + 1}/${MAX_PEER_SLOT_RETRIES})`, 'info');
            s.peerSlotTimer = setTimeout(() => {
              s.peerSlotTimer = null;
              mgr.nsTryPeerSlot(s, cfg, level, peerSlotAttempt + 1);
            }, 3000 + Math.random() * 2000);
          } else {
            // Max retries exhausted — escalate to next level
            mgr.log(`[${cfg.label}] Peer slot retries exhausted — escalating to level ${level + 1}`, 'err');
            s.joinStatus = null;
            s.joinAttempt = 0;
            mgr.nsAttempt(s, cfg, level + 1);
          }
        } else {
          // Other error — escalate
          mgr.log(`[${cfg.label}] Peer slot error: ${e.type} — escalating`, 'err');
          s.peerSlotPeer = null;
          mgr.nsAttempt(s, cfg, level + 1);
        }
      });
    });
  }

export function nsStartPeerSlotProbe(mgr: P2PManager, s: NSState, cfg: NSConfig) {
    if (s.peerSlotProbeTimer) { clearInterval(s.peerSlotProbeTimer); }
    // Probe every 30s (not 5s) to avoid hammering the signaling server
    s.peerSlotProbeTimer = setInterval(() => mgr.nsProbePeerSlot(s, cfg), 30000);
    // Do one initial probe after 3s
    setTimeout(() => mgr.nsProbePeerSlot(s, cfg), 3000);
  }

export function nsProbePeerSlot(mgr: P2PManager, s: NSState, cfg: NSConfig) {
    if (!mgr.persPeer || mgr.persPeer.destroyed || mgr.persPeer.disconnected) return;
    if (!s.isRouter) return;
    if (s !== mgr.publicNS) {
      const cs = s as CNSState;
      if (cs.offline || mgr.offlineMode) return;
    } else {
      if (mgr.namespaceOffline) return;
    }

    const slotID = cfg.makePeerSlotID();
    const conn = mgr.persPeer.connect(slotID, { reliable: true });

    const timeout = setTimeout(() => {
      try { conn.close(); } catch {}
    }, 5000);

    conn.on('open', () => {
      conn.send({ type: 'reverse-welcome' });

      conn.on('data', (d: any) => {
        clearTimeout(timeout);
        if (d.type === 'checkin') {
          mgr.log(`[${cfg.label}] Reverse-connect peer checked in: ${d.discoveryID}`, 'ok');

          const uuid = extractDiscUUID(d.discoveryID);

          // Dedup by public key
          if (d.publicKey) {
            const staleKey = Object.keys(s.registry).find(did =>
              did !== d.discoveryID && !!s.registry[did].publicKey && s.registry[did].publicKey === d.publicKey
            );
            if (staleKey) {
              delete s.registry[staleKey];
            }
          }

          const knownPID = Object.keys(mgr.contacts).find((pid) => {
            const c = mgr.contacts[pid];
            if (d.publicKey && c.publicKey && c.publicKey === d.publicKey) return true;
            return c.discoveryUUID === uuid;
          });

          if (knownPID) {
            mgr.contacts[knownPID].onNetwork = true;
            mgr.contacts[knownPID].networkDiscID = d.discoveryID;
            // Auto-connect if not already connected
            if (!mgr.offlineMode && mgr.persPeer && !mgr.persPeer.destroyed) {
              const c = mgr.contacts[knownPID];
              if (!c.conn?.open && !c.pending) {
                const pid = c.currentPID || knownPID;
                if (!mgr.connectingPIDs.has(pid)) {
                  mgr.connectPersistent(pid, c.friendlyName);
                }
              }
            }
          }

          s.registry[d.discoveryID] = {
            discoveryID: d.discoveryID,
            friendlyName: d.friendlyname,
            lastSeen: Date.now(),
            conn,
            knownPID: knownPID || null,
            publicKey: d.publicKey || undefined,
          };
          mgr.nsBroadcast(s, cfg);
          mgr.nsEmit(s);

          // Forward group-specific messages from reverse-connect peer
          conn.on('data', (d2: any) => {
            if ('groupId' in s) {
              mgr.groupHandleNSData((s as any).groupId, d2, conn);
            }
          });

          // Monitor this connection
          conn.on('close', () => {
            if (s.registry[d.discoveryID]?.conn === conn) {
              delete s.registry[d.discoveryID];
              mgr.nsBroadcast(s, cfg);
              mgr.nsEmit(s);
            }
          });
        }
      });
    });

    conn.on('error', () => {
      clearTimeout(timeout);
      // No peer waiting — silently ignore
    });
  }

