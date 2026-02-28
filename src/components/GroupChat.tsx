import React, { useState, useEffect, useRef } from 'react';
import { GroupMessage, GroupInfo, GroupCallInfo } from '../lib/types';
import { loadFile, loadFileMeta } from '../lib/store';
import { Send, Paperclip, ArrowLeft, Info, Users, Pencil, Trash2, RotateCcw, Check, AlertCircle, Clock, Download, File, Shield, Phone, Video, Monitor, PhoneCall } from 'lucide-react';
import { clsx } from 'clsx';

interface GroupChatProps {
  groupId: string;
  info: GroupInfo;
  messages: GroupMessage[];
  myFingerprint: string;
  activeCall?: GroupCallInfo;
  inGroupCall?: boolean;
  onSendMessage: (content: string) => void;
  onSendFile: (file: File) => void;
  onEditMessage: (msgId: string, content: string) => void;
  onDeleteMessage: (msgId: string) => void;
  onRetryMessage: (msgId: string) => void;
  onCall?: (kind: 'audio' | 'video' | 'screen') => void;
  onJoinCall?: () => void;
  onBack: () => void;
  onShowInfo: () => void;
}

function StatusIcon({ status, deliveredTo, otherMemberCount }: { status?: string; deliveredTo?: string[]; otherMemberCount: number }) {
  if (status === 'failed') return <AlertCircle size={11} className="text-red-400" />;
  if (status === 'sending') return <Clock size={11} className="text-gray-600" />;
  if (deliveredTo && deliveredTo.length > 0) {
    const allDelivered = deliveredTo.length >= otherMemberCount;
    return (
      <span className="inline-flex items-center" title={`Delivered to ${deliveredTo.length}/${otherMemberCount}`}>
        <Check size={11} className={allDelivered ? 'text-blue-400' : 'text-gray-400'} />
        <Check size={11} className={allDelivered ? 'text-blue-400' : 'text-gray-400'} style={{ marginLeft: -6 }} />
      </span>
    );
  }
  if (status === 'sent') return <Check size={11} className="text-gray-400" />;
  return null;
}

