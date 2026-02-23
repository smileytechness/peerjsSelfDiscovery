import React, { useRef, useState, useEffect } from 'react';
import { Contact, PeerInfo, ChatMessage } from '../lib/types';
import { extractDiscUUID } from '../lib/discovery';
import { clsx } from 'clsx';
import { Info, ChevronDown, ChevronRight, Key, Share2, UserPlus, Wifi, WifiOff, Download, Radio, Pencil } from 'lucide-react';

interface SidebarProps {
  // My identity (shown in header)
  myName: string;
  myPid: string;
  myFingerprint: string;
  persConnected: boolean;
  offlineMode: boolean;
  onShare: () => void;
  onToggleOffline: () => void;
  // Signaling state detail
  signalingState: 'connected' | 'reconnecting' | 'offline';
  lastSignalingTs: number;
  reconnectAttempt: number;
  // Network / discovery
  networkRole: string;
  networkIP: string;
  networkDiscID: string;
  namespaceLevel: number;
  isRouter: boolean;
  namespaceOffline: boolean;
  onToggleNamespace: () => void;
  onShowNamespaceInfo: () => void;
  // Contacts / chats
  peers: Record<string, Contact>;
  registry: Record<string, PeerInfo>;
  chats: Record<string, ChatMessage[]>;
  unreadCounts: Record<string, number>;
  activeChat: string | null;
  sidebarOpen: boolean;
  onSelectChat: (pid: string) => void;
  onConnect: (did: string, fname: string) => void;
  onAddContact: () => void;
  onShowContactInfo: (pid: string) => void;
  onShowProfile: () => void;
  onAcceptIncoming: (pid: string) => void;
  onDismissPending: (pid: string) => void;
}

function formatTimeSince(ts: number): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 10000) return 'just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
}

function formatTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function lastMessagePreview(msgs: ChatMessage[] | undefined): { text: string; ts: number } | null {
  if (!msgs || msgs.length === 0) return null;
  const last = msgs[msgs.length - 1];
  const text = last.type === 'file' ? `📎 ${last.name || 'file'}` : (last.content || '');
  return { text, ts: last.ts };
}

