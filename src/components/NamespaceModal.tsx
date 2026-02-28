import React from 'react';
import { X, Radio, Loader2 } from 'lucide-react';
import { PeerInfo, APP_PREFIX } from '../lib/types';
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
  namespaceName?: string;   // "Public IP" by default
  routerEndpoint?: string;  // e.g. "peerns-ns-teamchat-1"
  advanced?: boolean;       // advanced NS — no prefix
  onLeave?: () => void;     // shown for custom namespaces
  joinStatus?: 'electing' | 'joining' | 'peer-slot' | null;
  joinAttempt?: number;
}

function formatAge(ts: number): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 5000) return 'just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
}

export function NamespaceModal({ role, ip, discID, namespaceLevel, isRouter, registry, onClose, namespaceName = 'Public IP', routerEndpoint, advanced, onLeave, joinStatus, joinAttempt }: NamespaceModalProps) {
  const peers = Object.values(registry);
  const myEntry = peers.find(r => r.isMe);
  const others = peers.filter(r => !r.isMe);

  return (
    <div
      className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 anim-fade-in"
      onClick={onClose}
    >
      <div
        className="bg-gray-900 border border-gray-800 rounded-xl w-full max-w-md shadow-2xl overflow-hidden anim-scale-up"
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
                namespaceLevel === 0 && !joinStatus ? 'text-gray-500 border-gray-700' :
                isRouter ? 'text-yellow-400 border-yellow-800' : 'text-blue-400 border-blue-800'
              )}>
                {joinStatus ? (
                  joinStatus === 'electing' ? `Electing L${joinAttempt || 1}...` :
                  joinStatus === 'peer-slot' ? 'Reverse connect (-p1)' :
                  `Joining (attempt ${joinAttempt || 1}/3)`
                ) : namespaceLevel === 0 ? 'Not joined' : role}
              </span>
            </Row>
            {/* Join status indicator */}
            {joinStatus && (
              <div className="flex items-center gap-2 bg-gray-800/60 rounded-lg px-3 py-2">
                <Loader2 size={12} className="text-blue-400 animate-spin" />
                <span className="text-[11px] text-gray-300">
                  {joinStatus === 'electing' && (
                    <>Trying to claim router at level {joinAttempt || 1}...</>
                  )}
                  {joinStatus === 'joining' && (
                    <>Connecting to router (attempt {joinAttempt || 1}/3, 8s timeout)...</>
                  )}
                  {joinStatus === 'peer-slot' && (
                    <>Claimed -p1 slot — waiting for router probe (up to 30s)...</>
                  )}
                </span>
              </div>
            )}
            <Row label={`Namespace (${namespaceName})`}>
              {ip ? (
                <span className="font-mono text-[11px]">
                  {advanced ? (
                    <>
                      <span className="text-cyan-400">{ip}</span>
                      <span className="text-gray-500">-{namespaceLevel || 1}</span>
                    </>
                  ) : (
                    <>
                      <span className="text-gray-500">{APP_PREFIX}-{routerEndpoint ? 'ns-' : ''}</span>
                      <span className="text-cyan-400">{routerEndpoint ? ip : ip.replace(/\./g, '-')}</span>
                      <span className="text-gray-500">-{namespaceLevel || 1}</span>
                    </>
                  )}
                </span>
              ) : (
                <span className="font-mono text-[11px] text-gray-500">—</span>
              )}
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
            <Row label="Join attempts before -p1">
              <span className="font-mono text-[11px] text-gray-300">3 (8s timeout each)</span>
            </Row>
            <Row label="-p1 slot timeout">
              <span className="font-mono text-[11px] text-gray-300">30s before escalate</span>
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
                  <p>You probe the <span className="text-purple-400 font-semibold">-p1 reverse slot</span> every 5s. Peers behind NAT that can't connect directly claim this slot — you reach out to them instead.</p>
                  {namespaceLevel > 1 && <p>You're at level {namespaceLevel} — you probe for a free level 1 slot every 30s and migrate down when available.</p>}
                </>
              ) : joinStatus === 'peer-slot' ? (
                <>
                  <p>Direct connection to the router failed after 3 attempts (NAT or firewall blocking WebRTC).</p>
                  <p>You claimed the <span className="text-purple-400 font-semibold">-p1 reverse slot</span> on the signaling server. The router probes this slot every 5s and will connect to you instead.</p>
                  <p>If no probe arrives within 30s, you'll escalate to run a level {(namespaceLevel || 1) + 1} router.</p>
                </>
              ) : joinStatus === 'joining' ? (
                <>
                  <p>Attempting to connect to the level {namespaceLevel || 1} router via WebRTC (attempt {joinAttempt || 1}/3).</p>
                  <p>Each attempt times out after 8s. After 3 failed attempts, you'll try the <span className="text-purple-400 font-semibold">-p1 reverse slot</span> where the router reaches out to you.</p>
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

          {/* Join sequence explanation */}
          <div className="px-5 py-4 border-b border-gray-800">
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Join Sequence</div>
            <div className="text-[11px] text-gray-400 space-y-1 leading-relaxed">
              <StepRow n={1} active={joinStatus === 'electing' || (!isRouter && !joinStatus && namespaceLevel === 0)} done={isRouter}>
                Try to claim router slot (level 1)
              </StepRow>
              <StepRow n={2} active={joinStatus === 'joining'} done={!isRouter && namespaceLevel > 0 && !joinStatus}>
                Connect to existing router (3 attempts, 8s timeout)
              </StepRow>
              <StepRow n={3} active={joinStatus === 'peer-slot'} done={false}>
                Reverse connect via -p1 slot (router probes you)
              </StepRow>
              <StepRow n={4} active={false} done={isRouter && namespaceLevel > 1}>
                Escalate to higher level router
              </StepRow>
            </div>
          </div>

          {/* Registry */}
          <div className={clsx('px-5 py-4', onLeave && 'border-b border-gray-800')}>
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

          {onLeave && (
            <div className="px-5 py-4">
              <button
                onClick={() => { onLeave(); onClose(); }}
                className="w-full text-[12px] font-semibold bg-red-900/40 hover:bg-red-900/70 text-red-400 py-2 rounded-lg transition-colors"
              >
                Leave Namespace
              </button>
            </div>
          )}
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

function StepRow({ n, active, done, children }: { n: number; active: boolean; done: boolean; children: React.ReactNode }) {
  return (
    <div className={clsx('flex items-center gap-2 px-2 py-1 rounded', active && 'bg-blue-900/30')}>
      <span className={clsx(
        'w-4 h-4 rounded-full text-[9px] flex items-center justify-center font-bold shrink-0',
        active ? 'bg-blue-500 text-white' :
        done ? 'bg-green-600 text-white' :
        'bg-gray-700 text-gray-500'
      )}>
        {done ? '\u2713' : n}
      </span>
      <span className={clsx('text-[11px]', active ? 'text-blue-300' : done ? 'text-green-400' : 'text-gray-500')}>
        {children}
      </span>
      {active && <Loader2 size={10} className="text-blue-400 animate-spin ml-auto" />}
    </div>
  );
}

const RegistryRow: React.FC<{ entry: PeerInfo; label?: string }> = ({ entry, label }) => {
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
};
