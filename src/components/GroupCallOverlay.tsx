import React, { useEffect, useRef, useState, useCallback } from 'react';
import { PhoneOff, Mic, MicOff, VideoIcon, VideoOff, Minimize2, Users, Maximize2, X, Monitor, MonitorOff } from 'lucide-react';
import { GroupCallInfo } from '../lib/types';
import { clsx } from 'clsx';

interface GroupCallOverlayProps {
  groupName: string;
  callInfo: GroupCallInfo;
  localStream: MediaStream | null;
  remoteStreams: Map<string, MediaStream>;
  myFingerprint: string;
  duration: number;
  onEnd: () => void;
  onMinimize?: () => void;
  onToggleCamera?: () => Promise<boolean>;
  onToggleScreen?: () => Promise<boolean>;
}

// ─── Participant Video Tile ─────────────────────────────────────────────────

const ParticipantTile: React.FC<{
  stream?: MediaStream | null;
  name: string;
  isSelf?: boolean;
  muted?: boolean;
  focused?: boolean;
  onFocus?: () => void;
}> = ({ stream, name, isSelf, muted, focused, onFocus }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hasVideo, setHasVideo] = useState(false);

  // Attach stream and detect video tracks
  useEffect(() => {
    const el = videoRef.current;
    if (!stream || !el) { setHasVideo(false); return; }

    el.srcObject = stream;

    const checkTracks = () => {
      const vt = stream.getVideoTracks();
      setHasVideo(vt.length > 0 && vt.some(t => t.readyState === 'live'));
    };
    checkTracks();

    // loadedmetadata fires when the video element decodes actual frames
    const onMeta = () => setHasVideo(true);
    el.addEventListener('loadedmetadata', onMeta);

    // Listen for tracks being added/removed
    stream.addEventListener('addtrack', checkTracks);
    stream.addEventListener('removetrack', checkTracks);

    // Re-check on addtrack since new video tracks won't have listeners yet
    const onAddTrack = (e: MediaStreamTrackEvent) => {
      checkTracks();
      if (e.track.kind === 'video') {
        e.track.addEventListener('ended', checkTracks);
        e.track.addEventListener('mute', checkTracks);
        e.track.addEventListener('unmute', checkTracks);
      }
    };
    stream.addEventListener('addtrack', onAddTrack);

    // Also listen for individual track state changes on existing tracks
    const tracks = stream.getVideoTracks();
    tracks.forEach(t => {
      t.addEventListener('ended', checkTracks);
      t.addEventListener('mute', checkTracks);
      t.addEventListener('unmute', checkTracks);
    });

    return () => {
      el.removeEventListener('loadedmetadata', onMeta);
      stream.removeEventListener('addtrack', checkTracks);
      stream.removeEventListener('removetrack', checkTracks);
      stream.removeEventListener('addtrack', onAddTrack);
      tracks.forEach(t => {
        t.removeEventListener('ended', checkTracks);
        t.removeEventListener('mute', checkTracks);
        t.removeEventListener('unmute', checkTracks);
      });
    };
  }, [stream]);

  return (
    <div
      className={clsx(
        'relative bg-gray-800 rounded-lg overflow-hidden flex items-center justify-center cursor-pointer group/tile',
        focused ? 'col-span-full row-span-2 aspect-video max-h-[70vh]' : 'aspect-video',
      )}
      onClick={onFocus}
    >
      {/* Always render video element when stream exists so WebRTC can negotiate */}
      {stream && (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isSelf || muted}
          className={clsx('w-full h-full object-contain bg-black', !hasVideo && 'hidden')}
        />
      )}
      {stream && !hasVideo ? (
        /* Has stream but no video tracks — audio-only participant */
        <div className="flex flex-col items-center gap-2">
          <div className="w-14 h-14 rounded-full bg-gray-700 border-2 border-green-500 flex items-center justify-center text-xl font-bold text-green-300 animate-pulse">
            {name.charAt(0).toUpperCase()}
          </div>
        </div>
      ) : !stream ? (
        /* No stream at all — connecting */
        <div className="flex flex-col items-center gap-2">
          <div className="w-14 h-14 rounded-full bg-gray-700 border-2 border-purple-500 flex items-center justify-center text-xl font-bold text-purple-300">
            {name.charAt(0).toUpperCase()}
          </div>
          <span className="text-[10px] text-gray-500">Connecting...</span>
        </div>
      ) : null}
      <div className="absolute bottom-1 left-1 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded">
        {isSelf ? 'You' : name}
      </div>
      {/* Focus/expand hint on hover */}
      {onFocus && !focused && (
        <div className="absolute top-1 right-1 opacity-0 group-hover/tile:opacity-100 transition-opacity">
          <Maximize2 size={12} className="text-white/70" />
        </div>
      )}
    </div>
  );
};

// ─── Main Overlay ───────────────────────────────────────────────────────────

