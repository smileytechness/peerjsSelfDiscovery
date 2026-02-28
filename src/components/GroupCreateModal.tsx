import React, { useState } from 'react';
import { X, Users } from 'lucide-react';
import { Contact } from '../lib/types';

interface GroupCreateModalProps {
  contacts: Record<string, Contact>;
  onCreate: (name: string, inviteSlug?: string) => string;
  onInvite: (groupId: string, contactKey: string) => void;
  onClose: () => void;
}

export function GroupCreateModal({ contacts, onCreate, onInvite, onClose }: GroupCreateModalProps) {
  const [name, setName] = useState('');
  const [inviteSlug, setInviteSlug] = useState('');
  const [step, setStep] = useState<'name' | 'invite'>('name');
  const [groupId, setGroupId] = useState<string | null>(null);
  const [invited, setInvited] = useState<Set<string>>(new Set());

  const handleCreate = () => {
    if (!name.trim()) return;
    const slug = inviteSlug.trim() || undefined;
    const id = onCreate(name.trim(), slug);
    setGroupId(id);
    setStep('invite');
  };

  const handleInvite = (contactKey: string) => {
    if (!groupId) return;
    onInvite(groupId, contactKey);
    setInvited(prev => new Set([...prev, contactKey]));
  };

  const allContacts = Object.entries(contacts).filter(
    ([_, c]) => !c.pending
  );

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 anim-fade-in">
      <div className="bg-gray-900 border border-gray-800 p-5 rounded-xl w-full max-w-sm shadow-2xl anim-scale-up">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-gray-200 flex items-center gap-2">
            <Users size={18} />
            {step === 'name' ? 'Create Group' : 'Invite Members'}
          </h3>
          <button onClick={onClose} className="p-1 hover:bg-gray-800 rounded text-gray-400 hover:text-white">
            <X size={16} />
          </button>
        </div>

        {step === 'name' ? (
          <>
            <div className="space-y-3">
              <div>
                <label className="text-[11px] text-gray-500 block mb-1">Group Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My Group"
                  className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-600"
                  autoFocus
                  onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                />
              </div>
              <div>
                <label className="text-[11px] text-gray-500 block mb-1">Invite Slug (optional)</label>
                <input
                  type="text"
                  value={inviteSlug}
                  onChange={(e) => setInviteSlug(e.target.value)}
                  placeholder="my-group-123"
                  className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-600"
                />
                <div className="text-[10px] text-gray-600 mt-1">Share this slug so others can join by name</div>
              </div>
            </div>
            <button
              onClick={handleCreate}
              disabled={!name.trim()}
              className="w-full mt-4 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold py-2 rounded text-sm transition-colors"
            >
              Create Group
            </button>
          </>
        ) : (
          <>
            <div className="text-[11px] text-gray-500 mb-3">
              Group "{name}" created. Invite contacts:
            </div>
            <div className="space-y-1.5 max-h-60 overflow-y-auto">
              {allContacts.length > 0 ? allContacts.map(([key, c]) => {
                const isOnline = !!c.conn?.open;
                return (
                  <div key={key} className="flex items-center justify-between px-2 py-1.5 rounded hover:bg-gray-800">
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
              }) : (
                <div className="text-[11px] text-gray-600 text-center py-4">No contacts to invite</div>
              )}
            </div>
            <button
              onClick={onClose}
              className="w-full mt-4 bg-gray-700 hover:bg-gray-600 text-gray-300 font-semibold py-2 rounded text-sm transition-colors"
            >
              Done
            </button>
          </>
        )}
      </div>
    </div>
  );
}