const GroupMessageItem: React.FC<{
  msg: GroupMessage;
  isMine: boolean;
  otherMemberCount: number;
  onEdit: (msgId: string, content: string) => void;
  onDelete: (msgId: string) => void;
  onRetry: (msgId: string) => void;
}> = ({ msg, isMine, otherMemberCount, onEdit, onDelete, onRetry }) => {
  const [fileData, setFileData] = useState<string | null>(null);
  const [meta, setMeta] = useState<any>(null);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(msg.content || '');
  const [showActions, setShowActions] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (msg.type === 'file' && msg.tid) {
      loadFile(msg.tid).then(setFileData);
      setMeta(loadFileMeta(msg.tid));
    }
  }, [msg]);

  useEffect(() => {
    if (editing && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [editing]);

  const canEdit = isMine && msg.type === 'text' && !msg.deleted && msg.status !== 'failed';

  const submitEdit = () => {
    if (editValue.trim() && editValue.trim() !== msg.content) {
      onEdit(msg.id, editValue.trim());
    }
    setEditing(false);
  };

  if (msg.type === 'system') {
    return (
      <div className="flex justify-center mb-2">
        <span className="text-[11px] text-gray-500 bg-gray-800/50 px-3 py-1 rounded-full">
          {msg.content}
        </span>
      </div>
    );
  }

  if (msg.deleted) {
    return (
      <div className={clsx('flex mb-1', isMine ? 'justify-end' : 'justify-start')}>
        <span className="text-[11px] italic text-gray-600 px-3 py-1 bg-gray-800/50 rounded-lg">
          {isMine ? 'You deleted this message' : 'Message deleted'}
        </span>
      </div>
    );
  }

  return (
    <div
      className={clsx('flex flex-col mb-2 max-w-[75%]', isMine ? 'self-end items-end' : 'self-start items-start')}
      onMouseEnter={() => isMine && setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      {!isMine && (
        <span className="text-[10px] text-purple-400 font-semibold mb-0.5 pl-1">{msg.senderName}</span>
      )}

      {/* Action buttons (hover, own messages only) */}
      {isMine && showActions && !editing && !msg.deleted && (
        <div className="flex gap-1 mb-1">
          {canEdit && (
            <button
              onClick={() => { setEditValue(msg.content || ''); setEditing(true); }}
              className="p-1 bg-gray-700 hover:bg-gray-600 rounded text-gray-400 hover:text-white"
              title="Edit"
            >
              <Pencil size={11} />
            </button>
          )}
          <button
            onClick={() => onDelete(msg.id)}
            className="p-1 bg-gray-700 hover:bg-red-900/60 rounded text-gray-400 hover:text-red-400"
            title="Delete"
          >
            <Trash2 size={11} />
          </button>
        </div>
      )}

      {/* Bubble */}
      {editing ? (
        <div className="flex flex-col gap-1 w-full">
          <textarea
            ref={editRef}
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitEdit(); }
              if (e.key === 'Escape') setEditing(false);
            }}
            className="bg-blue-700 text-white text-sm rounded-lg p-2 resize-none focus:outline-none focus:ring-1 focus:ring-blue-400 min-w-[120px]"
            rows={2}
          />
          <div className="flex gap-1 justify-end">
            <button onClick={() => setEditing(false)} className="text-[10px] text-gray-400 hover:text-white px-2 py-0.5 bg-gray-700 rounded">Cancel</button>
            <button onClick={submitEdit} className="text-[10px] text-white px-2 py-0.5 bg-blue-600 hover:bg-blue-700 rounded">Save</button>
          </div>
        </div>
      ) : (
        <div
          className={clsx(
            'p-2 rounded-lg text-sm break-words',
            isMine ? 'bg-blue-600 text-white rounded-br-none' : 'bg-gray-800 text-gray-200 rounded-bl-none'
          )}
        >
          {msg.type === 'file' ? (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2 font-semibold">
                <File size={16} /> {msg.name}
              </div>
              <div className="text-xs opacity-70">
                {(msg.size ? (msg.size / 1024).toFixed(1) : '0')} KB
              </div>
              {fileData ? (
                <div className="mt-2">
                  {msg.name?.match(/\.(jpg|jpeg|png|gif|webp)$/i) ? (
                    <img src={fileData} alt={msg.name} className="max-w-[200px] rounded" />
                  ) : (
                    <a
                      href={fileData}
                      download={msg.name}
                      className="flex items-center gap-1 bg-gray-700 hover:bg-gray-600 px-2 py-1 rounded text-xs text-white w-fit"
                    >
                      <Download size={12} /> Download
                    </a>
                  )}
                </div>
              ) : (
                <div className="text-xs italic opacity-50">Loading file...</div>
              )}
            </div>
          ) : (
            <>
              {msg.content}
              {msg.edited && <span className="text-[9px] opacity-50 ml-1">(edited)</span>}
            </>
          )}
        </div>
      )}

      {/* Timestamp + status */}
      <div className="text-[10px] text-gray-500 mt-0.5 flex items-center gap-1">
        <span>{new Date(msg.ts).toLocaleTimeString()}</span>
        {msg.e2e && <Shield size={9} className="text-green-500" title="End-to-end encrypted" />}
        {isMine && <StatusIcon status={msg.status} deliveredTo={msg.deliveredTo} otherMemberCount={otherMemberCount} />}
        {isMine && msg.status === 'failed' && (
          <button
            onClick={() => onRetry(msg.id)}
            className="flex items-center gap-0.5 text-red-400 hover:text-red-300 ml-1"
            title="Retry"
          >
            <RotateCcw size={10} /> retry
          </button>
        )}
      </div>
    </div>
  );
};

