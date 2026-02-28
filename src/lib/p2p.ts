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
  CustomNS,
  NSConfig,
  RVZ_WINDOW,
  RVZ_SWEEP_IV,
  GroupCallInfo,
} from './types';
import {
  makeRouterID,
  makeDiscID,
  extractDiscUUID,
  getPublicIP,
  slugifyNamespace,
  makeCustomRouterID,
  makeCustomDiscID,
  makePeerSlotID,
  makeRendezvousRouterID,
  makeRendezvousDiscID,
  makeRendezvousPeerSlotID,
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
  ecdsaToECDHPrivate,
  ecdsaToECDHPublic,
  deriveSharedKey,
  fingerprintSharedKey,
  encryptMessage,
  decryptMessage,
  arrayBufferToBase64,
  deriveRendezvousSlug,
} from './crypto';
import { NSState, CNSState, GroupNSState, GeoNSState, makeNSState } from './p2p-types';

import {
  nsEmit as _nsEmit, nsAttempt as _nsAttempt, nsTryJoin as _nsTryJoin,
  nsHandleRouterConn as _nsHandleRouterConn, nsBroadcast as _nsBroadcast,
  nsMergeRegistry as _nsMergeRegistry, nsStartPingTimer as _nsStartPingTimer,
  nsRegisterDisc as _nsRegisterDisc, nsStartMonitor as _nsStartMonitor,
  nsClearMonitor as _nsClearMonitor, nsProbeLevel1 as _nsProbeLevel1,
  nsBroadcastMigration as _nsBroadcastMigration, nsMigrate as _nsMigrate,
  nsFailover as _nsFailover, nsTeardown as _nsTeardown,
  nsTryPeerSlot as _nsTryPeerSlot, nsStartPeerSlotProbe as _nsStartPeerSlotProbe,
  nsProbePeerSlot as _nsProbePeerSlot,
} from './p2p-ns';
import {
  rvzStart as _rvzStart, rvzSweep as _rvzSweep, rvzProcessNext as _rvzProcessNext,
  rvzOnWindowExpire as _rvzOnWindowExpire, rvzCleanupActive as _rvzCleanupActive,
  rvzTeardown as _rvzTeardown, rvzCheckRegistry as _rvzCheckRegistry,
  rvzHandleExchange as _rvzHandleExchange, rvzEnqueue as _rvzEnqueue,
  rvzContactConnected as _rvzContactConnected,
} from './p2p-rvz';
import {
  handlePersistentData as _handlePersistentData, flushMessageQueue as _flushMessageQueue,
  markWaitingMessagesFailed as _markWaitingMessagesFailed,
  resetUnackedMessages as _resetUnackedMessages, resetContactMessages as _resetContactMessages,
  sendEncryptedMessage as _sendEncryptedMessage, _sendFileNow as __sendFileNow,
} from './p2p-messaging';
import {
  registerPersistent as _registerPersistent, schedulePersReconnect as _schedulePersReconnect,
  handleOnline as _handleOnline, reconnectOfflineContacts as _reconnectOfflineContacts,
  startHeartbeat as _startHeartbeat, startCheckinTimer as _startCheckinTimer,
  watchNetwork as _watchNetwork, startKeepAlive as _startKeepAlive,
  acquireWakeLock as _acquireWakeLock, handleNetworkChange as _handleNetworkChange,
  notify as _notify, startContactSweep as _startContactSweep,
} from './p2p-signaling';
import {
  requestConnect as _requestConnect, handleDiscData as _handleDiscData,
  handleHandshakeData as _handleHandshakeData, connectPersistent as _connectPersistent,
} from './p2p-handshake';
import {
  groupCreate as _groupCreate, groupJoin as _groupJoin, groupJoinBySlug as _groupJoinBySlug,
  groupLeave as _groupLeave, groupSendMessage as _groupSendMessage,
  groupEditMessage as _groupEditMessage, groupDeleteMessage as _groupDeleteMessage,
  groupRetryMessage as _groupRetryMessage, groupSendFile as _groupSendFile,
  groupInvite as _groupInvite, groupHandleInvite as _groupHandleInvite,
  groupHandleNSData as _groupHandleNSData, groupSendCheckin as _groupSendCheckin,
  groupSave as _groupSave, groupRestore as _groupRestore, groupEmit as _groupEmit,
  groupKickMember as _groupKickMember,
  groupCallStart as _groupCallStart,
  groupCallJoin as _groupCallJoin,
  groupCallLeave as _groupCallLeave,
  groupCallAutoAnswer as _groupCallAutoAnswer,
  groupCallToggleCamera as _groupCallToggleCamera,
  groupCallToggleScreen as _groupCallToggleScreen,
} from './p2p-group';
import {
  geoStart as _geoStart, geoStop as _geoStop, geoRefresh as _geoRefresh,
  geoUpdatePosition as _geoUpdatePosition, geoGetNearbyPeers as _geoGetNearbyPeers,
} from './p2p-geo';

// ─── P2PManager ───────────────────────────────────────────────────────────────

export class P2PManager extends EventTarget {
  public friendlyName: string = '';
  public persistentID: string = '';
  public discoveryUUID: string = '';
  public discoveryID: string = '';
  public publicIP: string = '';
  public pubkeyFingerprint: string = '';

  public contacts: Record<string, Contact> = {};
  public chats: Record<string, ChatMessage[]> = {};

  // Public IP namespace state (shared NSState)
  /** @internal */ public publicNS: NSState = makeNSState();

  /** @internal */ public persPeer: Peer | null = null;

  public persConnected: boolean = false;
  public signalingState: 'connected' | 'reconnecting' | 'offline' = 'offline';
  public lastSignalingTs: number = 0;
  /** @internal */ public heartbeatTimer: any = null;
  /** @internal */ public checkinTimer: any = null;
  /** @internal */ public connectingPIDs: Set<string> = new Set();
  /** @internal */ public connectFailures: Record<string, number> = {};
  public readonly MAX_CONNECT_RETRIES = 3;
  public offlineMode: boolean = false;
  public namespaceOffline: boolean = false;
  public readonly MAX_NAMESPACE = 5;
  public readonly MAX_JOIN_ATTEMPTS = 3;
  /** @internal */ public incomingFiles: Record<string, FileTransfer> = {};
  /** @internal */ public pendingFiles: Record<string, File[]> = {};

  // ─── Custom Namespaces ─────────────────────────────────────────────────────
  /** @internal */ public cns: Map<string, CNSState> = new Map();

  // ─── Group Chats ────────────────────────────────────────────────────────────
  /** @internal */ public groups: Map<string, GroupNSState> = new Map();

  // ─── Geo Discovery ──────────────────────────────────────────────────────────
  /** @internal */ public geoStates: GeoNSState[] = [];
  /** @internal */ public geoWatchId: number | null = null;
  public geoRefreshing = false;
  public geoLat: number | null = null;
  public geoLng: number | null = null;
  /** Cache of publicKey → fingerprint for geo peers */
  /** @internal */ public geoFPCache: Map<string, string> = new Map();

