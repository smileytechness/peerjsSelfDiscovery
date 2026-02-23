import { Peer, DataConnection, MediaConnection } from 'peerjs';
import {
  APP_PREFIX,
  TTL,
  PING_IV,
  PeerInfo,
  Contact,
  ChatMessage,
  FileTransfer,
  CHUNK_SIZE,
} from './types';
import {
  makeRouterID,
  makeDiscID,
  extractDiscUUID,
  getPublicIP,
} from './discovery';
import {
  saveContacts,
  loadContacts,
  saveChats,
  loadChats,
  saveFile,
} from './store';
import {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  exportPrivateKey,
  importPrivateKey,
  signData,
  verifySignature,
} from './crypto';


export class P2PManager extends EventTarget {
  public friendlyName: string = '';
  public persistentID: string = '';
  public discoveryUUID: string = '';
  public discoveryID: string = '';
  public publicIP: string = '';
  public pubkeyFingerprint: string = '';

  public contacts: Record<string, Contact> = {};
  public chats: Record<string, ChatMessage[]> = {};
  public registry: Record<string, PeerInfo> = {};

  private routerPeer: Peer | null = null;
  private discPeer: Peer | null = null;
  private persPeer: Peer | null = null;
  private routerConn: DataConnection | null = null;

  public isRouter: boolean = false;
  public namespaceLevel: number = 0;
  public persConnected: boolean = false;
  public signalingState: 'connected' | 'reconnecting' | 'offline' = 'offline';
  public lastSignalingTs: number = 0;
  private pingTimer: any = null;
  private heartbeatTimer: any = null;
  private namespaceMonitorTimer: any = null;
  private connectingPIDs: Set<string> = new Set();
  public offlineMode: boolean = false;
  public namespaceOffline: boolean = false;
  private readonly MAX_NAMESPACE = 5;
  private readonly MAX_JOIN_ATTEMPTS = 3;
  private incomingFiles: Record<string, FileTransfer> = {};
  private pendingFiles: Record<string, File[]> = {};

  private privateKey: CryptoKey | null = null;
  private publicKey: CryptoKey | null = null;
  private publicKeyStr: string = '';

  private initPromise: Promise<void> | null = null;

  constructor() {
    super();
  }

  private async loadState() {
    this.contacts = loadContacts();
    this.chats = loadChats();
    this.friendlyName = localStorage.getItem('myapp-name') || '';
    this.persistentID = localStorage.getItem('myapp-pid') || '';
    this.discoveryUUID = localStorage.getItem('myapp-disc-uuid') || '';

    if (!this.persistentID) {
      this.persistentID = `${APP_PREFIX}-${crypto.randomUUID().replace(/-/g, '')}`;
      localStorage.setItem('myapp-pid', this.persistentID);
    }
    if (!this.discoveryUUID) {
      this.discoveryUUID = crypto.randomUUID().replace(/-/g, '');
      localStorage.setItem('myapp-disc-uuid', this.discoveryUUID);
    }

    // Load or generate keys — requires secure context (HTTPS or localhost)
    if (!window.crypto?.subtle) {
      this.log('No secure context (not HTTPS) — crypto disabled, identity verification skipped', 'err');
      return;
    }

    const sk = localStorage.getItem('myapp-sk');
    const pk = localStorage.getItem('myapp-pk');

    if (sk && pk) {
      try {
        this.privateKey = await importPrivateKey(sk);
        this.publicKey = await importPublicKey(pk);
        this.publicKeyStr = pk;
        this.pubkeyFingerprint = await this.computeFingerprint(pk);
        this.log('Loaded cryptographic identity', 'ok');
      } catch (e) {
        this.log('Failed to load keys, regenerating...', 'err');
        await this.generateAndSaveKeys();
      }
    } else {
      await this.generateAndSaveKeys();
    }
  }

  private async generateAndSaveKeys() {
    this.log('Generating new identity keys...', 'info');
    const pair = await generateKeyPair();
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
    const sk = await exportPrivateKey(this.privateKey);
    const pk = await exportPublicKey(this.publicKey);
    this.publicKeyStr = pk;
    this.pubkeyFingerprint = await this.computeFingerprint(pk);
    localStorage.setItem('myapp-sk', sk);
    localStorage.setItem('myapp-pk', pk);
    this.log('Identity keys generated', 'ok');
  }

  private async computeFingerprint(pk: string): Promise<string> {
    if (!window.crypto?.subtle) return '';
    try {
      const bytes = new TextEncoder().encode(pk);
      const hash = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(hash)).slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch {
      return '';
    }
  }

  public init(name: string) {
    this.friendlyName = name;
    localStorage.setItem('myapp-name', name);

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this._init();
    return this.initPromise;
  }

  private async _init() {
    await this.loadState();
    this.log('Initializing...', 'info');

    this.registerPersistent();
    this.watchNetwork();
    this.startHeartbeat();

    this.publicIP = (await getPublicIP()) || '';
    if (!this.publicIP) {
      this.log('Could not detect public IP — manual connect still works', 'err');
      this.emitStatus();
      return;
    }

    this.log(`Public IP: ${this.publicIP}`, 'ok');
    this.discoveryID = makeDiscID(this.publicIP, this.discoveryUUID);
    this.attemptNamespace(1);

    this.emitStatus();
  }

