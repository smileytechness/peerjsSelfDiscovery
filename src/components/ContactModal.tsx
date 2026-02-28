import React, { useState } from 'react';
import { X, Copy, Activity, MessageCircle, Trash2, Key, CheckCircle, Shield, Eye, EyeOff, AlertTriangle, Radio, Users, UserPlus } from 'lucide-react';
import { Contact, RVZ_WINDOW, GroupInfo, GroupMessage } from '../lib/types';
import { P2PManager } from '../lib/p2p';
import { clsx } from 'clsx';

interface ContactModalProps {
  contactKey: string;
  contact: Contact;
  pubkeyFingerprint?: string | null;
  sharedKeyFingerprint?: string | null;
  rvzStatus?: 'queued' | 'active' | null;
  p2p: P2PManager;
  groups?: Record<string, { info: GroupInfo; messages: GroupMessage[]; isRouter: boolean; level: number; memberCount: number }>;
  onGroupInvite?: (groupId: string, contactKey: string) => void;
  onSelectGroupChat?: (groupId: string) => void;
  onClose: () => void;
  onPing: (key: string) => void;
  onChat: (key: string) => void;
  onDelete: (key: string) => void;
}

function formatLastSeen(ts?: number): string {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

export function ContactModal({ contactKey, contact, pubkeyFingerprint, sharedKeyFingerprint, rvzStatus, p2p, groups, onGroupInvite, onSelectGroupChat, onClose, onPing, onChat, onDelete }: ContactModalProps) {
  const isOnline = !!contact.conn?.open;
  const hasKey = !!contact.publicKey;
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [showSharedKey, setShowSharedKey] = useState(false);
  const [sharedKeyRaw, setSharedKeyRaw] = useState<string | null>(null);
  const [invitedGroups, setInvitedGroups] = useState<Set<string>>(new Set());

  // Compute shared and invitable groups
  const contactFP = contact.fingerprint || contactKey;
  const sharedGroups = groups ? Object.entries(groups).filter(
    ([_, g]) => contactFP in g.info.members
  ) : [];
  const invitableGroups = groups ? Object.entries(groups).filter(
    ([_, g]) => !(contactFP in g.info.members)
  ) : [];

  const copy = (text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
  };

  const handleRevealKey = async () => {
    if (showSharedKey) {
      setShowSharedKey(false);
      return;
    }
    const raw = await p2p.getSharedKeyExport(contactKey);
    setSharedKeyRaw(raw);
    setShowSharedKey(true);
  };

  return (
    <div
      className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 anim-fade-in"
      onClick={onClose}
    >
      <div
        className="bg-gray-900 border border-gray-800 rounded-xl w-full max-w-sm shadow-2xl max-h-[85vh] flex flex-col anim-scale-up"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-5 pb-3 shrink-0">
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

        {/* Details — scrollable on mobile */}
        <div className="px-5 pb-4 space-y-3 overflow-y-auto min-h-0">
          {/* Identity (Public Key Hash) */}
          <div>
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-2">
              Identity (Public Key Hash)
              {hasKey && (
                <span className="flex items-center gap-0.5 text-green-500 text-[10px]">
                  <CheckCircle size={10} /> verified
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 bg-gray-800 rounded-lg px-3 py-2">
              <Key size={12} className={hasKey ? 'text-purple-400' : 'text-gray-600'} />
              <span className={clsx('font-mono text-[11px] flex-1', hasKey ? 'text-purple-400' : 'text-gray-600 italic')}>
                {contact.fingerprint || pubkeyFingerprint || (hasKey ? '...' : 'not yet exchanged')}
              </span>
              {(contact.fingerprint || pubkeyFingerprint) && (
                <button onClick={() => copy(contact.fingerprint || pubkeyFingerprint || '')} className="text-gray-500 hover:text-gray-300 shrink-0" title="Copy fingerprint">
                  <Copy size={13} />
                </button>
              )}
            </div>
            {hasKey && (
              <div className="text-[10px] text-gray-600 mt-1">
                SHA-256 fingerprint of their public key. Verify it matches on the other device.
              </div>
            )}
          </div>

          {/* Current Address (PeerJS ID) */}
          <div>
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Current Address</div>
            <div className="flex items-center gap-2 bg-gray-800 rounded-lg px-3 py-2">
              <span className="font-mono text-[11px] text-gray-300 flex-1 break-all">{contact.currentPID || contactKey}</span>
              <button onClick={() => copy(contact.currentPID || contactKey)} className="text-gray-500 hover:text-gray-300 shrink-0" title="Copy">
                <Copy size={13} />
              </button>
            </div>
          </div>

          {/* Known Addresses */}
          {contact.knownPIDs && contact.knownPIDs.length > 1 && (
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Known Addresses ({contact.knownPIDs.length})</div>
              <div className="bg-gray-800 rounded-lg px-3 py-2 space-y-1 max-h-24 overflow-y-auto">
                {contact.knownPIDs.map((pid, i) => (
                  <div key={pid} className="flex items-center gap-1">
                    <span className={clsx('font-mono text-[10px] flex-1 truncate', pid === contact.currentPID ? 'text-gray-300' : 'text-gray-600')}>
                      {pid}
                    </span>
                    {pid === contact.currentPID && (
                      <span className="text-[9px] text-green-600 shrink-0">current</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Shared E2E key */}
          <div>
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-2">
              Shared Key (E2E)
              {sharedKeyFingerprint && (
                <span className="flex items-center gap-0.5 text-green-500 text-[10px]">
                  <Shield size={10} /> active
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 bg-gray-800 rounded-lg px-3 py-2">
              <Shield size={12} className={sharedKeyFingerprint ? 'text-emerald-400' : 'text-gray-600'} />
              <span className={clsx('font-mono text-[11px] flex-1', sharedKeyFingerprint ? 'text-emerald-400' : 'text-gray-600 italic')}>
                {sharedKeyFingerprint || 'not yet derived'}
              </span>
              {sharedKeyFingerprint && (
                <button onClick={() => copy(sharedKeyFingerprint)} className="text-gray-500 hover:text-gray-300 shrink-0" title="Copy">
                  <Copy size={13} />
                </button>
              )}
            </div>
            {sharedKeyFingerprint && (
              <div className="text-[10px] text-gray-600 mt-1">
                Both devices compute the same key. Verify this fingerprint matches on the other device.
              </div>
            )}

            {/* Reveal full shared key */}
            {sharedKeyFingerprint && (
              <div className="mt-2">
                <button
                  onClick={handleRevealKey}
                  className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
                >
                  {showSharedKey ? <EyeOff size={10} /> : <Eye size={10} />}
                  {showSharedKey ? 'Hide full key' : 'Reveal full key'}
                </button>
                {showSharedKey && (
                  <div className="mt-1.5 bg-red-950/30 border border-red-900/40 rounded-lg p-2">
                    <div className="flex items-center gap-1 text-[10px] text-red-400 mb-1.5">
                      <AlertTriangle size={10} />
                      Do not share this key. It encrypts messages with this contact.
                    </div>
                    {sharedKeyRaw ? (
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[10px] text-gray-400 flex-1 break-all leading-relaxed">{sharedKeyRaw}</span>
                        <button onClick={() => copy(sharedKeyRaw)} className="text-gray-500 hover:text-gray-300 shrink-0" title="Copy key">
                          <Copy size={12} />
                        </button>
                      </div>
                    ) : (
                      <span className="text-[10px] text-gray-600 italic">Key unavailable</span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Shared Groups */}
          {sharedGroups.length > 0 && (
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-2">
                <Users size={10} /> Shared Groups ({sharedGroups.length})
              </div>
              <div className="bg-gray-800 rounded-lg px-3 py-2 space-y-1.5">
                {sharedGroups.map(([gid, g]) => (
                  <div key={gid} className="flex items-center justify-between">
                    <span className="text-[11px] text-gray-300 truncate flex-1">{g.info.name}</span>
                    {onSelectGroupChat && (
                      <button
                        onClick={() => { onSelectGroupChat(gid); onClose(); }}
                        className="text-[10px] px-1.5 py-0.5 bg-purple-600 hover:bg-purple-700 text-white rounded shrink-0"
                      >
                        Open
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Add to Group */}
          {invitableGroups.length > 0 && onGroupInvite && (
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-2">
                <UserPlus size={10} /> Add to Group
              </div>
              <div className="bg-gray-800 rounded-lg px-3 py-2 space-y-1.5">
                {invitableGroups.map(([gid, g]) => (
                  <div key={gid} className="flex items-center justify-between">
                    <span className="text-[11px] text-gray-300 truncate flex-1">{g.info.name}</span>
                    {invitedGroups.has(gid) ? (
                      <span className="text-[10px] text-green-400 shrink-0">Invited</span>
                    ) : (
                      <button
                        onClick={() => { onGroupInvite(gid, contactKey); setInvitedGroups(prev => new Set([...prev, gid])); }}
                        disabled={!isOnline}
                        className="text-[10px] px-1.5 py-0.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded shrink-0"
                      >
                        {isOnline ? 'Invite' : 'Offline'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Discovery ID if on network */}
          {contact.networkDiscID && (
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">On Network Now</div>
              <div className="bg-gray-800 rounded-lg px-3 py-2">
                <span className="font-mono text-[10px] text-gray-500 break-all">{contact.networkDiscID}</span>
              </div>
            </div>
          )}

          {/* Rendezvous Fallback */}
          {contact.publicKey && (
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-2">
                Rendezvous Fallback
                {rvzStatus === 'active' && (
                  <span className="flex items-center gap-0.5 text-yellow-500 text-[10px]">
                    <Radio size={10} /> searching
                  </span>
                )}
                {rvzStatus === 'queued' && (
                  <span className="text-gray-500 text-[10px]">queued</span>
                )}
                {!rvzStatus && isOnline && (
                  <span className="text-green-600 text-[10px]">not needed</span>
                )}
              </div>
              <div className="bg-gray-800 rounded-lg px-3 py-2 space-y-1">
                <div className="flex justify-between text-[10px]">
                  <span className="text-gray-500">Method</span>
                  <span className="text-gray-400">HMAC time-rotating namespace</span>
                </div>
                <div className="flex justify-between text-[10px]">
                  <span className="text-gray-500">Window</span>
                  <span className="text-gray-400">{RVZ_WINDOW / 60000} min</span>
                </div>
                <div className="text-[10px] text-gray-600 mt-1">
                  If unreachable, both devices independently derive the same namespace from the shared key + current time window and meet there to exchange new addresses.
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Actions — fixed at bottom */}
        {confirmingDelete ? (
          <div className="px-5 pb-5 shrink-0">
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
                onClick={() => { onDelete(contactKey); onClose(); }}
                className="flex-1 bg-red-700 hover:bg-red-600 text-white rounded-lg py-2 text-sm font-medium transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        ) : (
          <div className="px-5 pb-5 flex gap-2 shrink-0">
            <button
              onClick={() => { onPing(contactKey); onClose(); }}
              className="flex-1 flex items-center justify-center gap-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg py-2 text-sm transition-colors"
            >
              <Activity size={14} /> Ping
            </button>
            <button
              onClick={() => { onChat(contactKey); onClose(); }}
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
