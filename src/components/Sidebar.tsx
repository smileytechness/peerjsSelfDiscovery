import React, { useRef, useState, useEffect } from 'react';
import { Contact, PeerInfo, ChatMessage } from '../lib/types';
import { extractDiscUUID } from '../lib/discovery';
import { clsx } from 'clsx';
import { Info, ChevronDown, ChevronRight, Key, Share2, UserPlus, Wifi, WifiOff, Download } from 'lucide-react';

interface SidebarProps {
  // My identity (shown in header)
  myName: string;
  myPid: string;
  myFingerprint: string;
  persConnected: boolean;
  offlineMode: boolean;
  onShare: () => void;
  onToggleOffline: () => void;
  // Network / discovery
  networkRole: string;
  networkIP: string;
  networkDiscID: string;
  namespaceLevel: number;
  namespaceOffline: boolean;
  onToggleNamespace: () => void;
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
  networkRole,
  networkIP,
  networkDiscID,
  namespaceLevel,
  namespaceOffline,
  onToggleNamespace,
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
}: SidebarProps) {
  const savedPIDs = Object.keys(peers);
  const unknownOnNet = Object.keys(registry).filter((did) => !registry[did].isMe && !registry[did].knownPID);
  const isRouter = networkRole.startsWith('Router');
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
          <span className="font-semibold text-gray-100 text-sm flex-1 truncate">{myName || '—'}</span>
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
                      <span className={clsx(
                        'text-[10px] font-mono px-1 py-0.5 rounded border',
                        namespaceOffline ? 'text-orange-400 border-orange-800' :
                        isRouter ? 'text-yellow-400 border-yellow-800' : 'text-blue-400 border-blue-800'
                      )}>
                        {namespaceOffline ? 'Paused' : namespaceLevel > 0 ? (isRouter ? `Router L${namespaceLevel}` : `Peer L${namespaceLevel}`) : '…'}
                      </span>
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
                      'px-3 py-2.5 cursor-pointer border-l-2 transition-colors group',
                      activeChat === pid
                        ? 'bg-gray-800 border-blue-500'
                        : 'border-transparent hover:bg-gray-800/60 hover:border-gray-700'
                    )}
                  >
                    {/* Row 1: status dot + name + unread badge + info */}
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

                    {/* Row 2: last message preview + time */}
                    <div className="flex items-center justify-between mt-0.5 pl-4 gap-2">
                      <span className="text-[11px] text-gray-500 italic truncate flex-1">
                        {preview
                          ? preview.text
                          : <span className="not-italic text-gray-600">no messages yet</span>
                        }
                      </span>
                      {preview && (
                        <span className="text-[10px] text-gray-600 shrink-0">{formatTime(preview.ts)}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </>
          ) : (
            <div className="p-4 text-center">
              <div className="text-xs text-gray-600">No contacts yet</div>
              <div className="text-[11px] text-gray-700 mt-1">
                Add nearby peers above or tap Add
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
