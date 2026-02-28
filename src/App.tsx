import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useP2P } from './hooks/useP2P';
import { Sidebar } from './components/Sidebar';
import { ChatArea } from './components/ChatArea';
import { ContactModal } from './components/ContactModal';
import { SetupModal } from './components/SetupModal';
import { ShareModal } from './components/ShareModal';
import { ConnectModal } from './components/ConnectModal';
import { MediaOverlay } from './components/MediaOverlay';
import { CallingOverlay } from './components/CallingOverlay';
import { NamespaceModal } from './components/NamespaceModal';
import { ProfileModal } from './components/ProfileModal';
import { LearnMore } from './components/LearnMore';
import { GroupChat } from './components/GroupChat';
import { GroupCreateModal } from './components/GroupCreateModal';
import { GroupInfoModal } from './components/GroupInfoModal';
import { GroupCallOverlay } from './components/GroupCallOverlay';
import { p2p } from './lib/p2p';
import { APP_PREFIX, APP_NAME } from './lib/types';
import { BUILD } from './lib/version';
import { clsx } from 'clsx';

// ── Simple Web Audio ringtones ────────────────────────────────────────────────

function playTone(ctx: AudioContext, freq: number, duration: number, gain = 0.3) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.connect(g);
  g.connect(ctx.destination);
  osc.frequency.value = freq;
  g.gain.setValueAtTime(gain, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + duration);
}

function startRinging(interval: number, pattern: () => void): () => void {
  pattern();
  const id = setInterval(pattern, interval);
  return () => clearInterval(id);
}

let _audioCtx: AudioContext | null = null;
function getAudioCtx() {
  if (!_audioCtx) _audioCtx = new AudioContext();
  if (_audioCtx.state === 'suspended') _audioCtx.resume();
  return _audioCtx;
}

function ringOutgoing() {
  const ctx = getAudioCtx();
  playTone(ctx, 440, 0.4);
  setTimeout(() => playTone(ctx, 440, 0.4), 500);
}

function ringIncoming() {
  const ctx = getAudioCtx();
  playTone(ctx, 880, 0.2);
  setTimeout(() => playTone(ctx, 660, 0.2), 250);
  setTimeout(() => playTone(ctx, 880, 0.2), 500);
}

function playMessagePing() {
  const ctx = getAudioCtx();
  playTone(ctx, 1047, 0.12, 0.15); // C6, soft
}

function playRequestChime() {
  const ctx = getAudioCtx();
  playTone(ctx, 523, 0.15, 0.25);  // C5
  setTimeout(() => playTone(ctx, 659, 0.15, 0.25), 180);  // E5
  setTimeout(() => playTone(ctx, 784, 0.25, 0.35), 360);  // G5
}

// ── Toast types ───────────────────────────────────────────────────────────────

interface Toast {
  id: string;
  pid: string;
  fname: string;
  preview: string;
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const {
    status,
    peers,
    registry,
    chats,
    logs,
    unreadCounts,
    groupUnreadCounts,
    offlineMode,
    namespaceOffline,
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
    customNamespaces,
    groups,
    geoActive,
    geoRefreshing,
    nearbyPeers,
    geoDebug,
    geoLat,
    geoLng,
    queueState,
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
    activeGroupCall,
    groupCallRemoteStreams,
    geoStartDisc,
    geoStopDisc,
    geoRefresh,
    setOfflineMode,
    setNamespaceOffline,
    p2p,
  } = useP2P();

