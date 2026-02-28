import { useState, useEffect, useCallback, useMemo } from 'react';
import { p2p } from '../lib/p2p';
import { peerQueue, QueueState } from '../lib/peer-queue';
import { Contact, ChatMessage, PeerInfo, CustomNS, GroupInfo, GroupMessage, GroupCallInfo, APP_PREFIX } from '../lib/types';

export function useP2P() {
  const [status, setStatus] = useState({
    status: 'offline',
    role: 'Peer',
    ip: '',
    did: '',
    pid: '',
    namespaceLevel: 0,
    pubkeyFingerprint: '',
    persConnected: false,
    signalingState: 'offline' as 'connected' | 'reconnecting' | 'offline',
    lastSignalingTs: 0,
    reconnectAttempt: 0,
  });
  const [peers, setPeers] = useState<Record<string, Contact>>({});
  const [registry, setRegistry] = useState<Record<string, PeerInfo>>({});
  const [chats, setChats] = useState<Record<string, ChatMessage[]>>({});
  const [logs, setLogs] = useState<{ msg: string; type: string; ts: number }[]>([]);
  const [offlineMode, setOfflineModeState] = useState(() => !!localStorage.getItem(`${APP_PREFIX}-offline`));
  const [namespaceOffline, setNamespaceOfflineState] = useState(() => !!localStorage.getItem(`${APP_PREFIX}-ns-offline`));
  const [customNamespaces, setCustomNamespaces] = useState<Record<string, CustomNS>>(() => p2p.customNamespaces);
  const [groups, setGroups] = useState<Record<string, { info: GroupInfo; messages: GroupMessage[]; isRouter: boolean; level: number; memberCount: number; activeCall?: GroupCallInfo }>>(() => p2p.groupList);
  const [activeGroupCall, setActiveGroupCall] = useState<{ groupId: string; info: GroupCallInfo; groupName: string } | null>(p2p.activeGroupCallInfo);
  const [groupCallRemoteStreams, setGroupCallRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [geoActive, setGeoActive] = useState(false);
  const [geoRefreshing, setGeoRefreshing] = useState(false);
  const [nearbyPeers, setNearbyPeers] = useState<{ peer: any; overlapCount: number; totalHashes: number; fingerprint?: string }[]>([]);
  const [geoDebug, setGeoDebug] = useState<any[]>([]);
  const [geoLat, setGeoLat] = useState<number | null>(null);
  const [geoLng, setGeoLng] = useState<number | null>(null);
  const [queueState, setQueueState] = useState<QueueState>(peerQueue.state);
  const [lastRead, setLastRead] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem(`${APP_PREFIX}-lastread`) || '{}'); } catch { return {}; }
  });
  const [groupLastRead, setGroupLastRead] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem(`${APP_PREFIX}-group-lastread`) || '{}'); } catch { return {}; }
  });

  useEffect(() => {
    const onStatus = (e: any) => setStatus(e.detail);
    const onPeerList = () => {
      setPeers({ ...p2p.contacts });
      setRegistry({ ...p2p.registry });
    };
    const onMessage = () => {
      setChats({ ...p2p.chats });
    };
    const onLog = (e: any) => {
      setLogs((prev: { msg: string; type: string; ts: number }[]) => [...prev, { ...e.detail, ts: Date.now() }]);
    };
    const onCNS = () => setCustomNamespaces({ ...p2p.customNamespaces });
    const onGroup = () => setGroups({ ...p2p.groupList });
    const onGeo = () => {
      setGeoActive(p2p.geoActive);
      setGeoRefreshing(p2p.geoRefreshing);
      setNearbyPeers(p2p.geoGetNearbyPeers());
      setGeoDebug(p2p.geoDebugInfo);
      setGeoLat(p2p.geoLat);
      setGeoLng(p2p.geoLng);
    };
    const onGroupCall = () => {
      setActiveGroupCall(p2p.activeGroupCallInfo);
      setGroupCallRemoteStreams(new Map(p2p.groupCallRemoteStreams));
    };

    p2p.addEventListener('status-change', onStatus);
    p2p.addEventListener('peer-list-update', onPeerList);
    p2p.addEventListener('message', onMessage);
    p2p.addEventListener('log', onLog);
    p2p.addEventListener('custom-ns-update', onCNS);
    p2p.addEventListener('group-update', onGroup);
    p2p.addEventListener('geo-update', onGeo);
    p2p.addEventListener('group-call-update', onGroupCall);
    const unsubQueue = peerQueue.onStateChange(setQueueState);

    // Initial state
    setPeers({ ...p2p.contacts });
    setRegistry({ ...p2p.registry });
    setChats({ ...p2p.chats });
    setStatus({
      status: p2p.publicIP ? 'online' : 'offline',
      role: p2p.isRouter ? `Router L${p2p.namespaceLevel}` : `Peer L${p2p.namespaceLevel}`,
      ip: p2p.publicIP,
      did: p2p.discoveryID,
      pid: p2p.persistentID,
      namespaceLevel: p2p.namespaceLevel,
      pubkeyFingerprint: p2p.pubkeyFingerprint,
      persConnected: p2p.persConnected,
      signalingState: p2p.signalingState,
      lastSignalingTs: p2p.lastSignalingTs,
      reconnectAttempt: 0,
    });

    return () => {
      p2p.removeEventListener('status-change', onStatus);
      p2p.removeEventListener('peer-list-update', onPeerList);
      p2p.removeEventListener('message', onMessage);
      p2p.removeEventListener('log', onLog);
      p2p.removeEventListener('custom-ns-update', onCNS);
      p2p.removeEventListener('group-update', onGroup);
      p2p.removeEventListener('geo-update', onGeo);
      p2p.removeEventListener('group-call-update', onGroupCall);
      unsubQueue();
    };
  }, []);

  // Handle contact migration — update lastRead key
  useEffect(() => {
    const handler = (e: any) => {
      const { oldPID, newPID } = e.detail;
      setLastRead((prev: Record<string, number>) => {
        if (!prev[oldPID]) return prev;
        const next = { ...prev, [newPID]: prev[oldPID] };
        delete next[oldPID];
        localStorage.setItem(`${APP_PREFIX}-lastread`, JSON.stringify(next));
        return next;
      });
    };
    p2p.addEventListener('contact-migrated', handler);
    return () => p2p.removeEventListener('contact-migrated', handler);
  }, []);

  const unreadCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    Object.keys(chats).forEach((key) => {
      const lr = lastRead[key] || 0;
      counts[key] = (chats[key] || []).filter((m: ChatMessage) => m.dir === 'recv' && m.ts > lr).length;
    });
    return counts;
  }, [chats, lastRead]);

  const groupUnreadCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    const fp = status.pubkeyFingerprint;
    Object.entries(groups).forEach(([groupId, g]) => {
      const lr = groupLastRead[groupId] || 0;
      counts[groupId] = (g.messages || []).filter(
        (m) => m.senderFP !== fp && m.ts > lr && m.type !== 'system'
      ).length;
    });
    return counts;
  }, [groups, groupLastRead, status.pubkeyFingerprint]);

  const markRead = useCallback((contactKey: string) => {
    setLastRead((prev: Record<string, number>) => {
      const next = { ...prev, [contactKey]: Date.now() };
      localStorage.setItem(`${APP_PREFIX}-lastread`, JSON.stringify(next));
      return next;
    });
  }, []);

  const markGroupRead = useCallback((groupId: string) => {
    setGroupLastRead((prev: Record<string, number>) => {
      const next = { ...prev, [groupId]: Date.now() };
      localStorage.setItem(`${APP_PREFIX}-group-lastread`, JSON.stringify(next));
      return next;
    });
  }, []);

  const init = useCallback((name: string) => p2p.init(name), []);
  const connect = useCallback((did: string, fname: string) => p2p.requestConnect(did, fname), []);
  const sendMessage = useCallback((pid: string, content: string) => p2p.sendMessage(pid, content), []);
  const sendFile = useCallback((pid: string, file: File) => p2p.sendFile(pid, file), []);
  const startCall = useCallback((pid: string, kind: 'audio' | 'video' | 'screen') => p2p.startCall(pid, kind), []);
  const pingContact = useCallback((pid: string) => p2p.pingContact(pid), []);
  const deleteContact = useCallback((pid: string) => p2p.deleteContact(pid), []);
  const editMessage = useCallback((pid: string, id: string, content: string) => p2p.editMessage(pid, id, content), []);
  const deleteMessage = useCallback((pid: string, id: string) => p2p.deleteMessage(pid, id), []);
  const retryMessage = useCallback((pid: string, id: string) => p2p.retryMessage(pid, id), []);
  const updateName = useCallback((name: string) => p2p.updateFriendlyName(name), []);
  const acceptIncoming = useCallback((pid: string) => p2p.acceptIncomingRequest(pid), []);
  const joinCustomNS = useCallback((name: string, advanced?: boolean) => p2p.joinCustomNamespace(name, advanced), []);
  const leaveCustomNS = useCallback((slug: string) => p2p.leaveCustomNamespace(slug), []);
  const toggleCustomNSOffline = useCallback((slug: string, offline: boolean) => p2p.setCustomNSOffline(slug, offline), []);
  const groupCreate = useCallback((name: string, inviteSlug?: string) => p2p.groupCreate(name, inviteSlug), []);
  const groupJoinById = useCallback((groupId: string, info?: any) => p2p.groupJoin(groupId, info), []);
  const groupJoinBySlug = useCallback((slug: string) => p2p.groupJoinBySlug(slug), []);
  const groupLeaveById = useCallback((groupId: string) => p2p.groupLeave(groupId), []);
  const groupSendMsg = useCallback((groupId: string, content: string) => p2p.groupSendMessage(groupId, content), []);
  const groupEditMsg = useCallback((groupId: string, msgId: string, content: string) => p2p.groupEditMessage(groupId, msgId, content), []);
  const groupDeleteMsg = useCallback((groupId: string, msgId: string) => p2p.groupDeleteMessage(groupId, msgId), []);
  const groupRetryMsg = useCallback((groupId: string, msgId: string) => p2p.groupRetryMessage(groupId, msgId), []);
  const groupSendFile = useCallback((groupId: string, file: File) => p2p.groupSendFile(groupId, file), []);
  const groupInviteContact = useCallback((groupId: string, contactKey: string) => p2p.groupInvite(groupId, contactKey), []);
  const groupKickMember = useCallback((groupId: string, targetFP: string) => p2p.groupKickMember(groupId, targetFP), []);
  const groupCallStart = useCallback((groupId: string, kind: 'audio' | 'video' | 'screen') => p2p.groupCallStart(groupId, kind), []);
  const groupCallJoinById = useCallback((groupId: string) => p2p.groupCallJoin(groupId), []);
  const groupCallLeaveCall = useCallback((groupId?: string) => p2p.groupCallLeave(groupId), []);
  const groupCallToggleCamera = useCallback(() => p2p.groupCallToggleCamera(), []);
  const groupCallToggleScreen = useCallback(() => p2p.groupCallToggleScreen(), []);
  const geoStartDisc = useCallback(() => p2p.geoStart(), []);
  const geoStopDisc = useCallback(() => p2p.geoStop(), []);
  const geoRefresh = useCallback(() => p2p.geoRefresh(), []);
  const setOfflineMode = useCallback((offline: boolean) => {
    p2p.setOfflineMode(offline);
    setOfflineModeState(offline);
    if (offline) setNamespaceOfflineState(true);
    else setNamespaceOfflineState(false);
  }, []);
  const setNamespaceOffline = useCallback((offline: boolean) => {
    p2p.setNamespaceOffline(offline);
    setNamespaceOfflineState(offline);
  }, []);

  return {
    status,
    peers,
    registry,
    chats,
    logs,
    unreadCounts,
    groupUnreadCounts,
    offlineMode,
    namespaceOffline,
    customNamespaces,
    groups,
    activeGroupCall,
    groupCallRemoteStreams,
    geoActive,
    geoRefreshing,
    nearbyPeers,
    geoDebug,
    geoLat,
    geoLng,
    queueState,
    markRead,
    markGroupRead,
    init,
    connect,
    sendMessage,
    sendFile,
    startCall,
    pingContact,
    deleteContact,
    editMessage,
    deleteMessage,
    retryMessage,
    updateName,
    acceptIncoming,
    joinCustomNS,
    leaveCustomNS,
    toggleCustomNSOffline,
    groupCreate,
    groupJoinById,
    groupJoinBySlug,
    groupLeaveById,
    groupSendMsg,
    groupEditMsg,
    groupDeleteMsg,
    groupRetryMsg,
    groupSendFile,
    groupInviteContact,
    groupKickMember,
    groupCallStart,
    groupCallJoinById,
    groupCallLeaveCall,
    groupCallToggleCamera,
    groupCallToggleScreen,
    geoStartDisc,
    geoStopDisc,
    geoRefresh,
    setOfflineMode,
    setNamespaceOffline,
    p2p,
  };
}
