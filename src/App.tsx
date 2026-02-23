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
import { p2p } from './lib/p2p';
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
    offlineMode,
    namespaceOffline,
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
    customNamespaces,
    setOfflineMode,
    setNamespaceOffline,
  } = useP2P();

  const [activeChat, setActiveChat] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showShare, setShowShare] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [showNamespaceInfo, setShowNamespaceInfo] = useState(false);
  const [customNSInfoSlug, setCustomNSInfoSlug] = useState<string | null>(null);
  const [setupNeeded, setSetupNeeded] = useState(!localStorage.getItem('myapp-name'));
  const [contactModalPid, setContactModalPid] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const [connRequest, setConnRequest] = useState<{ fname: string; publicKey?: string; fingerprint?: string; verified?: boolean; accept: () => void; reject: () => void; saveForLater: () => void } | null>(null);
  const [pendingConnectPID] = useState<string | null>(() => {
    try { return new URL(window.location.href).searchParams.get('connect'); } catch { return null; }
  });
  const [incomingCall, setIncomingCall] = useState<{ call: any; fname: string; kind: string } | null>(null);
  const [callingState, setCallingState] = useState<{ fname: string; kind: 'audio' | 'video' | 'screen'; call: any; stream: MediaStream; cameraStream?: MediaStream } | null>(null);
  const [activeCall, setActiveCall] = useState<{ stream: MediaStream; localStream?: MediaStream; cameraStream?: MediaStream; fname: string; kind: string; call: any } | null>(null);

  const logEndRef = useRef<HTMLDivElement>(null);
  const stopIncomingRing = useRef<(() => void) | null>(null);
  const stopOutgoingRing = useRef<(() => void) | null>(null);
  const activeChatRef = useRef<string | null>(null);

  // Keep activeChatRef in sync so event handlers can read current value
  useEffect(() => { activeChatRef.current = activeChat; }, [activeChat]);

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

  // ── Incoming connection request sound ──────────────────────────────────────
  useEffect(() => {
    if (connRequest) {
      playRequestChime();
      navigator.vibrate?.([200, 100, 200]);
    }
  }, [connRequest]);

  useEffect(() => {
    const onRequest = (e: any) => setConnRequest(e.detail);
    const onIncomingCall = (e: any) => setIncomingCall(e.detail);
    p2p.addEventListener('connection-request', onRequest);
    p2p.addEventListener('incoming-call', onIncomingCall);
    return () => {
      p2p.removeEventListener('connection-request', onRequest);
      p2p.removeEventListener('incoming-call', onIncomingCall);
    };
  }, []);

  useEffect(() => {
    const name = localStorage.getItem('myapp-name');
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

  const handleJoin = (name: string) => {
    setSetupNeeded(false);
    init(name);
  };

  const handleSelectChat = useCallback((pid: string) => {
    setActiveChat(pid);
    setToasts(prev => prev.filter(t => t.pid !== pid));
    window.history.pushState({ chat: pid }, '', `?chat=${pid}`);
  }, []);

  const handleBack = useCallback(() => {
    setActiveChat(null);
    setSidebarOpen(true);
    if (window.history.state?.chat) {
      window.history.back();
    }
  }, []);

  const handleCall = async (kind: 'audio' | 'video' | 'screen') => {
    if (!activeChat) return;
    const fname = peers[activeChat]?.friendlyName || activeChat;
    try {
      const { call, stream, cameraStream } = await startCall(activeChat, kind);
      setCallingState({ fname, kind, call, stream, cameraStream });

      call.on('stream', (remoteStream: MediaStream) => {
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
        setCallingState(null);
        setActiveCall(null);
        stream.getTracks().forEach((t: MediaStreamTrack) => t.stop());
        cameraStream?.getTracks().forEach((t: MediaStreamTrack) => t.stop());
      });
    } catch (e: any) {
      setCallingState(null);
      if (e?.message) {
        // Surface the error visually — for now use the log panel (already shown at bottom)
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
    try {
      let localStream: MediaStream | undefined;
      if (kind !== 'screen') {
        localStream = await navigator.mediaDevices.getUserMedia(
          kind === 'audio' ? { audio: true } : { audio: true, video: true }
        );
      }
      call.answer(localStream);
      call.on('stream', (remoteStream: MediaStream) => {
        setActiveCall({ stream: remoteStream, localStream, fname, kind, call });
        setIncomingCall(null);
      });
      call.on('close', () => {
        setActiveCall(null);
        if (localStream) localStream.getTracks().forEach((t: MediaStreamTrack) => t.stop());
      });
    } catch (e) {
      console.error('Failed to answer call', e);
      call.close();
      setIncomingCall(null);
    }
  };

  const rejectCall = () => {
    if (incomingCall) { incomingCall.call.close(); setIncomingCall(null); }
  };

  const endCall = () => {
    if (activeCall) {
      activeCall.call.close();
      activeCall.localStream?.getTracks().forEach((t: MediaStreamTrack) => t.stop());
      activeCall.cameraStream?.getTracks().forEach((t: MediaStreamTrack) => t.stop());
      setActiveCall(null);
    }
  };

  if (setupNeeded) {
    return <SetupModal onJoin={handleJoin} />;
  }

  return (
    <div className="flex h-screen bg-gray-950 text-gray-200 font-sans overflow-hidden flex-col">

      {/* Main content: sidebar + chat */}
      <div className="flex flex-1 overflow-hidden min-h-0">
        <Sidebar
          myName={localStorage.getItem('myapp-name') || status.pid}
          myPid={status.pid}
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
          activeChat={activeChat}
          sidebarOpen={sidebarOpen}
          onSelectChat={handleSelectChat}
          onConnect={(did, fname) => connect(did, fname)}
          onAddContact={() => setShowConnect(true)}
          onShowContactInfo={(pid) => setContactModalPid(pid)}
          onShowProfile={() => setShowProfile(true)}
          onAcceptIncoming={(pid) => acceptIncoming(pid)}
          onDismissPending={(pid) => { deleteContact(pid); if (activeChat === pid) setActiveChat(null); }}
          customNamespaces={customNamespaces}
          onJoinCustomNS={joinCustomNS}
          onToggleCustomNSOffline={toggleCustomNSOffline}
          onShowCustomNSInfo={(slug) => setCustomNSInfoSlug(slug)}
        />

        <div className={clsx('flex-1 flex flex-col min-w-0', !activeChat && sidebarOpen ? 'hidden md:flex' : 'flex')}>
          {activeChat ? (
            <ChatArea
              pid={activeChat}
              friendlyName={peers[activeChat]?.friendlyName || activeChat}
              messages={chats[activeChat] || []}
              onSendMessage={(content) => sendMessage(activeChat, content)}
              onSendFile={(file) => sendFile(activeChat, file)}
              onCall={handleCall}
              onBack={handleBack}
              onContactInfo={() => setContactModalPid(activeChat)}
              onEditMessage={(id, content) => editMessage(activeChat, id, content)}
              onDeleteMessage={(id) => deleteMessage(activeChat, id)}
              onRetryMessage={(id) => retryMessage(activeChat, id)}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-gray-600 flex-col gap-3">
              <div className="text-4xl">💬</div>
              <div className="text-sm">Select a contact to chat</div>
            </div>
          )}
        </div>
      </div>

      {/* Log panel */}
      <div className="shrink-0 h-24 border-t border-gray-800 bg-black overflow-y-auto">
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

      {/* Build badge */}
      <div className="fixed bottom-2 right-2 z-[200] bg-gray-800 border border-gray-700 text-gray-500 text-[10px] font-mono px-1.5 py-0.5 rounded pointer-events-none select-none">
        #{BUILD}
      </div>

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
      {contactModalPid && peers[contactModalPid] && (
        <ContactModal
          pid={contactModalPid}
          contact={peers[contactModalPid]}
          onClose={() => setContactModalPid(null)}
          onPing={(pid) => pingContact(pid)}
          onChat={(pid) => { setContactModalPid(null); handleSelectChat(pid); }}
          onDelete={(pid) => { deleteContact(pid); if (activeChat === pid) setActiveChat(null); }}
        />
      )}

      {showShare && <ShareModal pid={status.pid} onClose={() => setShowShare(false)} />}

      {showProfile && (
        <ProfileModal
          name={localStorage.getItem('myapp-name') || status.pid}
          pid={status.pid}
          publicKey={p2p.publicKeyStr}
          fingerprint={status.pubkeyFingerprint}
          signalingState={status.signalingState}
          lastSignalingTs={status.lastSignalingTs}
          persConnected={status.persConnected}
          signalingServer={p2p.signalingServer}
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
          onClose={() => setShowNamespaceInfo(false)}
        />
      )}

      {customNSInfoSlug && customNamespaces[customNSInfoSlug] && (() => {
        const ns = customNamespaces[customNSInfoSlug];
        const myEntry = (Object.values(ns.registry) as any[]).find(r => r.isMe);
        return (
          <NamespaceModal
            namespaceName={ns.name}
            role={ns.isRouter ? `Router L${ns.level}` : `Peer L${ns.level}`}
            ip={ns.slug}
            routerEndpoint={`myapp-ns-${ns.slug}-${ns.level || 1}`}
            discID={myEntry?.discoveryID || ''}
            namespaceLevel={ns.level}
            isRouter={ns.isRouter}
            registry={ns.registry}
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
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-800 p-5 rounded-xl w-full max-w-sm shadow-2xl">
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
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-800 p-6 rounded-xl w-80 shadow-2xl">
            <h3 className="text-lg font-semibold text-gray-200 mb-1">Incoming Call</h3>
            <p className="text-gray-400 text-sm mb-6">
              <span className="text-white font-semibold">{incomingCall.fname}</span> is calling ({incomingCall.kind}).
            </p>
            <div className="flex gap-3">
              <button onClick={answerCall} className="flex-1 bg-green-600 hover:bg-green-700 text-white font-semibold py-2 rounded text-sm">Answer</button>
              <button onClick={rejectCall} className="flex-1 bg-red-600 hover:bg-red-700 text-white font-semibold py-2 rounded text-sm">Reject</button>
            </div>
          </div>
        </div>
      )}

      {callingState && (
        <CallingOverlay
          fname={callingState.fname}
          kind={callingState.kind}
          onCancel={cancelCall}
        />
      )}

      {activeCall && (
        <MediaOverlay
          stream={activeCall.stream}
          localStream={activeCall.localStream}
          cameraStream={activeCall.cameraStream}
          fname={activeCall.fname}
          kind={activeCall.kind}
          onEnd={endCall}
        />
      )}
    </div>
  );
}
