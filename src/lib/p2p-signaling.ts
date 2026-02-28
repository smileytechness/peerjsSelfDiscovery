import { Peer } from 'peerjs';
import { APP_PREFIX } from './types';
import { getPublicIP, makeDiscID } from './discovery';
import { saveContacts, saveChats } from './store';
import type { P2PManager } from './p2p';
import { peerQueue } from './peer-queue';

/** Send a lightweight heartbeat to the PeerJS signaling socket (internal API). */
function sendSignalingHeartbeat(mgr: P2PManager): boolean {
  const sock = (mgr.persPeer as any)?.socket;
  if (sock && typeof sock.send === 'function') {
    try { sock.send({ type: 'HEARTBEAT' }); return true; } catch {}
  }
  return false;
}

export function registerPersistent(mgr: P2PManager) {
    if (mgr.persPeer && !mgr.persPeer.destroyed) return;

    peerQueue.schedule(() => {
      let unavailIdHandled = false; // prevents close handler from double-scheduling
      mgr.persPeer = new Peer(mgr.persistentID);

      mgr.persPeer.on('open', (id) => {
        mgr.persConnected = true;
        mgr.signalingState = 'connected';
        mgr.lastSignalingTs = Date.now();
        mgr.reconnectBackoff = 0;
        mgr.reconnectScheduled = false;
        mgr.unavailIdRetries = 0; // successful — reset retry counter
        peerQueue.reportSignalingSuccess();
        mgr.log(`Persistent ID registered: ${id}`, 'ok');
        mgr.emitStatus();
        mgr.reconnectOfflineContacts();
      });

      mgr.persPeer.on('disconnected', () => {
        mgr.persConnected = false;
        mgr.signalingState = 'reconnecting';
        mgr.emitStatus();
        if (unavailIdHandled) return; // unavailable-id handler manages its own retry
        peerQueue.reportSignalingError();
        mgr.log('Persistent peer lost signaling connection — reconnecting...', 'err');
        mgr.schedulePersReconnect();
      });

      mgr.persPeer.on('close', () => {
        mgr.persConnected = false;
        mgr.emitStatus();
        if (unavailIdHandled) return; // unavailable-id handler already scheduled re-registration
        peerQueue.reportSignalingError();
        mgr.log('Persistent peer closed — recreating...', 'err');
        mgr.persPeer = null;
        setTimeout(() => mgr.registerPersistent(), 3000);
      });

      mgr.persPeer.on('connection', (conn) => {
        // Pre-map incoming PID to contact key if we recognize it
        const inPID = conn.peer;
        const ck = mgr.contactKeyForPID(inPID);
        if (ck !== inPID && mgr.contacts[ck]) {
          // Known contact reconnecting — update conn immediately
          if (mgr.contacts[ck].conn && !mgr.contacts[ck].conn.open) mgr.contacts[ck].conn = null;
          // If we already have an open outgoing conn, keep it; incoming hello will sort it out
        }

        conn.on('data', (d) => mgr.handlePersistentData(d, conn));
        conn.on('close', () => {
          const key = Object.keys(mgr.contacts).find((k) => mgr.contacts[k].conn === conn);
          if (key) {
            mgr.contacts[key].conn = null;
            // Reset unACK'd 'sent' messages to 'waiting' so they re-send on reconnect
            mgr.resetContactMessages(key);
            mgr.emitPeerListUpdate();
          }
        });
      });

      mgr.persPeer.on('call', (call) => mgr.handleIncomingCall(call));
      mgr.persPeer.on('error', (e: any) => {
        if (e.type === 'peer-unavailable') {
          const unavailPeer = e.message?.match(/peer\s+(\S+)/i)?.[1] || '';
          // Suppress -p1 peer slot probes — these are expected failures, not actionable
          if (unavailPeer.endsWith('-p1')) {
            mgr.dispatchEvent(new CustomEvent('peer-unavailable', { detail: { peer: unavailPeer } }));
            return;
          }
          mgr.log(`Peer unavailable: ${unavailPeer.slice(-12) || '(unknown)'}`, 'info');
          mgr.dispatchEvent(new CustomEvent('peer-unavailable', { detail: { peer: unavailPeer } }));
          return;
        }
        if (e.type === 'network') {
          // Network is down — don't log as error, disconnected handler will schedule reconnect
          return;
        }
        mgr.log(`Persistent peer error: ${e.type}`, 'err');
        if (e.type === 'unavailable-id') {
          // The signaling server still holds our ID from a stale WebSocket.
          // Retry with the SAME PID (with backoff) before giving up and generating a new one.
          unavailIdHandled = true;
          const MAX_SAME_ID_RETRIES = 3;
          mgr.unavailIdRetries++;
          mgr.persPeer?.destroy();
          mgr.persPeer = null;

          if (mgr.unavailIdRetries <= MAX_SAME_ID_RETRIES) {
            // Retry with same PID — exponential backoff: 3s, 6s, 12s
            const delay = 3000 * Math.pow(2, mgr.unavailIdRetries - 1);
            mgr.log(`unavailable-id for own PID — retry ${mgr.unavailIdRetries}/${MAX_SAME_ID_RETRIES} in ${(delay / 1000).toFixed(0)}s (stale session likely)`, 'info');
            setTimeout(() => mgr.registerPersistent(), delay);
          } else {
            // All retries exhausted — ID is genuinely claimed by another instance.
            // Generate a new PID and archive the old one.
            mgr.log('unavailable-id persisted after retries — generating new PID', 'err');
            const oldPID = mgr.persistentID;
            try {
              const hist: string[] = JSON.parse(localStorage.getItem(`${APP_PREFIX}-pid-history`) || '[]');
              if (oldPID && !hist.includes(oldPID)) { hist.push(oldPID); localStorage.setItem(`${APP_PREFIX}-pid-history`, JSON.stringify(hist)); }
            } catch {}
            mgr.loadPidHistory();
            mgr.persistentID = `${APP_PREFIX}-${crypto.randomUUID().replace(/-/g, '')}`;
            localStorage.setItem(`${APP_PREFIX}-pid`, mgr.persistentID);
            mgr.unavailIdRetries = 0;
            setTimeout(() => mgr.registerPersistent(), 3000);
          }
          return; // Don't fall through to other error handling
        }
      });
    }, 'high');
  }

