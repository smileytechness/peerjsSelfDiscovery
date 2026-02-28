import React, { useState } from 'react';
import { X, Copy, Key, Check, Pencil, History } from 'lucide-react';
import { clsx } from 'clsx';

interface ProfileModalProps {
  name: string;
  pid: string;
  publicKey: string;
  fingerprint: string;
  signalingState: 'connected' | 'reconnecting' | 'offline';
  lastSignalingTs: number;
  persConnected: boolean;
  signalingServer: string;
  pidHistory: string[];
  onEditName: (name: string) => void;
  onClose: () => void;
}

function formatTimeSince(ts: number): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 10000) return 'just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      onClick={copy}
      className="p-1 rounded text-gray-500 hover:text-gray-200 hover:bg-gray-700 transition-colors shrink-0"
      title="Copy"
    >
      {copied ? <Check size={13} className="text-green-400" /> : <Copy size={13} />}
    </button>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">{label}</div>
      {children}
    </div>
  );
}

export function ProfileModal({
  name, pid, publicKey, fingerprint, signalingState, lastSignalingTs, persConnected,
  signalingServer, pidHistory, onEditName, onClose
}: ProfileModalProps) {
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(name);

  const submitName = () => {
    const trimmed = nameInput.trim();
    if (trimmed && trimmed !== name) onEditName(trimmed);
    setEditingName(false);
  };

  const sigColor = signalingState === 'connected'
    ? 'bg-green-500'
    : signalingState === 'reconnecting'
      ? 'bg-orange-400 animate-pulse'
      : 'bg-gray-600';
  const sigLabel = signalingState === 'connected'
    ? `Connected · last handshake ${formatTimeSince(lastSignalingTs)}`
    : signalingState === 'reconnecting'
      ? 'Reconnecting…'
      : 'Offline';

  return (
    <div
      className="fixed inset-0 bg-black/80 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4 anim-fade-in"
      onClick={onClose}
    >
      <div
        className="bg-gray-900 border border-gray-800 rounded-t-2xl sm:rounded-xl w-full sm:max-w-sm shadow-2xl max-h-[90vh] overflow-y-auto anim-slide-up"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-gray-800">
          <h3 className="text-base font-semibold text-gray-200">My Profile</h3>
          <button onClick={onClose} className="p-1 text-gray-500 hover:text-gray-300 hover:bg-gray-800 rounded">
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-5">

          {/* Display name */}
          <InfoRow label="Display Name">
            {editingName ? (
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  value={nameInput}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNameInput(e.target.value)}
                  onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                    if (e.key === 'Enter') submitName();
                    if (e.key === 'Escape') setEditingName(false);
                  }}
                  className="flex-1 bg-gray-800 border border-blue-500 rounded-lg px-3 py-1.5 text-sm text-gray-100 focus:outline-none"
                />
                <button onClick={submitName} className="p-1.5 bg-blue-600 hover:bg-blue-700 rounded-lg text-white">
                  <Check size={14} />
                </button>
                <button onClick={() => setEditingName(false)} className="p-1.5 bg-gray-700 hover:bg-gray-600 rounded-lg text-gray-300">
                  <X size={14} />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className={clsx('w-2 h-2 rounded-full shrink-0', persConnected ? 'bg-green-500' : 'bg-gray-600')} />
                <span className="text-white font-bold text-base flex-1">{name || '—'}</span>
                <button
                  onClick={() => { setNameInput(name); setEditingName(true); }}
                  className="p-1 rounded text-gray-500 hover:text-gray-200 hover:bg-gray-700 transition-colors"
                  title="Edit name"
                >
                  <Pencil size={13} />
                </button>
              </div>
            )}
          </InfoRow>

          {/* Persistent ID */}
          <InfoRow label="Persistent ID">
            <div className="flex items-start gap-1 bg-gray-950 rounded-lg p-2">
              <span className="font-mono text-[11px] text-blue-400 break-all flex-1 leading-relaxed">{pid || '—'}</span>
              {pid && <CopyButton text={pid} />}
            </div>
          </InfoRow>

          {/* PID History */}
          {pidHistory.length > 0 && (
            <InfoRow label={`Previous Addresses (${pidHistory.length})`}>
              <div className="bg-gray-950 rounded-lg p-2 space-y-1 max-h-24 overflow-y-auto">
                {pidHistory.map((oldPid) => (
                  <div key={oldPid} className="flex items-center gap-1">
                    <History size={10} className="text-gray-600 shrink-0" />
                    <span className="font-mono text-[10px] text-gray-500 flex-1 truncate">{oldPid}</span>
                    <CopyButton text={oldPid} />
                  </div>
                ))}
              </div>
            </InfoRow>
          )}

          {/* Key fingerprint — the short 8-byte hash shown at a glance */}
          <InfoRow label="Key Fingerprint (SHA-256, first 8 bytes)">
            <div className="flex items-center gap-1 bg-gray-950 rounded-lg p-2">
              <Key size={11} className="text-purple-400 shrink-0" />
              <span className="font-mono text-[11px] text-purple-300 flex-1">{fingerprint || '—'}</span>
              {fingerprint && <CopyButton text={fingerprint} />}
            </div>
          </InfoRow>

          {/* Full public key */}
          <InfoRow label="Full Public Key (Ed25519 / ECDSA)">
            <div className="flex items-start gap-1 bg-gray-950 rounded-lg p-2">
              <span className="font-mono text-[10px] text-gray-400 break-all flex-1 leading-relaxed max-h-28 overflow-y-auto">
                {publicKey || 'Not available'}
              </span>
              {publicKey && <CopyButton text={publicKey} />}
            </div>
          </InfoRow>

          {/* Signaling */}
          <InfoRow label="Signaling Server">
            <div className="bg-gray-950 rounded-lg p-2 space-y-1.5">
              <div className="flex items-center gap-2">
                <span className={clsx('w-2 h-2 rounded-full shrink-0', sigColor)} />
                <span className="text-xs text-gray-300">{sigLabel}</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="font-mono text-[10px] text-gray-500 flex-1">wss://{signalingServer}</span>
                <CopyButton text={`wss://${signalingServer}`} />
              </div>
            </div>
          </InfoRow>

          {/* App origin */}
          <InfoRow label="App Origin">
            <div className="flex items-center gap-1 bg-gray-950 rounded-lg p-2">
              <span className="font-mono text-[11px] text-gray-400 break-all flex-1">{window.location.origin}</span>
              <CopyButton text={window.location.origin} />
            </div>
          </InfoRow>

        </div>
      </div>
    </div>
  );
}
