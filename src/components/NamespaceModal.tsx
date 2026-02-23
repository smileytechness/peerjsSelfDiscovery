import React from 'react';
import { X, Radio } from 'lucide-react';
import { PeerInfo } from '../lib/types';
import { TTL, PING_IV } from '../lib/types';
import { clsx } from 'clsx';

interface NamespaceModalProps {
  role: string;
  ip: string;
  discID: string;
  namespaceLevel: number;
  isRouter: boolean;
  registry: Record<string, PeerInfo>;
  onClose: () => void;
}

function formatAge(ts: number): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 5000) return 'just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
}

export function NamespaceModal({ role, ip, discID, namespaceLevel, isRouter, registry, onClose }: NamespaceModalProps) {
  const peers = Object.values(registry);
  const myEntry = peers.find(r => r.isMe);
  const others = peers.filter(r => !r.isMe);

  return (
    <div
      className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-gray-900 border border-gray-800 rounded-xl w-full max-w-md shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <Radio size={16} className="text-blue-400" />
            <h2 className="text-base font-bold text-gray-100">Namespace Routing</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-800 rounded text-gray-500 hover:text-gray-300">
            <X size={18} />
          </button>
        </div>

        <div className="overflow-y-auto max-h-[70vh]">
          {/* Role & Identity */}
          <div className="px-5 py-4 border-b border-gray-800 space-y-2">
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">This Device</div>
            <Row label="Role">
              <span className={clsx(
                'font-mono text-[11px] px-1.5 py-0.5 rounded border',
                namespaceLevel === 0 ? 'text-gray-500 border-gray-700' :
                isRouter ? 'text-yellow-400 border-yellow-800' : 'text-blue-400 border-blue-800'
              )}>
                {namespaceLevel === 0 ? 'Not joined' : role}
              </span>
            </Row>
            <Row label="Namespace (Public IP)">
              <span className="font-mono text-[11px] text-gray-300">{ip || '—'}</span>
            </Row>
            <Row label="My Disc ID">
              <span className="font-mono text-[10px] text-gray-400 break-all">{discID || '—'}</span>
            </Row>
          </div>

          {/* Timing config */}
          <div className="px-5 py-4 border-b border-gray-800 space-y-2">
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Timing Config</div>
            <Row label="Router → peer ping">
              <span className="font-mono text-[11px] text-gray-300">{PING_IV / 1000}s</span>
            </Row>
            <Row label="Peer timeout (TTL)">
              <span className="font-mono text-[11px] text-gray-300">{TTL / 1000}s</span>
            </Row>
            <Row label="Failover jitter">
              <span className="font-mono text-[11px] text-gray-300">0–3s random</span>
            </Row>
            <Row label="Lower-level probe">
              <span className="font-mono text-[11px] text-gray-300">every 30s</span>
            </Row>
            <Row label="Max levels">
              <span className="font-mono text-[11px] text-gray-300">5</span>
            </Row>
            <Row label="Join attempts before escalate">
              <span className="font-mono text-[11px] text-gray-300">3</span>
            </Row>
          </div>

          {/* How it works */}
          <div className="px-5 py-4 border-b border-gray-800">
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">How It Works</div>
            <div className="text-[11px] text-gray-400 space-y-1.5 leading-relaxed">
              {isRouter ? (
                <>
                  <p>You are the <span className="text-yellow-400 font-semibold">router</span> for this namespace. Peers connect to you to exchange discovery IDs and registry updates.</p>
                  <p>You ping all registered peers every <span className="text-white">{PING_IV / 1000}s</span>. Peers that don't pong within <span className="text-white">{TTL / 1000}s</span> are evicted from the registry.</p>
                  {namespaceLevel > 1 && <p>You're at level {namespaceLevel} — you probe for a free level 1 slot every 30s and migrate down when available.</p>}
                </>
              ) : namespaceLevel > 0 ? (
                <>
                  <p>You are a <span className="text-blue-400 font-semibold">peer</span> checked in to the level {namespaceLevel} router. The router sends you the full registry and pings you every <span className="text-white">{PING_IV / 1000}s</span>.</p>
                  <p>If the router disappears, you fail over with up to 3s jitter, then try level {namespaceLevel + 1}.</p>
                  {namespaceLevel > 1 && <p>You probe for a lower-level router every 30s and migrate when found.</p>}
                </>
              ) : (
                <p className="text-gray-500 italic">Not currently joined to any namespace.</p>
              )}
            </div>
          </div>

          {/* Registry */}
          <div className="px-5 py-4">
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-3">
              Registry ({peers.length} {peers.length === 1 ? 'peer' : 'peers'})
            </div>
            {peers.length === 0 ? (
              <div className="text-[11px] text-gray-600 italic">Empty — not joined to namespace</div>
            ) : (
              <div className="space-y-2">
                {myEntry && (
                  <RegistryRow entry={myEntry} label="me" />
                )}
                {others.map(entry => (
                  <RegistryRow key={entry.discoveryID} entry={entry} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-[11px] text-gray-500 shrink-0">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

function RegistryRow({ entry, label }: { entry: PeerInfo; label?: string }) {
  const isStale = !entry.isMe && (Date.now() - entry.lastSeen) > (TTL * 0.8);
  return (
    <div className={clsx('bg-gray-800 rounded-lg px-3 py-2', isStale && 'opacity-50')}>
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0',
            entry.isMe ? 'bg-blue-400' : entry.conn ? 'bg-green-500' : 'bg-gray-600'
          )} />
          <span className="text-[12px] font-semibold text-gray-200 truncate">{entry.friendlyName}</span>
          {label && <span className="text-[10px] text-gray-500 font-mono">({label})</span>}
          {isStale && <span className="text-[9px] text-orange-400 font-mono">stale</span>}
        </div>
        <span className="text-[10px] text-gray-500 shrink-0">{formatAge(entry.lastSeen)}</span>
      </div>
      <div className="font-mono text-[9px] text-gray-600 truncate pl-3">
        {entry.discoveryID}
      </div>
      {entry.knownPID && (
        <div className="font-mono text-[9px] text-green-700 truncate pl-3">
          ↔ saved contact
        </div>
      )}
    </div>
  );
}