export function schedulePersReconnect(mgr: P2PManager) {
    if (mgr.offlineMode || mgr.reconnectScheduled) return;
    mgr.reconnectScheduled = true;
    const delay = Math.min(1000 * Math.pow(2, mgr.reconnectBackoff), 30000) + Math.random() * 1000;
    mgr.reconnectBackoff = Math.min(mgr.reconnectBackoff + 1, 5);
    mgr.log(`Scheduling reconnect in ${(delay / 1000).toFixed(1)}s (attempt ${mgr.reconnectBackoff})`, 'info');
    setTimeout(() => {
      mgr.reconnectScheduled = false;
      if (!mgr.persPeer || mgr.persPeer.destroyed) {
        mgr.persPeer = null;
        mgr.registerPersistent();
      } else if (mgr.persPeer.disconnected) {
        try {
          mgr.persPeer.reconnect();
        } catch {
          mgr.persPeer.destroy();
          mgr.persPeer = null;
          mgr.registerPersistent();
        }
      }
    }, delay);
  }

export function handleOnline(mgr: P2PManager) {
    if (mgr.offlineMode) return;
    mgr.log('Connectivity change — checking persistent peer...', 'info');
    if (!mgr.persPeer || mgr.persPeer.destroyed) {
      mgr.persPeer = null;
      mgr.registerPersistent();
    } else if (mgr.persPeer.disconnected) {
      mgr.reconnectBackoff = 0;
      try {
        mgr.persPeer.reconnect();
      } catch {
        mgr.persPeer.destroy();
        mgr.persPeer = null;
        mgr.registerPersistent();
      }
    }
    if (mgr.publicIP && !mgr.namespaceOffline && !mgr.publicNS.isRouter && (!mgr.publicNS.routerConn || !mgr.publicNS.routerConn.open)) {
      setTimeout(() => mgr.tryJoinNamespace(mgr.publicNS.level || 1), 1500);
    }
  }

