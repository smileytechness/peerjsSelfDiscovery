import React, { useRef, useState, useEffect, useMemo } from 'react';
import { Contact, PeerInfo, ChatMessage, CustomNS, GroupInfo, GroupMessage, GeoRegistryEntry, APP_PREFIX } from '../lib/types';
import { extractDiscUUID } from '../lib/discovery';
import { NearbyPanel } from './NearbyPanel';
import { clsx } from 'clsx';
import { Info, ChevronDown, ChevronRight, Key, Share2, UserPlus, Wifi, WifiOff, Download, Radio, Pencil, Plus, Bell, Users, Shield } from 'lucide-react';

interface SidebarProps {
  // My identity (shown in header)
  myName: string;
  myPid: string;
  myPidHistory?: string[];
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
  groupUnreadCounts: Record<string, number>;
  activeChat: string | null;
  sidebarOpen: boolean;
  onSelectChat: (pid: string) => void;
  onConnect: (did: string, fname: string) => void;
  onAddContact: () => void;
  onShowContactInfo: (pid: string) => void;
  onShowProfile: () => void;
  onAcceptIncoming: (pid: string) => void;
  onDismissPending: (pid: string) => void;
  // Custom namespaces
  customNamespaces: Record<string, CustomNS>;
  onJoinCustomNS: (name: string, advanced?: boolean) => void;
  onToggleCustomNSOffline: (slug: string, offline: boolean) => void;
  onShowCustomNSInfo: (slug: string) => void;
  // Groups
  groups: Record<string, { info: GroupInfo; messages: GroupMessage[]; isRouter: boolean; level: number; memberCount: number }>;
  activeGroupChat: string | null;
  onSelectGroupChat: (groupId: string) => void;
  onCreateGroup: () => void;
  onShowGroupInfo: (groupId: string) => void;
  // Geo
  geoActive: boolean;
  geoRefreshing: boolean;
  nearbyPeers: { peer: GeoRegistryEntry; overlapCount: number; totalHashes: number; fingerprint?: string }[];
  geoDebug?: any[];
  queueState?: any;
  geoLat?: number | null;
  geoLng?: number | null;
  onGeoStart: () => void;
  onGeoStop: () => void;
  onGeoRefresh: () => void;
  // Footer
  onShowLearnMore: () => void;
  onToggleLogs: () => void;
  showLogs: boolean;
  buildNumber: number;
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
  const text = last.type === 'file' ? `📎 ${last.name || 'file'}`
             : last.type === 'call' ? `📞 ${last.callResult === 'answered' ? `${last.callKind} call` : last.callResult === 'missed' ? 'Missed call' : last.callResult === 'rejected' ? 'Declined call' : 'Cancelled call'}`
             : (last.content || '');
  return { text, ts: last.ts };
}

type ChatFilter = 'all' | 'groups' | 'contacts' | 'unread';
type ChatItem = {
  kind: 'contact';
  key: string;
  contact: Contact;
  lastTs: number;
  unread: number;
  preview: { text: string; ts: number } | null;
} | {
  kind: 'outgoing';
  key: string;
  contact: Contact;
  lastTs: number;
  unread: number;
} | {
  kind: 'group';
  groupId: string;
  info: GroupInfo;
  messages: GroupMessage[];
  isRouter: boolean;
  level: number;
  memberCount: number;
  lastTs: number;
  unread: number;
};