  // ─── Group Calls ──────────────────────────────────────────────────────────
  public activeGroupCallId: string | null = null;
  /** @internal */ public groupCallLocalStream: MediaStream | null = null;
  /** @internal */ public groupCallCameraStream: MediaStream | null = null;
  /** @internal */ public groupCallMediaConns: Map<string, MediaConnection> = new Map(); // fp → MediaConnection
  /** @internal */ public groupCallRemoteStreams: Map<string, MediaStream> = new Map(); // fp → remote stream
  public groupCallKind: 'audio' | 'video' | 'screen' = 'audio';

  /** @internal */ public privateKey: CryptoKey | null = null;
  /** @internal */ public publicKey: CryptoKey | null = null;
  /** @internal */ public ecdhPrivateKey: CryptoKey | null = null;
  public publicKeyStr: string = '';
  public readonly signalingServer = '0.peerjs.com';
  // Runtime shared key cache: contactKey → { key, fingerprint }
  /** @internal */ public sharedKeys: Map<string, { key: CryptoKey; fingerprint: string }> = new Map();

  // PID → fingerprint reverse lookup (for when PeerJS gives us a PID)
  /** @internal */ public pidToFP: Map<string, string> = new Map();

  // ─── Rendezvous — parallel per-contact discovery namespaces ───────────────
  /** Active rvz namespaces keyed by contactKey */
  /** @internal */ public rvzMap: Map<string, { state: NSState; cfg: NSConfig; windowTimer: any }> = new Map();
  /** @internal */ public rvzSweepTimer: any = null;
  /** @internal */ public rvzInitTimer: any = null;
  // Legacy fields kept for backward compat with nsMergeRegistry check
  /** @internal */ public rvzQueue: string[] = [];
  /** @internal */ public rvzActive: string | null = null;
  /** @internal */ public rvzState: NSState | null = null;
  /** @internal */ public rvzCfg: NSConfig | null = null;
  /** @internal */ public rvzWindowTimer: any = null;

  /** @internal */ public initPromise: Promise<void> | null = null;
  /** @internal */ public wakeLock: any = null;
  /** @internal */ public keepAliveTimer: any = null;
  /** @internal */ public contactSweepTimer: any = null;

  // Cached PID history (avoids parsing localStorage on every emitStatus call)
  /** @internal */ public pidHistory: string[] = [];
  /** @internal */ public loadPidHistory() {
    try { this.pidHistory = JSON.parse(localStorage.getItem(`${APP_PREFIX}-pid-history`) || '[]'); } catch { this.pidHistory = []; }
  }

  // ─── Backward-compatible getters ───────────────────────────────────────────
  get isRouter() { return this.publicNS.isRouter; }
  get namespaceLevel() { return this.publicNS.level; }
  get registry(): Record<string, PeerInfo> { return this.publicNS.registry; }
  set registry(v: Record<string, PeerInfo>) { this.publicNS.registry = v; }

  // ─── NSConfig factories ────────────────────────────────────────────────────
  private get publicNSConfig(): NSConfig {
    return {
      label: 'public',
      makeRouterID: (level) => makeRouterID(this.publicIP, level),
      makeDiscID: (uuid) => makeDiscID(this.publicIP, uuid),
      makePeerSlotID: () => makePeerSlotID(this.publicIP),
    };
  }

  /** @internal */ public makeCNSConfig(s: { name: string; slug: string; advanced?: boolean }): NSConfig {
    const slug = s.slug;
    if (s.advanced) {
      return {
        label: `ns:${s.name}`,
        makeRouterID: (level) => `${slug}-${level}`,
        makeDiscID: (uuid) => `${slug}-${uuid}`,
        makePeerSlotID: () => `${slug}-p1`,
      };
    }
    return {
      label: `ns:${s.name}`,
      makeRouterID: (level) => makeCustomRouterID(slug, level),
      makeDiscID: (uuid) => makeCustomDiscID(slug, uuid),
      makePeerSlotID: () => `${APP_PREFIX}-ns-${slug}-p1`,
    };
  }

  // ─── ECDH shared key derivation ────────────────────────────────────────────

  /** Derive (or retrieve cached) shared AES key for a contact. Returns null if
   *  our ECDH key or their public key is unavailable. */
  /** @internal */ public async getOrDeriveSharedKey(contactKey: string): Promise<{ key: CryptoKey; fingerprint: string } | null> {
    if (!this.ecdhPrivateKey) return null;
    const c = this.contacts[contactKey];
    if (!c?.publicKey) return null;

    const cached = this.sharedKeys.get(contactKey);
    if (cached) return cached;

    try {
      const theirECDH = await ecdsaToECDHPublic(c.publicKey);
      const key = await deriveSharedKey(this.ecdhPrivateKey, theirECDH);
      const fingerprint = await fingerprintSharedKey(key);
      const entry = { key, fingerprint };
      this.sharedKeys.set(contactKey, entry);
      // Persist shared key fingerprint on contact
      c.sharedKeyFingerprint = fingerprint;
      saveContacts(this.contacts);
      this.log(`Shared key derived for ${c.friendlyName}: ${fingerprint}`, 'ok');
      return entry;
    } catch (e) {
      this.log(`Failed to derive shared key for ${c.friendlyName}: ${e}`, 'err');
      return null;
    }
  }

  /** Public accessor: get shared key fingerprint for a contact (for UI display) */
  public getSharedKeyFingerprint(contactKey: string): string | null {
    return this.sharedKeys.get(contactKey)?.fingerprint ?? this.contacts[contactKey]?.sharedKeyFingerprint ?? null;
  }

  /** Export raw shared AES key as base64 (for UI display) */
  public async getSharedKeyExport(contactKey: string): Promise<string | null> {
    const entry = this.sharedKeys.get(contactKey);
    if (!entry) return null;
    const raw = await window.crypto.subtle.exportKey('raw', entry.key);
    return arrayBufferToBase64(raw);
  }

  /** Invalidate cached shared key (e.g. if contact's public key changes — shouldn't happen) */
  /** @internal */ public clearSharedKey(contactKey: string) {
    this.sharedKeys.delete(contactKey);
  }

  constructor() {
    super();
  }

  private async loadState() {
    this.contacts = loadContacts();
    this.chats = loadChats();
    this.loadPidHistory();
    this.friendlyName = localStorage.getItem(`${APP_PREFIX}-name`) || '';
    this.persistentID = localStorage.getItem(`${APP_PREFIX}-pid`) || '';
    this.discoveryUUID = localStorage.getItem(`${APP_PREFIX}-disc-uuid`) || '';

    // ── Migration: PID-keyed → fingerprint-keyed contacts ──────────────────
    await this.migrateToFingerprintKeys();

    // Build pidToFP map from loaded contacts
    for (const [key, c] of Object.entries(this.contacts)) {
      if (c.fingerprint && c.currentPID) {
        this.pidToFP.set(c.currentPID, key);
        c.knownPIDs?.forEach(pid => this.pidToFP.set(pid, key));
      }
    }

    if (!this.persistentID) {
      this.persistentID = `${APP_PREFIX}-${crypto.randomUUID().replace(/-/g, '')}`;
      localStorage.setItem(`${APP_PREFIX}-pid`, this.persistentID);
    }
    if (!this.discoveryUUID) {
      this.discoveryUUID = crypto.randomUUID().replace(/-/g, '');
      localStorage.setItem(`${APP_PREFIX}-disc-uuid`, this.discoveryUUID);
    }

    if (!window.crypto?.subtle) {
      this.log('No secure context (not HTTPS) — crypto disabled, identity verification skipped', 'err');
      return;
    }

    const sk = localStorage.getItem(`${APP_PREFIX}-sk`);
    const pk = localStorage.getItem(`${APP_PREFIX}-pk`);

    if (sk && pk) {
      try {
        this.privateKey = await importPrivateKey(sk);
        this.publicKey = await importPublicKey(pk);
        this.publicKeyStr = pk;
        this.pubkeyFingerprint = await this.computeFingerprint(pk);
        this.ecdhPrivateKey = await ecdsaToECDHPrivate(this.privateKey);
        this.log('Loaded cryptographic identity', 'ok');
      } catch (e) {
        this.log('Failed to load keys, regenerating...', 'err');
        await this.generateAndSaveKeys();
      }
    } else {
      await this.generateAndSaveKeys();
    }
  }

