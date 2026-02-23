import React, { useState } from 'react';
import { X, Copy, Activity, MessageCircle, Trash2, Key, CheckCircle } from 'lucide-react';
import { Contact } from '../lib/types';
import { clsx } from 'clsx';

interface ContactModalProps {
  pid: string;
  contact: Contact;
  onClose: () => void;
  onPing: (pid: string) => void;
  onChat: (pid: string) => void;
  onDelete: (pid: string) => void;
}

function formatLastSeen(ts?: number): string {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

export function ContactModal({ pid, contact, onClose, onPing, onChat, onDelete }: ContactModalProps) {
  const isOnline = !!contact.conn?.open;
  const hasKey = !!contact.publicKey;
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const copy = (text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
  };

  return (
    <div
      className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-gray-900 border border-gray-800 rounded-xl w-full max-w-sm shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-5 pb-3">
          <div>
            <h2 className="text-xl font-bold text-gray-100">{contact.friendlyName}</h2>
            <div className="flex items-center gap-1.5 mt-1">
              <span className={clsx('w-2 h-2 rounded-full', isOnline ? 'bg-green-500' : 'bg-gray-600')} />
              <span className={clsx('text-xs', isOnline ? 'text-green-400' : 'text-gray-500')}>
                {isOnline ? 'online' : `last seen ${formatLastSeen(contact.lastSeen)}`}
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-800 rounded text-gray-500 hover:text-gray-300"
          >
            <X size={18} />
          </button>
        </div>

        {/* Details */}
        <div className="px-5 pb-4 space-y-3">
          {/* Persistent ID */}
          <div>
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Persistent ID</div>
            <div className="flex items-center gap-2 bg-gray-800 rounded-lg px-3 py-2">
              <span className="font-mono text-[11px] text-gray-300 flex-1 break-all">{pid}</span>
              <button onClick={() => copy(pid)} className="text-gray-500 hover:text-gray-300 shrink-0" title="Copy">
                <Copy size={13} />
              </button>
            </div>
          </div>

          {/* Key fingerprint */}
          <div>
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-2">
              Public Key
              {hasKey && (
                <span className="flex items-center gap-0.5 text-green-500 text-[10px]">
                  <CheckCircle size={10} /> verified
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 bg-gray-800 rounded-lg px-3 py-2">
              <Key size={12} className={hasKey ? 'text-purple-400' : 'text-gray-600'} />
              <span className={clsx('font-mono text-[11px] flex-1 break-all', hasKey ? 'text-purple-400' : 'text-gray-600 italic')}>
                {hasKey ? contact.publicKey!.slice(0, 48) + '…' : 'not yet exchanged'}
              </span>
              {hasKey && (
                <button onClick={() => copy(contact.publicKey!)} className="text-gray-500 hover:text-gray-300 shrink-0" title="Copy">
                  <Copy size={13} />
                </button>
              )}
            </div>
          </div>

          {/* Discovery ID if on network */}
          {contact.networkDiscID && (
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">On Network Now</div>
              <div className="bg-gray-800 rounded-lg px-3 py-2">
                <span className="font-mono text-[10px] text-gray-500 break-all">{contact.networkDiscID}</span>
              </div>
            </div>
          )}
        </div>

        {/* Actions */}
        {confirmingDelete ? (
          <div className="px-5 pb-5">
            <div className="text-sm text-gray-400 mb-3 text-center">
              Remove <span className="text-white font-semibold">{contact.friendlyName}</span> from contacts?
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmingDelete(false)}
                className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg py-2 text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => { onDelete(pid); onClose(); }}
                className="flex-1 bg-red-700 hover:bg-red-600 text-white rounded-lg py-2 text-sm font-medium transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        ) : (
          <div className="px-5 pb-5 flex gap-2">
            <button
              onClick={() => { onPing(pid); onClose(); }}
              className="flex-1 flex items-center justify-center gap-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg py-2 text-sm transition-colors"
            >
              <Activity size={14} /> Ping
            </button>
            <button
              onClick={() => { onChat(pid); onClose(); }}
              className="flex-1 flex items-center justify-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg py-2 text-sm font-medium transition-colors"
            >
              <MessageCircle size={14} /> Chat
            </button>
            <button
              onClick={() => setConfirmingDelete(true)}
              className="p-2 flex items-center justify-center bg-gray-800 hover:bg-red-900/40 text-gray-500 hover:text-red-400 rounded-lg transition-colors"
              title="Delete contact"
            >
              <Trash2 size={16} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
