import React, { useEffect, useState } from 'react';
import { PhoneOff, Monitor, Video, Mic } from 'lucide-react';

interface CallingOverlayProps {
  fname: string;
  kind: 'audio' | 'video' | 'screen';
  peerUnreachable?: boolean;
  onCancel: () => void;
}

const kindLabel = { audio: 'Audio call', video: 'Video call', screen: 'Screen share' };
const KindIcon = ({ kind }: { kind: string }) => {
  if (kind === 'screen') return <Monitor size={28} className="text-blue-400" />;
  if (kind === 'video') return <Video size={28} className="text-blue-400" />;
  return <Mic size={28} className="text-blue-400" />;
};

export function CallingOverlay({ fname, kind, peerUnreachable, onCancel }: CallingOverlayProps) {
  const [dots, setDots] = useState('');

  useEffect(() => {
    const t = setInterval(() => setDots(d => d.length >= 3 ? '' : d + '.'), 500);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="fixed inset-0 bg-black/90 z-[100] flex flex-col items-center justify-center gap-6 anim-fade-in">
      <div className="flex flex-col items-center gap-4">
        <div className="w-20 h-20 rounded-full bg-gray-800 border-2 border-blue-500 flex items-center justify-center animate-pulse">
          <KindIcon kind={kind} />
        </div>
        <div className="text-center">
          <div className="text-white text-xl font-bold">{fname}</div>
          <div className="text-gray-400 text-sm mt-1">{kindLabel[kind]}{dots}</div>
          {peerUnreachable && (
            <div className="text-orange-400 text-xs mt-2">Peer may not have received the call</div>
          )}
        </div>
      </div>

      <button
        onClick={onCancel}
        className="flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white px-6 py-3 rounded-full font-semibold transition-colors"
      >
        <PhoneOff size={18} /> Cancel
      </button>
    </div>
  );
}