  /** One-time migration: rekey PID-keyed contacts/chats to fingerprint keys */
  private async migrateToFingerprintKeys() {
    if (localStorage.getItem(`${APP_PREFIX}-fp-migrated`)) return;
    const oldContacts = { ...this.contacts };
    const oldChats = { ...this.chats };
    let migrated = false;

    for (const [pid, c] of Object.entries(oldContacts)) {
      // Already fingerprint-keyed if it doesn't look like a PID
      if (!pid.startsWith(`${APP_PREFIX}-`) && !pid.startsWith('peerns-')) continue;
      if (c.fingerprint) continue; // Already has fingerprint (somehow)
      if (!c.publicKey) {
        // No pubkey — keep as PID key (pending contact)
        (c as any).currentPID = pid;
        continue;
      }

      const fp = await this.computeFingerprint(c.publicKey);
      if (!fp) continue;

      // Rekey contact
      const newContact = { ...c, fingerprint: fp, currentPID: pid, knownPIDs: [pid] };
      delete this.contacts[pid];
      this.contacts[fp] = newContact;

      // Rekey chats
      if (oldChats[pid]) {
        if (!this.chats[fp]) {
          this.chats[fp] = oldChats[pid];
        } else {
          const existingIds = new Set(this.chats[fp].map(m => m.id));
          const newMsgs = oldChats[pid].filter(m => !existingIds.has(m.id));
          this.chats[fp] = [...this.chats[fp], ...newMsgs].sort((a, b) => a.ts - b.ts);
        }
        delete this.chats[pid];
      }

      // Migrate lastRead
      try {
        const lr = JSON.parse(localStorage.getItem(`${APP_PREFIX}-lastread`) || '{}');
        if (lr[pid]) {
          lr[fp] = lr[pid];
          delete lr[pid];
          localStorage.setItem(`${APP_PREFIX}-lastread`, JSON.stringify(lr));
        }
      } catch {}

      this.log(`Migration: ${pid.slice(-8)} → fp:${fp}`, 'info');
      migrated = true;
    }

    if (migrated) {
      saveContacts(this.contacts);
      saveChats(this.chats);
    }
    localStorage.setItem(`${APP_PREFIX}-fp-migrated`, '1');
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
    this.ecdhPrivateKey = await ecdsaToECDHPrivate(this.privateKey);
    localStorage.setItem(`${APP_PREFIX}-sk`, sk);
    localStorage.setItem(`${APP_PREFIX}-pk`, pk);
    this.log('Identity keys generated', 'ok');
  }

  public async computeFingerprint(pk: string): Promise<string> {
    if (!window.crypto?.subtle) return '';
    try {
      const bytes = new TextEncoder().encode(pk);
      const hash = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(hash)).slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch {
      return '';
    }
  }

  /** Look up a contact by PeerJS ID. Returns fingerprint key + contact if found. */
  public contactByPID(pid: string): { fp: string; contact: Contact } | null {
    const fp = this.pidToFP.get(pid);
    return fp && this.contacts[fp] ? { fp, contact: this.contacts[fp] } : null;
  }

  /** Get the contacts/chats key for a PeerJS ID: fingerprint if known, PID as fallback. */
  public contactKeyForPID(pid: string): string {
    const mapped = this.pidToFP.get(pid);
    if (mapped) return mapped;
    // Fallback: search contacts by currentPID or knownPIDs
    for (const [key, c] of Object.entries(this.contacts)) {
      if (c.currentPID === pid || c.knownPIDs?.includes(pid)) {
        this.pidToFP.set(pid, key); // cache for future
        return key;
      }
    }
    return pid;
  }

  public init(name: string) {
    this.friendlyName = name;
    localStorage.setItem(`${APP_PREFIX}-name`, name);

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this._init();
    return this.initPromise;
  }

  private async _init() {
    await this.loadState();
    this.log('Initializing...', 'info');

    const savedOffline = !!localStorage.getItem(`${APP_PREFIX}-offline`);
    const savedNsOffline = !!localStorage.getItem(`${APP_PREFIX}-ns-offline`);

    if (savedOffline) {
      this.offlineMode = true;
      this.namespaceOffline = true;
      this.signalingState = 'offline';
      this.log('Restored offline mode from previous session', 'info');
      this.emitStatus();
      return;
    }

    this.registerPersistent();
    this.watchNetwork();
    this.startHeartbeat();
    this.startCheckinTimer();
    this.startContactSweep();
    // Request notification permission early so we can notify when backgrounded
    this.requestNotificationPermission();

    // Restore custom namespaces immediately (don't wait for IP detection)
    this.cnsRestoreSaved();
    // Restore group chats
    this.groupRestore();

    if (savedNsOffline) {
      // Public IP namespace was paused — skip network detection entirely
      this.namespaceOffline = true;
      this.log('Public IP namespace paused from previous session — skipping network detection', 'info');
      this.rvzStart();
      this.emitStatus();
      return;
    }

    this.emitStatus();

    this.publicIP = (await getPublicIP()) || '';
    if (!this.publicIP) {
      this.log('Could not detect public IP — manual connect still works', 'err');
      this.rvzStart();
      this.emitStatus();
      return;
    }

    this.log(`Public IP: ${this.publicIP}`, 'ok');
    this.discoveryID = makeDiscID(this.publicIP, this.discoveryUUID);
    this.attemptNamespace(1);
    this.rvzStart();

    this.emitStatus();
  }

  /** @internal */ public watchNetwork() { _watchNetwork(this); }

  // ─── Keep-alive: prevent browser from suspending the page ──────────────

  /** @internal */ public startKeepAlive() { _startKeepAlive(this); }

  /** @internal */ public async acquireWakeLock() { _acquireWakeLock(this); }

  /** Request notification permission (needed for background awareness on mobile PWAs) */
  public async requestNotificationPermission(): Promise<boolean> {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    const result = await Notification.requestPermission();
    this.log(`Notification permission: ${result}`, result === 'granted' ? 'ok' : 'info');
    return result === 'granted';
  }

  /** Show a browser notification. Always fires when permission granted — the in-app
   *  toast system separately handles suppression for the active chat. */
  /** @internal */ public async notify(title: string, body: string, tag?: string) { _notify(this, title, body, tag); }

  /** @internal */ public async handleNetworkChange() { _handleNetworkChange(this); }

