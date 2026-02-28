import React, { useState } from 'react';
import { APP_NAME } from '../lib/types';
import { BUILD } from '../lib/version';
import { LearnMore } from './LearnMore';
import { Shield, Globe, Wifi, MapPin, Users, RefreshCw, ExternalLink, FileUp } from 'lucide-react';

interface SetupModalProps {
  onJoin: (name: string) => void;
  pendingConnectPID?: string | null;
}

const features = [
  { icon: Shield, color: 'text-green-500', title: 'End-to-end encrypted', desc: 'Messages, calls, and files — all encrypted with your own keys.' },
  { icon: FileUp, color: 'text-pink-400', title: 'Cross-device file sharing', desc: 'Send files between Android, iPhone, and desktop — any network, no login.' },
  { icon: Wifi, color: 'text-blue-400', title: 'Same-network discovery', desc: 'Auto-discover people on your Wi-Fi — no IDs needed.' },
  { icon: MapPin, color: 'text-purple-400', title: 'GPS nearby', desc: 'Find people physically nearby, even on different networks.' },
  { icon: Globe, color: 'text-cyan-400', title: 'Custom namespaces', desc: 'Join shared spaces by name — "office", "hackathon", anything.' },
  { icon: Users, color: 'text-orange-400', title: 'Group chats & calls', desc: 'Encrypted group messaging with voice and video calls.' },
  { icon: RefreshCw, color: 'text-yellow-400', title: 'Instant reconnect', desc: 'Come back online and reconnect automatically — no manual steps.' },
];

export function SetupModal({ onJoin, pendingConnectPID }: SetupModalProps) {
  const [name, setName] = useState('');
  const [showLearnMore, setShowLearnMore] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      onJoin(name.trim());
    }
  };

  if (showLearnMore) {
    return <LearnMore onClose={() => setShowLearnMore(false)} />;
  }

  return (
    <div className="fixed inset-0 bg-black flex flex-col min-h-[100dvh] overflow-y-auto z-50 anim-fade-in">

      {/* Hero */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-12">
        <h1 className="text-4xl font-bold text-blue-500 mb-2">{APP_NAME}</h1>
        <p className="text-gray-400 text-base mb-8 text-center max-w-md">
          Private, serverless messaging — no accounts, no servers, just you.
        </p>

        {pendingConnectPID && (
          <div className="bg-blue-950/50 border border-blue-800/60 rounded-lg px-4 py-3 mb-6 w-full max-w-sm">
            <p className="text-blue-300 text-sm font-medium mb-1">Someone invited you to connect!</p>
            <p className="text-blue-400/70 font-mono text-[11px] truncate">{pendingConnectPID}</p>
            <p className="text-blue-400/60 text-xs mt-1">Enter your name below to join and connect automatically.</p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="w-full max-w-sm">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="What should people call you?"
            className="w-full bg-gray-950 border border-gray-800 rounded-lg px-4 py-3.5 text-base text-gray-200 mb-4 focus:outline-none focus:border-blue-500 transition-colors"
            autoFocus
          />
          <button
            type="submit"
            disabled={!name.trim()}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-lg transition-colors text-base"
          >
            Get Started
          </button>
        </form>

        <button
          onClick={() => setShowLearnMore(true)}
          className="mt-5 text-sm text-blue-400 hover:text-blue-300 transition-colors"
        >
          Learn more about {APP_NAME}
        </button>
      </div>

      {/* Features grid */}
      <div className="w-full max-w-2xl mx-auto px-6 pb-10">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {features.map((f) => (
            <div key={f.title} className="bg-gray-800/50 border border-gray-800 rounded-xl px-4 py-3.5 flex items-start gap-3">
              <f.icon size={18} className={`${f.color} shrink-0 mt-0.5`} />
              <div>
                <p className="text-gray-200 font-medium text-sm">{f.title}</p>
                <p className="text-gray-500 text-xs leading-relaxed">{f.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="w-full border-t border-gray-800/60 py-5 px-6 flex flex-col items-center gap-2 text-xs text-gray-600">
        <div className="flex items-center gap-4">
          <a
            href="https://github.com/smileytechness/peerns"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-gray-500 hover:text-gray-300 transition-colors"
          >
            <ExternalLink size={12} />
            Open source on GitHub
          </a>
          <span className="text-gray-800">·</span>
          <a
            href="https://itqix.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-500 hover:text-gray-300 transition-colors"
          >
            ITQIX Technology
          </a>
        </div>
        <span className="font-mono text-[10px] text-gray-700">v0.{BUILD}</span>
      </div>
    </div>
  );
}
