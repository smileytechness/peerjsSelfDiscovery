import React, { useEffect, useRef } from 'react';
import { PhoneOff } from 'lucide-react';

interface MediaOverlayProps {
  stream: MediaStream;
  localStream?: MediaStream;
  // cameraStream is the local camera feed shown as PiP during screen share
  cameraStream?: MediaStream;
  fname: string;
  kind: string;
  onEnd: () => void;
}

export function MediaOverlay({ stream, localStream, cameraStream, fname, kind, onEnd }: MediaOverlayProps) {
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const cameraVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = stream;
    if (localVideoRef.current && localStream) localVideoRef.current.srcObject = localStream;
    if (cameraVideoRef.current && cameraStream) cameraVideoRef.current.srcObject = cameraStream;
  }, [stream, localStream, cameraStream]);

  const isScreen = kind === 'screen';

  return (
    <div className="fixed inset-0 bg-black/95 z-[100] flex flex-col items-center justify-center">
      <div className="absolute top-4 left-4 text-gray-400 text-sm">
        {isScreen ? '📺 Screen share' : '📞 Call'} with{' '}
        <span className="text-white font-semibold">{fname}</span>
      </div>

      {/* Main stream — remote screen or remote video/audio */}
      <video
        ref={remoteVideoRef}
        autoPlay
        playsInline
        className="max-w-[90vw] max-h-[80vh] rounded-lg bg-black"
      />

      {/* Local video — camera (audio/video calls) or camera PiP (screen share) */}
      {(localStream || cameraStream) && (
        <video
          ref={localStream ? localVideoRef : cameraVideoRef}
          autoPlay
          playsInline
          muted
          className="absolute bottom-20 right-4 w-28 rounded-lg bg-gray-900 border border-gray-700 shadow-lg"
        />
      )}

      <button
        onClick={onEnd}
        className="absolute bottom-8 flex items-center gap-2 px-6 py-3 bg-red-600 hover:bg-red-700 text-white rounded-full font-semibold shadow-lg transition-colors"
      >
        <PhoneOff size={18} /> End Call
      </button>
    </div>
  );
}