  /** @internal */ public emitStatus() {
    const level = this.publicNS.level;
    const roleLabel = level > 0
      ? (this.publicNS.isRouter ? `Router L${level}` : `Peer L${level}`)
      : (this.publicNS.isRouter ? 'Router' : 'Peer');

    this.dispatchEvent(
      new CustomEvent('status-change', {
        detail: {
          status: this.publicIP ? 'online' : 'offline',
          role: roleLabel,
          ip: this.publicIP,
          did: this.discoveryID,
          pid: this.persistentID,
          namespaceLevel: this.publicNS.level,
          pubkeyFingerprint: this.pubkeyFingerprint,
          persConnected: this.persConnected,
          signalingState: this.signalingState,
          lastSignalingTs: this.lastSignalingTs,
          reconnectAttempt: this.reconnectBackoff,
          joinStatus: this.publicNS.joinStatus,
          joinAttempt: this.publicNS.joinAttempt,
          pidHistory: this.pidHistory,
        },
      })
    );
  }

  /** @internal */ public log(msg: string, type: string = 'info') {
    console.log(`[P2P:${type}] ${msg}`);
    this.dispatchEvent(new CustomEvent('log', { detail: { msg, type } }));
  }

  /** @internal */ public registerPersistent() { _registerPersistent(this); }

  /** @internal */ public reconnectBackoff = 0;
  /** @internal — retries with same PID before generating a new one on unavailable-id */
  public unavailIdRetries = 0;

  public setOfflineMode(offline: boolean) {
    this.offlineMode = offline;
    localStorage.setItem(`${APP_PREFIX}-offline`, offline ? '1' : '');
    this.log(offline ? 'Offline mode — all connections paused' : 'Going online...', 'info');
    if (offline) {
      this.setNamespaceOffline(true);
      this.rvzTeardown();
      // Teardown all custom namespaces
      this.cns.forEach((s) => { s.offline = true; this.nsTeardown(s); });
      // Teardown all group namespaces
      this.groups.forEach((s) => this.nsTeardown(s));
      // Teardown all geo namespaces
      this.geoStop();
      if (this.checkinTimer) { clearInterval(this.checkinTimer); this.checkinTimer = null; }
      if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
      if (this.keepAliveTimer) { clearInterval(this.keepAliveTimer); this.keepAliveTimer = null; }
      if (this.contactSweepTimer) { clearInterval(this.contactSweepTimer); this.contactSweepTimer = null; }
      if (this.persPeer && !this.persPeer.destroyed && !this.persPeer.disconnected) {
        try { this.persPeer.disconnect(); } catch {}
      }
      this.persConnected = false;
      this.signalingState = 'offline';
      this.emitStatus();
    } else {
      this.namespaceOffline = false;
      localStorage.setItem(`${APP_PREFIX}-ns-offline`, '');
      this.signalingState = 'reconnecting';
      this.startCheckinTimer();
      this.startHeartbeat();
      this.startKeepAlive();
      this.startContactSweep();
      // Restore custom namespaces
      this.cns.forEach((s) => {
        s.offline = false;
        this.nsAttempt(s, s.cfg, 1);
      });
      // Restore group namespaces
      let groupDelay = 0;
      this.groups.forEach((s) => {
        groupDelay += 1500;
        setTimeout(() => this.nsAttempt(s, s.cfg, 1), groupDelay);
      });
      // Restart rendezvous discovery for offline contacts
      this.rvzSweep();
      this.handleOnline();
    }
  }

  public setNamespaceOffline(offline: boolean) {
    this.namespaceOffline = offline;
    localStorage.setItem(`${APP_PREFIX}-ns-offline`, offline ? '1' : '');
    if (offline) {
      // Teardown public NS but keep discPeer alive
      if (this.publicNS.monitorTimer) { clearInterval(this.publicNS.monitorTimer); this.publicNS.monitorTimer = null; }
      if (this.publicNS.pingTimer) { clearInterval(this.publicNS.pingTimer); this.publicNS.pingTimer = null; }
      if (this.publicNS.peerSlotProbeTimer) { clearInterval(this.publicNS.peerSlotProbeTimer); this.publicNS.peerSlotProbeTimer = null; }
      if (this.publicNS.peerSlotPeer && !this.publicNS.peerSlotPeer.destroyed) { try { this.publicNS.peerSlotPeer.destroy(); } catch {} this.publicNS.peerSlotPeer = null; }
      if (this.publicNS.peerSlotTimer) { clearTimeout(this.publicNS.peerSlotTimer); this.publicNS.peerSlotTimer = null; }
      if (this.publicNS.routerPeer) { this.publicNS.routerPeer.destroy(); this.publicNS.routerPeer = null; }
      // Keep discPeer alive — destroying it releases our disc ID on PeerJS server
      if (this.publicNS.routerConn) { this.publicNS.routerConn.close(); this.publicNS.routerConn = null; }
      this.publicNS.isRouter = false;
      this.publicNS.level = 0;
      const myEntry = Object.values(this.publicNS.registry).find(r => r.isMe);
      this.publicNS.registry = myEntry ? { [myEntry.discoveryID]: myEntry } : {};
      this.emitPeerListUpdate();
      this.emitStatus();
      this.log('Namespace discovery paused', 'info');
    } else {
      if (this.publicIP) {
        this.log('Rejoining namespace...', 'info');
        this.attemptNamespace(1);
      } else {
        // IP detection was skipped because namespace was paused on init — detect now
        this.log('Detecting network for namespace rejoin...', 'info');
        getPublicIP().then(ip => {
          if (!ip) {
            this.log('Could not detect public IP', 'err');
            this.emitStatus();
            return;
          }
          this.publicIP = ip;
          this.discoveryID = makeDiscID(ip, this.discoveryUUID);
          this.log(`Public IP: ${ip}`, 'ok');
          this.attemptNamespace(1);
          this.emitStatus();
        });
      }
    }
  }

  /** @internal */ public findContactByPublicKey(publicKey: string, excludePID?: string): string | null {
    return Object.keys(this.contacts).find(
      k => k !== excludePID && !!this.contacts[k].publicKey && this.contacts[k].publicKey === publicKey
    ) ?? null;
  }

  /** @internal */ public migrateContact(oldKey: string, newKey: string) {
    if (oldKey === newKey) return;
    const existing = this.contacts[oldKey];
    if (!existing) return;

    if (!this.contacts[newKey]) {
      this.contacts[newKey] = { ...existing, conn: null };
    } else {
      // Preserve fields from old contact that new one might lack
      if (existing.publicKey && !this.contacts[newKey].publicKey) {
        this.contacts[newKey].publicKey = existing.publicKey;
      }
      if (existing.fingerprint && !this.contacts[newKey].fingerprint) {
        this.contacts[newKey].fingerprint = existing.fingerprint;
      }
      if (existing.currentPID) {
        this.contacts[newKey].currentPID = existing.currentPID;
      }
      if (existing.knownPIDs) {
        const known = new Set([...(this.contacts[newKey].knownPIDs || []), ...existing.knownPIDs]);
        this.contacts[newKey].knownPIDs = [...known];
      }
    }
    // Merge chat histories (concatenate + deduplicate by id, sort by timestamp)
    if (this.chats[oldKey]) {
      if (!this.chats[newKey]) {
        this.chats[newKey] = this.chats[oldKey];
      } else {
        const existingIds = new Set(this.chats[newKey].map(m => m.id));
        const newMsgs = this.chats[oldKey].filter(m => !existingIds.has(m.id));
        this.chats[newKey] = [...this.chats[newKey], ...newMsgs].sort((a, b) => a.ts - b.ts);
      }
      delete this.chats[oldKey];
    }
    // Migrate shared key
    const oldSK = this.sharedKeys.get(oldKey);
    if (oldSK && !this.sharedKeys.has(newKey)) {
      this.sharedKeys.set(newKey, oldSK);
    }
    this.sharedKeys.delete(oldKey);

    // Update pidToFP mappings and clean up stale connectFailures
    if (this.contacts[newKey].fingerprint) {
      const fp = this.contacts[newKey].fingerprint;
      this.contacts[newKey].knownPIDs?.forEach(pid => {
        this.pidToFP.set(pid, fp);
        delete this.connectFailures[pid];
      });
      if (this.contacts[newKey].currentPID) {
        this.pidToFP.set(this.contacts[newKey].currentPID, fp);
        delete this.connectFailures[this.contacts[newKey].currentPID];
      }
    }

    delete this.contacts[oldKey];
    saveContacts(this.contacts);
    saveChats(this.chats);
    this.log(`Contact migrated: ${oldKey.slice(-8)} → ${newKey.slice(-8)}`, 'info');

    // Notify UI to redirect activeChat if needed
    this.dispatchEvent(new CustomEvent('contact-migrated', { detail: { oldPID: oldKey, newPID: newKey } }));
  }

