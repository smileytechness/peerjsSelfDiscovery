import React from 'react';
import { X, ExternalLink, Shield, Users, MapPin, Wifi, Globe, Lock, Phone, RefreshCw, Code } from 'lucide-react';
import { APP_NAME } from '../lib/types';
import { BUILD } from '../lib/version';

interface LearnMoreProps {
  onClose: () => void;
}

export function LearnMore({ onClose }: LearnMoreProps) {
  return (
    <div
      className="fixed inset-0 bg-black/80 flex items-center justify-center z-[250] p-4 anim-fade-in"
      onClick={onClose}
    >
      <div
        className="bg-gray-900 border border-gray-800 rounded-xl w-full max-w-lg shadow-2xl max-h-[85vh] overflow-y-auto anim-scale-up"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-gray-800 sticky top-0 bg-gray-900 z-10">
          <h2 className="text-lg font-bold text-blue-400">About {APP_NAME}</h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-800 rounded text-gray-500 hover:text-gray-300 transition-colors">
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-5 text-[13px] leading-relaxed">

          {/* What is it */}
          <section>
            <h3 className="text-sm font-semibold text-gray-200 mb-2">What is {APP_NAME}?</h3>
            <p className="text-gray-400">
              A private messaging app that connects you <span className="text-white font-medium">directly to other people</span> — no middlemen, no accounts, no data collection. Your messages, calls, and files go straight from your device to theirs using encrypted peer-to-peer connections.
            </p>
            <p className="text-gray-400 mt-2">
              The app itself is just a website — there are no servers involved in running it. A small signaling service (powered by <span className="text-white font-medium">PeerJS</span>) helps devices find each other initially, but never sees your messages or data.
            </p>
          </section>

          {/* Features */}
          <section>
            <h3 className="text-sm font-semibold text-gray-200 mb-3">What makes it unique</h3>
            <div className="space-y-3">

              <div className="flex gap-3">
                <Shield size={16} className="text-green-500 shrink-0 mt-0.5" />
                <div>
                  <p className="text-gray-200 font-medium text-[13px]">End-to-end encrypted everything</p>
                  <p className="text-gray-500 text-[12px]">Messages, group chats, calls, and files are all encrypted. Each device generates its own cryptographic identity — nobody, not even {APP_NAME}, can read your conversations.</p>
                </div>
              </div>

              <div className="flex gap-3">
                <Wifi size={16} className="text-blue-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-gray-200 font-medium text-[13px]">Same-network discovery</p>
                  <p className="text-gray-500 text-[12px]">People on the same Wi-Fi or network are automatically discovered — no need to exchange IDs. Just open the app and you'll see who's nearby.</p>
                </div>
              </div>

              <div className="flex gap-3">
                <MapPin size={16} className="text-purple-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-gray-200 font-medium text-[13px]">GPS nearby discovery</p>
                  <p className="text-gray-500 text-[12px]">Find people physically nearby — even on different networks — using location-based discovery. Great for events, conferences, or public spaces. Your exact location is never shared; only a coarse area code is used.</p>
                </div>
              </div>

              <div className="flex gap-3">
                <Globe size={16} className="text-cyan-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-gray-200 font-medium text-[13px]">Custom namespaces</p>
                  <p className="text-gray-500 text-[12px]">Create or join shared spaces by name — like "office", "family", or "hackathon". Anyone who joins the same namespace can discover each other, no matter what network they're on.</p>
                </div>
              </div>

              <div className="flex gap-3">
                <Users size={16} className="text-orange-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-gray-200 font-medium text-[13px]">Encrypted group chats & calls</p>
                  <p className="text-gray-500 text-[12px]">Create group chats with end-to-end encryption. Start group audio or video calls. Invite members, share files, and manage your group — all without any server.</p>
                </div>
              </div>

              <div className="flex gap-3">
                <Phone size={16} className="text-green-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-gray-200 font-medium text-[13px]">Voice & video calls</p>
                  <p className="text-gray-500 text-[12px]">Call any contact directly — audio, video, or screen share. Calls are peer-to-peer with no server in between.</p>
                </div>
              </div>

              <div className="flex gap-3">
                <RefreshCw size={16} className="text-yellow-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-gray-200 font-medium text-[13px]">Instant reconnect</p>
                  <p className="text-gray-500 text-[12px]">When you and a contact both come back online, you reconnect automatically and instantly — no manual steps needed. Queued messages are delivered as soon as the connection is restored.</p>
                </div>
              </div>

            </div>
          </section>

          {/* How it works */}
          <section className="border-t border-gray-800 pt-4">
            <h3 className="text-sm font-semibold text-gray-200 mb-2">How does it work?</h3>
            <p className="text-gray-400">
              {APP_NAME} uses <span className="text-white font-medium">WebRTC</span> — the same technology behind video calls in your browser — to create direct connections between devices. A lightweight signaling server helps two devices find each other, but once connected, everything flows directly between them.
            </p>
            <p className="text-gray-400 mt-2">
              Your identity is a cryptographic key pair (ECDSA P-256) generated on your device. Your contacts verify you by your unique fingerprint — a short code derived from your public key. Messages are encrypted with AES-256-GCM using shared keys negotiated via ECDH. Group chats use a shared group key distributed securely to each member.
            </p>
            <p className="text-gray-400 mt-2">
              All your data — contacts, messages, keys, and files — is stored locally on your device. Nothing is uploaded to any server.
            </p>
          </section>

          {/* Open source */}
          <section className="border-t border-gray-800 pt-4">
            <div className="flex gap-3">
              <Code size={16} className="text-blue-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-gray-200 font-medium text-[13px]">Open source & self-hostable</p>
                <p className="text-gray-500 text-[12px]">{APP_NAME} is fully open source. Anyone can run their own instance, customize it, or point it to their own signaling and STUN/TURN servers. No vendor lock-in, no trust required.</p>
              </div>
            </div>
          </section>

          {/* Links */}
          <section className="border-t border-gray-800 pt-4 pb-1">
            <div className="flex flex-col gap-2">
              <a
                href="https://github.com/smileytechness/peerns"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-blue-400 hover:text-blue-300 text-[12px] font-medium transition-colors"
              >
                <ExternalLink size={13} />
                GitHub Repository
              </a>
              <a
                href="https://itqix.com"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-blue-400 hover:text-blue-300 text-[12px] font-medium transition-colors"
              >
                <ExternalLink size={13} />
                Created by ITQIX Technology
              </a>
            </div>
            <div className="mt-3 text-[10px] text-gray-600 font-mono">
              Version #0.{BUILD}
            </div>
          </section>

        </div>
      </div>
    </div>
  );
}
