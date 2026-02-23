import { useState, useEffect, useCallback, useMemo } from 'react';
import { p2p } from '../lib/p2p';
import { Contact, ChatMessage, PeerInfo, CustomNS } from '../lib/types';

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
  const [offlineMode, setOfflineModeState] = useState(false);
  const [namespaceOffline, setNamespaceOfflineState] = useState(false);
  const [customNamespaces, setCustomNamespaces] = useState<Record<string, CustomNS>>(() => p2p.customNamespaces);
  const [lastRead, setLastRead] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem('myapp-lastread') || '{}'); } catch { return {}; }
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

    p2p.addEventListener('status-change', onStatus);
    p2p.addEventListener('peer-list-update', onPeerList);
    p2p.addEventListener('message', onMessage);
    p2p.addEventListener('log', onLog);
    p2p.addEventListener('custom-ns-update', onCNS);

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
    };
  }, []);

  const unreadCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    Object.keys(chats).forEach((pid) => {
      const lr = lastRead[pid] || 0;
      counts[pid] = (chats[pid] || []).filter((m: ChatMessage) => m.dir === 'recv' && m.ts > lr).length;
    });
    return counts;
  }, [chats, lastRead]);

  const markRead = useCallback((pid: string) => {
    setLastRead((prev: Record<string, number>) => {
      const next = { ...prev, [pid]: Date.now() };
      localStorage.setItem('myapp-lastread', JSON.stringify(next));
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
  const joinCustomNS = useCallback((name: string) => p2p.joinCustomNamespace(name), []);
  const leaveCustomNS = useCallback((slug: string) => p2p.leaveCustomNamespace(slug), []);
  const toggleCustomNSOffline = useCallback((slug: string, offline: boolean) => p2p.setCustomNSOffline(slug, offline), []);
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
    offlineMode,
    namespaceOffline,
    customNamespaces,
    markRead,
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
    setOfflineMode,
    setNamespaceOffline,
    p2p,
  };
}
