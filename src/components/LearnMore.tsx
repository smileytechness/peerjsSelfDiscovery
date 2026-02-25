import React from 'react';
import { X, ExternalLink } from 'lucide-react';
import { APP_NAME, APP_PREFIX } from '../lib/types';
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

          {/* Simple explanation */}
          <section>
            <h3 className="text-sm font-semibold text-gray-200 mb-2">What is this?</h3>
            <p className="text-gray-400">
              A <span className="text-white font-medium">fully serverless</span> peer-to-peer chat app that runs entirely in your browser. There are no accounts, no servers storing your messages, and no middlemen. You connect directly to other people using WebRTC — the same technology that powers video calls in your browser.
            </p>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-gray-200 mb-2">How do people find each other?</h3>
            <p className="text-gray-400">
              When you open the app, it detects your public IP and joins a <span className="text-white font-medium">discovery namespace</span> — a shared meeting space for everyone on your network. You can also join <span className="text-white font-medium">custom namespaces</span> by typing any name (like "office" or "family"), which work across different networks.
            </p>
            <p className="text-gray-400 mt-2">
              Inside each namespace, the app automatically elects a <span className="text-white font-medium">router</span> — the first device to claim the slot. The router keeps a registry of who's online and broadcasts it to everyone. If the router leaves, another device takes over seamlessly.
            </p>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-gray-200 mb-2">How is identity verified?</h3>
            <p className="text-gray-400">
              Each device generates a unique <span className="text-white font-medium">ECDSA key pair</span> on first use. Your public key serves as your identity. When someone sends you a connection request, the app verifies the request signature using their public key — so you can confirm you're talking to who you think you are, without trusting any server.
            </p>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-gray-200 mb-2">What about saved contacts?</h3>
            <p className="text-gray-400">
              Once you accept a connection, the contact is saved with their public key and persistent ID. You can reconnect with them from any network — the app uses a signaling server only to establish the initial WebRTC connection, then all messages flow directly peer-to-peer.
            </p>
          </section>

          {/* Technical section */}
          <section className="border-t border-gray-800 pt-4">
            <h3 className="text-sm font-semibold text-gray-300 mb-2">Technical Details</h3>
            <div className="text-gray-500 text-[12px] space-y-2">
              <p>
                <span className="text-gray-400 font-medium">Signaling:</span> PeerJS (<code className="text-cyan-600">0.peerjs.com</code>) is used only for WebRTC signaling — the initial handshake to establish direct connections. No message content passes through the signaling server. The name {APP_NAME} is a riff on PeerJS.
              </p>
              <p>
                <span className="text-gray-400 font-medium">Routing:</span> Namespace routing uses a novel first-to-claim, self-managed mesh protocol. A deterministic PeerJS ID (e.g. <code className="text-cyan-600">{APP_PREFIX}-ns-office-1</code>) is claimed by the first peer to register it. This becomes the L1 router. If taken, peers escalate to L2, L3, etc. (up to L5), with automatic level-down migration when lower levels free up.
              </p>
              <p>
                <span className="text-gray-400 font-medium">Identity:</span> ECDSA P-256 key pairs generated via Web Crypto API. Public keys are exchanged during the handshake. Connection requests include a signed timestamp verified by the recipient. Key fingerprints are SHA-256 of the public key (first 8 bytes).
              </p>
              <p>
                <span className="text-gray-400 font-medium">Storage:</span> All data (contacts, messages, keys, files) stored locally in localStorage and IndexedDB. Nothing leaves your device except direct peer connections.
              </p>
              <p>
                <span className="text-gray-400 font-medium">Stack:</span> React + TypeScript + Vite + Tailwind CSS + PeerJS + Web Crypto API. Installable as a PWA.
              </p>
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
