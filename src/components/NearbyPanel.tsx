import React, { useState, lazy, Suspense } from 'react';
import { MapPin, Radio, UserPlus, X, ChevronDown, ChevronRight, Wifi, Hash, Users, Gauge, CheckCircle, Map, List, RefreshCw, MoreHorizontal } from 'lucide-react';
import { GeoRegistryEntry, Contact } from '../lib/types';
import type { QueueState } from '../lib/peer-queue';

const NearbyMap = lazy(() => import('./NearbyMap').then(m => ({ default: m.NearbyMap })));

interface GeoNamespaceDebug {
  geohash: string;
  isRouter: boolean;
  level: number;
  joinStatus: string | null;
  joinAttempt: number;
  routerID: string;
  discID: string;
  peerSlotID: string;
  peers: { discoveryID: string; friendlyName: string; publicKey?: string; isMe?: boolean; lastSeen: number }[];
}

interface NearbyPanelProps {
  active: boolean;
  refreshing?: boolean;
  nearbyPeers: { peer: GeoRegistryEntry; overlapCount: number; totalHashes: number; fingerprint?: string }[];
  contacts: Record<string, Contact>;
  geoDebug?: GeoNamespaceDebug[];
  queueState?: QueueState;
  geoLat?: number | null;
  geoLng?: number | null;
  onStart: () => void;
  onStop: () => void;
  onRefresh: () => void;
  onConnect: (did: string, fname: string) => void;
}