  const [activeChat, setActiveChat] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showShare, setShowShare] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [showNamespaceInfo, setShowNamespaceInfo] = useState(false);
  const [customNSInfoSlug, setCustomNSInfoSlug] = useState<string | null>(null);
  const [setupNeeded, setSetupNeeded] = useState(!localStorage.getItem(`${APP_PREFIX}-name`));
  const [contactModalKey, setContactModalKey] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [showLearnMore, setShowLearnMore] = useState(false);
  const [activeGroupChat, setActiveGroupChat] = useState<string | null>(null);
  const [showGroupCreate, setShowGroupCreate] = useState(false);
  const [groupInfoId, setGroupInfoId] = useState<string | null>(null);
  const [groupInviteData, setGroupInviteData] = useState<{ groupId: string; groupName: string; inviterName: string; info: any } | null>(null);
  const [groupCallMinimized, setGroupCallMinimized] = useState(false);
  const [groupCallDuration, setGroupCallDuration] = useState(0);
  const [incomingGroupCall, setIncomingGroupCall] = useState<{ groupId: string; groupName: string; callInfo: any } | null>(null);

  const [contactPubkeyFP, setContactPubkeyFP] = useState<string | null>(null);
  const [connRequest, setConnRequest] = useState<{ fname: string; publicKey?: string; fingerprint?: string; verified?: boolean; accept: () => void; reject: () => void; saveForLater: () => void } | null>(null);
  const [pendingConnectPID] = useState<string | null>(() => {
    try { return new URL(window.location.href).searchParams.get('connect'); } catch { return null; }
  });
  const [incomingCall, setIncomingCall] = useState<{ call: any; fname: string; kind: string } | null>(null);
  const [callingState, setCallingState] = useState<{ fname: string; kind: 'audio' | 'video' | 'screen'; call: any; stream: MediaStream; cameraStream?: MediaStream } | null>(null);
  const [activeCall, setActiveCall] = useState<{ stream: MediaStream; localStream?: MediaStream; cameraStream?: MediaStream; fname: string; kind: string; call: any } | null>(null);
  const [callMinimized, setCallMinimized] = useState(false);
  const [callDuration, setCallDuration] = useState(0);
  const [callCountdown, setCallCountdown] = useState(60);
  const [reqCountdown, setReqCountdown] = useState(60);

  const logEndRef = useRef<HTMLDivElement>(null);
  const stopIncomingRing = useRef<(() => void) | null>(null);
  const stopOutgoingRing = useRef<(() => void) | null>(null);
  const activeChatRef = useRef<string | null>(null);
  const persistentAudioRef = useRef<HTMLAudioElement>(null);
  const groupCallAudioRefs = useRef<Map<string, HTMLAudioElement>>(new Map());
  const silentAudioCtxRef = useRef<AudioContext | null>(null);

  // Keep activeChatRef in sync so event handlers can read current value
  useEffect(() => { activeChatRef.current = activeChat; }, [activeChat]);

  // Compute contact's pubkey fingerprint when modal opens
  useEffect(() => {
    if (contactModalKey && peers[contactModalKey]?.publicKey) {
      p2p.computeFingerprint(peers[contactModalKey].publicKey!).then(setContactPubkeyFP);
    } else {
      setContactPubkeyFP(null);
    }
  }, [contactModalKey]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // ── Toast for incoming messages ──────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: any) => {
      const { pid, msg } = e.detail;
      if (!msg || msg.dir !== 'recv' || msg.type === 'file') return;
      if (activeChatRef.current === pid) return; // already viewing this chat
      const fname = p2p.contacts[pid]?.friendlyName || pid;
      const preview = msg.content?.slice(0, 60) || '';
      const toast: Toast = { id: msg.id || crypto.randomUUID(), pid, fname, preview };
      setToasts(prev => [...prev.slice(-4), toast]); // max 5 toasts
      playMessagePing();
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== toast.id)), 5000);
    };
    p2p.addEventListener('message', handler);
    return () => p2p.removeEventListener('message', handler);
  }, []);

  // ── Incoming call ring ───────────────────────────────────────────────────────
  useEffect(() => {
    if (incomingCall) {
      navigator.vibrate?.([400, 200, 400, 200, 400]);
      stopIncomingRing.current = startRinging(3000, ringIncoming);
    } else {
      stopIncomingRing.current?.();
      stopIncomingRing.current = null;
      navigator.vibrate?.(0);
    }
    return () => { stopIncomingRing.current?.(); };
  }, [incomingCall]);

  // ── Outgoing call ring ───────────────────────────────────────────────────────
  useEffect(() => {
    if (callingState) {
      stopOutgoingRing.current = startRinging(3000, ringOutgoing);
    } else {
      stopOutgoingRing.current?.();
      stopOutgoingRing.current = null;
    }
    return () => { stopOutgoingRing.current?.(); };
  }, [callingState]);

  // ── Persistent audio: bind remote stream so audio plays even when minimized ─
  useEffect(() => {
    if (persistentAudioRef.current) {
      persistentAudioRef.current.srcObject = activeCall?.stream ?? null;
    }
  }, [activeCall?.stream]);

  // ── Active call duration timer ──────────────────────────────────────────────
  useEffect(() => {
    if (!activeCall) { setCallDuration(0); setCallMinimized(false); return; }
    setCallDuration(0);
    const t = setInterval(() => setCallDuration(d => d + 1), 1000);
    return () => clearInterval(t);
  }, [activeCall]);

  // ── Auto-decline incoming call after 60s ─────────────────────────────────
  useEffect(() => {
    if (!incomingCall) { setCallCountdown(60); return; }
    setCallCountdown(60);
    const tick = setInterval(() => setCallCountdown(prev => prev - 1), 1000);
    const timeout = setTimeout(() => { rejectCall(); }, 60000);
    return () => { clearInterval(tick); clearTimeout(timeout); };
  }, [incomingCall]);

  // ── Auto-"Later" connection request after 60s ──────────────────────────
  useEffect(() => {
    if (!connRequest) { setReqCountdown(60); return; }
    setReqCountdown(60);
    const tick = setInterval(() => setReqCountdown(prev => prev - 1), 1000);
    const timeout = setTimeout(() => { connRequest.saveForLater(); setConnRequest(null); }, 60000);
    return () => { clearInterval(tick); clearTimeout(timeout); };
  }, [connRequest]);

  // ── Incoming connection request sound ──────────────────────────────────────
  useEffect(() => {
    if (connRequest) {
      playRequestChime();
      navigator.vibrate?.([200, 100, 200]);
    }
  }, [connRequest]);

  // Handle contact migration — redirect activeChat if old key was migrated
  useEffect(() => {
    const handler = (e: any) => {
      const { oldPID, newPID } = e.detail;
      setActiveChat(prev => prev === oldPID ? newPID : prev);
      setContactModalKey(prev => prev === oldPID ? newPID : prev);
    };
    p2p.addEventListener('contact-migrated', handler);
    return () => p2p.removeEventListener('contact-migrated', handler);
  }, []);

  // Handle group invite
  useEffect(() => {
    const handler = (e: any) => {
      setGroupInviteData(e.detail);
    };
    p2p.addEventListener('group-invite', handler);
    return () => p2p.removeEventListener('group-invite', handler);
  }, []);

  // Handle incoming group call notification
  useEffect(() => {
    const handler = (e: any) => {
      // Don't show if we're already in a 1:1 call or group call
      if (activeCall || activeGroupCall) return;
      setIncomingGroupCall(e.detail);
    };
    p2p.addEventListener('group-call-incoming', handler);
    return () => p2p.removeEventListener('group-call-incoming', handler);
  }, [activeCall, activeGroupCall]);

  // Group call duration timer
  useEffect(() => {
    if (!activeGroupCall) { setGroupCallDuration(0); setGroupCallMinimized(false); return; }
    setGroupCallDuration(0);
    const t = setInterval(() => setGroupCallDuration(d => d + 1), 1000);
    return () => clearInterval(t);
  }, [activeGroupCall]);

  // Handle SW notification tap — open the relevant chat
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'open-chat') {
        setActiveChat(event.data.chat);
      }
    };
    navigator.serviceWorker?.addEventListener('message', handler);
    return () => navigator.serviceWorker?.removeEventListener('message', handler);
  }, []);

  useEffect(() => {
    const onRequest = (e: any) => setConnRequest(e.detail);
    // call-notify: reliable DataConnection-based pre-call alert.
    // Fires before the PeerJS MediaConnection arrives; starts ringing early.
    const onCallNotify = (e: any) => {
      const { contactKey, kind, fname } = e.detail;
      // Only set if we don't already have an active incoming call
      setIncomingCall(prev => prev ? prev : { call: null, fname, kind });
    };
    const onIncomingCall = (e: any) => {
      const { call, fname, kind } = e.detail;
      // Replace any pre-call notify state with the real MediaConnection
      setIncomingCall({ call, fname, kind });
      const callCK = p2p.contactKeyForPID(call.peer);
      // Detect missed call: caller hangs up before we answer/reject
      const missedHandler = () => {
        setIncomingCall(prev => {
          if (prev && prev.call === call) {
            p2p.addCallLog(callCK, 'recv', kind as 'audio' | 'video' | 'screen', 'missed');
            p2p.notify(`Missed ${kind} call`, `You missed a call from ${fname}`, `missed-${callCK}`);
            return null;
          }
          return prev;
        });
      };
      call.on('close', missedHandler);
    };
    p2p.addEventListener('connection-request', onRequest);
    p2p.addEventListener('call-notify', onCallNotify);
    p2p.addEventListener('incoming-call', onIncomingCall);
    return () => {
      p2p.removeEventListener('connection-request', onRequest);
      p2p.removeEventListener('call-notify', onCallNotify);
      p2p.removeEventListener('incoming-call', onIncomingCall);
    };
  }, []);

  useEffect(() => {
    const name = localStorage.getItem(`${APP_PREFIX}-name`);
    if (name) {
      setSetupNeeded(false);
      init(name);
    }
  }, [init]);

  // Auto-connect from share link (?connect=PID)
  useEffect(() => {
    if (!pendingConnectPID || setupNeeded || !status.pid) return;
    if (peers[pendingConnectPID]) return; // already a contact
    if (pendingConnectPID === status.pid) return; // self
    connect(pendingConnectPID, 'Unknown');
    // Clean up the URL
    const url = new URL(window.location.href);
    url.searchParams.delete('connect');
    window.history.replaceState({}, '', url.toString());
  }, [pendingConnectPID, setupNeeded, status.pid, peers, connect]);

  // Browser back button support
  useEffect(() => {
    const onPopState = (e: PopStateEvent) => {
      if (e.state?.chat) {
        setActiveChat(e.state.chat);
        if (window.innerWidth < 768) setSidebarOpen(false);
      } else {
        setActiveChat(null);
        setSidebarOpen(true);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (activeChat) {
      markRead(activeChat);
      if (window.innerWidth < 768) setSidebarOpen(false);
    }
  }, [activeChat, markRead]);

  useEffect(() => {
    if (activeGroupChat) markGroupRead(activeGroupChat);
  }, [activeGroupChat, markGroupRead]);

  // Mark group read when new messages arrive while viewing
  useEffect(() => {
    if (activeGroupChat && groups[activeGroupChat]) {
      markGroupRead(activeGroupChat);
    }
  }, [activeGroupChat, groups, markGroupRead]);

  const handleJoin = (name: string) => {
    setSetupNeeded(false);
    init(name);
  };

  const handleSelectChat = useCallback((pid: string) => {
    setActiveChat(pid);
    setActiveGroupChat(null);
    setToasts(prev => prev.filter(t => t.pid !== pid));
    window.history.pushState({ chat: pid }, '', `?chat=${pid}`);
  }, []);

  const handleSelectGroupChat = useCallback((groupId: string) => {
    setActiveGroupChat(groupId);
    setActiveChat(null);
    if (window.innerWidth < 768) setSidebarOpen(false);
  }, []);

  const handleBack = useCallback(() => {
    setActiveChat(null);
    setSidebarOpen(true);
    if (window.history.state?.chat) {
      window.history.back();
    }
  }, []);

  // Refs to track call timing for call log duration
  const outCallStartRef = useRef<number>(0);
  const outCallAnsweredRef = useRef<boolean>(false);
  const outCallRejectedRef = useRef<boolean>(false);
  const outCallReceivedRef = useRef<boolean>(false);
  const outCallPidRef = useRef<string | null>(null);
  const outCallKindRef = useRef<'audio' | 'video' | 'screen'>('audio');
  const inCallStartRef = useRef<number>(0);
  const inCallPidRef = useRef<string | null>(null);
  const inCallKindRef = useRef<'audio' | 'video' | 'screen'>('audio');
  const [peerUnreachable, setPeerUnreachable] = useState(false);

  const handleGroupCall = async (groupId: string, kind: 'audio' | 'video' | 'screen') => {
    if (activeCall) return; // mutual exclusion: can't start group call during 1:1 call
    await groupCallStart(groupId, kind);
  };

  const handleGroupCallJoin = async (groupId: string) => {
    if (activeCall) return; // mutual exclusion
    await groupCallJoinById(groupId);
    setIncomingGroupCall(null);
  };

  const handleGroupCallLeave = () => {
    groupCallLeaveCall();
  };

  const handleCall = async (kind: 'audio' | 'video' | 'screen') => {
    if (!activeChat) return;
    if (activeGroupCall) return; // mutual exclusion: can't start 1:1 call during group call
    const fname = peers[activeChat]?.friendlyName || activeChat;
    const callCK = activeChat; // contact key (fingerprint)
    try {
      const { call, stream, cameraStream } = await startCall(activeChat, kind);
      setCallingState({ fname, kind, call, stream, cameraStream });
      outCallAnsweredRef.current = false;
      outCallRejectedRef.current = false;
      outCallReceivedRef.current = false;
      outCallPidRef.current = callCK;
      outCallKindRef.current = kind;
      setPeerUnreachable(false);

      // 10s timer: if no call-received ACK, show warning
      const ackTimer = setTimeout(() => {
        if (!outCallReceivedRef.current && !outCallAnsweredRef.current) {
          setPeerUnreachable(true);
        }
      }, 10000);

      // Listen for call ACK events
      const onCallReceived = (e: any) => {
        if (e.detail.contactKey === callCK) {
          outCallReceivedRef.current = true;
          clearTimeout(ackTimer);
          setPeerUnreachable(false);
        }
      };
      const onCallRejected = (e: any) => {
        if (e.detail.contactKey === callCK) outCallRejectedRef.current = true;
      };
      const onCallAnswered = (e: any) => {
        // Fallback for screen share: if stream event hasn't fired after 2s, transition UI
        if (e.detail.contactKey === callCK && kind === 'screen') {
          outCallReceivedRef.current = true;
          clearTimeout(ackTimer);
          setPeerUnreachable(false);
          setTimeout(() => {
            if (!outCallAnsweredRef.current) {
              outCallAnsweredRef.current = true;
              outCallStartRef.current = Date.now();
              stopOutgoingRing.current?.();
              setCallingState(null);
              setActiveCall({ stream: new MediaStream(), localStream: stream, cameraStream, fname, kind, call });
            }
          }, 2000);
        }
      };
      // peer-unavailable: PeerJS can't find the target on the signaling server
      const targetPID = p2p.contacts[callCK]?.currentPID || callCK;
      const onPeerUnavail = (e: any) => {
        if (e.detail.peer === targetPID) {
          clearTimeout(ackTimer);
          setPeerUnreachable(true);
        }
      };
      p2p.addEventListener('call-received', onCallReceived);
      p2p.addEventListener('call-rejected', onCallRejected);
      p2p.addEventListener('call-answered', onCallAnswered);
      p2p.addEventListener('peer-unavailable', onPeerUnavail);

      call.on('error', (err: any) => {
        console.error('PeerJS call error:', err);
        clearTimeout(ackTimer);
        setPeerUnreachable(true);
      });
      call.on('stream', (remoteStream: MediaStream) => {
        outCallAnsweredRef.current = true;
        outCallStartRef.current = Date.now();
        clearTimeout(ackTimer);
        setPeerUnreachable(false);
        stopOutgoingRing.current?.();
        setCallingState(null);
        setActiveCall({
          stream: remoteStream,
          localStream: kind === 'screen' ? undefined : stream,
          cameraStream: kind === 'screen' ? cameraStream : undefined,
          fname,
          kind,
          call,
        });
      });
      call.on('close', () => {
        clearTimeout(ackTimer);
        setPeerUnreachable(false);
        p2p.removeEventListener('call-received', onCallReceived);
        p2p.removeEventListener('call-rejected', onCallRejected);
        p2p.removeEventListener('call-answered', onCallAnswered);
        p2p.removeEventListener('peer-unavailable', onPeerUnavail);
        if (outCallAnsweredRef.current && outCallStartRef.current) {
          const duration = Math.floor((Date.now() - outCallStartRef.current) / 1000);
          p2p.addCallLog(callCK, 'sent', kind, 'answered', duration);
        } else if (outCallRejectedRef.current) {
          p2p.addCallLog(callCK, 'sent', kind, 'rejected');
        } else {
          p2p.addCallLog(callCK, 'sent', kind, 'cancelled');
        }
        outCallAnsweredRef.current = false;
        outCallRejectedRef.current = false;
        outCallReceivedRef.current = false;
        outCallStartRef.current = 0;
        setCallingState(null);
        setActiveCall(null);
        stream.getTracks().forEach((t: MediaStreamTrack) => t.stop());
        cameraStream?.getTracks().forEach((t: MediaStreamTrack) => t.stop());
      });
    } catch (e: any) {
      setCallingState(null);
      setPeerUnreachable(false);
      if (e?.message) {
        console.error('Call failed:', e.message);
      }
    }
  };

  const cancelCall = () => {
    if (callingState) {
      callingState.call.close();
      callingState.stream.getTracks().forEach((t: MediaStreamTrack) => t.stop());
      callingState.cameraStream?.getTracks().forEach((t: MediaStreamTrack) => t.stop());
      setCallingState(null);
    }
  };

  const answerCall = async () => {
    if (!incomingCall) return;
    const { call, kind, fname } = incomingCall;
    // call may be null if we only have a call-notify (DataConnection) but no MediaConnection yet
    if (!call) return;
    const callCK = p2p.contactKeyForPID(call.peer);
    try {
      let localStream: MediaStream | undefined;
      if (kind === 'screen') {
        // Screen share: answer with audio so caller gets a stream event back
        try {
          localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch {
          // Mic unavailable — create a silent audio track so PeerJS fires the stream event on caller
          const ctx = new AudioContext();
          silentAudioCtxRef.current = ctx;
          const oscillator = ctx.createOscillator();
          const dest = ctx.createMediaStreamDestination();
          oscillator.connect(dest);
          oscillator.start();
          const silentTrack = dest.stream.getAudioTracks()[0];
          silentTrack.enabled = false; // muted
          localStream = new MediaStream([silentTrack]);
        }
      } else {
        localStream = await navigator.mediaDevices.getUserMedia(
          kind === 'audio' ? { audio: true } : { audio: true, video: true }
        );
      }
      call.answer(localStream);
      // Send answered ACK via DataConnection so caller knows (Bug 3: screen share UI)
      const ansConn = p2p.contacts[callCK]?.conn;
      if (ansConn?.open) ansConn.send({ type: 'call-answered', kind });
      inCallPidRef.current = callCK;
      inCallKindRef.current = kind as 'audio' | 'video' | 'screen';
      call.on('stream', (remoteStream: MediaStream) => {
        inCallStartRef.current = Date.now();
        setActiveCall({ stream: remoteStream, localStream, fname, kind, call });
        setIncomingCall(null);
      });
      call.on('close', () => {
        if (inCallStartRef.current) {
          const duration = Math.floor((Date.now() - inCallStartRef.current) / 1000);
          p2p.addCallLog(callCK, 'recv', kind as 'audio' | 'video' | 'screen', 'answered', duration);
        }
        inCallStartRef.current = 0;
        setActiveCall(null);
        if (localStream) localStream.getTracks().forEach((t: MediaStreamTrack) => t.stop());
        if (silentAudioCtxRef.current) {
          silentAudioCtxRef.current.close().catch(() => {});
          silentAudioCtxRef.current = null;
        }
      });
    } catch (e) {
      console.error('Failed to answer call', e);
      call.close();
      setIncomingCall(null);
    }
  };

  const rejectCall = () => {
    if (incomingCall) {
      if (incomingCall.call) {
        const rejectCK = p2p.contactKeyForPID(incomingCall.call.peer);
        // Send rejection ACK via DataConnection so caller knows
        const conn = p2p.contacts[rejectCK]?.conn;
        if (conn?.open) conn.send({ type: 'call-rejected', kind: incomingCall.kind });
        p2p.addCallLog(rejectCK, 'recv', incomingCall.kind as 'audio' | 'video' | 'screen', 'rejected');
        incomingCall.call.close();
      }
      setIncomingCall(null);
    }
  };

  const endCall = () => {
    if (activeCall) {
      activeCall.call.close();
      activeCall.localStream?.getTracks().forEach((t: MediaStreamTrack) => t.stop());
      activeCall.cameraStream?.getTracks().forEach((t: MediaStreamTrack) => t.stop());
      setActiveCall(null);
    }
    if (silentAudioCtxRef.current) {
      silentAudioCtxRef.current.close().catch(() => {});
      silentAudioCtxRef.current = null;
    }
  };

  if (setupNeeded) {
    return <SetupModal onJoin={handleJoin} pendingConnectPID={pendingConnectPID} />;
  }

  return (
    <div className="flex bg-gray-950 text-gray-200 font-sans overflow-hidden flex-col" style={{ height: '100dvh' }}>

      {/* Minimized call bar */}
      {activeCall && callMinimized && (
        <div className="shrink-0 bg-green-700 px-4 py-2 flex items-center justify-between shadow-lg z-[90]">
          <div className="flex items-center gap-2 text-white text-sm">
            <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
            In call with <span className="font-semibold">{activeCall.fname}</span>
            <span className="font-mono text-green-200 text-xs ml-1">
              {Math.floor(callDuration / 60).toString().padStart(2, '0')}:{(callDuration % 60).toString().padStart(2, '0')}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setCallMinimized(false)}
              className="text-white text-xs bg-green-800 hover:bg-green-900 px-3 py-1 rounded transition-colors"
            >
              Expand
            </button>
            <button
              onClick={endCall}
              className="text-white text-xs bg-red-600 hover:bg-red-700 px-3 py-1 rounded transition-colors"
            >
              End
            </button>
          </div>
        </div>
      )}

      {/* Minimized group call bar */}
      {activeGroupCall && groupCallMinimized && (
        <div className="shrink-0 bg-purple-700 px-4 py-2 flex items-center justify-between shadow-lg z-[90]">
          <div className="flex items-center gap-2 text-white text-sm">
            <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
            Group call: <span className="font-semibold">{activeGroupCall.groupName}</span>
            <span className="font-mono text-purple-200 text-xs ml-1">
              {Math.floor(groupCallDuration / 60).toString().padStart(2, '0')}:{(groupCallDuration % 60).toString().padStart(2, '0')}
            </span>
            <span className="text-purple-300 text-xs">({Object.keys(activeGroupCall.info.participants).length})</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setGroupCallMinimized(false)}
              className="text-white text-xs bg-purple-800 hover:bg-purple-900 px-3 py-1 rounded transition-colors"
            >
              Expand
            </button>
            <button
              onClick={handleGroupCallLeave}
              className="text-white text-xs bg-red-600 hover:bg-red-700 px-3 py-1 rounded transition-colors"
            >
              Leave
            </button>
          </div>
        </div>
      )}

      {/* Main content: sidebar + chat */}
      <div className="flex flex-1 overflow-hidden min-h-0">
        <Sidebar
          myName={localStorage.getItem(`${APP_PREFIX}-name`) || status.pid}
          myPid={status.pid}
          myPidHistory={status.pidHistory}
          myFingerprint={status.pubkeyFingerprint}
          persConnected={status.persConnected}
          offlineMode={offlineMode}
          onShare={() => setShowShare(true)}
          onToggleOffline={() => setOfflineMode(!offlineMode)}
          signalingState={status.signalingState}
          lastSignalingTs={status.lastSignalingTs}
          reconnectAttempt={status.reconnectAttempt}
          networkRole={status.role}
          networkIP={status.ip}
          networkDiscID={status.did}
          namespaceLevel={status.namespaceLevel}
          isRouter={status.role.startsWith('Router')}
          namespaceOffline={namespaceOffline}
          onToggleNamespace={() => setNamespaceOffline(!namespaceOffline)}
          onShowNamespaceInfo={() => setShowNamespaceInfo(true)}
          peers={peers}
          registry={registry}
          chats={chats}
          unreadCounts={unreadCounts}
          groupUnreadCounts={groupUnreadCounts}
          activeChat={activeChat}
          sidebarOpen={sidebarOpen}
          onSelectChat={handleSelectChat}
          onConnect={(did, fname) => connect(did, fname)}
          onAddContact={() => setShowConnect(true)}
          onShowContactInfo={(pid) => setContactModalKey(pid)}
          onShowProfile={() => setShowProfile(true)}
          onAcceptIncoming={(key) => acceptIncoming(key)}
          onDismissPending={(key) => { deleteContact(key); if (activeChat === key) setActiveChat(null); }}
          customNamespaces={customNamespaces}
          onJoinCustomNS={joinCustomNS}
          onToggleCustomNSOffline={toggleCustomNSOffline}
          onShowCustomNSInfo={(slug) => setCustomNSInfoSlug(slug)}
          groups={groups}
          activeGroupChat={activeGroupChat}
          onSelectGroupChat={handleSelectGroupChat}
          onCreateGroup={() => setShowGroupCreate(true)}
          onShowGroupInfo={(id) => setGroupInfoId(id)}
          geoActive={geoActive}
          geoRefreshing={geoRefreshing}
          nearbyPeers={nearbyPeers}
          geoDebug={geoDebug}
          queueState={queueState}
          geoLat={geoLat}
          geoLng={geoLng}
          onGeoStart={geoStartDisc}
          onGeoStop={geoStopDisc}
          onGeoRefresh={geoRefresh}
          onShowLearnMore={() => setShowLearnMore(true)}
          onToggleLogs={() => setShowLogs(v => !v)}
          showLogs={showLogs}
          buildNumber={BUILD}
        />

        <div className={clsx('flex-1 flex flex-col min-w-0', !activeChat && !activeGroupChat && sidebarOpen ? 'hidden md:flex' : 'flex')}>
          {activeGroupChat && groups[activeGroupChat] ? (
            <GroupChat
              groupId={activeGroupChat}
              info={groups[activeGroupChat].info}
              messages={groups[activeGroupChat].messages}
              myFingerprint={status.pubkeyFingerprint}
              activeCall={groups[activeGroupChat].activeCall}
              inGroupCall={activeGroupCall?.groupId === activeGroupChat}
              onSendMessage={(content) => groupSendMsg(activeGroupChat, content)}
              onSendFile={(file) => groupSendFile(activeGroupChat, file)}
              onEditMessage={(msgId, content) => groupEditMsg(activeGroupChat, msgId, content)}
              onDeleteMessage={(msgId) => groupDeleteMsg(activeGroupChat, msgId)}
              onRetryMessage={(msgId) => groupRetryMsg(activeGroupChat, msgId)}
              onCall={(kind) => handleGroupCall(activeGroupChat, kind)}
              onJoinCall={() => handleGroupCallJoin(activeGroupChat)}
              onBack={() => { setActiveGroupChat(null); setSidebarOpen(true); }}
              onShowInfo={() => setGroupInfoId(activeGroupChat)}
            />
          ) : activeChat ? (
            <ChatArea
              contactKey={activeChat}
              friendlyName={peers[activeChat]?.friendlyName || activeChat}
              fingerprint={peers[activeChat]?.fingerprint || null}
              messages={chats[activeChat] || []}
              onSendMessage={(content) => sendMessage(activeChat, content)}
              onSendFile={(file) => sendFile(activeChat, file)}
              onCall={handleCall}
              onBack={handleBack}
              onContactInfo={() => setContactModalKey(activeChat)}
              onEditMessage={(id, content) => editMessage(activeChat, id, content)}
              onDeleteMessage={(id) => deleteMessage(activeChat, id)}
              onRetryMessage={(id) => retryMessage(activeChat, id)}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-gray-600 flex-col gap-3">
              <div className="text-4xl">💬</div>
              <div className="text-sm">Select a contact or group to chat</div>
            </div>
          )}
        </div>
      </div>

      {/* Log panel — toggled by version badge */}
      {showLogs && (
        <div className="shrink-0 h-32 border-t border-gray-800 bg-black overflow-y-auto anim-slide-up">
          <div className="px-2 py-1 min-h-full">
            {logs.length === 0 ? (
              <div className="text-[11px] text-gray-700 font-mono pt-1">awaiting logs...</div>
            ) : (
              logs.slice(-100).map((l: { msg: string; type: string; ts: number }, i: number) => (
                <div
                  key={i}
                  className={clsx(
                    'text-[11px] font-mono leading-snug',
                    l.type === 'ok'  ? 'text-green-400' :
                    l.type === 'err' ? 'text-red-400'   : 'text-blue-400'
                  )}
                >
                  [{new Date(l.ts).toLocaleTimeString()}] {l.msg}
                </div>
              ))
            )}
            <div ref={logEndRef} />
          </div>
        </div>
      )}


      {showLearnMore && <LearnMore onClose={() => setShowLearnMore(false)} />}

      {/* Toast notifications */}
      <div className="fixed bottom-28 left-2 z-[150] flex flex-col gap-2 pointer-events-none">
        {toasts.map(toast => (
          <div
            key={toast.id}
            onClick={() => { handleSelectChat(toast.pid); setToasts(prev => prev.filter(t => t.id !== toast.id)); }}
            className="pointer-events-auto bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 shadow-xl max-w-[260px] cursor-pointer hover:bg-gray-700 transition-colors animate-in slide-in-from-left-2"
          >
            <div className="text-xs font-semibold text-gray-200 truncate">{toast.fname}</div>
            <div className="text-[11px] text-gray-400 truncate mt-0.5">{toast.preview}</div>
          </div>
        ))}
      </div>

      {/* Contact detail modal */}
      {contactModalKey && peers[contactModalKey] && (
        <ContactModal
          contactKey={contactModalKey}
          contact={peers[contactModalKey]}
          pubkeyFingerprint={contactPubkeyFP}
          sharedKeyFingerprint={p2p.getSharedKeyFingerprint(contactModalKey)}
          rvzStatus={p2p.rvzActive === contactModalKey ? 'active' : p2p.rvzQueue.includes(contactModalKey) ? 'queued' : null}
          p2p={p2p}
          groups={groups}
          onGroupInvite={(gid, ck) => groupInviteContact(gid, ck)}
          onSelectGroupChat={(gid) => { setContactModalKey(null); handleSelectGroupChat(gid); }}
          onClose={() => setContactModalKey(null)}
          onPing={(key) => pingContact(key)}
          onChat={(key) => { setContactModalKey(null); handleSelectChat(key); }}
          onDelete={(key) => { deleteContact(key); if (activeChat === key) setActiveChat(null); }}
        />
      )}

      {showShare && <ShareModal pid={status.pid} fingerprint={status.pubkeyFingerprint} onClose={() => setShowShare(false)} />}

      {showProfile && (
        <ProfileModal
          name={localStorage.getItem(`${APP_PREFIX}-name`) || status.pid}
          pid={status.pid}
          publicKey={p2p.publicKeyStr}
          fingerprint={status.pubkeyFingerprint}
          signalingState={status.signalingState}
          lastSignalingTs={status.lastSignalingTs}
          persConnected={status.persConnected}
          signalingServer={p2p.signalingServer}
          pidHistory={status.pidHistory || []}
          onEditName={updateName}
          onClose={() => setShowProfile(false)}
        />
      )}

      {showNamespaceInfo && (
        <NamespaceModal
          role={status.role}
          ip={status.ip}
          discID={status.did}
          namespaceLevel={status.namespaceLevel}
          isRouter={status.role.startsWith('Router')}
          registry={registry}
          joinStatus={status.joinStatus}
          joinAttempt={status.joinAttempt}
          onClose={() => setShowNamespaceInfo(false)}
        />
      )}

      {customNSInfoSlug && customNamespaces[customNSInfoSlug] && (() => {
        const ns = customNamespaces[customNSInfoSlug];
        const myEntry = (Object.values(ns.registry) as any[]).find(r => r.isMe);
        const endpoint = ns.advanced
          ? `${ns.slug}-${ns.level || 1}`
          : `${APP_PREFIX}-ns-${ns.slug}-${ns.level || 1}`;
        return (
          <NamespaceModal
            namespaceName={ns.name}
            role={ns.isRouter ? `Router L${ns.level}` : `Peer L${ns.level}`}
            ip={ns.slug}
            routerEndpoint={endpoint}
            discID={myEntry?.discoveryID || ''}
            namespaceLevel={ns.level}
            isRouter={ns.isRouter}
            registry={ns.registry}
            advanced={ns.advanced}
            joinStatus={ns.joinStatus}
            joinAttempt={ns.joinAttempt}
            onLeave={() => leaveCustomNS(customNSInfoSlug)}
            onClose={() => setCustomNSInfoSlug(null)}
          />
        );
      })()}

      {showConnect && (
        <ConnectModal
          onConnect={(pid, fname) => connect(pid, fname)}
          onClose={() => setShowConnect(false)}
        />
      )}

      {connRequest && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 anim-fade-in">
          <div className="bg-gray-900 border border-gray-800 p-5 rounded-xl w-full max-w-sm shadow-2xl anim-scale-up">
            <h3 className="text-base font-semibold text-gray-200 mb-3">Incoming Connection Request</h3>
            <div className="mb-4">
              <div className="text-white font-bold text-lg">{connRequest.fname}</div>
              <div className="text-gray-400 text-sm">wants to connect with you</div>
            </div>
            {/* Public key / verification */}
            <div className={`rounded-lg px-3 py-2 mb-4 text-xs ${connRequest.publicKey ? (connRequest.verified ? 'bg-green-900/30 border border-green-800/50' : 'bg-red-900/30 border border-red-800/50') : 'bg-gray-800 border border-gray-700'}`}>
              {connRequest.publicKey ? (
                <>
                  <div className={`font-semibold mb-1 ${connRequest.verified ? 'text-green-400' : 'text-red-400'}`}>
                    {connRequest.verified ? '✓ Identity Verified' : '⚠ Verification Failed'}
                  </div>
                  {connRequest.fingerprint && (
                    <div className="font-mono text-purple-300 text-[10px] break-all">{connRequest.fingerprint}</div>
                  )}
                  {!connRequest.verified && (
                    <div className="text-red-300 mt-1">The signature on this request is invalid. Proceed with caution.</div>
                  )}
                </>
              ) : (
                <div className="text-gray-400">No public key provided — identity unverified</div>
              )}
            </div>
            <div className="text-[10px] text-gray-500 text-center mb-2">
              Auto-saving for later in <span className={clsx('font-mono font-bold', reqCountdown <= 10 ? 'text-orange-400' : 'text-gray-400')}>{reqCountdown}s</span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => { connRequest.accept(); setConnRequest(null); }}
                className="flex-1 bg-green-600 hover:bg-green-700 text-white font-semibold py-2 rounded text-sm"
              >Accept</button>
              <button
                onClick={() => { connRequest.saveForLater(); setConnRequest(null); }}
                className="flex-1 bg-gray-700 hover:bg-gray-600 text-gray-300 font-semibold py-2 rounded text-sm"
                title="Save to contacts — accept later"
              >Later</button>
              <button
                onClick={() => { connRequest.reject(); setConnRequest(null); }}
                className="flex-1 bg-red-900/60 hover:bg-red-900 text-red-300 font-semibold py-2 rounded text-sm"
              >Reject</button>
            </div>
          </div>
        </div>
      )}

      {incomingCall && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 anim-fade-in">
          <div className="bg-gray-900 border border-gray-800 p-6 rounded-xl w-80 shadow-2xl anim-scale-up">
            <h3 className="text-lg font-semibold text-gray-200 mb-1">Incoming Call</h3>
            <p className="text-gray-400 text-sm mb-3">
              <span className="text-white font-semibold">{incomingCall.fname}</span> is calling ({incomingCall.kind}).
            </p>
            {!incomingCall.call && (
              <p className="text-orange-400 text-[11px] mb-2">Connecting… waiting for media channel</p>
            )}
            {/* Countdown bar */}
            <div className="mb-4">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-gray-500">Auto-decline in</span>
                <span className={clsx('text-[11px] font-mono font-bold', callCountdown <= 10 ? 'text-red-400' : 'text-gray-400')}>{callCountdown}s</span>
              </div>
              <div className="w-full h-1 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className={clsx('h-full rounded-full transition-all duration-1000', callCountdown <= 10 ? 'bg-red-500' : 'bg-gray-600')}
                  style={{ width: `${(callCountdown / 60) * 100}%` }}
                />
              </div>
            </div>
            <div className="flex gap-3">
              <button onClick={answerCall} disabled={!incomingCall.call} className={clsx('flex-1 font-semibold py-2 rounded text-sm', incomingCall.call ? 'bg-green-600 hover:bg-green-700 text-white' : 'bg-gray-700 text-gray-500 cursor-not-allowed')}>Answer</button>
              <button onClick={rejectCall} className="flex-1 bg-red-600 hover:bg-red-700 text-white font-semibold py-2 rounded text-sm">Reject</button>
            </div>
          </div>
        </div>
      )}

      {callingState && (
        <CallingOverlay
          fname={callingState.fname}
          kind={callingState.kind}
          peerUnreachable={peerUnreachable}
          onCancel={cancelCall}
        />
      )}

      {/* Group create modal */}
      {showGroupCreate && (
        <GroupCreateModal
          contacts={peers}
          onCreate={(name, slug) => groupCreate(name, slug)}
          onInvite={(gid, ck) => groupInviteContact(gid, ck)}
          onClose={() => setShowGroupCreate(false)}
        />
      )}

      {/* Group info modal */}
      {groupInfoId && groups[groupInfoId] && (
        <GroupInfoModal
          info={groups[groupInfoId].info}
          isRouter={groups[groupInfoId].isRouter}
          level={groups[groupInfoId].level}
          myFingerprint={status.pubkeyFingerprint}
          contacts={peers}
          onLeave={() => { groupLeaveById(groupInfoId); if (activeGroupChat === groupInfoId) setActiveGroupChat(null); }}
          onInvite={(ck) => groupInviteContact(groupInfoId, ck)}
          onKick={(fp) => groupKickMember(groupInfoId, fp)}
          onClose={() => setGroupInfoId(null)}
        />
      )}

      {/* Group invite prompt */}
      {groupInviteData && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 anim-fade-in">
          <div className="bg-gray-900 border border-gray-800 p-5 rounded-xl w-full max-w-sm shadow-2xl anim-scale-up">
            <h3 className="text-base font-semibold text-gray-200 mb-3">Group Invite</h3>
            <p className="text-gray-400 text-sm mb-4">
              <span className="text-white font-semibold">{groupInviteData.inviterName}</span> invited you to join{' '}
              <span className="text-purple-400 font-semibold">{groupInviteData.groupName}</span>
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => { groupJoinById(groupInviteData.groupId, groupInviteData.info); setGroupInviteData(null); }}
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 rounded text-sm"
              >Join</button>
              <button
                onClick={() => setGroupInviteData(null)}
                className="flex-1 bg-gray-700 hover:bg-gray-600 text-gray-300 font-semibold py-2 rounded text-sm"
              >Decline</button>
            </div>
          </div>
        </div>
      )}

      {/* Incoming group call prompt */}
      {incomingGroupCall && !activeGroupCall && !activeCall && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 anim-fade-in">
          <div className="bg-gray-900 border border-gray-800 p-5 rounded-xl w-full max-w-sm shadow-2xl anim-scale-up">
            <h3 className="text-base font-semibold text-gray-200 mb-3">Group Call</h3>
            <p className="text-gray-400 text-sm mb-4">
              <span className="text-purple-400 font-semibold">{incomingGroupCall.groupName}</span> has an active {incomingGroupCall.callInfo?.kind || 'audio'} call
              ({Object.keys(incomingGroupCall.callInfo?.participants || {}).length} participants)
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => { handleGroupCallJoin(incomingGroupCall.groupId); }}
                className="flex-1 bg-green-600 hover:bg-green-700 text-white font-semibold py-2 rounded text-sm"
              >Join</button>
              <button
                onClick={() => setIncomingGroupCall(null)}
                className="flex-1 bg-gray-700 hover:bg-gray-600 text-gray-300 font-semibold py-2 rounded text-sm"
              >Ignore</button>
            </div>
          </div>
        </div>
      )}

      {/* Group call overlay */}
      {activeGroupCall && !groupCallMinimized && (
        <GroupCallOverlay
          groupName={activeGroupCall.groupName}
          callInfo={activeGroupCall.info}
          localStream={p2p.groupCallLocalStream}
          remoteStreams={groupCallRemoteStreams}
          myFingerprint={status.pubkeyFingerprint}
          duration={groupCallDuration}
          onEnd={handleGroupCallLeave}
          onMinimize={() => setGroupCallMinimized(true)}
          onToggleCamera={groupCallToggleCamera}
          onToggleScreen={groupCallToggleScreen}
        />
      )}

      {/* Persistent audio elements for group call remote streams (survive minimize) */}
      {activeGroupCall && Array.from(groupCallRemoteStreams.entries()).map(([fp, stream]) => (
        <audio
          key={`gc-audio-${fp}`}
          autoPlay
          ref={(el) => {
            if (el) { el.srcObject = stream; groupCallAudioRefs.current.set(fp, el); }
          }}
          style={{ display: 'none' }}
        />
      ))}

      {/* Persistent audio element — keeps remote audio playing when call is minimized */}
      {activeCall && (
        <audio ref={persistentAudioRef} autoPlay style={{ display: 'none' }} />
      )}

      {activeCall && !callMinimized && (
        <MediaOverlay
          stream={activeCall.stream}
          localStream={activeCall.localStream}
          cameraStream={activeCall.cameraStream}
          fname={activeCall.fname}
          kind={activeCall.kind}
          duration={callDuration}
          call={activeCall.call}
          onEnd={endCall}
          onMinimize={() => setCallMinimized(true)}
        />
      )}

    </div>
  );
}