  /** @internal */ public schedulePersReconnect() { _schedulePersReconnect(this); }

  /** @internal */ public async handleOnline() { _handleOnline(this); }

  /** @internal */ public reconnectOfflineContacts() { _reconnectOfflineContacts(this); }

  /** @internal */ public reconnectScheduled = false;

  /** @internal */ public startHeartbeat() { _startHeartbeat(this); }

  /** @internal */ public startCheckinTimer() { _startCheckinTimer(this); }

  /** @internal */ public startContactSweep() { _startContactSweep(this); }

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══ Shared Namespace Routing Core (ns* methods) ═══════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // All namespace types (public IP, custom) use these methods.
  // They operate on an NSState object + NSConfig closures.

  /** @internal */ public nsEmit(s: NSState) { _nsEmit(this, s); }

  /** @internal */ public nsAttempt(s: NSState, cfg: NSConfig, level: number) { _nsAttempt(this, s, cfg, level); }

  /** @internal */ public nsTryJoin(s: NSState, cfg: NSConfig, level: number, attempt: number = 0) { _nsTryJoin(this, s, cfg, level, attempt); }

  /** @internal */ public nsHandleRouterConn(s: NSState, cfg: NSConfig, conn: DataConnection) { _nsHandleRouterConn(this, s, cfg, conn); }

  /** @internal */ public nsBroadcast(s: NSState, _cfg: NSConfig) { _nsBroadcast(this, s, _cfg); }

  /** @internal */ public nsMergeRegistry(s: NSState, cfg: NSConfig, peers: any[]) { _nsMergeRegistry(this, s, cfg, peers); }

  /** @internal */ public nsStartPingTimer(s: NSState, cfg: NSConfig) { _nsStartPingTimer(this, s, cfg); }

  /** @internal */ public nsRegisterDisc(s: NSState, cfg: NSConfig, discRetry?: number) { _nsRegisterDisc(this, s, cfg, discRetry); }

  /** @internal */ public nsStartMonitor(s: NSState, cfg: NSConfig) { _nsStartMonitor(this, s, cfg); }

  /** @internal */ public nsClearMonitor(s: NSState) { _nsClearMonitor(this, s); }

  /** @internal */ public nsProbeLevel1(s: NSState, cfg: NSConfig) { _nsProbeLevel1(this, s, cfg); }

  /** @internal */ public nsBroadcastMigration(s: NSState, level: number) { _nsBroadcastMigration(this, s, level); }

  /** @internal */ public nsMigrate(s: NSState, cfg: NSConfig, targetLevel: number) { _nsMigrate(this, s, cfg, targetLevel); }

  /** @internal */ public nsFailover(s: NSState, cfg: NSConfig) { _nsFailover(this, s, cfg); }

  /** @internal */ public nsTeardown(s: NSState, keepDisc = false) { _nsTeardown(this, s, keepDisc); }

  // ─── EDM NAT Reverse-Connect (-p1 peer slot) ──────────────────────────────

  /** Peer side: claim the -p1 slot and wait for router to connect */
  /** @internal */ public nsTryPeerSlot(s: NSState, cfg: NSConfig, level: number, peerSlotAttempt?: number) { _nsTryPeerSlot(this, s, cfg, level, peerSlotAttempt); }

  /** Router side: start continuously probing the -p1 slot */
  /** @internal */ public nsStartPeerSlotProbe(s: NSState, cfg: NSConfig) { _nsStartPeerSlotProbe(this, s, cfg); }

  /** Router side: single probe of the -p1 slot */
  /** @internal */ public nsProbePeerSlot(s: NSState, cfg: NSConfig) { _nsProbePeerSlot(this, s, cfg); }

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══ Public IP Routing (thin wrappers over ns* core) ══════════════════════
  // ═══════════════════════════════════════════════════════════════════════════

  /** @internal */ public attemptNamespace(level: number) {
    this.nsAttempt(this.publicNS, this.publicNSConfig, level);
  }

  /** @internal */ public tryJoinNamespace(level: number, attempt: number = 0) {
    this.nsTryJoin(this.publicNS, this.publicNSConfig, level, attempt);
  }

  private handleRouterConn(conn: DataConnection) {
    this.nsHandleRouterConn(this.publicNS, this.publicNSConfig, conn);
  }

  private broadcastRegistry() {
    this.nsBroadcast(this.publicNS, this.publicNSConfig);
  }

  private mergeRegistry(peers: any[]) {
    this.nsMergeRegistry(this.publicNS, this.publicNSConfig, peers);
  }

  private startPingTimer() {
    this.nsStartPingTimer(this.publicNS, this.publicNSConfig);
  }

  private registerDisc() {
    this.nsRegisterDisc(this.publicNS, this.publicNSConfig);
  }

  private checkForLowerNamespace() {
    this.nsProbeLevel1(this.publicNS, this.publicNSConfig);
  }

  /** @internal */ public failover() {
    this.nsFailover(this.publicNS, this.publicNSConfig);
  }

  private handleRouterMigrate(level: number) {
    this.nsMigrate(this.publicNS, this.publicNSConfig, level);
  }

  // ─── Manual connect / handshake ───────────────────────────────────────────

  /** @internal */ public requestConnect(targetID: string, fname: string) { _requestConnect(this, targetID, fname); }

  /** @internal */ public handleDiscData(d: any, conn: DataConnection) { _handleDiscData(this, d, conn); }

  /** @internal */ public async handleHandshakeData(d: any, conn: DataConnection) { _handleHandshakeData(this, d, conn); }

  /** @internal */ public connectPersistent(pid: string, fname: string) { _connectPersistent(this, pid, fname); }

  /** @internal */ public markWaitingMessagesFailed(contactKey: string) { _markWaitingMessagesFailed(this, contactKey); }

  /** @internal */ public resetUnackedMessages() { _resetUnackedMessages(this); }
  /** @internal */ public resetContactMessages(contactKey: string) { _resetContactMessages(this, contactKey); }

