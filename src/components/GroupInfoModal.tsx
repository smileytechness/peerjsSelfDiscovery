import React, { useState } from 'react';
import { X, Users, Crown, UserMinus, Key, UserPlus, ChevronDown, ChevronRight, Shield, Ban } from 'lucide-react';
import { GroupInfo, Contact } from '../lib/types';
import { clsx } from 'clsx';

interface GroupInfoModalProps {
  info: GroupInfo;
  isRouter: boolean;
  level: number;
  myFingerprint: string;
  contacts: Record<string, Contact>;
  onLeave: () => void;
  onInvite: (contactKey: string) => void;
  onKick?: (targetFP: string) => void;
  onClose: () => void;
}

export function GroupInfoModal({ info, isRouter, level, myFingerprint, contacts, onLeave, onInvite, onKick, onClose }: GroupInfoModalProps) {
  const members = Object.values(info.members);
  const memberFPs = new Set(Object.keys(info.members));
  const [showInvite, setShowInvite] = useState(false);
  const [invited, setInvited] = useState<Set<string>>(new Set());

  // Contacts not already in the group
  const invitableContacts = Object.entries(contacts).filter(
    ([key, c]) => !c.pending && !memberFPs.has(c.fingerprint || key)
  );

  const handleInvite = (key: string) => {
    onInvite(key);
    setInvited(prev => new Set([...prev, key]));
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 anim-fade-in">
      <div className="bg-gray-900 border border-gray-800 p-5 rounded-xl w-full max-w-sm shadow-2xl anim-scale-up max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between mb-4 shrink-0">
          <h3 className="text-base font-semibold text-gray-200 flex items-center gap-2">
            <Users size={18} />
            {info.name}
          </h3>
          <button onClick={onClose} className="p-1 hover:bg-gray-800 rounded text-gray-400 hover:text-white">
            <X size={16} />
          </button>
        </div>

        <div className="overflow-y-auto min-h-0 flex-1">
          {/* Group details */}
          <div className="space-y-2 text-[11px] mb-4">
            <div className="flex justify-between">
              <span className="text-gray-500">Group ID</span>
              <span className="font-mono text-gray-400">{info.id}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Created</span>
              <span className="text-gray-400">{new Date(info.createdAt).toLocaleDateString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">My role</span>
              <span className="text-gray-400">{isRouter ? `Router L${level}` : `Peer L${level}`}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Encryption</span>
              <span className={clsx('flex items-center gap-1', info.groupKeyBase64 ? 'text-green-400' : 'text-gray-600')}>
                <Shield size={10} />
                {info.groupKeyBase64 ? 'E2E Encrypted' : 'Not encrypted'}
              </span>
            </div>
            {info.inviteSlug && (
              <div className="flex justify-between">
                <span className="text-gray-500">Invite slug</span>
                <span className="font-mono text-cyan-400">{info.inviteSlug}</span>
              </div>
            )}
          </div>

          {/* Members */}
          <div className="border-t border-gray-800 pt-3">
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">
              Members ({members.length})
            </div>
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {members.map((m) => {
                const isMe = m.fingerprint === myFingerprint;
                const isAdmin = info.members[myFingerprint]?.role === 'admin' || info.createdBy === myFingerprint;
                const canKick = isAdmin && !isMe && onKick;
                return (
                  <div key={m.fingerprint} className="flex items-center gap-2 px-2 py-1.5 rounded bg-gray-800/50">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-gray-200 truncate flex items-center gap-1">
                        {m.friendlyName}
                        {isMe && (
                          <span className="text-[9px] text-blue-400 bg-blue-900/30 px-1 rounded">you</span>
                        )}
                        {m.role === 'admin' && (
                          <Crown size={10} className="text-yellow-400 shrink-0" />
                        )}
                      </div>
                      <div className="text-[10px] font-mono text-purple-400 truncate flex items-center gap-0.5">
                        <Key size={8} className="shrink-0" />
                        {m.fingerprint}
                      </div>
                    </div>
                    {canKick && (
                      <button
                        onClick={() => onKick!(m.fingerprint)}
                        className="p-1 hover:bg-red-900/60 rounded text-gray-500 hover:text-red-400 shrink-0"
                        title="Remove from group"
                      >
                        <Ban size={12} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Invite Contacts */}
          {invitableContacts.length > 0 && (
            <div className="border-t border-gray-800 pt-3 mt-3">
              <button
                onClick={() => setShowInvite(!showInvite)}
                className="flex items-center gap-1.5 text-[10px] text-gray-500 uppercase tracking-wider mb-2 hover:text-gray-300 transition-colors w-full"
              >
                {showInvite ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                <UserPlus size={10} />
                Invite Contacts ({invitableContacts.length})
              </button>
              {showInvite && (
                <div className="space-y-1.5 max-h-40 overflow-y-auto">
                  {invitableContacts.map(([key, c]) => {
                    const isOnline = !!c.conn?.open;
                    return (
                      <div key={key} className="flex items-center justify-between px-2 py-1.5 rounded bg-gray-800/50">
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isOnline ? 'bg-green-500' : 'bg-gray-600'}`} />
                          <span className={`text-sm truncate ${isOnline ? 'text-gray-200' : 'text-gray-500'}`}>{c.friendlyName}</span>
                          {!isOnline && <span className="text-[9px] text-gray-600 shrink-0">(offline)</span>}
                        </div>
                        {invited.has(key) ? (
                          <span className="text-[10px] text-green-400 shrink-0">Invited</span>
                        ) : (
                          <button
                            onClick={() => handleInvite(key)}
                            disabled={!isOnline}
                            className="text-[10px] px-2 py-0.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded shrink-0"
                          >
                            Invite
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="mt-4 flex gap-2 shrink-0">
          <button
            onClick={() => { onLeave(); onClose(); }}
            className="flex-1 bg-red-900/60 hover:bg-red-900 text-red-300 font-semibold py-2 rounded text-sm transition-colors flex items-center justify-center gap-1"
          >
            <UserMinus size={14} /> Leave Group
          </button>
        </div>
      </div>
    </div>
  );
}