export function reconnectOfflineContacts(mgr: P2PManager) {
    if (!mgr.persPeer || mgr.persPeer.destroyed || mgr.persPeer.disconnected) return;
    // Clear stale failure counts — fresh start on reconnect
    mgr.connectFailures = {};

    const keys = Object.keys(mgr.contacts).filter(key => {
      const c = mgr.contacts[key];
      if (c.conn?.open) return false;
      if (c.pending) return false;
      const pid = c.currentPID || key;
      return !mgr.connectingPIDs.has(pid);
    });
    if (keys.length === 0) return;
    mgr.log(`Reconnecting to ${keys.length} offline contact(s)...`, 'info');
    // Stagger reconnects to avoid hammering the signaling server (429 rate-limit)
    keys.forEach((key, i) => {
      setTimeout(() => {
        if (mgr.offlineMode || !mgr.persPeer || mgr.persPeer.destroyed) return;
        const c = mgr.contacts[key];
        if (!c || c.conn?.open) return; // already connected in the meantime
        if (c.conn && !c.conn.open) c.conn = null;
        const pid = c.currentPID || key;
        if (!mgr.connectingPIDs.has(pid)) {
          mgr.connectPersistent(pid, c.friendlyName);
        }
      }, i * 500); // 500ms apart
    });
  }

export function startHeartbeat(mgr: P2PManager) {
    if (mgr.heartbeatTimer) clearInterval(mgr.heartbeatTimer);
    mgr.heartbeatTimer = setInterval(() => {
      if (mgr.offlineMode) return;
      const connected = mgr.persPeer != null && !mgr.persPeer.destroyed && !mgr.persPeer.disconnected;
      if (connected !== mgr.persConnected) {
        mgr.persConnected = connected;
        mgr.emitStatus();
      }
      if (!connected && mgr.persPeer && !mgr.persPeer.destroyed && !mgr.reconnectScheduled) {
        mgr.log('Heartbeat: signaling lost — reconnecting', 'info');
        mgr.schedulePersReconnect();
      }
    }, 20000);
  }

export function startCheckinTimer(mgr: P2PManager) {
    if (mgr.checkinTimer) clearInterval(mgr.checkinTimer);
    mgr.checkinTimer = setInterval(() => {
      if (mgr.offlineMode || !mgr.persPeer) return;
      if (mgr.persPeer.disconnected || mgr.persPeer.destroyed) {
        mgr.log('5-min checkin: signaling lost — reconnecting', 'info');
        mgr.schedulePersReconnect();
        return;
      }
      // Force a heartbeat to keep the signaling socket alive
      sendSignalingHeartbeat(mgr);
      // Reset any stale unacked messages (sent >2min ago without ACK → waiting for retry)
      mgr.resetUnackedMessages();
      // Flush queues for any connected contacts with pending messages
      Object.keys(mgr.contacts).forEach(key => {
        if (mgr.contacts[key]?.conn?.open) mgr.flushMessageQueue(key);
      });
      // Decay reconnect backoff after sustained uptime
      if (mgr.reconnectBackoff > 0) mgr.reconnectBackoff = 0;
      mgr.log('5-min checkin: signaling alive', 'info');
    }, 5 * 60 * 1000);
  }

export function watchNetwork(mgr: P2PManager) {
    const nc = (navigator as any).connection;
    if (nc) {
      nc.addEventListener('change', () => mgr.handleNetworkChange());
    }

    window.addEventListener('online', () => {
      mgr.log('Browser online event', 'info');
      mgr.handleOnline();
    });
    window.addEventListener('offline', () => {
      mgr.log('Browser offline event', 'err');
      mgr.persConnected = false;
      mgr.emitStatus();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        mgr.log('App foregrounded — checking connections', 'info');
        mgr.handleOnline();
        mgr.acquireWakeLock();
      }
    });

    mgr.startKeepAlive();
  }

/**
 * Periodic sweep: every 30s, try to reconnect any saved contacts that are offline.
 * This is the PRIMARY reconnect mechanism — simple, direct PID connections.
 * No namespace or rendezvous needed; if both peers are registered with PeerJS, it works.
 */