  private watchNetwork() {
    // navigator.connection — available on Android/Chrome, not iOS
    const nc = (navigator as any).connection;
    if (nc) {
      nc.addEventListener('change', () => this.handleNetworkChange());
    }

    // window.online — broad support, fires when device regains connectivity
    window.addEventListener('online', () => {
      this.log('Browser online event', 'info');
      this.handleOnline();
    });
    window.addEventListener('offline', () => {
      this.log('Browser offline event', 'err');
      this.persConnected = false;
      this.emitStatus();
    });

    // visibilitychange — fires when user returns to app (tab focus, foreground on mobile)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.log('App foregrounded — checking connections', 'info');
        this.handleOnline();
      }
    });
  }

  private async handleNetworkChange() {
    if (this.offlineMode) return;
    const nc = (navigator as any).connection;
    const type = nc?.type || nc?.effectiveType || 'unknown';
    this.log(`Network type changed → ${type}`, 'info');

    // Force the persistent peer to re-register on the new network interface.
    // Simply calling handleOnline() is not enough: persPeer.disconnected may still
    // be false when the network type changes (the WebSocket looks alive briefly
    // before the server-side keepalive timeout fires). We force disconnect → reconnect
    // so the open event fires immediately, triggering reconnectOfflineContacts().
    if (this.persPeer && !this.persPeer.destroyed) {
      this.reconnectBackoff = 0;
      this.signalingState = 'reconnecting';
      this.emitStatus();
      try {
        if (!this.persPeer.disconnected) this.persPeer.disconnect();
        this.persPeer.reconnect();
      } catch {
        this.persPeer.destroy();
        this.persPeer = null;
        this.registerPersistent();
      }
    } else {
      this.handleOnline();
    }

    if (!this.publicIP) return;

    const newIP = await getPublicIP();
    if (!newIP) {
      this.log('IP undetectable after network change', 'err');
      return;
    }
    if (newIP !== this.publicIP) {
      this.log(`IP changed ${this.publicIP} → ${newIP} — refailing discovery`, 'info');
      this.publicIP = newIP;
      this.discoveryID = makeDiscID(this.publicIP, this.discoveryUUID);
      this.emitStatus();
      this.failover();
    } else {
      this.log('Same IP — rejoining discovery', 'ok');
      if (!this.isRouter && (!this.routerConn || !this.routerConn.open)) {
        this.tryJoinNamespace(this.namespaceLevel || 1);
      }
    }
  }

  private emitStatus() {
    const level = this.namespaceLevel;
    const roleLabel = level > 0
      ? (this.isRouter ? `Router L${level}` : `Peer L${level}`)
      : (this.isRouter ? 'Router' : 'Peer');

    this.dispatchEvent(
      new CustomEvent('status-change', {
        detail: {
          status: this.publicIP ? 'online' : 'offline',
          role: roleLabel,
          ip: this.publicIP,
          did: this.discoveryID,
          pid: this.persistentID,
          namespaceLevel: this.namespaceLevel,
          pubkeyFingerprint: this.pubkeyFingerprint,
          persConnected: this.persConnected,
          signalingState: this.signalingState,
          lastSignalingTs: this.lastSignalingTs,
          reconnectAttempt: this.reconnectBackoff,
        },
      })
    );
  }

  private log(msg: string, type: string = 'info') {
    console.log(`[P2P:${type}] ${msg}`);
    this.dispatchEvent(new CustomEvent('log', { detail: { msg, type } }));
  }

  private registerPersistent() {
    if (this.persPeer && !this.persPeer.destroyed) return;

    this.persPeer = new Peer(this.persistentID);

    this.persPeer.on('open', (id) => {
      this.persConnected = true;
      this.signalingState = 'connected';
      this.lastSignalingTs = Date.now();
      this.reconnectBackoff = 0;
      this.log(`Persistent ID registered: ${id}`, 'ok');
      this.emitStatus();
      // After (re-)connecting to signaling, restore data connections to contacts
      this.reconnectOfflineContacts();
    });

    this.persPeer.on('disconnected', () => {
      this.persConnected = false;
      this.signalingState = 'reconnecting';
      this.log('Persistent peer lost signaling connection — reconnecting...', 'err');
      this.emitStatus();
      this.schedulePersReconnect();
    });

    this.persPeer.on('close', () => {
      this.persConnected = false;
      this.log('Persistent peer closed — recreating...', 'err');
      this.emitStatus();
      this.persPeer = null;
      // Recreate after short delay
      setTimeout(() => this.registerPersistent(), 3000);
    });

    this.persPeer.on('connection', (conn) => {
      conn.on('data', (d) => this.handlePersistentData(d, conn));
      conn.on('close', () => {
        const pid = Object.keys(this.contacts).find((k) => this.contacts[k].conn === conn);
        if (pid) {
          this.contacts[pid].conn = null;
          this.emitPeerListUpdate();
        }
      });
    });

    this.persPeer.on('call', (call) => this.handleIncomingCall(call));
    this.persPeer.on('error', (e: any) => {
      this.log(`Persistent peer error: ${e.type}`, 'err');
      if (e.type === 'unavailable-id') {
        // Our persistent ID is taken — this is very rare but we handle it
        this.log('Persistent ID claimed — generating new one', 'err');
        this.persistentID = `${APP_PREFIX}-${crypto.randomUUID().replace(/-/g, '')}`;
        localStorage.setItem('myapp-pid', this.persistentID);
        this.persPeer?.destroy();
        this.persPeer = null;
        setTimeout(() => this.registerPersistent(), 1000);
      }
    });
  }

  private reconnectBackoff = 0;

  public setOfflineMode(offline: boolean) {
    this.offlineMode = offline;
    this.log(offline ? 'Offline mode — all connections paused' : 'Going online...', 'info');
    if (offline) {
      // Kill namespace discovery too
      this.setNamespaceOffline(true);
      if (this.persPeer && !this.persPeer.destroyed && !this.persPeer.disconnected) {
        try { this.persPeer.disconnect(); } catch {}
      }
      this.persConnected = false;
      this.signalingState = 'offline';
      this.emitStatus();
    } else {
      this.namespaceOffline = false; // re-enable namespace when going online
      this.signalingState = 'reconnecting';
      this.handleOnline();
    }
  }

  public setNamespaceOffline(offline: boolean) {
    this.namespaceOffline = offline;
    if (offline) {
      this.clearNamespaceMonitor();
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
      if (this.routerPeer) { this.routerPeer.destroy(); this.routerPeer = null; }
      // Keep discPeer alive — destroying it releases our disc ID on PeerJS server,
      // and if we rejoin quickly the same ID gets unavailable-id, generating a new UUID
      // and causing us to appear as an unknown peer in our own registry.
      if (this.routerConn) { this.routerConn.close(); this.routerConn = null; }
      this.isRouter = false;
      this.namespaceLevel = 0;
      const myEntry = Object.values(this.registry).find(r => r.isMe);
      this.registry = myEntry ? { [myEntry.discoveryID]: myEntry } : {};
      this.emitPeerListUpdate();
      this.emitStatus();
      this.log('Namespace discovery paused', 'info');
    } else {
      if (this.publicIP) {
        this.log('Rejoining namespace...', 'info');
        this.attemptNamespace(1);
      }
    }
  }

  // Returns the PID of an existing contact with the given public key (excluding `excludePID`)
  private findContactByPublicKey(publicKey: string, excludePID?: string): string | null {
    return Object.keys(this.contacts).find(
      k => k !== excludePID && !!this.contacts[k].publicKey && this.contacts[k].publicKey === publicKey
    ) ?? null;
  }

  // Merges an old contact entry into a new PID when a device gets a new persistent ID
  private migrateContact(oldPID: string, newPID: string) {
    if (oldPID === newPID) return;
    const existing = this.contacts[oldPID];
    if (!this.contacts[newPID]) {
      this.contacts[newPID] = { ...existing, conn: null };
    }
    if (this.chats[oldPID] && !this.chats[newPID]) {
      this.chats[newPID] = this.chats[oldPID];
      delete this.chats[oldPID];
    }
    delete this.contacts[oldPID];
    saveContacts(this.contacts);
    saveChats(this.chats);
    this.log(`Contact migrated: ${oldPID.slice(-8)} → ${newPID.slice(-8)}`, 'info');
  }

  private schedulePersReconnect() {
    if (this.offlineMode) return;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectBackoff), 30000) + Math.random() * 1000;
    this.reconnectBackoff = Math.min(this.reconnectBackoff + 1, 5);
    setTimeout(() => {
      if (!this.persPeer || this.persPeer.destroyed) {
        this.persPeer = null;
        this.registerPersistent();
      } else if (this.persPeer.disconnected) {
        try {
          this.persPeer.reconnect();
        } catch {
          this.persPeer.destroy();
          this.persPeer = null;
          this.registerPersistent();
        }
      }
    }, delay);
  }

  private handleOnline() {
    if (this.offlineMode) return;
    this.log('Connectivity change — checking persistent peer...', 'info');
    if (!this.persPeer || this.persPeer.destroyed) {
      this.persPeer = null;
      this.registerPersistent();
    } else if (this.persPeer.disconnected) {
      this.reconnectBackoff = 0;
      try {
        this.persPeer.reconnect();
      } catch {
        this.persPeer.destroy();
        this.persPeer = null;
        this.registerPersistent();
      }
    }
    // Re-join discovery if needed
    if (this.publicIP && !this.namespaceOffline && !this.isRouter && (!this.routerConn || !this.routerConn.open)) {
      setTimeout(() => this.tryJoinNamespace(this.namespaceLevel || 1), 1500);
    }
  }

  private reconnectOfflineContacts() {
    if (!this.persPeer || this.persPeer.destroyed || this.persPeer.disconnected) return;
    const pids = Object.keys(this.contacts).filter(
      pid => !this.contacts[pid].conn?.open && !this.connectingPIDs.has(pid)
    );
    if (pids.length === 0) return;
    this.log(`Reconnecting to ${pids.length} offline contact(s)...`, 'info');
    pids.forEach(pid => {
      if (this.contacts[pid].conn && !this.contacts[pid].conn.open) {
        this.contacts[pid].conn = null;
      }
      this.connectPersistent(pid, this.contacts[pid].friendlyName);
    });
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.offlineMode) return;
      const connected = this.persPeer != null && !this.persPeer.destroyed && !this.persPeer.disconnected;
      if (connected !== this.persConnected) {
        this.persConnected = connected;
        this.emitStatus();
      }
      if (!connected && this.persPeer && !this.persPeer.destroyed) {
        this.log('Heartbeat: signaling lost — reconnecting', 'info');
        this.schedulePersReconnect();
      }
    }, 20000);
  }

  // ─── Namespace cascade ────────────────────────────────────────────────────

  private attemptNamespace(level: number) {
    if (this.namespaceOffline) return;
    if (level > this.MAX_NAMESPACE) {
      this.log(`All namespace levels exhausted (1–${this.MAX_NAMESPACE}) — discovery offline`, 'err');
      return;
    }

    const rid = makeRouterID(this.publicIP, level);
    this.log(`Attempting router election at level ${level}: ${rid}`, 'info');

    if (this.routerPeer) { this.routerPeer.destroy(); this.routerPeer = null; }

    this.routerPeer = new Peer(rid);

    this.routerPeer.on('open', (id) => {
      this.isRouter = true;
      this.namespaceLevel = level;
      this.log(`Elected as router at level ${level}: ${id}`, 'ok');
      this.emitStatus();
      this.routerPeer?.on('connection', (conn) => this.handleRouterConn(conn));
      this.startPingTimer();
      this.registerDisc();
      if (level > 1) {
        this.startNamespaceMonitor();
      }
    });

    this.routerPeer.on('error', (e: any) => {
      if (e.type === 'unavailable-id') {
        this.log(`Level ${level} router slot taken — trying to join`, 'info');
        this.routerPeer = null;
        this.tryJoinNamespace(level);
      } else {
        this.log(`Router election error at level ${level}: ${e.type}`, 'err');
      }
    });
  }

  private tryJoinNamespace(level: number, attempt: number = 0) {
    const rid = makeRouterID(this.publicIP, level);
    this.log(`Connecting to level ${level} router (attempt ${attempt + 1}): ${rid}`, 'info');

    const peer = this.persPeer;
    if (!peer) return;

    if (this.routerConn) { this.routerConn.close(); this.routerConn = null; }

    this.routerConn = peer.connect(rid, { reliable: true });
    let connected = false;

    this.routerConn.on('open', () => {
      connected = true;
      this.isRouter = false;
      this.namespaceLevel = level;
      this.routerConn?.send({
        type: 'checkin',
        discoveryID: this.discoveryID,
        friendlyname: this.friendlyName,
        publicKey: this.publicKeyStr,
      });
      this.log(`Checked in to level ${level} router`, 'ok');
      this.registerDisc();
      if (level > 1) {
        this.startNamespaceMonitor();
      }
      this.emitStatus();
    });

    this.routerConn.on('data', (d: any) => {
      if (d.type === 'registry') this.mergeRegistry(d.peers);
      if (d.type === 'ping') this.routerConn?.send({ type: 'pong' });
      if (d.type === 'migrate') {
        this.log(`Router signaling migration to level ${d.level}`, 'info');
        this.handleRouterMigrate(d.level);
      }
    });

    this.routerConn.on('close', () => {
      if (!connected) return;
      this.log('Router disconnected — failing over', 'err');
      this.routerConn = null;
      this.clearNamespaceMonitor();
      this.failover();
    });

    this.routerConn.on('error', (err) => {
      this.log(`Join error at level ${level}: ${err.type}`, 'err');
      this.routerConn = null;
      if (attempt < this.MAX_JOIN_ATTEMPTS) {
        setTimeout(() => this.tryJoinNamespace(level, attempt + 1), 1500);
      } else {
        this.log(`Cannot reach level ${level} router — escalating to level ${level + 1}`, 'info');
        this.attemptNamespace(level + 1);
      }
    });
  }

  // ─── Namespace monitor (for level > 1 routers and peers) ─────────────────

  private startNamespaceMonitor() {
    this.clearNamespaceMonitor();
    this.namespaceMonitorTimer = setInterval(() => this.checkForLowerNamespace(), 30000);
  }

  private clearNamespaceMonitor() {
    if (this.namespaceMonitorTimer) {
      clearInterval(this.namespaceMonitorTimer);
      this.namespaceMonitorTimer = null;
    }
  }

  private checkForLowerNamespace() {
    if (this.namespaceLevel <= 1 || !this.publicIP) return;

    const rid = makeRouterID(this.publicIP, 1);
    const peer = this.discPeer || this.persPeer;
    if (!peer) return;

    this.log(`Probing level 1 namespace availability...`, 'info');

    const testConn = peer.connect(rid, { reliable: true });
    let settled = false;

    const resolve = (routerFound: boolean) => {
      if (settled) return;
      settled = true;
      try { testConn.close(); } catch {}

      if (routerFound) {
        // A live router is at level 1 — migrate there
        this.log(`Level 1 router live — migrating from level ${this.namespaceLevel}`, 'info');
        if (this.isRouter) {
          // Tell our peers to follow, then migrate ourselves
          this.broadcastMigration(1);
          setTimeout(() => this.handleRouterMigrate(1), 600);
        } else {
          this.handleRouterMigrate(1);
        }
      } else {
        // Level 1 is unclaimed
        if (this.isRouter) {
          this.log(`Level 1 unclaimed — reclaiming from level ${this.namespaceLevel}`, 'info');
          this.broadcastMigration(1);
          setTimeout(() => {
            this.clearNamespaceMonitor();
            if (this.routerPeer) { this.routerPeer.destroy(); this.routerPeer = null; }
            if (this.discPeer) { this.discPeer.destroy(); this.discPeer = null; }
            if (this.routerConn) { this.routerConn.close(); this.routerConn = null; }
            this.isRouter = false;
            this.namespaceLevel = 0;
            const myEntry = Object.values(this.registry).find(r => r.isMe);
            this.registry = myEntry ? { [myEntry.discoveryID]: myEntry } : {};
            this.emitPeerListUpdate();
            this.attemptNamespace(1);
          }, 600);
        }
        // Peers do nothing — wait for their router to handle it or next check cycle
      }
    };

    testConn.on('open', () => resolve(true));
    testConn.on('error', () => resolve(false));
    setTimeout(() => resolve(false), 4000);
  }

  private broadcastMigration(level: number) {
    Object.values(this.registry).forEach((r) => {
      if (r.conn && !r.isMe) {
        try { r.conn.send({ type: 'migrate', level }); } catch {}
      }
    });
  }

  private handleRouterMigrate(targetLevel: number) {
    this.log(`Migrating to level ${targetLevel}`, 'info');
    this.clearNamespaceMonitor();
    if (this.routerConn) { this.routerConn.close(); this.routerConn = null; }
    if (this.routerPeer) { this.routerPeer.destroy(); this.routerPeer = null; }
    if (this.discPeer) { this.discPeer.destroy(); this.discPeer = null; }
    this.isRouter = false;
    this.namespaceLevel = 0;
    const myEntry = Object.values(this.registry).find(r => r.isMe);
    this.registry = myEntry ? { [myEntry.discoveryID]: myEntry } : {};
    this.emitPeerListUpdate();
    // Jitter so all migrating clients don't slam level-1 simultaneously
    setTimeout(() => this.attemptNamespace(targetLevel), Math.random() * 2000);
  }

  // ─── Discovery peer registration ──────────────────────────────────────────

  private registerDisc() {
    // Reuse existing discPeer if it's still open — prevents the unavailable-id race
    // that occurs when rejoining namespace shortly after a pause (PeerJS server hasn't
    // released the old ID yet, so we'd generate a new UUID and appear as an unknown peer).
    if (this.discPeer && !this.discPeer.destroyed) {
      const id = this.discoveryID;
      if (!this.registry[id]) {
        this.registry[id] = {
          discoveryID: id,
          friendlyName: this.friendlyName,
          lastSeen: Date.now(),
          isMe: true,
          publicKey: this.publicKeyStr || undefined,
        };
      }
      if (this.isRouter) this.broadcastRegistry();
      this.emitStatus();
      return;
    }

    if (this.discPeer) { this.discPeer.destroy(); this.discPeer = null; }

    this.discPeer = new Peer(this.discoveryID);
    this.discPeer.on('open', (id) => {
      this.log(`Discovery ID: ${id}`, 'ok');
      this.registry[id] = {
        discoveryID: id,
        friendlyName: this.friendlyName,
        lastSeen: Date.now(),
        isMe: true,
        publicKey: this.publicKeyStr || undefined,
      };

      if (this.isRouter) {
        this.broadcastRegistry();
      }
      this.emitStatus();
    });

    this.discPeer.on('connection', (conn) => {
      conn.on('data', (d) => this.handleDiscData(d, conn));
    });

    this.discPeer.on('error', (e: any) => {
      this.log(`Discovery error: ${e.type}`, 'err');
      if (e.type === 'unavailable-id') {
        // UUID collision — regenerate
        this.discoveryUUID = crypto.randomUUID().replace(/-/g, '');
        localStorage.setItem('myapp-disc-uuid', this.discoveryUUID);
        this.discoveryID = makeDiscID(this.publicIP, this.discoveryUUID);
        this.registerDisc();
      }
    });
  }

  // ─── Router: handle peer check-ins ───────────────────────────────────────

  private handleRouterConn(conn: DataConnection) {
    conn.on('data', (d: any) => {
      if (d.type === 'checkin') {
        const uuid = extractDiscUUID(d.discoveryID);

        // Dedup: remove stale entry for this same device (same public key).
        // Happens when a device reconnects quickly and the old disc ID hasn't timed out yet.
        if (d.publicKey) {
          const staleKey = Object.keys(this.registry).find(did =>
            did !== d.discoveryID && !!this.registry[did].publicKey && this.registry[did].publicKey === d.publicKey
          );
          if (staleKey) {
            this.log(`Replaced stale disc entry: …${staleKey.slice(-8)} → …${d.discoveryID.slice(-8)}`, 'info');
            delete this.registry[staleKey];
          }
        }

        // Match existing contact by public key first, then by discoveryUUID
        const knownPID = Object.keys(this.contacts).find((pid) => {
          const c = this.contacts[pid];
          if (d.publicKey && c.publicKey && c.publicKey === d.publicKey) return true;
          return c.discoveryUUID === uuid;
        });

        if (knownPID) {
          this.contacts[knownPID].onNetwork = true;
          this.contacts[knownPID].networkDiscID = d.discoveryID;
        }

        this.registry[d.discoveryID] = {
          discoveryID: d.discoveryID,
          friendlyName: d.friendlyname,
          lastSeen: Date.now(),
          conn,
          knownPID: knownPID || null,
          publicKey: d.publicKey || undefined,
        };
        this.log(`Peer checked in at L${this.namespaceLevel}: ${d.discoveryID}`, 'ok');
        this.broadcastRegistry();
        this.emitPeerListUpdate();
      }
      if (d.type === 'pong') {
        const key = Object.keys(this.registry).find((k) => this.registry[k].conn === conn);
        if (key) this.registry[key].lastSeen = Date.now();
      }
    });
    conn.on('close', () => {
      const key = Object.keys(this.registry).find((k) => this.registry[k].conn === conn);
      if (key) {
        delete this.registry[key];
        this.broadcastRegistry();
        this.emitPeerListUpdate();
      }
    });
  }

  private broadcastRegistry() {
    const peers = Object.keys(this.registry).map((did) => ({
      discoveryID: did,
      friendlyname: this.registry[did].friendlyName,
      publicKey: this.registry[did].publicKey,
    }));
    Object.values(this.registry).forEach((r) => {
      if (r.conn && !r.isMe) {
        try {
          r.conn.send({ type: 'registry', peers });
        } catch {}
      }
    });
  }

  private startPingTimer() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      const now = Date.now();
      Object.keys(this.registry).forEach((did) => {
        const r = this.registry[did];
        if (r.isMe) return;
        if (r.conn) {
          try { r.conn.send({ type: 'ping' }); } catch {}
        }
        if (now - r.lastSeen > TTL + 10000) {
          this.log(`Peer timed out: ${did}`, 'err');
          delete this.registry[did];
          this.broadcastRegistry();
          this.emitPeerListUpdate();
        }
      });
    }, PING_IV);
  }

  // ─── Peer: merge registry updates ────────────────────────────────────────

  private mergeRegistry(peers: any[]) {
    this.log(`Registry update: ${peers.length} peers`, 'info');

    const newRegistry: Record<string, PeerInfo> = {};
    const myEntry = Object.values(this.registry).find(r => r.isMe);
    if (myEntry) newRegistry[myEntry.discoveryID] = myEntry;

    Object.keys(this.contacts).forEach((pid) => {
      this.contacts[pid].onNetwork = false;
      this.contacts[pid].networkDiscID = null;
    });

    peers.forEach((p) => {
      if (p.discoveryID === this.discoveryID) return;

      const uuid = extractDiscUUID(p.discoveryID);

      // Dedup: if we already have an entry for this same public key, remove the older one
      // so a device that reconnected with a new disc ID doesn't appear twice.
      if (p.publicKey) {
        const staleKey = Object.keys(newRegistry).find(did =>
          did !== p.discoveryID && !newRegistry[did].isMe && !!newRegistry[did].publicKey && newRegistry[did].publicKey === p.publicKey
        );
        if (staleKey) delete newRegistry[staleKey];
      }

      // Public key match takes priority over discoveryUUID
      const knownPID = Object.keys(this.contacts).find((pid) => {
        const c = this.contacts[pid];
        if (p.publicKey && c.publicKey && c.publicKey === p.publicKey) return true;
        return c.discoveryUUID === uuid;
      });

      if (knownPID) {
        this.contacts[knownPID].onNetwork = true;
        this.contacts[knownPID].networkDiscID = p.discoveryID;
        // Store public key if we receive it for the first time
        if (p.publicKey && !this.contacts[knownPID].publicKey) {
          this.contacts[knownPID].publicKey = p.publicKey;
          saveContacts(this.contacts);
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

    this.registry = newRegistry;
    this.emitPeerListUpdate();
  }

  // ─── Failover ─────────────────────────────────────────────────────────────

  private failover() {
    if (this.namespaceOffline) return;
    const jitter = Math.random() * 3000;
    this.log(`Failover in ${(jitter / 1000).toFixed(1)}s — restarting from L1`, 'info');
    this.clearNamespaceMonitor();
    setTimeout(() => {
      if (this.routerPeer) { this.routerPeer.destroy(); this.routerPeer = null; }
      if (this.discPeer) { this.discPeer.destroy(); this.discPeer = null; }
      if (this.routerConn) { this.routerConn.close(); this.routerConn = null; }
      this.isRouter = false;
      this.namespaceLevel = 0;

      const myEntry = Object.values(this.registry).find(r => r.isMe);
      this.registry = myEntry ? { [myEntry.discoveryID]: myEntry } : {};
      this.emitPeerListUpdate();

      this.discoveryID = makeDiscID(this.publicIP, this.discoveryUUID);
      this.attemptNamespace(1);
    }, jitter);
  }

  // ─── Manual connect / handshake ───────────────────────────────────────────

  public requestConnect(targetID: string, fname: string) {
    if (targetID === this.discoveryID || targetID === this.persistentID) return;
    this.log(`Requesting connection to: ${targetID}`, 'info');

    const isPersistent = targetID.split('-').length === 2;
    const peer = isPersistent ? this.persPeer : (this.discPeer || this.persPeer);

    if (!peer) {
      this.log('No active peer instance to connect', 'err');
      return;
    }

    const conn = peer.connect(targetID, { reliable: true });
    conn.on('open', () => {
      this.log(`Handshake channel open with ${targetID}`, 'info');
      conn.send({ type: 'request', friendlyname: this.friendlyName });
    });

    conn.on('data', (d: any) => {
      if (d.type === 'accepted') {
        this.log(`Request accepted by ${fname}`, 'ok');
        conn.send({
          type: 'confirm',
          persistentID: this.persistentID,
          friendlyname: this.friendlyName,
          discoveryUUID: this.discoveryUUID
        });

        // Dedup: if this public key already exists under a different PID, migrate
        const dupPID = d.publicKey ? this.findContactByPublicKey(d.publicKey, d.persistentID) : null;
        if (dupPID) this.migrateContact(dupPID, d.persistentID);

        this.contacts[d.persistentID] = {
          ...(this.contacts[d.persistentID] || {}),
          friendlyName: fname,
          discoveryID: isPersistent ? null : targetID,
          discoveryUUID: d.discoveryUUID,
          conn: null
        };

        if (!this.chats[d.persistentID]) this.chats[d.persistentID] = [];
        saveContacts(this.contacts);
        saveChats(this.chats);

        setTimeout(() => conn.close(), 1000);
        this.connectPersistent(d.persistentID, fname);
        this.emitPeerListUpdate();
      }
      if (d.type === 'rejected') {
        this.log(`${fname} rejected the connection`, 'err');
        conn.close();
      }
    });

    conn.on('error', (err) => {
      this.log(`Connection request failed: ${err.type}`, 'err');
    });
  }

  private handleDiscData(d: any, conn: DataConnection) {
    this.handleHandshakeData(d, conn);
  }

  private async handleHandshakeData(d: any, conn: DataConnection) {
    if (d.type === 'request') {
      const fname = d.friendlyname;
      this.log(`Incoming connection request from ${fname}`, 'info');
      const event = new CustomEvent('connection-request', {
        detail: {
          fname,
          accept: () => {
            conn.send({ type: 'accepted', persistentID: this.persistentID, discoveryUUID: this.discoveryUUID });
            this.log(`Accepted request from ${fname}`, 'ok');
          },
          reject: () => {
            conn.send({ type: 'rejected' });
            setTimeout(() => conn.close(), 500);
          }
        }
      });
      this.dispatchEvent(event);
    }
    if (d.type === 'confirm') {
      const pid = d.persistentID;
      this.log(`Handshake confirmed by ${d.friendlyname} (${pid})`, 'ok');

      // Dedup: if this public key already exists under a different PID, migrate
      const dupPID = d.publicKey ? this.findContactByPublicKey(d.publicKey, pid) : null;
      if (dupPID) this.migrateContact(dupPID, pid);

      this.contacts[pid] = {
        ...(this.contacts[pid] || {}),
        friendlyName: d.friendlyname,
        discoveryID: null,
        discoveryUUID: d.discoveryUUID,
        conn: null
      };
      if (!this.chats[pid]) this.chats[pid] = [];
      saveContacts(this.contacts);
      saveChats(this.chats);
      setTimeout(() => conn.close(), 500);
      this.emitPeerListUpdate();
    }
  }

  public connectPersistent(pid: string, fname: string) {
    if (!this.persPeer || this.persPeer.destroyed) return;
    if (this.persPeer.disconnected) {
      // Signaling is down — handleOnline will call reconnectOfflineContacts once peer reopens
      this.log(`Signaling down — will reconnect to ${fname} when online`, 'info');
      return;
    }

    // Clear stale conn object (exists but channel is closed)
    if (this.contacts[pid]?.conn && !this.contacts[pid].conn.open) {
      this.contacts[pid].conn = null;
    }

    if (this.contacts[pid]?.conn?.open) {
      this.log(`Already connected to ${fname}`, 'info');
      return;
    }

    this.log(`Opening persistent connection to ${fname} (${pid})...`, 'info');
    this.connectingPIDs.add(pid);
    const conn = this.persPeer.connect(pid, { reliable: true });

    conn.on('open', async () => {
      this.connectingPIDs.delete(pid);
      if (!this.contacts[pid]) this.contacts[pid] = { friendlyName: fname, discoveryID: null, discoveryUUID: '' };
      this.contacts[pid].conn = conn;

      const ts = Date.now().toString();
      let signature = '';
      if (this.privateKey) {
        signature = await signData(this.privateKey, ts);
      }

      conn.send({
        type: 'hello',
        friendlyname: this.friendlyName,
        publicKey: this.publicKeyStr,
        ts,
        signature
      });

      this.flushMessageQueue(pid);
      this.emitPeerListUpdate();
      this.log(`Persistent channel open with ${fname}`, 'ok');
    });

    conn.on('data', (d) => this.handlePersistentData(d, conn));

    conn.on('close', () => {
      this.connectingPIDs.delete(pid);
      this.log(`Persistent channel closed with ${fname}`, 'info');
      if (this.contacts[pid]) {
        this.contacts[pid].conn = null;
        this.emitPeerListUpdate();
      }
    });

    conn.on('error', (err) => {
      this.connectingPIDs.delete(pid);
      this.log(`Persistent connection error with ${fname}: ${err.type}`, 'err');
    });
  }

  private async handlePersistentData(d: any, conn: DataConnection) {
    const pid = conn.peer;

    if (['request', 'confirm'].includes(d.type)) {
      return this.handleHandshakeData(d, conn);
    }

    if (d.type === 'hello') {
      // Dedup: same device got a new persistent ID — migrate old entry to new PID
      if (d.publicKey) {
        const dupPID = this.findContactByPublicKey(d.publicKey, pid);
        if (dupPID) this.migrateContact(dupPID, pid);
      }

      const isNew = !this.contacts[pid] || !this.contacts[pid].conn;

      if (d.publicKey && d.signature && d.ts) {
        if (window.crypto?.subtle) {
          try {
            const key = await importPublicKey(d.publicKey);
            const valid = await verifySignature(key, d.signature, d.ts);
            if (!valid) {
              this.log(`Invalid signature from ${d.friendlyname}`, 'err');
              conn.close();
              return;
            }
            if (!this.contacts[pid]) this.contacts[pid] = { friendlyName: d.friendlyname, discoveryID: null, discoveryUUID: '', conn, publicKey: d.publicKey };
            this.contacts[pid].publicKey = d.publicKey;
            this.log(`Verified identity for ${d.friendlyname}`, 'ok');
          } catch {
            this.log(`Identity verification failed for ${d.friendlyname}`, 'err');
          }
        } else {
          this.log(`No secure context — skipping identity check for ${d.friendlyname}`, 'info');
        }
      }

      if (!this.contacts[pid]) this.contacts[pid] = { friendlyName: d.friendlyname, discoveryID: null, discoveryUUID: '', conn };
      this.contacts[pid].conn = conn;
      this.contacts[pid].friendlyName = d.friendlyname;
      this.contacts[pid].lastSeen = Date.now();
      if (!this.chats[pid]) this.chats[pid] = [];

      if (isNew) {
        const ts = Date.now().toString();
        let signature = '';
        if (this.privateKey) {
          signature = await signData(this.privateKey, ts);
        }
        conn.send({
          type: 'hello',
          friendlyname: this.friendlyName,
          publicKey: this.publicKeyStr,
          ts,
          signature
        });
      }
      saveContacts(this.contacts);
      this.emitPeerListUpdate();
      this.log(`Hello from ${d.friendlyname}`, 'ok');
    }

    if (d.type === 'message') {
      if (!this.chats[pid]) this.chats[pid] = [];
      const msg: ChatMessage = { id: d.id || crypto.randomUUID(), dir: 'recv', content: d.content, ts: d.ts, type: 'text' };
      this.chats[pid].push(msg);
      saveChats(this.chats);
      if (conn.open) conn.send({ type: 'message-ack', id: d.id });
      this.dispatchEvent(new CustomEvent('message', { detail: { pid, msg } }));
    }

    if (d.type === 'message-ack') {
      const msgs = this.chats[pid];
      if (msgs) {
        const msg = msgs.find(m => m.id === d.id && m.dir === 'sent');
        if (msg) {
          msg.status = 'delivered';
          saveChats(this.chats);
          this.dispatchEvent(new CustomEvent('message', { detail: { pid } }));
        }
      }
    }

    if (d.type === 'file-start') {
      this.incomingFiles[d.tid] = { tid: d.tid, name: d.name, size: d.size, total: d.total, chunks: [], received: 0 };
      this.log(`Receiving: ${d.name}`, 'info');
    }
    if (d.type === 'file-chunk') {
      const f = this.incomingFiles[d.tid];
      if (f) {
        f.chunks[d.index] = d.chunk;
        f.received++;
        this.dispatchEvent(new CustomEvent('file-progress', { detail: { tid: d.tid, progress: f.received / f.total, name: f.name } }));
      }
    }
    if (d.type === 'file-end') {
      const f = this.incomingFiles[d.tid];
      if (!f) return;
      const blob = new Blob(f.chunks);
      const ts = Date.now();
      saveFile(d.tid, blob, f.name, ts).then(() => {
        if (!this.chats[pid]) this.chats[pid] = [];
        const msg: ChatMessage = { id: crypto.randomUUID(), dir: 'recv', type: 'file', name: f.name, tid: d.tid, size: f.size, ts };
        this.chats[pid].push(msg);
        saveChats(this.chats);
        delete this.incomingFiles[d.tid];
        // Acknowledge receipt so sender gets delivery checkmark
        if (conn.open) conn.send({ type: 'file-ack', tid: d.tid });
        this.log(`File received: ${f.name}`, 'ok');
        this.dispatchEvent(new CustomEvent('message', { detail: { pid, msg } }));
      });
    }

    if (d.type === 'file-ack') {
      const msgs = this.chats[pid];
      if (msgs) {
        const msg = msgs.find(m => m.tid === d.tid && m.dir === 'sent');
        if (msg) {
          msg.status = 'delivered';
          saveChats(this.chats);
          this.dispatchEvent(new CustomEvent('message', { detail: { pid } }));
        }
      }
    }
  }

  private flushMessageQueue(pid: string) {
    const c = this.contacts[pid];
    if (!c || !c.conn || !c.conn.open) return;

    const queue = this.chats[pid]?.filter(m => m.dir === 'sent' && m.status === 'waiting') || [];
    let updated = false;
    queue.forEach(msg => {
      if (msg.type === 'text') {
        c.conn.send({ type: 'message', content: msg.content, ts: msg.ts, id: msg.id });
        msg.status = 'sent';
        updated = true;
      }
    });
    if (updated) {
      saveChats(this.chats);
      this.dispatchEvent(new CustomEvent('message', { detail: { pid } }));
    }

    const files = this.pendingFiles[pid];
    if (files?.length) {
      files.forEach(file => this._sendFileNow(pid, file, c.conn));
      delete this.pendingFiles[pid];
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  public deleteContact(pid: string) {
    const c = this.contacts[pid];
    if (c?.conn?.open) try { c.conn.close(); } catch {}
    delete this.contacts[pid];
    delete this.chats[pid];
    saveContacts(this.contacts);
    saveChats(this.chats);
    this.emitPeerListUpdate();
    this.log(`Deleted contact: ${pid}`, 'info');
  }

  public pingContact(pid: string): Promise<'online' | 'offline'> {
    return new Promise((resolve) => {
      if (!this.persPeer) return resolve('offline');
      const c = this.contacts[pid];
      if (!c) return resolve('offline');

      if (c.conn?.open) {
        resolve('online');
        return;
      }

      const conn = this.persPeer.connect(pid, { reliable: true });
      const timer = setTimeout(() => {
        conn.close();
        resolve('offline');
        this.log(`${c.friendlyName} did not respond to ping`, 'info');
      }, 5000);

      conn.on('open', async () => {
        clearTimeout(timer);
        if (!this.contacts[pid]) this.contacts[pid] = c;
        this.contacts[pid].conn = conn;
        const ts = Date.now().toString();
        const signature = this.privateKey ? await signData(this.privateKey, ts) : '';
        conn.send({ type: 'hello', friendlyname: this.friendlyName, publicKey: this.publicKeyStr, ts, signature });
        resolve('online');
        this.emitPeerListUpdate();
        this.log(`${c.friendlyName} is online`, 'ok');
      });

      conn.on('data', (d) => this.handlePersistentData(d, conn));
      conn.on('close', () => {
        if (this.contacts[pid]) { this.contacts[pid].conn = null; this.emitPeerListUpdate(); }
      });
      conn.on('error', () => {
        clearTimeout(timer);
        resolve('offline');
      });
    });
  }

  public sendMessage(pid: string, content: string) {
    const c = this.contacts[pid];
    const msg: ChatMessage = { id: crypto.randomUUID(), dir: 'sent', content, ts: Date.now(), type: 'text', status: 'waiting' };

    if (!this.chats[pid]) this.chats[pid] = [];
    this.chats[pid].push(msg);
    saveChats(this.chats);

    if (c && c.conn && c.conn.open) {
      c.conn.send({ type: 'message', content, ts: msg.ts, id: msg.id });
      msg.status = 'sent';
      saveChats(this.chats);
    } else if (c) {
      // conn is null or stale — clear and reconnect
      if (c.conn && !c.conn.open) c.conn = null;
      this.connectPersistent(pid, c.friendlyName);
    }
    this.dispatchEvent(new CustomEvent('message', { detail: { pid, msg } }));
  }

  public sendFile(pid: string, file: File) {
    const c = this.contacts[pid];
    if (!c) return;

    if (!c.conn || !c.conn.open) {
      if (!this.pendingFiles[pid]) this.pendingFiles[pid] = [];
      this.pendingFiles[pid].push(file);
      this.log(`File queued (offline): ${file.name}`, 'info');
      if (!c.conn) this.connectPersistent(pid, c.friendlyName);
      return;
    }

    this._sendFileNow(pid, file, c.conn);
  }

  private _sendFileNow(pid: string, file: File, conn: DataConnection) {
    const tid = crypto.randomUUID().replace(/-/g, '');
    const reader = new FileReader();
    reader.onload = async (e) => {
      const buf = e.target?.result as ArrayBuffer;
      const total = Math.ceil(buf.byteLength / CHUNK_SIZE);
      conn.send({ type: 'file-start', tid, name: file.name, size: buf.byteLength, total });

      for (let i = 0; i < total; i++) {
        conn.send({
          type: 'file-chunk',
          tid,
          index: i,
          chunk: buf.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
        });
      }
      conn.send({ type: 'file-end', tid });

      const blob = new Blob([buf]);
      await saveFile(tid, blob, file.name, Date.now());

      if (!this.chats[pid]) this.chats[pid] = [];
      const msg: ChatMessage = { id: crypto.randomUUID(), dir: 'sent', type: 'file', name: file.name, tid, size: file.size, ts: Date.now(), status: 'sent' };
      this.chats[pid].push(msg);
      saveChats(this.chats);
      this.dispatchEvent(new CustomEvent('message', { detail: { pid, msg } }));
      this.log(`Sent: ${file.name}`, 'ok');
    };
    reader.readAsArrayBuffer(file);
  }

  public async startCall(pid: string, kind: 'audio' | 'video' | 'screen') {
    if (!this.persPeer) throw new Error('Not initialized');
    try {
      const stream = kind === 'screen'
        ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        : await navigator.mediaDevices.getUserMedia(kind === 'audio' ? { audio: true } : { audio: true, video: true });

      const call = this.persPeer.call(pid, stream, { metadata: { kind } });
      return { call, stream };
    } catch (e: any) {
      this.log(`Call failed: ${e.message}`, 'err');
      throw e;
    }
  }

  private handleIncomingCall(call: MediaConnection) {
    const pid = call.peer;
    const fname = this.contacts[pid]?.friendlyName || pid;
    const kind = call.metadata?.kind || 'video';
    this.dispatchEvent(new CustomEvent('incoming-call', { detail: { call, fname, kind } }));
  }

  private emitPeerListUpdate() {
    this.dispatchEvent(new CustomEvent('peer-list-update'));
  }
}

export const p2p = new P2PManager();