  /** @internal */ public async handlePersistentData(d: any, conn: DataConnection) { _handlePersistentData(this, d, conn); }

  /** @internal */ public async flushMessageQueue(contactKey: string) { _flushMessageQueue(this, contactKey); }

  // ─── Public API ───────────────────────────────────────────────────────────

  public async editMessage(contactKey: string, id: string, content: string) {
    const msgs = this.chats[contactKey];
    if (!msgs) return;
    const msg = msgs.find(m => m.id === id && m.dir === 'sent');
    if (!msg || msg.deleted) return;
    msg.content = content;
    msg.edited = true;
    saveChats(this.chats);
    this.dispatchEvent(new CustomEvent('message', { detail: { pid: contactKey } }));
    const conn = this.contacts[contactKey]?.conn;
    if (conn?.open) {
      const sk = await this.getOrDeriveSharedKey(contactKey);
      if (sk && this.privateKey) {
        try {
          const { iv, ct } = await encryptMessage(sk.key, content);
          const sig = await signData(this.privateKey, ct);
          conn.send({ type: 'message-edit', id, iv, ct, sig, e2e: true });
          return;
        } catch {}
      }
      conn.send({ type: 'message-edit', id, content });
    }
  }

  public deleteMessage(contactKey: string, id: string) {
    const msgs = this.chats[contactKey];
    if (!msgs) return;
    const msg = msgs.find(m => m.id === id && m.dir === 'sent');
    if (!msg) return;
    msg.content = '';
    msg.deleted = true;
    saveChats(this.chats);
    this.dispatchEvent(new CustomEvent('message', { detail: { pid: contactKey } }));
    const conn = this.contacts[contactKey]?.conn;
    if (conn?.open) conn.send({ type: 'message-delete', id, tid: msg.tid });
  }

  public retryMessage(contactKey: string, id: string) {
    const msgs = this.chats[contactKey];
    if (!msgs) return;
    const msg = msgs.find(m => m.id === id && m.dir === 'sent' && m.status === 'failed');
    if (!msg) return;
    msg.status = 'waiting';
    const c = this.contacts[contactKey];
    const pid = c?.currentPID || contactKey;
    delete this.connectFailures[pid];
    saveChats(this.chats);
    this.dispatchEvent(new CustomEvent('message', { detail: { pid: contactKey } }));
    if (c) this.connectPersistent(pid, c.friendlyName);
  }

  public acceptIncomingRequest(contactKey: string) {
    const c = this.contacts[contactKey];
    if (!c || c.pending !== 'incoming') return;
    const fname = c.friendlyName;
    const pid = c.currentPID || contactKey;
    delete c.pending;
    saveContacts(this.contacts);
    this.emitPeerListUpdate();
    this.connectPersistent(pid, fname);
    this.log(`Accepted saved request from ${fname}`, 'ok');
  }

  public updateFriendlyName(name: string) {
    this.friendlyName = name;
    localStorage.setItem(`${APP_PREFIX}-name`, name);
    // Broadcast to all open connections
    Object.values(this.contacts).forEach((c: Contact) => {
      if (c.conn?.open) c.conn.send({ type: 'name-update', name });
    });
    // Re-checkin to public namespace router
    if (this.publicNS.routerConn?.open) {
      this.publicNS.routerConn.send({ type: 'checkin', discoveryID: this.discoveryID, friendlyname: name, publicKey: this.publicKeyStr });
    }
    // Re-checkin to custom namespace routers
    this.cns.forEach((s) => {
      const discID = s.cfg.makeDiscID(this.discoveryUUID);
      if (s.routerConn?.open) {
        s.routerConn.send({ type: 'checkin', discoveryID: discID, friendlyname: name, publicKey: this.publicKeyStr });
      }
      if (s.registry[discID]) {
        s.registry[discID].friendlyName = name;
      }
      if (s.isRouter) this.nsBroadcast(s, s.cfg);
    });
    if (this.publicNS.registry[this.discoveryID]) this.publicNS.registry[this.discoveryID].friendlyName = name;
    if (this.publicNS.isRouter) this.broadcastRegistry();
    this.emitPeerListUpdate();
    this.emitStatus();
    this.log(`Name updated to: ${name}`, 'ok');
  }

  public deleteContact(contactKey: string) {
    const c = this.contacts[contactKey];
    if (c?.conn?.open) try { c.conn.close(); } catch {}
    // Remove pidToFP mappings
    c?.knownPIDs?.forEach(pid => this.pidToFP.delete(pid));
    if (c?.currentPID) this.pidToFP.delete(c.currentPID);
    this.sharedKeys.delete(contactKey);
    delete this.contacts[contactKey];
    delete this.chats[contactKey];
    saveContacts(this.contacts);
    saveChats(this.chats);
    this.emitPeerListUpdate();
    this.log(`Deleted contact: ${contactKey}`, 'info');
  }

  public pingContact(contactKey: string): Promise<'online' | 'offline'> {
    return new Promise((resolve) => {
      if (!this.persPeer) return resolve('offline');
      const c = this.contacts[contactKey];
      if (!c) return resolve('offline');

      if (c.conn?.open) {
        resolve('online');
        return;
      }

      const pid = c.currentPID || contactKey;
      const conn = this.persPeer.connect(pid, { reliable: true });
      const timer = setTimeout(() => {
        conn.close();
        resolve('offline');
        this.log(`${c.friendlyName} did not respond to ping`, 'info');
      }, 5000);

      conn.on('open', async () => {
        clearTimeout(timer);
        if (!this.contacts[contactKey]) this.contacts[contactKey] = c;
        this.contacts[contactKey].conn = conn;
        const ts = Date.now().toString();
        const signature = this.privateKey ? await signData(this.privateKey, ts) : '';
        conn.send({ type: 'hello', friendlyname: this.friendlyName, publicKey: this.publicKeyStr, ts, signature });
        resolve('online');
        this.emitPeerListUpdate();
        this.log(`${c.friendlyName} is online`, 'ok');
      });

      conn.on('data', (d) => this.handlePersistentData(d, conn));
      conn.on('close', () => {
        if (this.contacts[contactKey]) { this.contacts[contactKey].conn = null; this.emitPeerListUpdate(); }
      });
      conn.on('error', () => {
        clearTimeout(timer);
        resolve('offline');
      });
    });
  }

  public async sendMessage(contactKey: string, content: string) {
    const c = this.contacts[contactKey];
    const msg: ChatMessage = { id: crypto.randomUUID(), dir: 'sent', content, ts: Date.now(), type: 'text', status: 'waiting' };

    if (!this.chats[contactKey]) this.chats[contactKey] = [];
    this.chats[contactKey].push(msg);
    saveChats(this.chats);

    if (c && c.conn && c.conn.open) {
      await this.sendEncryptedMessage(contactKey, c.conn, msg);
      msg.status = 'sent';
      saveChats(this.chats);
    } else if (c) {
      if (c.conn && !c.conn.open) c.conn = null;
      const pid = c.currentPID || contactKey;
      this.connectPersistent(pid, c.friendlyName);
    }
    this.dispatchEvent(new CustomEvent('message', { detail: { pid: contactKey, msg } }));
  }

  /** Send a text message, encrypting with shared key if available */
  /** @internal */ public async sendEncryptedMessage(contactKey: string, conn: DataConnection, msg: ChatMessage) { _sendEncryptedMessage(this, contactKey, conn, msg); }