export function Sidebar({
  myName,
  myPid,
  myPidHistory,
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
  groupUnreadCounts,
  activeChat,
  sidebarOpen,
  onSelectChat,
  onConnect,
  onAddContact,
  onShowContactInfo,
  onShowProfile,
  onAcceptIncoming,
  onDismissPending,
  customNamespaces,
  onJoinCustomNS,
  onToggleCustomNSOffline,
  onShowCustomNSInfo,
  groups,
  activeGroupChat,
  onSelectGroupChat,
  onCreateGroup,
  onShowGroupInfo,
  geoActive,
  geoRefreshing,
  nearbyPeers,
  geoDebug,
  queueState,
  geoLat,
  geoLng,
  onGeoStart,
  onGeoStop,
  onGeoRefresh,
  onShowLearnMore,
  onToggleLogs,
  showLogs,
  buildNumber,
}: SidebarProps) {
  const allKeys = Object.keys(peers);
  const incomingKeys = allKeys.filter(key => peers[key].pending === 'incoming');
  const outgoingKeys = allKeys.filter(key => peers[key].pending === 'outgoing');
  const savedKeysRaw = allKeys.filter(key => !peers[key].pending);
  // Deduplicate by fingerprint/publicKey — if multiple keys share a fingerprint, keep first occurrence
  const savedKeys = savedKeysRaw.filter((key, i) => {
    const fp = peers[key].fingerprint;
    if (!fp) return true;
    return savedKeysRaw.findIndex(k => peers[k].fingerprint === fp) === i;
  });
  const unknownOnNet = Object.keys(registry).filter((did) => !registry[did].isMe && !registry[did].knownPID);
  const peerCount = Object.keys(registry).filter(k => !registry[k].isMe).length;

  const [nsExpanded, setNsExpanded] = useState(() => localStorage.getItem(`${APP_PREFIX}-ns-expanded`) !== '0');
  const [nsInput, setNsInput] = useState('');
  const [nsAdvanced, setNsAdvanced] = useState(false);
  const [chatFilter, setChatFilter] = useState<ChatFilter>('all');

  // Resizable sidebar width (desktop only)
  const MIN_SIDEBAR_W = 240;
  const MAX_SIDEBAR_W = 480;
  const DEFAULT_SIDEBAR_W = 320;
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem(`${APP_PREFIX}-sidebar-width`);
    return saved ? Math.max(MIN_SIDEBAR_W, Math.min(MAX_SIDEBAR_W, parseInt(saved, 10))) : DEFAULT_SIDEBAR_W;
  });
  const widthRef = useRef(sidebarWidth);
  useEffect(() => { widthRef.current = sidebarWidth; }, [sidebarWidth]);
  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = widthRef.current;
    const onMove = (ev: MouseEvent) => {
      const newW = Math.max(MIN_SIDEBAR_W, Math.min(MAX_SIDEBAR_W, startW + ev.clientX - startX));
      setSidebarWidth(newW);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      localStorage.setItem(`${APP_PREFIX}-sidebar-width`, String(widthRef.current));
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const cnsArr = Object.values(customNamespaces);
  const totalNS = 1 + cnsArr.length;
  const activeNS = (networkIP && !namespaceOffline ? 1 : 0) + cnsArr.filter(ns => !ns.offline).length;
  const [installPrompt, setInstallPrompt] = useState<any>(null);
  const [notifPerm, setNotifPerm] = useState<string>(() =>
    'Notification' in window ? Notification.permission : 'unavailable'
  );

  useEffect(() => {
    const handler = (e: Event) => { e.preventDefault(); setInstallPrompt(e); };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTarget = useRef<string | null>(null);

  const startLongPress = (key: string) => {
    longPressTarget.current = key;
    longPressTimer.current = setTimeout(() => {
      if (longPressTarget.current === key) onShowContactInfo(key);
    }, 600);
  };
  const cancelLongPress = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
    longPressTarget.current = null;
  };

  // Build merged + sorted chat items
  const chatItems = useMemo<ChatItem[]>(() => {
    const items: ChatItem[] = [];

    // Outgoing pending contacts
    for (const key of outgoingKeys) {
      items.push({ kind: 'outgoing', key, contact: peers[key], lastTs: 0, unread: 0 });
    }

    // Saved contacts
    for (const key of savedKeys) {
      const preview = lastMessagePreview(chats[key]);
      items.push({
        kind: 'contact',
        key,
        contact: peers[key],
        lastTs: preview?.ts || 0,
        unread: unreadCounts[key] || 0,
        preview,
      });
    }

    // Groups
    for (const [groupId, g] of Object.entries(groups)) {
      const lastMsg = g.messages.length > 0 ? g.messages[g.messages.length - 1] : null;
      items.push({
        kind: 'group',
        groupId,
        info: g.info,
        messages: g.messages,
        isRouter: g.isRouter,
        level: g.level,
        memberCount: g.memberCount,
        lastTs: lastMsg?.ts || 0,
        unread: groupUnreadCounts[groupId] || 0,
      });
    }

    // Sort: items with messages first (by lastTs desc), then items without messages alphabetically
    items.sort((a, b) => {
      if (a.lastTs && b.lastTs) return b.lastTs - a.lastTs;
      if (a.lastTs) return -1;
      if (b.lastTs) return 1;
      const nameA = a.kind === 'group' ? a.info.name : a.contact.friendlyName;
      const nameB = b.kind === 'group' ? b.info.name : b.contact.friendlyName;
      return nameA.localeCompare(nameB);
    });

    return items;
  }, [savedKeys, outgoingKeys, peers, chats, unreadCounts, groups, groupUnreadCounts]);

  // Apply filter
  const filteredItems = useMemo(() => {
    switch (chatFilter) {
      case 'groups': return chatItems.filter(i => i.kind === 'group');
      case 'contacts': return chatItems.filter(i => i.kind === 'contact' || i.kind === 'outgoing');
      case 'unread': return chatItems.filter(i => i.unread > 0);
      default: return chatItems;
    }
  }, [chatItems, chatFilter]);

  const totalChats = savedKeys.length + outgoingKeys.length + Object.keys(groups).length;

  return (
    <div
      className={clsx(
        'w-full sidebar-resizable bg-gray-900 border-r border-gray-800 flex-col h-full shrink-0 relative',
        sidebarOpen ? 'flex' : 'hidden md:flex'
      )}
      style={{ '--sidebar-w': `${sidebarWidth}px` } as React.CSSProperties}
    >

      {/* ── Identity header ── */}
      <div className="shrink-0 px-4 py-3 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <span
            className={clsx('w-2.5 h-2.5 rounded-full shrink-0',
              offlineMode ? 'bg-gray-600' :
              signalingState === 'reconnecting' ? 'bg-orange-400 animate-pulse' :
              persConnected ? 'bg-green-500' : 'bg-gray-600'
            )}
            title={offlineMode ? 'Offline mode' : signalingState === 'reconnecting' ? 'Reconnecting…' : persConnected ? 'Connected & reachable' : 'Disconnected'}
          />
          <button
            onClick={onShowProfile}
            className="flex items-center gap-1.5 flex-1 min-w-0 text-left hover:opacity-80 transition-opacity"
            title="View profile & settings"
          >
            <span className="font-semibold text-gray-100 text-base truncate">{myName || '—'}</span>
            <Pencil size={12} className="text-gray-500 shrink-0" />
          </button>
          <button
            onClick={onToggleOffline}
            className={clsx(
              'p-1.5 rounded shrink-0 transition-colors',
              offlineMode
                ? 'text-orange-400 bg-orange-900/30 hover:bg-orange-900/50'
                : 'text-gray-400 hover:bg-gray-800 hover:text-white'
            )}
            title={offlineMode ? 'Offline mode — click to reconnect' : 'Go offline (pause signaling)'}
          >
            {offlineMode ? <WifiOff size={15} /> : <Wifi size={15} />}
          </button>
          {notifPerm === 'default' && (
            <button
              onClick={async () => {
                if ('Notification' in window) {
                  const r = await Notification.requestPermission();
                  setNotifPerm(r);
                }
              }}
              className="p-1.5 hover:bg-yellow-900/20 rounded text-yellow-400 hover:text-yellow-300 transition-colors shrink-0"
              title="Enable notifications"
            >
              <Bell size={14} />
            </button>
          )}
          {installPrompt && (
            <button
              onClick={() => { installPrompt.prompt(); setInstallPrompt(null); }}
              className="p-1.5 hover:bg-blue-900/20 rounded text-blue-400 hover:text-blue-300 transition-colors shrink-0"
              title="Install as app"
            >
              <Download size={14} />
            </button>
          )}
          <button
            onClick={onShare}
            className="flex items-center gap-1 px-2.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-medium transition-colors shrink-0"
            title="Invite someone to connect"
          >
            <Share2 size={13} /> Invite
          </button>
        </div>
        {myFingerprint && (
          <div className="mt-1.5 ml-5 flex items-center gap-1">
            <Key size={11} className="text-purple-400 shrink-0" />
            <span className="font-mono text-xs text-purple-400">{myFingerprint}</span>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">

        {/* ── Discovery Namespaces ── */}
        <div className="border-b border-gray-800">
          <button
            onClick={() => setNsExpanded((v: boolean) => { const next = !v; localStorage.setItem(`${APP_PREFIX}-ns-expanded`, next ? '1' : '0'); return next; })}
            className="w-full flex items-center justify-between px-4 py-2.5 text-[11px] text-gray-500 uppercase tracking-wider hover:bg-gray-800/50 transition-colors"
          >
            <span>📡 Discovery Namespaces {totalNS > 0 && <span className={activeNS === totalNS ? 'text-green-600' : 'text-orange-500'}>({activeNS}/{totalNS})</span>}</span>
            {nsExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>

          {nsExpanded && (
            <div className="px-4 pb-4 space-y-2.5 anim-fade-fast">
              {/* Local Network — compact card */}
              <div className={clsx(
                'flex items-center justify-between bg-gray-800 rounded-lg px-3 py-2.5 text-xs',
                (namespaceOffline || !networkIP) && 'opacity-50'
              )}>
                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                  <span className="text-gray-300 font-medium shrink-0">🌐 Local Network</span>
                  {networkIP && !namespaceOffline && (
                    <span className="text-gray-500 text-[11px]">({peerCount})</span>
                  )}
                  <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0',
                    namespaceOffline ? 'bg-orange-400' :
                    !networkIP ? 'bg-gray-600' :
                    isRouter ? 'bg-yellow-400' : 'bg-green-500'
                  )} />
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {(networkIP || namespaceOffline) && (
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
                  )}
                  <button
                    onClick={networkIP ? onShowNamespaceInfo : undefined}
                    className={clsx(
                      'text-[11px] font-mono px-1.5 py-0.5 rounded border flex items-center gap-0.5 transition-opacity',
                      namespaceOffline ? 'text-orange-400 border-orange-800 hover:opacity-75' :
                      !networkIP ? 'text-gray-500 border-gray-700' :
                      isRouter ? 'text-yellow-400 border-yellow-800 hover:opacity-75' : 'text-blue-400 border-blue-800 hover:opacity-75'
                    )}
                    title={namespaceOffline ? 'Namespace paused' : networkIP ? 'View namespace routing info' : 'Detecting network...'}
                  >
                    <Radio size={9} />
                    {namespaceOffline ? 'Paused' : !networkIP ? 'Detecting…' : namespaceLevel > 0 ? (isRouter ? `Router L${namespaceLevel}` : `Peer L${namespaceLevel}`) : '…'}
                  </button>
                </div>
              </div>

              {/* Nearby / unknown peers in local network */}
              {unknownOnNet.length > 0 && (
                <div className="pl-1 space-y-1.5">
                  {unknownOnNet.map((did) => (
                    <div key={did} className="flex items-center justify-between gap-2 bg-gray-800/30 rounded-lg px-3 py-2 text-xs">
                      <span className="text-gray-300 truncate">{registry[did].friendlyName}</span>
                      <button
                        onClick={() => onConnect(did, registry[did].friendlyName)}
                        className="shrink-0 text-[11px] px-2 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors"
                      >
                        Connect
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Custom namespace cards — compact */}
              {Object.values(customNamespaces).map((ns) => {
                const nsPeerCount = Object.keys(ns.registry).filter(k => !ns.registry[k].isMe).length;
                const nsUnknown = Object.keys(ns.registry).filter(did => !ns.registry[did].isMe && !ns.registry[did].knownPID);
                return (
                  <React.Fragment key={ns.slug}>
                    <div className={clsx(
                      'flex items-center justify-between bg-gray-800 rounded-lg px-3 py-2.5 text-xs',
                      ns.offline && 'opacity-50'
                    )}>
                      <div className="flex items-center gap-1.5 min-w-0 flex-1">
                        <span className="text-gray-300 font-medium truncate">🏷 {ns.name}</span>
                        {!ns.offline && (
                          <span className="text-gray-500 text-[11px]">({nsPeerCount})</span>
                        )}
                        <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0',
                          ns.offline ? 'bg-orange-400' :
                          ns.level === 0 ? 'bg-gray-600' :
                          ns.isRouter ? 'bg-yellow-400' : 'bg-green-500'
                        )} />
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => onToggleCustomNSOffline(ns.slug, !ns.offline)}
                          className={clsx(
                            'p-0.5 rounded transition-colors',
                            ns.offline ? 'text-orange-400' : 'text-gray-500 hover:text-gray-300'
                          )}
                          title={ns.offline ? 'Paused — click to rejoin' : 'Pause this namespace'}
                        >
                          {ns.offline ? <WifiOff size={11} /> : <Wifi size={11} />}
                        </button>
                        <button
                          onClick={() => onShowCustomNSInfo(ns.slug)}
                          className={clsx(
                            'text-[11px] font-mono px-1.5 py-0.5 rounded border flex items-center gap-0.5 hover:opacity-75 transition-opacity',
                            ns.offline ? 'text-orange-400 border-orange-800' :
                            ns.level === 0 ? 'text-gray-500 border-gray-700' :
                            ns.isRouter ? 'text-yellow-400 border-yellow-800' : 'text-blue-400 border-blue-800'
                          )}
                          title="View namespace routing info"
                        >
                          <Radio size={9} />
                          {ns.offline ? 'Paused' : ns.level === 0 ? '…' : (ns.isRouter ? `Router L${ns.level}` : `Peer L${ns.level}`)}
                        </button>
                      </div>
                    </div>
                    {nsUnknown.length > 0 && (
                      <div className="pl-1 space-y-1.5">
                        {nsUnknown.map((did) => (
                          <div key={did} className="flex items-center justify-between gap-2 bg-gray-800/30 rounded-lg px-3 py-2 text-xs">
                            <span className="text-gray-300 truncate">{ns.registry[did].friendlyName}</span>
                            <button
                              onClick={() => onConnect(did, ns.registry[did].friendlyName)}
                              className="shrink-0 text-[11px] px-2 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors"
                            >
                              Connect
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </React.Fragment>
                );
              })}

              {/* Nearby (Geo) — inside Discovery */}
              <NearbyPanel
                active={geoActive}
                refreshing={geoRefreshing}
                nearbyPeers={nearbyPeers}
                contacts={peers}
                geoDebug={geoDebug}
                queueState={queueState}
                geoLat={geoLat}
                geoLng={geoLng}
                onStart={onGeoStart}
                onStop={onGeoStop}
                onRefresh={onGeoRefresh}
                onConnect={onConnect}
              />

              {/* Join namespace input */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = nsInput.trim();
                  if (name) { onJoinCustomNS(name, nsAdvanced || undefined); setNsInput(''); setNsAdvanced(false); }
                }}
                className="mt-1"
              >
                <div className="flex gap-1">
                  <input
                    type="text"
                    value={nsInput}
                    onChange={(e) => setNsInput(e.target.value)}
                    placeholder={nsAdvanced ? 'Base pattern (e.g. myco-room1)' : 'Join namespace…'}
                    className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-600"
                  />
                  <button
                    type="submit"
                    disabled={!nsInput.trim()}
                    className="shrink-0 p-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded transition-colors"
                    title="Join namespace"
                  >
                    <Plus size={12} />
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setNsAdvanced(v => !v)}
                  className={clsx(
                    'mt-1 text-[11px] px-1.5 py-0.5 rounded transition-colors',
                    nsAdvanced ? 'text-cyan-400 bg-cyan-900/30' : 'text-gray-600 hover:text-gray-400'
                  )}
                >
                  {nsAdvanced ? '✓ Advanced (no prefix)' : 'Advanced'}
                </button>
              </form>
            </div>
          )}
        </div>

        {/* ── Pending incoming requests ── */}
        {incomingKeys.length > 0 && (
          <div className="border-b border-gray-800 pt-1 pb-2">
            <div className="px-4 py-2 text-[11px] text-yellow-500 uppercase tracking-wider">
              📨 Incoming Requests ({incomingKeys.length})
            </div>
            {incomingKeys.map((key) => {
              const contact = peers[key];
              return (
                <div key={key} className="px-3 py-2.5 bg-yellow-900/10 border-l-2 border-yellow-700/50 mx-3 rounded-lg mb-1.5">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="font-semibold text-gray-200 text-sm flex-1 truncate">{contact.friendlyName}</span>
                    {contact.pendingVerified !== undefined && (
                      <span className={clsx('text-[9px] font-mono px-1 py-0.5 rounded', contact.pendingVerified ? 'bg-green-900/50 text-green-400' : 'bg-red-900/50 text-red-400')}>
                        {contact.pendingVerified ? '✓' : '⚠'}
                      </span>
                    )}
                  </div>
                  {contact.pendingFingerprint && (
                    <div className="text-[11px] font-mono text-purple-400 mb-2 pl-0 truncate">{contact.pendingFingerprint}</div>
                  )}
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => onAcceptIncoming(key)}
                      className="flex-1 text-xs font-semibold bg-green-700 hover:bg-green-600 text-white py-1.5 rounded transition-colors"
                    >Accept</button>
                    <button
                      onClick={() => onDismissPending(key)}
                      className="flex-1 text-xs font-semibold bg-gray-700 hover:bg-gray-600 text-gray-300 py-1.5 rounded transition-colors"
                    >Dismiss</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── Chats (merged contacts + groups) ── */}
        <div className="pt-1">
          {/* Section header */}
          <div className="flex items-center justify-between px-4 py-2">
            <span className="text-[11px] text-gray-500 uppercase tracking-wider">
              Chats {totalChats > 0 ? `(${totalChats})` : ''}
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={onAddContact}
                className="p-1 hover:bg-blue-900/20 rounded text-blue-400 hover:text-blue-300 transition-colors"
                title="Add contact by Persistent ID"
              >
                <UserPlus size={12} />
              </button>
              <button
                onClick={onCreateGroup}
                className="p-1 hover:bg-blue-900/20 rounded text-blue-400 hover:text-blue-300 transition-colors"
                title="Create new group"
              >
                <Users size={12} />
              </button>
            </div>
          </div>

          {/* Filter chips */}
          <div className="flex gap-1.5 px-4 pb-2">
            {(['all', 'groups', 'contacts', 'unread'] as ChatFilter[]).map((f) => (
              <button
                key={f}
                onClick={() => setChatFilter(f)}
                className={clsx(
                  'text-[11px] px-2.5 py-1 rounded-full transition-colors capitalize',
                  chatFilter === f
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-800 text-gray-500 hover:text-gray-300'
                )}
              >
                {f}
              </button>
            ))}
          </div>

          {/* Chat items */}
          {filteredItems.length > 0 ? (
            filteredItems.map((item) => {
              if (item.kind === 'outgoing') {
                return (
                  <div key={`out-${item.key}`} className="px-4 py-2.5 border-l-2 border-blue-800/50 transition-colors">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full shrink-0 bg-blue-500 animate-pulse" />
                      <span className="font-semibold text-gray-400 text-sm flex-1 truncate">{item.contact.friendlyName}</span>
                      <button
                        onClick={() => onDismissPending(item.key)}
                        className="p-1 hover:bg-gray-700 rounded text-gray-600 hover:text-gray-400 shrink-0"
                        title="Cancel request"
                      ><Info size={13} /></button>
                    </div>
                    <div className="pl-4 mt-1 text-[11px] text-blue-500 italic">Request sent — awaiting response…</div>
                  </div>
                );
              }

              if (item.kind === 'contact') {
                const { key, contact, unread, preview } = item;
                const isOnline = !!contact.conn?.open;
                const onNetwork = !!contact.onNetwork;
                const hasE2E = !!(contact.publicKey && contact.sharedKeyFingerprint);

                return (
                  <div
                    key={`c-${key}`}
                    onClick={() => onSelectChat(key)}
                    onContextMenu={(e: React.MouseEvent) => { e.preventDefault(); onShowContactInfo(key); }}
                    onTouchStart={() => startLongPress(key)}
                    onTouchEnd={cancelLongPress}
                    onTouchMove={cancelLongPress}
                    className={clsx(
                      'px-4 py-3 cursor-pointer border-l-2 transition-colors',
                      activeChat === key
                        ? 'bg-gray-800 border-blue-500'
                        : 'border-transparent hover:bg-gray-800/60 hover:border-gray-700'
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className={clsx(
                        'w-2 h-2 rounded-full shrink-0',
                        isOnline ? 'bg-green-500' : onNetwork ? 'bg-yellow-500' : 'bg-gray-600'
                      )} />
                      <div className="flex-1 min-w-0">
                        <span className="font-semibold text-gray-200 text-sm truncate flex items-center gap-1">
                          {contact.friendlyName}
                          {hasE2E && <Shield size={11} className="text-green-500 shrink-0" title="E2E encrypted" />}
                        </span>
                        {contact.fingerprint && (
                          <span className="text-[11px] font-mono text-purple-400 truncate block">
                            {contact.fingerprint}
                          </span>
                        )}
                      </div>
                      {unread > 0 && (
                        <span className="bg-blue-600 text-white text-[11px] font-bold min-w-[20px] px-1.5 py-0.5 rounded-full text-center shrink-0">
                          {unread > 99 ? '99+' : unread}
                        </span>
                      )}
                      <button
                        onClick={(e: React.MouseEvent) => { e.stopPropagation(); onShowContactInfo(key); }}
                        className="p-1 hover:bg-gray-700 rounded text-gray-500 hover:text-gray-300 shrink-0"
                        title="Contact info"
                      >
                        <Info size={14} />
                      </button>
                    </div>
                    <div className="flex items-center justify-between mt-1 pl-4 gap-2">
                      <span className="text-xs text-gray-500 italic truncate flex-1">
                        {preview ? preview.text : <span className="not-italic text-gray-600">no messages yet</span>}
                      </span>
                      {preview && (
                        <span className="text-[11px] text-gray-600 shrink-0">{formatTime(preview.ts)}</span>
                      )}
                    </div>
                  </div>
                );
              }

              if (item.kind === 'group') {
                const { groupId, info, messages, isRouter: grpRouter, level: grpLevel, memberCount, unread } = item;
                const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;

                return (
                  <div
                    key={`g-${groupId}`}
                    onClick={() => onSelectGroupChat(groupId)}
                    onContextMenu={(e: React.MouseEvent) => { e.preventDefault(); onShowGroupInfo(groupId); }}
                    className={clsx(
                      'px-4 py-3 cursor-pointer border-l-2 transition-colors',
                      activeGroupChat === groupId
                        ? 'bg-gray-800 border-purple-500'
                        : 'border-transparent hover:bg-gray-800/60 hover:border-gray-700'
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <Users size={15} className="text-purple-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <span className="font-semibold text-gray-200 text-sm truncate block">{info.name}</span>
                        <span className="text-[11px] text-gray-500">
                          {memberCount} member{memberCount !== 1 ? 's' : ''}
                          {grpRouter && <span className="text-yellow-400 ml-1">Router L{grpLevel}</span>}
                        </span>
                      </div>
                      {unread > 0 && (
                        <span className="bg-blue-600 text-white text-[11px] font-bold min-w-[20px] px-1.5 py-0.5 rounded-full text-center shrink-0">
                          {unread > 99 ? '99+' : unread}
                        </span>
                      )}
                      <button
                        onClick={(e: React.MouseEvent) => { e.stopPropagation(); onShowGroupInfo(groupId); }}
                        className="p-1 hover:bg-gray-700 rounded text-gray-500 hover:text-gray-300 shrink-0"
                        title="Group info"
                      >
                        <Info size={14} />
                      </button>
                    </div>
                    {lastMsg && (
                      <div className="flex items-center justify-between mt-1 pl-6 gap-2">
                        <span className="text-xs text-gray-500 italic truncate flex-1">
                          {lastMsg.senderName}: {lastMsg.content?.slice(0, 40)}
                        </span>
                        <span className="text-[11px] text-gray-600 shrink-0">{formatTime(lastMsg.ts)}</span>
                      </div>
                    )}
                  </div>
                );
              }

              return null;
            })
          ) : (
            <div className="p-5 text-center">
              <div className="text-[13px] text-gray-600">
                {chatFilter === 'unread' ? 'No unread messages' :
                 chatFilter === 'groups' ? 'No groups yet' :
                 chatFilter === 'contacts' ? 'No contacts yet' :
                 'No chats yet'}
              </div>
              {chatFilter === 'all' && (
                <div className="text-xs text-gray-700 mt-1.5">Add contacts or create a group to get started</div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Footer — Learn More + Version */}
      <div className="shrink-0 px-4 py-2.5 border-t border-gray-800 flex items-center justify-center gap-1.5">
        <button
          onClick={onShowLearnMore}
          className="border text-[11px] font-mono px-2 py-1 rounded transition-colors bg-gray-800 border-gray-700 text-gray-500 hover:text-gray-400"
        >
          Learn More
        </button>
        <button
          onClick={onToggleLogs}
          className={clsx(
            'border text-[11px] font-mono px-2 py-1 rounded transition-colors',
            showLogs ? 'bg-blue-900/50 border-blue-700 text-blue-400' : 'bg-gray-800 border-gray-700 text-gray-500 hover:text-gray-400'
          )}
        >
          Version #0.{buildNumber}
        </button>
      </div>

      {/* Resize handle — desktop only */}
      <div
        className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-blue-500/40 active:bg-blue-500/50 transition-colors hidden md:block z-10"
        onMouseDown={handleResizeStart}
      />
    </div>
  );
}