function timeSince(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'now';
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

function overlapColor(overlap: number, total: number): string {
  const ratio = overlap / total;
  if (ratio >= 0.8) return 'bg-green-500';
  if (ratio >= 0.5) return 'bg-yellow-500';
  return 'bg-orange-500';
}

function overlapTextColor(overlap: number, total: number): string {
  const ratio = overlap / total;
  if (ratio >= 0.8) return 'text-green-400';
  if (ratio >= 0.5) return 'text-yellow-400';
  return 'text-orange-400';
}

function isSavedContact(peer: GeoRegistryEntry, contacts: Record<string, Contact>): boolean {
  if (!peer.publicKey) return false;
  return Object.values(contacts).some(c => !c.pending && c.publicKey === peer.publicKey);
}

function StatusBadge({ isRouter, level, joinStatus, joinAttempt }: { isRouter: boolean; level: number; joinStatus: string | null; joinAttempt: number }) {
  if (joinStatus === 'electing') {
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-900/40 text-purple-400 animate-pulse">Electing L{joinAttempt}</span>;
  }
  if (joinStatus === 'joining') {
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-900/40 text-yellow-400 animate-pulse">Joining L{level || joinAttempt} ({joinAttempt})</span>;
  }
  if (joinStatus === 'peer-slot') {
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-900/40 text-orange-400 animate-pulse">-p1 slot ({joinAttempt})</span>;
  }
  if (level === 0) {
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-500">Queued</span>;
  }
  if (isRouter) {
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-900/40 text-green-400">Router L{level}</span>;
  }
  return <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/40 text-blue-400">Peer L{level}</span>;
}

export function NearbyPanel({ active, refreshing, nearbyPeers, contacts, geoDebug, queueState, geoLat, geoLng, onStart, onStop, onRefresh, onConnect }: NearbyPanelProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const [showMap, setShowMap] = useState(false);

  /* ── Inactive — render as namespace-style card ── */
  if (!active) {
    return (
      <div className="flex items-center justify-between bg-gray-800 rounded-lg px-3 py-2.5 text-xs opacity-60">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <MapPin size={14} className="text-purple-400 shrink-0" />
          <span className="text-gray-300 font-medium shrink-0">Nearby</span>
          <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-gray-600" />
        </div>
        <button
          onClick={onStart}
          className="shrink-0 text-[11px] px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors"
        >
          Enable
        </button>
      </div>
    );
  }

  /* ── Active ── */
  const totalPeers = geoDebug?.reduce((acc, ns) => acc + ns.peers.filter(p => !p.isMe).length, 0) ?? 0;
  const totalNS = geoDebug?.length ?? 0;
  const routerCount = geoDebug?.filter(ns => ns.isRouter).length ?? 0;
  const joinedCount = geoDebug?.filter(ns => ns.level > 0).length ?? 0;
  const hasCoords = geoLat != null && geoLng != null;

  return (
    <div>
      {/* Card header — matches namespace cards */}
      <div className="flex items-center justify-between bg-gray-800 rounded-lg px-3 py-2.5 text-xs">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <MapPin size={14} className="text-purple-400 shrink-0" />
          <span className="text-gray-300 font-medium shrink-0">Nearby</span>
          {nearbyPeers.length > 0 && (
            <span className="text-gray-500 text-[11px]">({nearbyPeers.length})</span>
          )}
          <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-green-500 animate-pulse" />
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setShowMap(!showMap)}
            className="p-1 hover:bg-gray-700 rounded text-gray-500 hover:text-gray-300 transition-colors"
            title={showMap ? 'Show list' : 'Show map'}
          >
            {showMap ? <List size={13} /> : <Map size={13} />}
          </button>
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className={`p-1 hover:bg-gray-700 rounded transition-colors ${refreshing ? 'text-blue-400' : 'text-gray-500 hover:text-gray-300'}`}
            title={refreshing ? 'Refreshing GPS...' : 'Refresh GPS position'}
          >
            <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className={`p-1 hover:bg-gray-700 rounded transition-colors ${showAdvanced ? 'text-cyan-400' : 'text-gray-500 hover:text-gray-300'}`}
            title={showAdvanced ? 'Hide advanced details' : 'Show advanced details'}
          >
            <MoreHorizontal size={13} />
          </button>
          <button
            onClick={onStop}
            className="p-1 hover:bg-gray-700 rounded text-gray-500 hover:text-gray-300 transition-colors"
            title="Stop nearby discovery"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {/* Content below card */}
      <div className="mt-2 pl-1 space-y-2">
        {/* Map view */}
        {showMap && hasCoords && (
          <Suspense fallback={<div className="text-[11px] text-gray-600 text-center py-4">Loading map...</div>}>
            <NearbyMap
              peers={nearbyPeers}
              contacts={contacts}
              userLat={geoLat!}
              userLng={geoLng!}
            />
          </Suspense>
        )}

        {showMap && !hasCoords && (
          <div className="text-[11px] text-gray-600 text-center py-4">Waiting for GPS fix...</div>
        )}

        {/* List view */}
        {!showMap && (
          nearbyPeers.length === 0 ? (
            <div className="text-[11px] text-gray-600 text-center py-3">
              {joinedCount > 0 ? 'No other peers found yet...' : 'Joining geohash namespaces...'}
            </div>
          ) : (
            <div className="space-y-2">
              {nearbyPeers.map((entry, i) => {
                const saved = isSavedContact(entry.peer, contacts);
                return (
                  <div key={entry.peer.publicKey || entry.peer.discoveryID || i} className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-gray-300 truncate text-xs font-medium flex items-center gap-1.5">
                        {entry.peer.friendlyName}
                        {saved && <CheckCircle size={11} className="text-green-400 shrink-0" />}
                      </div>
                      <div className="text-gray-600 text-[10px] flex items-center gap-2 mt-0.5">
                        <span className={`flex items-center gap-0.5 font-mono font-bold ${overlapTextColor(entry.overlapCount, entry.totalHashes)}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${overlapColor(entry.overlapCount, entry.totalHashes)}`} />
                          {entry.overlapCount}/{entry.totalHashes}
                        </span>
                        {entry.peer.publicKey ? (
                          <span className={`font-mono text-[9px] ${saved ? 'text-green-500' : 'text-purple-500'}`}>
                            {saved ? '(saved)' : (entry.fingerprint || '...')}
                          </span>
                        ) : (
                          <span className="font-mono text-[9px] text-gray-600">no key</span>
                        )}
                      </div>
                    </div>
                    {!saved && (
                      <button
                        onClick={() => onConnect(entry.peer.discoveryID, entry.peer.friendlyName)}
                        className="shrink-0 text-[11px] px-2 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors flex items-center gap-1"
                      >
                        <UserPlus size={10} /> Connect
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )
        )}

        {/* Advanced section */}
        {showAdvanced && (
          <div className="space-y-2 border-t border-gray-800 pt-2">
            {/* Summary stats */}
            <div className="flex items-center gap-2.5 text-[10px] text-gray-500">
              <span className="flex items-center gap-0.5"><Hash size={9} />{totalNS} hashes</span>
              <span className="flex items-center gap-0.5"><Wifi size={9} />{joinedCount} joined</span>
              <span className="flex items-center gap-0.5"><Users size={9} />{totalPeers} peers</span>
              {routerCount > 0 && <span className="text-green-500">{routerCount} routing</span>}
            </div>

            {/* Queue status */}
            {queueState && (
              <div className="flex items-center gap-2 text-[10px]">
                <Gauge size={10} className={queueState.isThrottled ? 'text-red-400' : 'text-gray-500'} />
                <span className="text-gray-500">Queue: {queueState.totalCreated} created</span>
                {queueState.pending > 0 && <span className="text-yellow-400">{queueState.pending} pending</span>}
                <span className={queueState.isThrottled ? 'text-red-400' : 'text-gray-600'}>
                  {(queueState.currentInterval / 1000).toFixed(1)}s interval
                </span>
                {queueState.isThrottled && (
                  <span className="text-red-400 font-medium">THROTTLED ({queueState.throttleCount}x)</span>
                )}
                {queueState.networkUp === false && (
                  <span className="text-red-500 font-medium">NET DOWN</span>
                )}
              </div>
            )}

            {/* Per-geohash namespace details */}
            {geoDebug && geoDebug.length > 0 && (
              <div className="space-y-1.5 pt-0.5">
                <div className="text-[10px] text-gray-500 font-medium uppercase tracking-wider">Geo Namespaces</div>
                {[...geoDebug].sort((a, b) => a.geohash.localeCompare(b.geohash)).map(ns => {
                  const expanded = expandedHash === ns.geohash;
                  const otherPeers = ns.peers.filter(p => !p.isMe);
                  return (
                    <div key={ns.geohash} className="bg-gray-900/60 rounded-md overflow-hidden">
                      <button
                        onClick={() => setExpandedHash(expanded ? null : ns.geohash)}
                        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-gray-800/50 transition-colors text-left"
                      >
                        {expanded ? <ChevronDown size={11} className="text-gray-500 shrink-0" /> : <ChevronRight size={11} className="text-gray-500 shrink-0" />}
                        <span className="text-[11px] font-mono text-cyan-400 shrink-0">{ns.geohash}</span>
                        <StatusBadge isRouter={ns.isRouter} level={ns.level} joinStatus={ns.joinStatus} joinAttempt={ns.joinAttempt} />
                        {otherPeers.length > 0 && (
                          <span className="text-[10px] text-gray-400 ml-auto">{otherPeers.length} peer{otherPeers.length !== 1 ? 's' : ''}</span>
                        )}
                      </button>

                      {expanded && (
                        <div className="px-2.5 pb-2 space-y-1.5 border-t border-gray-800/50">
                          <div className="space-y-0.5 pt-1.5">
                            <div className="text-[9px] text-gray-600">
                              <span className="text-gray-500">Router:</span> <span className="font-mono">{ns.routerID}</span>
                            </div>
                            <div className="text-[9px] text-gray-600">
                              <span className="text-gray-500">Disc:</span> <span className="font-mono">{ns.discID}</span>
                            </div>
                            <div className="text-[9px] text-gray-600">
                              <span className="text-gray-500">P1 Slot:</span> <span className="font-mono">{ns.peerSlotID}</span>
                            </div>
                          </div>

                          {ns.peers.length === 0 ? (
                            <div className="text-[10px] text-gray-600 italic">Empty registry</div>
                          ) : (
                            <div className="space-y-0.5">
                              <div className="text-[9px] text-gray-500 font-medium">Registry ({ns.peers.length})</div>
                              {ns.peers.map((p, i) => (
                                <div key={p.discoveryID || i} className={`flex items-center gap-1.5 text-[10px] ${p.isMe ? 'text-cyan-500' : 'text-gray-300'}`}>
                                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${p.isMe ? 'bg-cyan-500' : 'bg-green-500'}`} />
                                  <span className="truncate font-medium">{p.friendlyName}{p.isMe ? ' (me)' : ''}</span>
                                  <span className="text-[9px] text-gray-600 ml-auto shrink-0">{timeSince(p.lastSeen)}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
