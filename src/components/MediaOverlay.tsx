import React, { useEffect, useRef, useState } from 'react';
import { PhoneOff, Mic, MicOff, VideoIcon, VideoOff, Monitor, MonitorOff, Minimize2, SwitchCamera } from 'lucide-react';
import { clsx } from 'clsx';

interface MediaOverlayProps {
  stream: MediaStream;
  localStream?: MediaStream;
  cameraStream?: MediaStream;
  fname: string;
  kind: string;
  duration: number;
  call: any;
  onEnd: () => void;
  onMinimize?: () => void;
}

export function MediaOverlay({ stream, localStream, cameraStream, fname, kind, duration, call, onEnd, onMinimize }: MediaOverlayProps) {
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const [micMuted, setMicMuted] = useState(false);
  const [camOff, setCamOff] = useState(false);

  useEffect(() => {
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = stream;
    if (localVideoRef.current && localStream) localVideoRef.current.srcObject = localStream;
    if (cameraVideoRef.current && cameraStream) cameraVideoRef.current.srcObject = cameraStream;
  }, [stream, localStream, cameraStream]);

  const formatDuration = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  };

  const toggleMic = () => {
    const audioTrack = localStream?.getAudioTracks()[0] || cameraStream?.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      setMicMuted(!audioTrack.enabled);
    }
  };

  const toggleCam = () => {
    const vidTrack = localStream?.getVideoTracks()[0] || cameraStream?.getVideoTracks()[0];
    if (vidTrack) {
      vidTrack.enabled = !vidTrack.enabled;
      setCamOff(!vidTrack.enabled);
    }
  };

  const switchCamera = async () => {
    const vidTrack = localStream?.getVideoTracks()[0];
    if (!vidTrack) return;
    const settings = vidTrack.getSettings();
    const facingMode = settings.facingMode === 'user' ? 'environment' : 'user';
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode },
        audio: false,
      });
      const newTrack = newStream.getVideoTracks()[0];
      if (localStream) {
        localStream.removeTrack(vidTrack);
        localStream.addTrack(newTrack);
        vidTrack.stop();
      }
      if (localVideoRef.current) localVideoRef.current.srcObject = localStream!;
      // Update the WebRTC sender so the remote peer sees the new camera
      try {
        const pc = call?.peerConnection;
        if (pc) {
          const sender = pc.getSenders().find((s: RTCRtpSender) => s.track?.kind === 'video');
          if (sender) await sender.replaceTrack(newTrack);
        }
      } catch (e) {
        console.error('Failed to replace track on WebRTC sender:', e);
      }
    } catch {}
  };

  const hasVideo = kind === 'video' || kind === 'screen';
  const hasLocalVideo = !!localStream?.getVideoTracks()[0] || !!cameraStream?.getVideoTracks()[0];

  return (
    <div className="fixed inset-0 bg-black/95 z-[100] flex flex-col items-center justify-center anim-fade-in">
      {/* Header */}
      <div className="absolute top-4 left-4 right-4 flex items-center justify-between">
        <div className="text-gray-400 text-sm">
          {kind === 'screen' ? 'Screen share' : 'Call'} with{' '}
          <span className="text-white font-semibold">{fname}</span>
          <span className="text-gray-500 ml-2 font-mono text-xs">{formatDuration(duration)}</span>
        </div>
        {onMinimize && (
          <button
            onClick={onMinimize}
            className="p-2 hover:bg-gray-800 rounded text-gray-400 hover:text-white transition-colors"
            title="Minimize"
          >
            <Minimize2 size={18} />
          </button>
        )}
      </div>

      {/* Main stream */}
      <video
        ref={remoteVideoRef}
        autoPlay
        playsInline
        className={clsx(
          'rounded-lg bg-black',
          hasVideo ? 'max-w-[90vw] max-h-[75vh]' : 'w-0 h-0'
        )}
      />

      {/* Audio-only indicator */}
      {!hasVideo && (
        <div className="flex flex-col items-center gap-4">
          <div className="w-24 h-24 rounded-full bg-gray-800 border-2 border-blue-500 flex items-center justify-center">
            <Mic size={32} className="text-blue-400" />
          </div>
          <div className="text-white text-xl font-bold">{fname}</div>
          <div className="text-gray-400 font-mono">{formatDuration(duration)}</div>
        </div>
      )}

      {/* Local PiP */}
      {(localStream || cameraStream) && hasLocalVideo && (
        <video
          ref={localStream ? localVideoRef : cameraVideoRef}
          autoPlay
          playsInline
          muted
          className="absolute bottom-24 right-4 w-28 rounded-lg bg-gray-900 border border-gray-700 shadow-lg"
        />
      )}

      {/* Control bar */}
      <div className="absolute bottom-8 flex items-center gap-3">
        <button
          onClick={toggleMic}
          className={clsx(
            'p-3 rounded-full transition-colors',
            micMuted ? 'bg-red-600 hover:bg-red-700 text-white' : 'bg-gray-700 hover:bg-gray-600 text-white'
          )}
          title={micMuted ? 'Unmute' : 'Mute'}
        >
          {micMuted ? <MicOff size={20} /> : <Mic size={20} />}
        </button>

        {hasLocalVideo && (
          <button
            onClick={toggleCam}
            className={clsx(
              'p-3 rounded-full transition-colors',
              camOff ? 'bg-red-600 hover:bg-red-700 text-white' : 'bg-gray-700 hover:bg-gray-600 text-white'
            )}
            title={camOff ? 'Turn camera on' : 'Turn camera off'}
          >
            {camOff ? <VideoOff size={20} /> : <VideoIcon size={20} />}
          </button>
        )}

        {hasLocalVideo && (
          <button
            onClick={switchCamera}
            className="p-3 rounded-full bg-gray-700 hover:bg-gray-600 text-white transition-colors"
            title="Switch camera"
          >
            <SwitchCamera size={20} />
          </button>
        )}

        <button
          onClick={onEnd}
          className="px-6 py-3 bg-red-600 hover:bg-red-700 text-white rounded-full font-semibold transition-colors flex items-center gap-2"
        >
          <PhoneOff size={18} /> End
        </button>
      </div>
    </div>
  );
}