export function Sidebar({
  myName,
  myPid,
  myFingerprint,
  persConnected,
  offlineMode,
  onShare,
  onToggleOffline,
  signalingState,
  lastSignalingTs,
  reconnectAttempt,
  networkRole,
  networkIP,
  networkDiscID,
  namespaceLevel,
  isRouter,
  namespaceOffline,
  onToggleNamespace,
  onShowNamespaceInfo,
  peers,
  registry,
  chats,
  unreadCounts,
  activeChat,
  sidebarOpen,
  onSelectChat,
  onConnect,
  onAddContact,
  onShowContactInfo,
  onShowProfile,
  onAcceptIncoming,
  onDismissPending,
}: SidebarProps) {
  const allPIDs = Object.keys(peers);
  const incomingPIDs = allPIDs.filter(pid => peers[pid].pending === 'incoming');
  const outgoingPIDs = allPIDs.filter(pid => peers[pid].pending === 'outgoing');
  const savedPIDs = allPIDs.filter(pid => !peers[pid].pending);
  const unknownOnNet = Object.keys(registry).filter((did) => !registry[did].isMe && !registry[did].knownPID);
  const peerCount = Object.keys(registry).filter(k => !registry[k].isMe).length;

  const [nsExpanded, setNsExpanded] = useState(true);
  const [installPrompt, setInstallPrompt] = useState<any>(null);

  useEffect(() => {
    const handler = (e: Event) => { e.preventDefault(); setInstallPrompt(e); };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTarget = useRef<string | null>(null);

  const startLongPress = (pid: string) => {
    longPressTarget.current = pid;
    longPressTimer.current = setTimeout(() => {
      if (longPressTarget.current === pid) onShowContactInfo(pid);
    }, 600);
  };
  const cancelLongPress = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
    longPressTarget.current = null;
  };

  return (
    <div className={clsx(
      'w-full md:w-64 bg-gray-900 border-r border-gray-800 flex-col h-full shrink-0',
      sidebarOpen ? 'flex' : 'hidden md:flex'
    )}>

      {/* ── Identity header ── */}
      <div className="shrink-0 px-3 py-2.5 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <span
            className={clsx('w-2 h-2 rounded-full shrink-0', persConnected ? 'bg-green-500' : 'bg-gray-600')}
            title={persConnected ? 'Reachable (persistent ID registered)' : 'Signaling disconnected'}
          />
          <button
            onClick={onShowProfile}
            className="flex items-center gap-1.5 flex-1 min-w-0 text-left hover:opacity-80 transition-opacity"
            title="View profile & settings"
          >
            <span className="font-semibold text-gray-100 text-sm truncate">{myName || '—'}</span>
            <Pencil size={11} className="text-gray-500 shrink-0" />
          </button>
          <button
            onClick={onToggleOffline}
            className={clsx(
              'p-1 rounded shrink-0 transition-colors',
              offlineMode
                ? 'text-orange-400 bg-orange-900/30 hover:bg-orange-900/50'
                : 'text-gray-400 hover:bg-gray-800 hover:text-white'
            )}
            title={offlineMode ? 'Offline mode — click to reconnect' : 'Go offline (pause signaling)'}
          >
            {offlineMode ? <WifiOff size={14} /> : <Wifi size={14} />}
          </button>
          {installPrompt && (
            <button
              onClick={() => { installPrompt.prompt(); setInstallPrompt(null); }}
              className="flex items-center gap-1 text-[10px] text-blue-400 hover:text-blue-300 px-1.5 py-0.5 hover:bg-blue-900/20 rounded transition-colors shrink-0"
              title="Install as app"
            >
              <Download size={11} /> Install
            </button>
          )}
          <button
            onClick={onShare}
            className="p-1 hover:bg-gray-800 rounded text-gray-400 hover:text-white shrink-0"
            title="Share your Persistent ID"
          >
            <Share2 size={14} />
          </button>
        </div>
        {myPid && (
          <div className="mt-0.5 ml-4 font-mono text-[10px] text-gray-500 truncate">
            {myPid.length > 30 ? myPid.slice(0, 30) + '…' : myPid}
          </div>
        )}
        {myFingerprint && (
          <div className="mt-0.5 ml-4 flex items-center gap-1">
            <Key size={9} className="text-purple-400 shrink-0" />
            <span className="font-mono text-[10px] text-purple-400">{myFingerprint}</span>
          </div>
        )}
        {/* Signaling state detail */}
        <div className="mt-0.5 ml-4 flex items-center gap-1">
          <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0',
            signalingState === 'connected' ? 'bg-green-500' :
            signalingState === 'reconnecting' ? 'bg-orange-400 animate-pulse' : 'bg-gray-600'
          )} />
          <span className={clsx('text-[10px] font-mono',
            signalingState === 'connected' ? 'text-green-600' :
            signalingState === 'reconnecting' ? 'text-orange-400' : 'text-gray-600'
          )}>
            {signalingState === 'connected'
              ? `signaling ok · ${formatTimeSince(lastSignalingTs)}`
              : signalingState === 'reconnecting'
              ? `reconnecting${reconnectAttempt > 0 ? ` (${reconnectAttempt})` : '…'}`
              : 'offline mode'}
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">

        {/* ── Discovery Namespaces ── */}
        <div className="border-b border-gray-800">
          <button
            onClick={() => setNsExpanded((v: boolean) => !v)}
            className="w-full flex items-center justify-between px-3 py-2 text-[10px] text-gray-500 uppercase tracking-wider hover:bg-gray-800/50 transition-colors"
          >
            <span>📡 Discovery Namespaces</span>
            {nsExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>

          {nsExpanded && (
            <div className="px-3 pb-3 space-y-2">
              {/* Public IP namespace card */}
              {networkIP ? (
                <div className={clsx('bg-gray-800 rounded-lg p-2.5 text-[11px]', namespaceOffline && 'opacity-50')}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-gray-300 font-medium">🌐 Public IP</span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={onToggleNamespace}
                        className={clsx(
                          'p-0.5 rounded transition-colors',
                          namespaceOffline ? 'text-orange-400' : 'text-gray-500 hover:text-gray-300'
                        )}
                        title={namespaceOffline ? 'Namespace paused — click to rejoin' : 'Pause this namespace'}
                      >
                        {namespaceOffline ? <WifiOff size={11} /> : <Wifi size={11} />}
                      </button>
                      <button
                        onClick={onShowNamespaceInfo}
                        className={clsx(
                          'text-[10px] font-mono px-1 py-0.5 rounded border flex items-center gap-0.5 hover:opacity-75 transition-opacity',
                          namespaceOffline ? 'text-orange-400 border-orange-800' :
                          isRouter ? 'text-yellow-400 border-yellow-800' : 'text-blue-400 border-blue-800'
                        )}
                        title="View namespace routing info"
                      >
                        <Radio size={9} />
                        {namespaceOffline ? 'Paused' : namespaceLevel > 0 ? (isRouter ? `Router L${namespaceLevel}` : `Peer L${namespaceLevel}`) : '…'}
                      </button>
                    </div>
                  </div>
                  <div className="space-y-1 text-[10px]">
                    <div className="flex justify-between">
                      <span className="text-gray-500">Namespace</span>
                      <span className="font-mono text-gray-400">{networkIP}</span>
                    </div>
                    {networkDiscID && (
                      <div className="flex justify-between">
                        <span className="text-gray-500">My disc ID</span>
                        <span className="font-mono text-gray-500 truncate max-w-[110px]">
                          …{networkDiscID.slice(-12)}
                        </span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span className="text-gray-500">Peers here</span>
                      <span className="text-gray-400">{peerCount}</span>
                    </div>
                  </div>

                  {/* Nearby / unknown peers in this namespace */}
                  {unknownOnNet.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-gray-700 space-y-1.5">
                      <div className="text-gray-500 text-[10px] mb-1">Nearby</div>
                      {unknownOnNet.map((did) => (
                        <div key={did} className="flex items-center justify-between gap-1">
                          <div className="min-w-0">
                            <div className="text-gray-300 truncate text-[11px] font-medium">
                              {registry[did].friendlyName}
                            </div>
                            <div className="text-gray-600 font-mono text-[9px] truncate">
                              {extractDiscUUID(did).slice(0, 10)}…
                            </div>
                          </div>
                          <button
                            onClick={() => onConnect(did, registry[did].friendlyName)}
                            className="shrink-0 text-[10px] px-1.5 py-0.5 bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors"
                          >
                            Add
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-[11px] text-gray-600 italic px-1">Detecting network…</div>
              )}
            </div>
          )}
        </div>

        {/* ── Pending incoming requests ── */}
        {incomingPIDs.length > 0 && (
          <div className="border-b border-gray-800 pt-1 pb-2">
            <div className="px-3 py-1.5 text-[10px] text-yellow-500 uppercase tracking-wider">
              📨 Incoming Requests ({incomingPIDs.length})
            </div>
            {incomingPIDs.map((pid) => {
              const contact = peers[pid];
              return (
                <div key={pid} className="px-3 py-2 bg-yellow-900/10 border-l-2 border-yellow-700/50 mx-2 rounded-lg mb-1">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="font-semibold text-gray-200 text-sm flex-1 truncate">{contact.friendlyName}</span>
                    {contact.pendingVerified !== undefined && (
                      <span className={clsx('text-[9px] font-mono px-1 py-0.5 rounded', contact.pendingVerified ? 'bg-green-900/50 text-green-400' : 'bg-red-900/50 text-red-400')}>
                        {contact.pendingVerified ? '✓' : '⚠'}
                      </span>
                    )}
                  </div>
                  {contact.pendingFingerprint && (
                    <div className="text-[10px] font-mono text-purple-400 mb-1.5 pl-0 truncate">{contact.pendingFingerprint}</div>
                  )}
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => onAcceptIncoming(pid)}
                      className="flex-1 text-[11px] font-semibold bg-green-700 hover:bg-green-600 text-white py-1 rounded transition-colors"
                    >Accept</button>
                    <button
                      onClick={() => onDismissPending(pid)}
                      className="flex-1 text-[11px] font-semibold bg-gray-700 hover:bg-gray-600 text-gray-300 py-1 rounded transition-colors"
                    >Dismiss</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── Contacts ── */}
        <div className="pt-1">
          {/* Section header with Add button */}
          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="text-[10px] text-gray-500 uppercase tracking-wider">
              Contacts {savedPIDs.length > 0 ? `(${savedPIDs.length})` : ''}
            </span>
            <button
              onClick={onAddContact}
              className="flex items-center gap-1 text-[10px] text-blue-400 hover:text-blue-300 px-1.5 py-0.5 hover:bg-blue-900/20 rounded transition-colors"
              title="Add contact by Persistent ID"
            >
              <UserPlus size={11} /> Add
            </button>
          </div>

          {/* Outgoing pending (request sent, waiting) */}
          {outgoingPIDs.map((pid) => {
            const contact = peers[pid];
            return (
              <div key={pid} className="px-3 py-2 border-l-2 border-blue-800/50 transition-colors">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full shrink-0 bg-blue-500 animate-pulse" />
                  <span className="font-semibold text-gray-400 text-sm flex-1 truncate">{contact.friendlyName}</span>
                  <button
                    onClick={() => onDismissPending(pid)}
                    className="p-1 hover:bg-gray-700 rounded text-gray-600 hover:text-gray-400 shrink-0"
                    title="Cancel request"
                  ><Info size={13} /></button>
                </div>
                <div className="pl-4 mt-0.5 text-[10px] text-blue-500 italic">Request sent — awaiting response…</div>
              </div>
            );
          })}

          {savedPIDs.length > 0 ? (
            <>
              {savedPIDs.map((pid) => {
                const contact = peers[pid];
                const unread = unreadCounts[pid] || 0;
                const preview = lastMessagePreview(chats[pid]);
                const isOnline = !!contact.conn?.open;
                const onNetwork = !!contact.onNetwork;

                return (
                  <div
                    key={pid}
                    onClick={() => onSelectChat(pid)}
                    onContextMenu={(e: React.MouseEvent) => { e.preventDefault(); onShowContactInfo(pid); }}
                    onTouchStart={() => startLongPress(pid)}
                    onTouchEnd={cancelLongPress}
                    onTouchMove={cancelLongPress}
                    className={clsx(
                      'px-3 py-2.5 cursor-pointer border-l-2 transition-colors',
                      activeChat === pid
                        ? 'bg-gray-800 border-blue-500'
                        : 'border-transparent hover:bg-gray-800/60 hover:border-gray-700'
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className={clsx(
                        'w-2 h-2 rounded-full shrink-0',
                        isOnline ? 'bg-green-500' : onNetwork ? 'bg-yellow-500' : 'bg-gray-600'
                      )} />
                      <span className="font-semibold text-gray-200 text-sm flex-1 truncate">
                        {contact.friendlyName}
                      </span>
                      {unread > 0 && (
                        <span className="bg-blue-600 text-white text-[10px] font-bold min-w-[18px] px-1 py-0.5 rounded-full text-center shrink-0">
                          {unread > 99 ? '99+' : unread}
                        </span>
                      )}
                      <button
                        onClick={(e: React.MouseEvent) => { e.stopPropagation(); onShowContactInfo(pid); }}
                        className="p-1 hover:bg-gray-700 rounded text-gray-500 hover:text-gray-300 shrink-0"
                        title="Contact info"
                      >
                        <Info size={13} />
                      </button>
                    </div>
                    <div className="flex items-center justify-between mt-0.5 pl-4 gap-2">
                      <span className="text-[11px] text-gray-500 italic truncate flex-1">
                        {preview ? preview.text : <span className="not-italic text-gray-600">no messages yet</span>}
                      </span>
                      {preview && (
                        <span className="text-[10px] text-gray-600 shrink-0">{formatTime(preview.ts)}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </>
          ) : outgoingPIDs.length === 0 && (
            <div className="p-4 text-center">
              <div className="text-xs text-gray-600">No contacts yet</div>
              <div className="text-[11px] text-gray-700 mt-1">Add nearby peers above or tap Add</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