  public sendFile(contactKey: string, file: File) {
    const c = this.contacts[contactKey];
    if (!c) return;

    if (!c.conn || !c.conn.open) {
      if (!this.pendingFiles[contactKey]) this.pendingFiles[contactKey] = [];
      this.pendingFiles[contactKey].push(file);
      this.log(`File queued (offline): ${file.name}`, 'info');
      if (!c.conn) {
        const pid = c.currentPID || contactKey;
        this.connectPersistent(pid, c.friendlyName);
      }
      return;
    }

    this._sendFileNow(contactKey, file, c.conn);
  }

  /** @internal */ public _sendFileNow(contactKey: string, file: File, conn: DataConnection) { __sendFileNow(this, contactKey, file, conn); }

  public async startCall(contactKey: string, kind: 'audio' | 'video' | 'screen') {
    if (!this.persPeer) throw new Error('Not initialized');
    const c = this.contacts[contactKey];
    const pid = c?.currentPID || contactKey;

    if (kind === 'screen' && !navigator.mediaDevices?.getDisplayMedia) {
      const err = new Error('Screen sharing is not supported on this browser. On Android, use a desktop browser.');
      this.log(err.message, 'err');
      throw err;
    }

    // Pre-check: ensure signaling is alive (required for PeerJS call delivery)
    if (this.persPeer.disconnected) {
      this.log('Signaling disconnected — reconnecting before call', 'info');
      this.schedulePersReconnect();
      throw new Error('Signaling disconnected — reconnecting. Please try again in a moment.');
    }

    // Send call-notify via DataConnection as a reliable pre-call heads-up.
    // DataConnection (WebRTC direct) survives even when signaling is stale,
    // and this wakes up the callee's signaling if needed.
    if (c?.conn?.open) {
      c.conn.send({ type: 'call-notify', kind, from: this.persistentID });
    }

    try {
      let stream: MediaStream;
      let cameraStream: MediaStream | undefined;

      if (kind === 'screen') {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        try {
          cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        } catch {}
      } else {
        stream = await navigator.mediaDevices.getUserMedia(
          kind === 'audio' ? { audio: true } : { audio: true, video: true }
        );
      }

      const call = this.persPeer.call(pid, stream, { metadata: { kind } });
      return { call, stream, cameraStream };
    } catch (e: any) {
      this.log(`Call failed: ${e.message}`, 'err');
      throw e;
    }
  }

  /** @internal */ public handleIncomingCall(call: MediaConnection) {
    const pid = call.peer;

    // Group call auto-answer: check metadata matches our active group call
    // Don't rely on participants list — it may not be updated yet due to router relay latency
    if (call.metadata?.groupCall && this.activeGroupCallId && this.groupCallLocalStream) {
      const metaGroupId = call.metadata.groupId;
      if (metaGroupId === this.activeGroupCallId) {
        this.log(`Auto-answering group call from ${pid.slice(-8)}`, 'info');
        _groupCallAutoAnswer(this, call);
        return;
      }
    }

    const ck = this.contactKeyForPID(pid);
    const fname = this.contacts[ck]?.friendlyName || pid;
    const kind = call.metadata?.kind || 'video';
    this.log(`Incoming ${kind} call from ${fname} (PID: ${pid.slice(-8)}, key: ${ck.slice(-8)})`, 'info');
    // ACK: tell caller we received the call notification
    const conn = this.contacts[ck]?.conn;
    if (conn?.open) {
      conn.send({ type: 'call-received', kind });
    } else {
      this.log('No open DataConnection for call-received ACK', 'info');
    }
    this.notify(`Incoming ${kind} call`, `${fname} is calling`, `call-${ck}`);
    this.dispatchEvent(new CustomEvent('incoming-call', { detail: { call, fname, kind } }));
  }

