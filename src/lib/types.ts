import { Peer } from 'peerjs';

export const APP_PREFIX = 'peerns';
export const APP_NAME = 'PeerNS';
export const TTL = 90000;
export const PING_IV = 60000;
export const IP_REFRESH = 5 * 60 * 1000;
export const CHUNK_SIZE = 16000;
export const RVZ_WINDOW = 10 * 60 * 1000;   // 10 minute time windows
export const RVZ_SWEEP_IV = 5 * 60 * 1000;  // sweep unreachable contacts every 5 min

export interface PeerInfo {
  discoveryID: string;
  friendlyName: string;
  lastSeen: number;
  isMe?: boolean;
  conn?: any;
  knownPID?: string | null;
  publicKey?: string;
}

export interface Contact {
  friendlyName: string;
  fingerprint?: string;              // Primary key (16-char hex SHA-256 of publicKey)
  publicKey?: string;
  currentPID: string;                // Last known PeerJS ID for connectivity
  knownPIDs?: string[];              // All historical PIDs this contact has used
  discoveryID: string | null;
  discoveryUUID: string;
  sharedKeyFingerprint?: string;     // Persisted to avoid recomputation on reconnect
  conn?: any;                        // runtime only, not persisted
  onNetwork?: boolean;               // runtime only
  networkDiscID?: string | null;     // runtime only
  lastSeen?: number;
  pending?: 'outgoing' | 'incoming';
  pendingFingerprint?: string;
  pendingVerified?: boolean;
}

export interface NSConfig {
  label: string;
  makeRouterID: (level: number) => string;
  makeDiscID: (uuid: string) => string;
  makePeerSlotID: () => string;
}

export interface CustomNS {
  name: string;
  slug: string;
  isRouter: boolean;
  level: number;
  offline: boolean;
  advanced?: boolean;
  registry: Record<string, PeerInfo>;
  joinStatus?: 'electing' | 'joining' | 'peer-slot' | null;
  joinAttempt?: number;
}

export interface ChatMessage {
  id: string;
  dir: 'sent' | 'recv';
  type?: 'text' | 'file' | 'call';
  content?: string;
  name?: string;
  tid?: string;
  size?: number;
  ts: number;
  status?: 'waiting' | 'sent' | 'delivered' | 'failed';
  edited?: boolean;
  deleted?: boolean;
  retries?: number;
  // Call log fields
  callKind?: 'audio' | 'video' | 'screen';
  callDuration?: number;
  callResult?: 'answered' | 'missed' | 'rejected' | 'cancelled';
}

export interface FileTransfer {
  tid: string;
  name: string;
  size: number;
  total: number;
  chunks: ArrayBuffer[];
  received: number;
}

// ─── Group Chat Types ────────────────────────────────────────────────────────

export interface GroupMember {
  fingerprint: string;
  friendlyName: string;
  publicKey?: string;
  currentPID?: string;
  joinedAt: number;
  role: 'admin' | 'member';
}

export interface GroupInfo {
  id: string;                                    // groupUUID
  name: string;
  createdBy: string;                             // fingerprint of creator
  createdAt: number;
  members: Record<string, GroupMember>;           // keyed by fingerprint
  inviteSlug?: string;                           // optional join slug
  groupKeyBase64?: string;                       // persisted AES-256-GCM group key
}

export interface GroupMessage {
  id: string;
  groupId: string;
  senderFP: string;
  senderName: string;
  content: string;
  ts: number;
  type: 'text' | 'file' | 'system';
  name?: string;
  tid?: string;
  size?: number;
  deliveredTo?: string[];
  status?: 'sending' | 'sent' | 'failed';
  edited?: boolean;
  deleted?: boolean;
  e2e?: boolean;
  iv?: string;
  ct?: string;
}

// ─── Group Call Types ────────────────────────────────────────────────────────

export interface GroupCallParticipant {
  fingerprint: string;
  friendlyName: string;
  pid: string;
  joinedAt: number;
}

export interface GroupCallInfo {
  callId: string;
  groupId: string;
  kind: 'audio' | 'video' | 'screen';
  startedBy: string;                                // fingerprint of initiator
  startedAt: number;
  participants: Record<string, GroupCallParticipant>; // keyed by fingerprint
}

// ─── Geo Discovery Types ─────────────────────────────────────────────────────

export interface GeoRegistryEntry extends PeerInfo {
  lat: number;
  lng: number;
  accuracy: number;
}