export function GroupCallOverlay({
  groupName,
  callInfo,
  localStream,
  remoteStreams,
  myFingerprint,
  duration,
  onEnd,
  onMinimize,
  onToggleCamera,
  onToggleScreen,
}: GroupCallOverlayProps) {
  const [micMuted, setMicMuted] = useState(false);
  const [camOn, setCamOn] = useState(() => {
    const vt = localStream?.getVideoTracks();
    return vt ? vt.some(t => t.readyState === 'live' && !t.label.toLowerCase().match(/screen|window|tab|monitor/)) : false;
  });
  const [screenOn, setScreenOn] = useState(() => {
    const vt = localStream?.getVideoTracks();
    return vt ? vt.some(t => t.readyState === 'live' && !!t.label.toLowerCase().match(/screen|window|tab|monitor/)) : false;
  });
  const [focusedFP, setFocusedFP] = useState<string | null>(null); // pinned participant
  const canScreenShare = typeof navigator.mediaDevices?.getDisplayMedia === 'function';

  const formatDuration = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  };

  const toggleMic = () => {
    const audioTrack = localStream?.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      setMicMuted(!audioTrack.enabled);
    }
  };

  const toggleCam = async () => {
    if (onToggleCamera) {
      const isOn = await onToggleCamera();
      setCamOn(isOn);
      if (isOn) setScreenOn(false); // camera replaces screen
    }
  };

  const toggleScreen = async () => {
    if (onToggleScreen) {
      const isOn = await onToggleScreen();
      setScreenOn(isOn);
      if (isOn) setCamOn(false); // screen replaces camera
    }
  };

  const handleFocus = useCallback((fp: string | null) => {
    setFocusedFP(prev => prev === fp ? null : fp); // toggle
  }, []);

  // Clear focused participant if they leave
  useEffect(() => {
    if (focusedFP && focusedFP !== 'self' && !remoteStreams.has(focusedFP) && !callInfo.participants[focusedFP]) {
      setFocusedFP(null);
    }
  }, [focusedFP, remoteStreams, callInfo.participants]);

  const participantCount = Object.keys(callInfo.participants).length;
  const remoteCount = remoteStreams.size;
  const hasFocused = focusedFP !== null;

  // Build participant entries for rendering
  const remoteEntries = Array.from(remoteStreams.entries());
  const pendingEntries = Object.entries(callInfo.participants)
    .filter(([fp]) => fp !== myFingerprint && !remoteStreams.has(fp));

  // If someone is focused, show them large with small sidebar thumbnails
  if (hasFocused) {
    const focusedStream = focusedFP === 'self' ? localStream : remoteStreams.get(focusedFP!);
    const focusedName = focusedFP === 'self' ? 'You' : (callInfo.participants[focusedFP!]?.friendlyName || focusedFP!.slice(0, 8));
    const isFocusedSelf = focusedFP === 'self';

    // Thumbnails = everyone except the focused one
    const thumbs: { fp: string; stream?: MediaStream | null; name: string; isSelf: boolean }[] = [];
    if (focusedFP !== 'self') {
      thumbs.push({ fp: 'self', stream: localStream, name: 'You', isSelf: true });
    }
    for (const [fp, stream] of remoteEntries) {
      if (fp === focusedFP) continue;
      const name = callInfo.participants[fp]?.friendlyName || fp.slice(0, 8);
      thumbs.push({ fp, stream, name, isSelf: false });
    }
    for (const [fp, p] of pendingEntries) {
      if (fp === focusedFP) continue;
      thumbs.push({ fp, stream: undefined, name: p.friendlyName, isSelf: false });
    }

    return (
      <div className="fixed inset-0 bg-black/95 z-[100] flex flex-col anim-fade-in">
        {/* Header */}
        <div className="shrink-0 px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-gray-400 text-sm">
            <Users size={14} className="text-purple-400" />
            <span className="text-white font-semibold">{groupName}</span>
            <span className="text-gray-500">({participantCount})</span>
            <span className="text-gray-500 font-mono text-xs ml-2">{formatDuration(duration)}</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setFocusedFP(null)} className="p-2 hover:bg-gray-800 rounded text-gray-400 hover:text-white" title="Exit focus view">
              <X size={18} />
            </button>
            {onMinimize && (
              <button onClick={onMinimize} className="p-2 hover:bg-gray-800 rounded text-gray-400 hover:text-white" title="Minimize">
                <Minimize2 size={18} />
              </button>
            )}
          </div>
        </div>

        {/* Focus layout: large main + thumbnail strip (column on mobile, row on desktop) */}
        <div className="flex-1 flex flex-col md:flex-row gap-2 p-4 overflow-hidden min-h-0">
          {/* Main focused view */}
          <div className="flex-1 flex items-center justify-center min-w-0 min-h-0">
            <ParticipantTile
              stream={focusedStream}
              name={focusedName}
              isSelf={isFocusedSelf}
              focused
              onFocus={() => handleFocus(focusedFP)}
            />
          </div>

          {/* Thumbnail strip — horizontal row on mobile, vertical column on desktop */}
          {thumbs.length > 0 && (
            <div className="shrink-0 flex md:flex-col gap-2 overflow-x-auto md:overflow-x-hidden md:overflow-y-auto md:w-32 h-20 md:h-auto">
              {thumbs.map(t => (
                <div key={t.fp} className="shrink-0 w-28 md:w-full">
                  <ParticipantTile
                    stream={t.stream}
                    name={t.name}
                    isSelf={t.isSelf}
                    onFocus={() => handleFocus(t.fp)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Controls */}
        <CallControls
          micMuted={micMuted}
          camOn={camOn}
          screenOn={screenOn}
          canScreenShare={canScreenShare}
          onToggleMic={toggleMic}
          onToggleCam={toggleCam}
          onToggleScreen={toggleScreen}
          onEnd={onEnd}
        />
      </div>
    );
  }

  // ─── Default grid layout (no focus) ─────────────────────────────────────

  const totalTiles = remoteCount + 1 + pendingEntries.length;
  const gridClass = totalTiles === 1
    ? 'grid-cols-1 max-w-md'
    : totalTiles === 2
    ? 'grid-cols-2 max-w-2xl'
    : totalTiles <= 4
    ? 'grid-cols-2 max-w-3xl'
    : 'grid-cols-3 max-w-4xl';

  return (
    <div className="fixed inset-0 bg-black/95 z-[100] flex flex-col anim-fade-in">
      {/* Header */}
      <div className="shrink-0 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-gray-400 text-sm">
          <Users size={14} className="text-purple-400" />
          <span className="text-white font-semibold">{groupName}</span>
          <span className="text-gray-500">({participantCount})</span>
          <span className="text-gray-500 font-mono text-xs ml-2">{formatDuration(duration)}</span>
        </div>
        <div className="flex items-center gap-2">
          {onMinimize && (
            <button onClick={onMinimize} className="p-2 hover:bg-gray-800 rounded text-gray-400 hover:text-white" title="Minimize">
              <Minimize2 size={18} />
            </button>
          )}
        </div>
      </div>

      {/* Video grid */}
      <div className="flex-1 flex items-center justify-center p-4 overflow-auto">
        <div className={clsx('grid gap-2 w-full mx-auto', gridClass)}>
          {/* Remote participants */}
          {remoteEntries.map(([fp, stream]) => {
            const participant = callInfo.participants[fp];
            return (
              <ParticipantTile
                key={fp}
                stream={stream}
                name={participant?.friendlyName || fp.slice(0, 8)}
                onFocus={() => handleFocus(fp)}
              />
            );
          })}

          {/* Local self tile */}
          <ParticipantTile
            stream={localStream}
            name="You"
            isSelf
            onFocus={() => handleFocus('self')}
          />

          {/* Participants in the call but no stream yet */}
          {pendingEntries.map(([fp, p]) => (
            <ParticipantTile
              key={fp}
              name={p.friendlyName}
              onFocus={() => handleFocus(fp)}
            />
          ))}
        </div>
      </div>

      {/* Controls */}
      <CallControls
        micMuted={micMuted}
        camOn={camOn}
        screenOn={screenOn}
        canScreenShare={canScreenShare}
        onToggleMic={toggleMic}
        onToggleCam={toggleCam}
        onToggleScreen={toggleScreen}
        onEnd={onEnd}
      />
    </div>
  );
}

// ─── Shared control bar ─────────────────────────────────────────────────────

function CallControls({ micMuted, camOn, screenOn, canScreenShare, onToggleMic, onToggleCam, onToggleScreen, onEnd }: {
  micMuted: boolean; camOn: boolean; screenOn: boolean; canScreenShare: boolean;
  onToggleMic: () => void; onToggleCam: () => void; onToggleScreen: () => void; onEnd: () => void;
}) {
  return (
    <div className="shrink-0 flex items-center justify-center gap-3 py-4">
      <button
        onClick={onToggleMic}
        className={clsx(
          'p-3 rounded-full transition-colors',
          micMuted ? 'bg-red-600 hover:bg-red-700 text-white' : 'bg-gray-700 hover:bg-gray-600 text-white'
        )}
        title={micMuted ? 'Unmute' : 'Mute'}
      >
        {micMuted ? <MicOff size={20} /> : <Mic size={20} />}
      </button>

      <button
        onClick={onToggleCam}
        className={clsx(
          'p-3 rounded-full transition-colors',
          camOn ? 'bg-blue-600 hover:bg-blue-700 text-white' : 'bg-gray-700 hover:bg-gray-600 text-white'
        )}
        title={camOn ? 'Turn camera off' : 'Turn camera on'}
      >
        {camOn ? <VideoIcon size={20} /> : <VideoOff size={20} />}
      </button>

      {canScreenShare && (
        <button
          onClick={onToggleScreen}
          className={clsx(
            'p-3 rounded-full transition-colors',
            screenOn ? 'bg-blue-600 hover:bg-blue-700 text-white' : 'bg-gray-700 hover:bg-gray-600 text-white'
          )}
          title={screenOn ? 'Stop screen share' : 'Share screen'}
        >
          {screenOn ? <MonitorOff size={20} /> : <Monitor size={20} />}
        </button>
      )}

      <button
        onClick={onEnd}
        className="px-6 py-3 bg-red-600 hover:bg-red-700 text-white rounded-full font-semibold transition-colors flex items-center gap-2"
      >
        <PhoneOff size={18} /> Leave
      </button>
    </div>
  );
}