export function startContactSweep(mgr: P2PManager) {
    if (mgr.contactSweepTimer) clearInterval(mgr.contactSweepTimer);
    mgr.contactSweepTimer = setInterval(() => {
      if (mgr.offlineMode) return;
      if (!mgr.persPeer || mgr.persPeer.destroyed || mgr.persPeer.disconnected) return;

      const offlineKeys = Object.keys(mgr.contacts).filter(key => {
        const c = mgr.contacts[key];
        if (c.conn?.open) return false;
        if (c.pending) return false;
        const pid = c.currentPID || key;
        if (mgr.connectingPIDs.has(pid)) return false;
        return true;
      });

      if (offlineKeys.length === 0) return;

      // Reset stale failure counts so fresh attempts get full retry budget
      offlineKeys.forEach(key => {
        const pid = mgr.contacts[key]?.currentPID || key;
        delete mgr.connectFailures[pid];
      });

      // Stagger: pick up to 3 contacts per sweep to avoid hammering signaling
      const batch = offlineKeys.slice(0, 3);
      batch.forEach((key, i) => {
        setTimeout(() => {
          if (mgr.offlineMode || !mgr.persPeer || mgr.persPeer.destroyed || mgr.persPeer.disconnected) return;
          const c = mgr.contacts[key];
          if (!c || c.conn?.open) return;
          const pid = c.currentPID || key;
          if (mgr.connectingPIDs.has(pid)) return;
          mgr.connectPersistent(pid, c.friendlyName || key.slice(-8));
        }, i * 2000);
      });
    }, 30000);
  }

export function startKeepAlive(mgr: P2PManager) {
    // Web Lock API — prevents browser from freezing the page when backgrounded.
    // The lock is held as long as the promise is pending (forever until page closes).
    if (navigator.locks) {
      navigator.locks.request(`${APP_PREFIX}-keepalive`, () => {
        mgr.log('Web Lock acquired — page will stay alive in background', 'ok');
        return new Promise(() => {}); // never resolves — holds the lock
      }).catch(() => {});
    }

    // Wake Lock API — prevents screen from sleeping (released when hidden, reacquired on visible)
    mgr.acquireWakeLock();

    // Periodic signaling ping — re-registers with PeerJS server if connection drifted.
    // Mobile browsers may let WebSocket idle-timeout; this forces activity every 45s.
    if (mgr.keepAliveTimer) clearInterval(mgr.keepAliveTimer);
    mgr.keepAliveTimer = setInterval(() => {
      if (mgr.offlineMode) return;
      if (mgr.persPeer && !mgr.persPeer.destroyed && !mgr.persPeer.disconnected) {
        sendSignalingHeartbeat(mgr);
      } else if (mgr.persPeer?.disconnected && !mgr.reconnectScheduled) {
        mgr.log('Keep-alive: signaling drifted — reconnecting', 'info');
        mgr.schedulePersReconnect();
      }
    }, 45000);
  }

export async function acquireWakeLock(mgr: P2PManager) {
    if (!('wakeLock' in navigator)) return;
    // Only acquire when page is visible (API requirement)
    if (document.visibilityState !== 'visible') return;
    try {
      mgr.wakeLock = await (navigator as any).wakeLock.request('screen');
      mgr.wakeLock.addEventListener('release', () => { mgr.wakeLock = null; });
    } catch {}
  }

