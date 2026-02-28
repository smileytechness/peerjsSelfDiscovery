import { DataConnection } from 'peerjs';
import { PeerInfo, NSConfig, GroupInfo, GroupMessage, GroupCallInfo } from './types';

export interface NSState {
  isRouter: boolean;
  level: number;
  registry: Record<string, PeerInfo>;
  routerPeer: import('peerjs').Peer | null;
  routerConn: DataConnection | null;
  discPeer: import('peerjs').Peer | null;
  pingTimer: any;
  monitorTimer: any;
  peerSlotPeer: import('peerjs').Peer | null;
  peerSlotTimer: any;
  peerSlotProbeTimer: any;
  joinTimeout: any;
  joinStatus: 'electing' | 'joining' | 'peer-slot' | null;
  joinAttempt: number;
}

export interface CNSState extends NSState {
  name: string;
  slug: string;
  offline: boolean;
  advanced?: boolean;
  cfg: NSConfig;
}

export interface GroupNSState extends NSState {
  groupId: string;
  info: GroupInfo;
  cfg: NSConfig;
  messages: GroupMessage[];
  pendingMessages: GroupMessage[];
  groupKey?: CryptoKey;
  groupKeyHistory?: CryptoKey[];
  groupPairwiseKeys?: Map<string, CryptoKey>;
  incomingFiles?: Record<string, { name: string; size: number; total: number; chunks: ArrayBuffer[]; received: number; senderFP: string; senderName: string }>;
  activeCall?: GroupCallInfo;
}

export interface GeoNSState extends NSState {
  geohash: string;
  cfg: NSConfig;
}

export function makeNSState(): NSState {
  return {
    isRouter: false,
    level: 0,
    registry: {},
    routerPeer: null,
    routerConn: null,
    discPeer: null,
    pingTimer: null,
    monitorTimer: null,
    peerSlotPeer: null,
    peerSlotTimer: null,
    peerSlotProbeTimer: null,
    joinTimeout: null,
    joinStatus: null,
    joinAttempt: 0,
  };
}