export function GroupChat({ groupId, info, messages, myFingerprint, activeCall, inGroupCall, onSendMessage, onSendFile, onEditMessage, onDeleteMessage, onRetryMessage, onCall, onJoinCall, onBack, onShowInfo }: GroupChatProps) {
  const [input, setInput] = useState('');
  const [showCallMenu, setShowCallMenu] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = () => {
    if (!input.trim()) return;
    onSendMessage(input);
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      onSendFile(e.target.files[0]);
    }
  };

  const memberCount = Object.keys(info.members).length;
  const otherMemberCount = memberCount - 1; // exclude sender for delivery tracking

  return (
    <div className="flex flex-col h-full bg-gray-900 anim-slide-right">
      {/* Header */}
      <div className="p-3 border-b border-gray-800 bg-gray-900 flex justify-between items-center shrink-0">
        <div className="flex items-center gap-2">
          <button onClick={onBack} className="md:hidden p-1.5 hover:bg-gray-800 rounded text-gray-400 hover:text-white">
            <ArrowLeft size={20} />
          </button>
          <button onClick={onShowInfo} className="text-left hover:opacity-75 transition-opacity">
            <div className="font-semibold text-gray-200">{info.name}</div>
            <div className="text-[11px] text-gray-500 flex items-center gap-1">
              <Users size={10} /> {memberCount} member{memberCount !== 1 ? 's' : ''}
              {info.groupKeyBase64 && <Shield size={9} className="text-green-500 ml-1" />}
            </div>
          </button>
        </div>
        <div className="flex items-center gap-1">
          {inGroupCall && (
            <span className="text-[10px] text-green-400 bg-green-900/30 px-2 py-0.5 rounded-full font-semibold flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" /> In Call
            </span>
          )}
          {onCall && !activeCall && !inGroupCall && (
            <div className="relative">
              <button
                onClick={() => setShowCallMenu(!showCallMenu)}
                className="p-2 hover:bg-gray-800 rounded text-gray-400 hover:text-green-400"
                title="Start group call"
              >
                <Phone size={17} />
              </button>
              {showCallMenu && (
                <div className="absolute right-0 top-full mt-1 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-10 py-1 min-w-[140px]">
                  <button onClick={() => { onCall('audio'); setShowCallMenu(false); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700 hover:text-white">
                    <Phone size={14} /> Audio
                  </button>
                  <button onClick={() => { onCall('video'); setShowCallMenu(false); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700 hover:text-white">
                    <Video size={14} /> Video
                  </button>
                  <button onClick={() => { onCall('screen'); setShowCallMenu(false); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700 hover:text-white">
                    <Monitor size={14} /> Screen
                  </button>
                </div>
              )}
            </div>
          )}
          <button onClick={onShowInfo} className="p-2 hover:bg-gray-800 rounded text-gray-400 hover:text-white" title="Group Info">
            <Info size={17} />
          </button>
        </div>
      </div>

      {/* Join Call banner */}
      {activeCall && !inGroupCall && onJoinCall && (
        <div className="shrink-0 bg-purple-900/60 border-b border-purple-800/50 px-4 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-purple-200 text-sm">
            <PhoneCall size={14} className="text-purple-400 animate-pulse" />
            <span>{activeCall.kind} call in progress ({Object.keys(activeCall.participants).length} participants)</span>
          </div>
          <button
            onClick={onJoinCall}
            className="bg-green-600 hover:bg-green-700 text-white text-xs font-semibold px-3 py-1 rounded transition-colors"
          >
            Join
          </button>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-1">
        {[...messages].sort((a, b) => a.ts - b.ts).map((msg) => (
          <GroupMessageItem
            key={msg.id}
            msg={msg}
            isMine={msg.senderFP === myFingerprint}
            otherMemberCount={otherMemberCount}
            onEdit={onEditMessage}
            onDelete={onDeleteMessage}
            onRetry={onRetryMessage}
          />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-3 border-t border-gray-800 bg-gray-900 flex gap-2 items-center shrink-0">
        <button
          onClick={() => fileInputRef.current?.click()}
          className="p-2 hover:bg-gray-800 rounded text-gray-400 hover:text-white"
          title="Send file"
        >
          <Paperclip size={20} />
        </button>
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileSelect}
          className="hidden"
        />
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          className="flex-1 bg-gray-800 border border-gray-700 rounded p-2 text-gray-200 text-sm focus:outline-none focus:border-blue-500 resize-none h-10"
        />
        <button
          onClick={handleSend}
          className="p-2 bg-blue-600 hover:bg-blue-700 rounded text-white"
        >
          <Send size={20} />
        </button>
      </div>
    </div>
  );
}