export async function handleNetworkChange(mgr: P2PManager) {
    if (mgr.offlineMode) return;
    const nc = (navigator as any).connection;
    const type = nc?.type || nc?.effectiveType || 'unknown';
    mgr.log(`Network type changed → ${type}`, 'info');

    // Invalidate all contact DataConnections — they're dead after network change
    Object.keys(mgr.contacts).forEach(key => {
      if (mgr.contacts[key].conn) {
        try { mgr.contacts[key].conn.close(); } catch {}
        mgr.contacts[key].conn = null;
      }
    });
    // Clear in-flight connection attempts — they're dead too
    mgr.connectingPIDs.clear();
    mgr.resetUnackedMessages();
    mgr.emitPeerListUpdate();

    if (mgr.persPeer && !mgr.persPeer.destroyed) {
      mgr.reconnectBackoff = 0;
      mgr.signalingState = 'reconnecting';
      mgr.emitStatus();
      try {
        if (!mgr.persPeer.disconnected) mgr.persPeer.disconnect();
        mgr.persPeer.reconnect();
      } catch {
        mgr.persPeer.destroy();
        mgr.persPeer = null;
        mgr.registerPersistent();
      }
    } else {
      mgr.handleOnline();
    }

    if (!mgr.publicIP) return;

    const newIP = await getPublicIP();
    if (!newIP) {
      mgr.log('IP undetectable after network change', 'err');
      return;
    }
    if (newIP !== mgr.publicIP) {
      mgr.log(`IP changed ${mgr.publicIP} → ${newIP} — refailing discovery`, 'info');
      mgr.publicIP = newIP;
      mgr.discoveryID = makeDiscID(mgr.publicIP, mgr.discoveryUUID);
      mgr.emitStatus();
      if (!mgr.namespaceOffline) mgr.failover();
    } else {
      mgr.log('Same IP — rejoining discovery', 'ok');
      if (!mgr.namespaceOffline && !mgr.publicNS.isRouter && (!mgr.publicNS.routerConn || !mgr.publicNS.routerConn.open)) {
        mgr.tryJoinNamespace(mgr.publicNS.level || 1);
      }
    }

    // Restart non-offline custom namespaces — staggered
    let nsDelay = 0;
    mgr.cns.forEach((s) => {
      if (s.offline) return;
      mgr.nsTeardown(s);
      s.level = 0; s.isRouter = false;
      const myEntry = Object.values(s.registry).find(r => r.isMe);
      s.registry = myEntry ? { [myEntry.discoveryID]: myEntry } : {};
      nsDelay += 2000;
      setTimeout(() => mgr.nsAttempt(s, s.cfg, 1), nsDelay + Math.random() * 1000);
    });

    // Restart group namespaces — staggered after custom NS
    mgr.groups.forEach((s) => {
      mgr.nsTeardown(s);
      s.level = 0; s.isRouter = false;
      const myEntry = Object.values(s.registry).find(r => r.isMe);
      s.registry = myEntry ? { [myEntry.discoveryID]: myEntry } : {};
      nsDelay += 2000;
      setTimeout(() => mgr.nsAttempt(s, s.cfg, 1), nsDelay + Math.random() * 1000);
    });

    // Restart geo namespaces — staggered after groups
    mgr.geoStates.forEach((s) => {
      mgr.nsTeardown(s);
      s.level = 0; s.isRouter = false;
      const myEntry = Object.values(s.registry).find(r => r.isMe);
      s.registry = myEntry ? { [myEntry.discoveryID]: myEntry } : {};
      nsDelay += 1500;
      setTimeout(() => {
        if (mgr.geoWatchId === null) return; // geo was stopped
        mgr.nsAttempt(s, s.cfg, 1);
      }, nsDelay + Math.random() * 1000);
    });
  }

export async function notify(mgr: P2PManager, title: string, body: string, tag?: string) {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    // Don't notify if user is actively viewing the app
    if (document.visibilityState === 'visible' && document.hasFocus()) return;

    const chatKey = tag?.startsWith('msg-') ? tag.replace('msg-', '')
                 : tag?.startsWith('call-') ? tag.replace('call-', '')
                 : undefined;
    const opts: NotificationOptions & { renotify?: boolean; data?: any } = {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: tag || `${APP_PREFIX}-${Date.now()}`,
      renotify: !!tag,
      data: { chat: chatKey },
    };

    // Prefer Service Worker notifications (required on Android Chrome / mobile PWAs)
    if ('serviceWorker' in navigator) {
      try {
        const reg = await navigator.serviceWorker.ready;
        await reg.showNotification(title, opts);
        return;
      } catch (e) {
        mgr.log(`SW notification failed, falling back: ${e}`, 'err');
      }
    }

    // Fallback: direct Notification API (desktop browsers)
    try {
      const n = new Notification(title, opts);
      setTimeout(() => n.close(), 15000);
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch (e) {
      mgr.log(`Notification failed: ${e}`, 'err');
    }
  }

