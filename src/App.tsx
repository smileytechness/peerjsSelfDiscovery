import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useP2P } from './hooks/useP2P';
import { Sidebar } from './components/Sidebar';
import { ChatArea } from './components/ChatArea';
import { ContactModal } from './components/ContactModal';
import { SetupModal } from './components/SetupModal';
import { ShareModal } from './components/ShareModal';
import { ConnectModal } from './components/ConnectModal';
import { MediaOverlay } from './components/MediaOverlay';
import { p2p } from './lib/p2p';
import { BUILD } from './lib/version';
import { clsx } from 'clsx';

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
    setOfflineMode,
    setNamespaceOffline,
  } = useP2P();

  const [activeChat, setActiveChat] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showShare, setShowShare] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [setupNeeded, setSetupNeeded] = useState(!localStorage.getItem('myapp-name'));
  const [contactModalPid, setContactModalPid] = useState<string | null>(null);

  const [connRequest, setConnRequest] = useState<{ fname: string; accept: () => void; reject: () => void } | null>(null);
  const [incomingCall, setIncomingCall] = useState<{ call: any; fname: string; kind: string } | null>(null);
  const [activeCall, setActiveCall] = useState<{ stream: MediaStream; localStream?: MediaStream; fname: string; kind: string; call: any } | null>(null);

  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

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

  // Mark read and auto-close sidebar on mobile when chat opens
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
    try {
      const { call, stream } = await startCall(activeChat, kind);
      call.on('stream', (remoteStream: MediaStream) => {
        setActiveCall({
          stream: remoteStream,
          localStream: kind === 'screen' ? undefined : stream,
          fname: peers[activeChat]?.friendlyName || activeChat,
          kind,
          call,
        });
      });
      call.on('close', () => {
        setActiveCall(null);
        stream.getTracks().forEach((t: MediaStreamTrack) => t.stop());
      });
    } catch (e) {
      console.error('Call failed', e);
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
      if (activeCall.localStream) activeCall.localStream.getTracks().forEach((t: MediaStreamTrack) => t.stop());
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
          networkRole={status.role}
          networkIP={status.ip}
          networkDiscID={status.did}
          namespaceLevel={status.namespaceLevel}
          namespaceOffline={namespaceOffline}
          onToggleNamespace={() => setNamespaceOffline(!namespaceOffline)}
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
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-gray-600 flex-col gap-3">
              <div className="text-4xl">💬</div>
              <div className="text-sm">Select a contact to chat</div>
            </div>
          )}
        </div>
      </div>

      {/* Log panel — always visible at bottom */}
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

      {/* Build badge — bottom right */}
      <div className="fixed bottom-2 right-2 z-[200] bg-gray-800 border border-gray-700 text-gray-500 text-[10px] font-mono px-1.5 py-0.5 rounded pointer-events-none select-none">
        #{BUILD}
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

      {showConnect && (
        <ConnectModal
          onConnect={(pid, fname) => connect(pid, fname)}
          onClose={() => setShowConnect(false)}
        />
      )}

      {connRequest && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-800 p-6 rounded-xl w-80 shadow-2xl">
            <h3 className="text-lg font-semibold text-gray-200 mb-2">Connection Request</h3>
            <p className="text-gray-400 text-sm mb-6">
              <span className="text-white font-semibold">{connRequest.fname}</span> wants to connect.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => { connRequest.accept(); setConnRequest(null); }}
                className="flex-1 bg-green-600 hover:bg-green-700 text-white font-semibold py-2 rounded text-sm"
              >Accept</button>
              <button
                onClick={() => { connRequest.reject(); setConnRequest(null); }}
                className="flex-1 bg-gray-700 hover:bg-gray-600 text-gray-300 font-semibold py-2 rounded text-sm"
              >Reject</button>
            </div>
          </div>
        </div>
      )}

      {incomingCall && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-800 p-6 rounded-xl w-80 shadow-2xl">
            <h3 className="text-lg font-semibold text-gray-200 mb-2">Incoming Call</h3>
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

      {activeCall && (
        <MediaOverlay
          stream={activeCall.stream}
          localStream={activeCall.localStream}
          fname={activeCall.fname}
          kind={activeCall.kind}
          onEnd={endCall}
        />
      )}
    </div>
  );
}
