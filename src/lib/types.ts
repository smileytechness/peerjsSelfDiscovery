import { Peer } from 'peerjs';

export const APP_PREFIX = 'myapp';
export const TTL = 90000;
export const PING_IV = 60000;
export const IP_REFRESH = 5 * 60 * 1000;
export const CHUNK_SIZE = 16000;

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
  discoveryID: string | null;
  discoveryUUID: string;
  conn?: any;
  onNetwork?: boolean;
  networkDiscID?: string | null;
  publicKey?: string; // For Zero Trust
  lastSeen?: number;  // Timestamp of last interaction
}

export interface ChatMessage {
  id: string;
  dir: 'sent' | 'recv';
  type?: 'text' | 'file';
  content?: string;
  name?: string;
  tid?: string;
  size?: number;
  ts: number;
  status?: 'waiting' | 'sent' | 'delivered' | 'failed';
  edited?: boolean;
  deleted?: boolean;
  retries?: number;
}

export interface FileTransfer {
  tid: string;
  name: string;
  size: number;
  total: number;
  chunks: ArrayBuffer[];
  received: number;
}