  public addCallLog(contactKey: string, dir: 'sent' | 'recv', callKind: 'audio' | 'video' | 'screen', callResult: 'answered' | 'missed' | 'rejected' | 'cancelled', callDuration?: number) {
    if (!this.chats[contactKey]) this.chats[contactKey] = [];
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      dir,
      type: 'call',
      ts: Date.now(),
      callKind,
      callResult,
      callDuration,
    };
    this.chats[contactKey].push(msg);
    saveChats(this.chats);
    this.dispatchEvent(new CustomEvent('message', { detail: { pid: contactKey, msg } }));
  }

  /** @internal */ public emitPeerListUpdate() {
    this.dispatchEvent(new CustomEvent('peer-list-update'));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══ Rendezvous Fallback ════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════

  /** Start the rendezvous system — called from _init() after cnsRestoreSaved() */
  /** @internal */ public rvzStart() { _rvzStart(this); }

  /** Scan contacts for unreachable peers and queue them for rendezvous */
  /** @internal */ public rvzSweep() { _rvzSweep(this); }

  /** Pop next contact from queue and start rendezvous namespace */
  /** @internal */ public async rvzProcessNext() { _rvzProcessNext(this); }

  /** Time window expired — re-queue if still unreachable, move to next contact */
  /** @internal */ public rvzOnWindowExpire() { _rvzOnWindowExpire(this); }

  /** Cleanup the currently active rendezvous (but keep timers for sweep/queue) */
  /** @internal */ public rvzCleanupActive() { _rvzCleanupActive(this); }

  /** Full teardown of rendezvous system */
  /** @internal */ public rvzTeardown() { _rvzTeardown(this); }

  /** Called from nsMergeRegistry when registry updates for the rendezvous namespace.
   *  Looks for the target contact by publicKey match. */
  /** @internal */ public rvzCheckRegistry(s: NSState) { _rvzCheckRegistry(this, s); }

  /** Handle incoming rendezvous exchange — update PID if changed, reconnect */
  /** @internal */ public async rvzHandleExchange(d: any, conn: DataConnection) { _rvzHandleExchange(this, d, conn); }

  /** Add a PID to the rendezvous queue (called from connectPersistent error path) */
  /** @internal */ public rvzEnqueue(contactKey: string) { _rvzEnqueue(this, contactKey); }

  /** Clean up rvz state when a contact connects (from any path) */
  /** @internal */ public rvzContactConnected(contactKey: string) { _rvzContactConnected(this, contactKey); }

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══ Group Chat Public API ════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════

  public async groupCreate(name: string, inviteSlug?: string): Promise<string> { return _groupCreate(this, name, inviteSlug); }
  public async groupJoin(groupId: string, info?: any) { _groupJoin(this, groupId, info); }
  public groupJoinBySlug(slug: string) { _groupJoinBySlug(this, slug); }
  public groupLeave(groupId: string) { _groupLeave(this, groupId); }
  public async groupSendMessage(groupId: string, content: string, type?: 'text' | 'system') { _groupSendMessage(this, groupId, content, type); }
  public async groupEditMessage(groupId: string, msgId: string, content: string) { _groupEditMessage(this, groupId, msgId, content); }
  public groupDeleteMessage(groupId: string, msgId: string) { _groupDeleteMessage(this, groupId, msgId); }
  public async groupRetryMessage(groupId: string, msgId: string) { _groupRetryMessage(this, groupId, msgId); }
  public groupSendFile(groupId: string, file: File) { _groupSendFile(this, groupId, file); }
  public async groupInvite(groupId: string, contactKey: string) { _groupInvite(this, groupId, contactKey); }
  public async groupKickMember(groupId: string, targetFP: string) { _groupKickMember(this, groupId, targetFP); }
  /** @internal */ public async groupHandleInvite(d: any) { _groupHandleInvite(this, d); }
  /** @internal */ public groupHandleNSData(groupId: string, d: any, conn: any) { _groupHandleNSData(this, groupId, d, conn); }
  /** @internal */ public groupSendCheckin(groupId: string) { _groupSendCheckin(this, groupId); }
  /** @internal */ public groupSave() { _groupSave(this); }
  /** @internal */ public async groupRestore() { _groupRestore(this); }
  /** @internal */ public groupEmit() { _groupEmit(this); }

  // ─── Group Call Public API ────────────────────────────────────────────────
  public async groupCallStart(groupId: string, kind: 'audio' | 'video' | 'screen') { _groupCallStart(this, groupId, kind); }
  public async groupCallJoin(groupId: string) { _groupCallJoin(this, groupId); }
  public groupCallLeave(groupId?: string) { _groupCallLeave(this, groupId); }
  public async groupCallToggleCamera(): Promise<boolean> { return _groupCallToggleCamera(this); }
  public async groupCallToggleScreen(): Promise<boolean> { return _groupCallToggleScreen(this); }

  /** Check if a PeerJS PID is a participant in the active group call */
  public isGroupCallParticipant(pid: string): boolean {
    if (!this.activeGroupCallId) return false;
    const state = this.groups.get(this.activeGroupCallId);
    if (!state?.activeCall) return false;
    return Object.values(state.activeCall.participants).some(p => p.pid === pid);
  }

  /** Get active group call info for UI */
  public get activeGroupCallInfo(): { groupId: string; info: GroupCallInfo; groupName: string } | null {
    if (!this.activeGroupCallId) return null;
    const state = this.groups.get(this.activeGroupCallId);
    if (!state?.activeCall) return null;
    return { groupId: this.activeGroupCallId, info: state.activeCall, groupName: state.info.name };
  }

  public get groupList(): Record<string, { info: any; messages: any[]; isRouter: boolean; level: number; memberCount: number; activeCall?: GroupCallInfo }> {
    const out: Record<string, any> = {};
    this.groups.forEach((s, id) => {
      out[id] = {
        info: s.info,
        messages: s.messages,
        isRouter: s.isRouter,
        level: s.level,
        memberCount: Object.keys(s.info.members).length,
        activeCall: s.activeCall || undefined,
      };
    });
    return out;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══ Geo Discovery Public API ═════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════

  public geoStart() { _geoStart(this); }
  public geoStop() { _geoStop(this); }
  public geoRefresh() { _geoRefresh(this); }
  /** @internal */ public geoUpdatePosition(lat: number, lng: number, accuracy: number) { _geoUpdatePosition(this, lat, lng, accuracy); }
  public geoGetNearbyPeers(): { peer: any; overlapCount: number; totalHashes: number }[] { return _geoGetNearbyPeers(this); }

  public get geoActive(): boolean { return this.geoWatchId !== null; }

  /** Detailed geo state for debug UI */
  public get geoDebugInfo(): {
    geohash: string;
    isRouter: boolean;
    level: number;
    joinStatus: string | null;
    joinAttempt: number;
    routerID: string;
    discID: string;
    peerSlotID: string;
    peers: { discoveryID: string; friendlyName: string; publicKey?: string; isMe?: boolean; lastSeen: number }[];
  }[] {
    return this.geoStates.map(s => ({
      geohash: s.geohash,
      isRouter: s.isRouter,
      level: s.level,
      joinStatus: s.joinStatus,
      joinAttempt: s.joinAttempt,
      routerID: s.cfg.makeRouterID(s.level || 1),
      discID: s.cfg.makeDiscID(this.discoveryUUID),
      peerSlotID: s.cfg.makePeerSlotID(),
      peers: Object.values(s.registry).map(r => ({
        discoveryID: r.discoveryID,
        friendlyName: r.friendlyName,
        publicKey: r.publicKey,
        isMe: r.isMe,
        lastSeen: r.lastSeen,
      })),
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══ Custom Namespace Public API ══════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════

  public joinCustomNamespace(name: string, advanced = false) {
    const slug = advanced ? name : slugifyNamespace(name);
    if (!slug || this.cns.has(slug)) return;

    const cfg = this.makeCNSConfig({ name, slug, advanced });
    const state: CNSState = {
      ...makeNSState(),
      name,
      slug,
      offline: false,
      advanced,
      cfg,
    };

    this.cns.set(slug, state);
    this.cnsSave();
    this.nsAttempt(state, cfg, 1);
    this.cnsEmit();
    this.log(`Joining custom namespace: ${name}${advanced ? ' (advanced)' : ''}`, 'info');
  }

  public leaveCustomNamespace(slug: string) {
    const s = this.cns.get(slug);
    if (!s) return;
    this.nsTeardown(s);
    this.cns.delete(slug);
    this.cnsSave();
    this.cnsEmit();
    this.log(`Left custom namespace: ${slug}`, 'info');
  }

  public setCustomNSOffline(slug: string, offline: boolean) {
    const s = this.cns.get(slug);
    if (!s) return;
    s.offline = offline;
    if (offline) {
      this.nsTeardown(s, true);
      s.level = 0; s.isRouter = false;
    } else {
      if (this.persPeer && !this.persPeer.destroyed && !this.persPeer.disconnected) {
        this.nsAttempt(s, s.cfg, 1);
      }
    }
    this.cnsSave();
    this.cnsEmit();
  }

  public get customNamespaces(): Record<string, CustomNS> {
    const out: Record<string, CustomNS> = {};
    this.cns.forEach((s, k) => {
      out[k] = {
        name: s.name,
        slug: s.slug,
        isRouter: s.isRouter,
        level: s.level,
        offline: s.offline,
        advanced: s.advanced,
        registry: { ...s.registry },
        joinStatus: s.joinStatus,
        joinAttempt: s.joinAttempt,
      };
    });
    return out;
  }

  // ─── Custom Namespace Internal ────────────────────────────────────────────

  private cnsEmit() {
    this.dispatchEvent(new CustomEvent('custom-ns-update'));
    this.emitPeerListUpdate();
  }

  private cnsSave() {
    const arr = Array.from(this.cns.values()).map(s => ({
      name: s.name,
      slug: s.slug,
      offline: s.offline,
      advanced: s.advanced || false,
    }));
    localStorage.setItem(`${APP_PREFIX}-custom-ns`, JSON.stringify(arr));
  }

  private cnsRestoreSaved() {
    try {
      const saved = JSON.parse(localStorage.getItem(`${APP_PREFIX}-custom-ns`) || '[]') as { name: string; offline?: boolean; advanced?: boolean }[];
      saved.forEach(({ name, offline, advanced }, i) => {
        const slug = advanced ? name : slugifyNamespace(name);
        if (!this.cns.has(slug)) {
          // Stagger joins to avoid signaling rate-limit
          setTimeout(() => {
            this.joinCustomNamespace(name, advanced);
            if (offline) this.setCustomNSOffline(slug, true);
          }, (i + 1) * 1500);
        }
      });
    } catch {}
  }
}

export const p2p = new P2PManager();
