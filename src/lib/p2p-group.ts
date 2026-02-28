import { APP_PREFIX, NSConfig, GroupInfo, GroupMember, GroupMessage, ChatMessage, CHUNK_SIZE, GroupCallInfo, GroupCallParticipant } from './types';
import { makeNSState, GroupNSState } from './p2p-types';
import { saveGroups, loadGroups, saveGroupMessages, loadGroupMessages, saveChats, saveFile } from './store';
import {
  generateGroupKey, exportGroupKey, importGroupKey,
  encryptGroupKeyForPeer, decryptGroupKeyFromPeer,
  encryptMessage, decryptMessage,
  ecdsaToECDHPrivate, ecdsaToECDHPublic, deriveSharedKey,
  arrayBufferToBase64,
} from './crypto';
import type { P2PManager } from './p2p';

// ─── NSConfig factory ────────────────────────────────────────────────────────

export function makeGroupNSConfig(groupId: string): NSConfig {
  return {
    label: `group:${groupId.slice(0, 8)}`,
    makeRouterID: (level) => `${APP_PREFIX}-group-${groupId}-${level}`,
    makeDiscID: (uuid) => `${APP_PREFIX}-group-${groupId}-${uuid}`,
    makePeerSlotID: () => `${APP_PREFIX}-group-${groupId}-p1`,
  };
}

// ─── Create ──────────────────────────────────────────────────────────────────

export async function groupCreate(mgr: P2PManager, name: string, inviteSlug?: string): Promise<string> {
  const groupId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const myFP = mgr.pubkeyFingerprint;

  // Generate group encryption key
  const groupKey = await generateGroupKey();
  const groupKeyBase64 = await exportGroupKey(groupKey);

  const info: GroupInfo = {
    id: groupId,
    name,
    createdBy: myFP,
    createdAt: Date.now(),
    members: {
      [myFP]: {
        fingerprint: myFP,
        friendlyName: mgr.friendlyName,
        publicKey: mgr.publicKeyStr,
        currentPID: mgr.persistentID,
        joinedAt: Date.now(),
        role: 'admin',
      },
    },
    inviteSlug: inviteSlug || undefined,
    groupKeyBase64,
  };

  const cfg = makeGroupNSConfig(groupId);
  const state: GroupNSState = {
    ...makeNSState(),
    groupId,
    info,
    cfg,
    messages: [],
    pendingMessages: [],
    groupKey,
    groupKeyHistory: [],
    groupPairwiseKeys: new Map(),
  };

  mgr.groups.set(groupId, state);
  groupSave(mgr);
  mgr.nsAttempt(state, cfg, 1);
  groupEmit(mgr);
  mgr.log(`Created group "${name}" (${groupId})`, 'ok');
  return groupId;
}

// ─── Join ────────────────────────────────────────────────────────────────────

export async function groupJoin(mgr: P2PManager, groupId: string, info?: GroupInfo) {
  if (mgr.groups.has(groupId)) return;

  const cfg = makeGroupNSConfig(groupId);
  const myFP = mgr.pubkeyFingerprint;

  const defaultInfo: GroupInfo = info || {
    id: groupId,
    name: `Group ${groupId.slice(0, 6)}`,
    createdBy: '',
    createdAt: Date.now(),
    members: {
      [myFP]: {
        fingerprint: myFP,
        friendlyName: mgr.friendlyName,
        publicKey: mgr.publicKeyStr,
        currentPID: mgr.persistentID,
        joinedAt: Date.now(),
        role: 'member',
      },
    },
  };

  // Ensure we're in the member list
  if (!defaultInfo.members[myFP]) {
    defaultInfo.members[myFP] = {
      fingerprint: myFP,
      friendlyName: mgr.friendlyName,
      publicKey: mgr.publicKeyStr,
      currentPID: mgr.persistentID,
      joinedAt: Date.now(),
      role: 'member',
    };
  }

  // Import group key if present in info
  let groupKey: CryptoKey | undefined;
  if (defaultInfo.groupKeyBase64) {
    try { groupKey = await importGroupKey(defaultInfo.groupKeyBase64); } catch {}
  }

  const state: GroupNSState = {
    ...makeNSState(),
    groupId,
    info: defaultInfo,
    cfg,
    messages: loadGroupMessages(groupId),
    pendingMessages: [],
    groupKey,
    groupKeyHistory: [],
    groupPairwiseKeys: new Map(),
  };

  mgr.groups.set(groupId, state);
  groupSave(mgr);
  mgr.nsAttempt(state, cfg, 1);
  groupEmit(mgr);
  mgr.log(`Joined group "${defaultInfo.name}" (${groupId})`, 'ok');
}

// ─── Join by slug ────────────────────────────────────────────────────────────

export function groupJoinBySlug(mgr: P2PManager, slug: string) {
  const groupId = slug;
  groupJoin(mgr, groupId);
}

// ─── Leave ───────────────────────────────────────────────────────────────────

export function groupLeave(mgr: P2PManager, groupId: string) {
  const state = mgr.groups.get(groupId);
  if (!state) return;

  // Leave group call if active
  if (mgr.activeGroupCallId === groupId) groupCallLeave(mgr, groupId);

  // Notify router we're leaving
  if (state.routerConn?.open) {
    state.routerConn.send({ type: 'group-leave', fingerprint: mgr.pubkeyFingerprint, friendlyName: mgr.friendlyName });
  }

  mgr.nsTeardown(state);
  mgr.groups.delete(groupId);
  // Clean up persisted messages
  try { localStorage.removeItem(`${APP_PREFIX}-group-msgs-${groupId}`); } catch {}
  groupSave(mgr);
  groupEmit(mgr);
  mgr.log(`Left group ${groupId}`, 'info');
}

// ─── Send Message ────────────────────────────────────────────────────────────

export async function groupSendMessage(mgr: P2PManager, groupId: string, content: string, type: 'text' | 'system' = 'text') {
  const state = mgr.groups.get(groupId);
  if (!state) return;

  const msg: GroupMessage = {
    id: crypto.randomUUID(),
    groupId,
    senderFP: mgr.pubkeyFingerprint,
    senderName: mgr.friendlyName,
    content,
    ts: Date.now(),
    type,
    status: 'sending',
  };

  // Encrypt with group key if available
  let wireMsg: any = msg;
  if (state.groupKey && type === 'text') {
    try {
      const { iv, ct } = await encryptMessage(state.groupKey, content);
      wireMsg = { ...msg, content: '', iv, ct, e2e: true };
      msg.e2e = true;
    } catch {
      // Fallback to plaintext
    }
  }

  state.messages.push(msg);
  saveGroupMessages(groupId, state.messages);
  groupEmit(mgr);

  if (state.isRouter) {
    msg.status = 'sent';
    groupRelayMessage(mgr, groupId, wireMsg);
    saveGroupMessages(groupId, state.messages);
    groupEmit(mgr);
  } else if (state.routerConn?.open) {
    state.routerConn.send({ type: 'group-message', msg: wireMsg });
    msg.status = 'sent';
    saveGroupMessages(groupId, state.messages);
    groupEmit(mgr);
  } else {
    msg.status = 'failed';
    saveGroupMessages(groupId, state.messages);
    groupEmit(mgr);
  }
}

// ─── Edit Message ────────────────────────────────────────────────────────────

export async function groupEditMessage(mgr: P2PManager, groupId: string, msgId: string, content: string) {
  const state = mgr.groups.get(groupId);
  if (!state) return;

  const msg = state.messages.find(m => m.id === msgId);
  if (!msg || msg.senderFP !== mgr.pubkeyFingerprint) return;

  msg.content = content;
  msg.edited = true;
  saveGroupMessages(groupId, state.messages);
  groupEmit(mgr);

  // Encrypt if group key available
  let wireContent = content;
  let iv: string | undefined;
  let ct: string | undefined;
  let e2e = false;
  if (state.groupKey) {
    try {
      const enc = await encryptMessage(state.groupKey, content);
      wireContent = '';
      iv = enc.iv;
      ct = enc.ct;
      e2e = true;
    } catch {}
  }

  const payload = { type: 'group-message-edit', msgId, content: wireContent, iv, ct, e2e, senderFP: mgr.pubkeyFingerprint };

  if (state.isRouter) {
    // Relay directly
    const relayPayload = { type: 'group-edit-relay', msgId, content: wireContent, iv, ct, e2e, senderFP: mgr.pubkeyFingerprint };
    Object.values(state.registry).forEach((r) => {
      if (r.conn && !r.isMe) { try { r.conn.send(relayPayload); } catch {} }
    });
  } else if (state.routerConn?.open) {
    state.routerConn.send(payload);
  }
}

// ─── Delete Message ──────────────────────────────────────────────────────────

export function groupDeleteMessage(mgr: P2PManager, groupId: string, msgId: string) {
  const state = mgr.groups.get(groupId);
  if (!state) return;

  const msg = state.messages.find(m => m.id === msgId);
  if (!msg || msg.senderFP !== mgr.pubkeyFingerprint) return;

  msg.deleted = true;
  msg.content = '';
  saveGroupMessages(groupId, state.messages);
  groupEmit(mgr);

  const payload = { type: 'group-message-delete', msgId, senderFP: mgr.pubkeyFingerprint };

  if (state.isRouter) {
    const relayPayload = { type: 'group-delete-relay', msgId, senderFP: mgr.pubkeyFingerprint };
    Object.values(state.registry).forEach((r) => {
      if (r.conn && !r.isMe) { try { r.conn.send(relayPayload); } catch {} }
    });
  } else if (state.routerConn?.open) {
    state.routerConn.send(payload);
  }
}

// ─── Retry Message ───────────────────────────────────────────────────────────

export async function groupRetryMessage(mgr: P2PManager, groupId: string, msgId: string) {
  const state = mgr.groups.get(groupId);
  if (!state) return;

  const msg = state.messages.find(m => m.id === msgId);
  if (!msg || msg.senderFP !== mgr.pubkeyFingerprint || msg.status !== 'failed') return;

  msg.status = 'sending';
  groupEmit(mgr);

  // Encrypt if group key available
  let wireMsg: any = msg;
  if (state.groupKey && msg.type === 'text') {
    try {
      const { iv, ct } = await encryptMessage(state.groupKey, msg.content);
      wireMsg = { ...msg, content: '', iv, ct, e2e: true };
    } catch {}
  }

  if (state.isRouter) {
    msg.status = 'sent';
    groupRelayMessage(mgr, groupId, wireMsg);
    saveGroupMessages(groupId, state.messages);
    groupEmit(mgr);
  } else if (state.routerConn?.open) {
    state.routerConn.send({ type: 'group-message', msg: wireMsg });
    msg.status = 'sent';
    saveGroupMessages(groupId, state.messages);
    groupEmit(mgr);
  } else {
    msg.status = 'failed';
    saveGroupMessages(groupId, state.messages);
    groupEmit(mgr);
  }
}

// ─── Send File ───────────────────────────────────────────────────────────────

export function groupSendFile(mgr: P2PManager, groupId: string, file: File) {
  const state = mgr.groups.get(groupId);
  if (!state) return;

  const tid = crypto.randomUUID();
  const reader = new FileReader();
  reader.onload = async () => {
    const buf = reader.result as ArrayBuffer;
    const total = Math.ceil(buf.byteLength / CHUNK_SIZE);

    const msg: GroupMessage = {
      id: crypto.randomUUID(),
      groupId,
      senderFP: mgr.pubkeyFingerprint,
      senderName: mgr.friendlyName,
      content: file.name,
      ts: Date.now(),
      type: 'file',
      name: file.name,
      tid,
      size: file.size,
      status: 'sending',
    };
    state.messages.push(msg);
    saveGroupMessages(groupId, state.messages);
    groupEmit(mgr);

    // Save locally for sender — await so UI can loadFile immediately
    await saveFile(tid, file, file.name);
    groupEmit(mgr); // re-emit so UI re-renders with file now available

    const sendChunks = (send: (payload: any) => void) => {
      send({ type: 'group-file-start', tid, name: file.name, size: file.size, total, senderFP: mgr.pubkeyFingerprint, senderName: mgr.friendlyName, msgId: msg.id });
      for (let i = 0; i < total; i++) {
        const chunk = buf.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        send({ type: 'group-file-chunk', tid, index: i, data: arrayBufferToBase64(chunk) });
      }
      send({ type: 'group-file-end', tid });
    };

    if (state.isRouter) {
      // Relay to all members
      Object.values(state.registry).forEach((r) => {
        if (r.conn && !r.isMe) {
          sendChunks((p) => { try { r.conn.send(p); } catch {} });
        }
      });
      msg.status = 'sent';
      saveGroupMessages(groupId, state.messages);
      groupEmit(mgr);
    } else if (state.routerConn?.open) {
      sendChunks((p) => state.routerConn!.send(p));
      msg.status = 'sent';
      saveGroupMessages(groupId, state.messages);
      groupEmit(mgr);
    } else {
      msg.status = 'failed';
      saveGroupMessages(groupId, state.messages);
      groupEmit(mgr);
    }
  };
  reader.readAsArrayBuffer(file);
}

// ─── Router: relay message to all members ────────────────────────────────────

export function groupRelayMessage(mgr: P2PManager, groupId: string, msg: GroupMessage) {
  const state = mgr.groups.get(groupId);
  if (!state || !state.isRouter) return;

  const payload = { type: 'group-relay', msg };
  Object.values(state.registry).forEach((r) => {
    if (r.conn && !r.isMe) {
      try { r.conn.send(payload); } catch {}
    }
  });
}

// ─── Router: handle incoming data from member ────────────────────────────────

export async function groupHandleRouterData(mgr: P2PManager, groupId: string, d: any, conn: any) {
  const state = mgr.groups.get(groupId);
  if (!state) return;

  if (d.type === 'group-message' && d.msg) {
    const msg = d.msg as GroupMessage;
    // Store locally (decrypt for router's own view if encrypted)
    if (!state.messages.some(m => m.id === msg.id)) {
      const localMsg = { ...msg };
      if (localMsg.e2e && localMsg.iv && localMsg.ct && state.groupKey) {
        try {
          localMsg.content = await decryptMessage(state.groupKey, localMsg.iv, localMsg.ct);
        } catch {
          // Try history keys
          for (const hk of (state.groupKeyHistory || [])) {
            try { localMsg.content = await decryptMessage(hk, localMsg.iv!, localMsg.ct!); break; } catch {}
          }
        }
      }
      state.messages.push(localMsg);
      saveGroupMessages(groupId, state.messages);
    }
    // Relay opaque (encrypted) to all members
    groupRelayMessage(mgr, groupId, msg);
    groupEmit(mgr);
  }

  if (d.type === 'group-message-ack' && d.id) {
    const msg = state.messages.find(m => m.id === d.id);
    if (msg) {
      if (!msg.deliveredTo) msg.deliveredTo = [];
      if (d.fingerprint && !msg.deliveredTo.includes(d.fingerprint)) {
        msg.deliveredTo.push(d.fingerprint);
        saveGroupMessages(groupId, state.messages);
        groupEmit(mgr);
        // Relay ACK to the original sender so they see blue checks
        if (msg.senderFP && msg.senderFP !== mgr.pubkeyFingerprint) {
          const senderEntry = Object.values(state.registry).find(
            r => !r.isMe && r.publicKey && state.info.members[msg.senderFP]?.publicKey === r.publicKey
          );
          if (senderEntry?.conn?.open) {
            try { senderEntry.conn.send({ type: 'group-ack-relay', id: d.id, deliveredTo: msg.deliveredTo }); } catch {}
          }
        }
      }
    }
  }

  if (d.type === 'group-message-edit') {
    // Verify sender, update local, relay
    const msg = state.messages.find(m => m.id === d.msgId);
    if (msg && msg.senderFP === d.senderFP) {
      if (d.e2e && d.iv && d.ct && state.groupKey) {
        try { msg.content = await decryptMessage(state.groupKey, d.iv, d.ct); } catch {}
      } else {
        msg.content = d.content;
      }
      msg.edited = true;
      saveGroupMessages(groupId, state.messages);
      groupEmit(mgr);
    }
    // Relay to all
    const relayPayload = { type: 'group-edit-relay', msgId: d.msgId, content: d.content, iv: d.iv, ct: d.ct, e2e: d.e2e, senderFP: d.senderFP };
    Object.values(state.registry).forEach((r) => {
      if (r.conn && !r.isMe && r.conn !== conn) { try { r.conn.send(relayPayload); } catch {} }
    });
  }

  if (d.type === 'group-message-delete') {
    const msg = state.messages.find(m => m.id === d.msgId);
    if (msg && msg.senderFP === d.senderFP) {
      msg.deleted = true;
      msg.content = '';
      saveGroupMessages(groupId, state.messages);
      groupEmit(mgr);
    }
    const relayPayload = { type: 'group-delete-relay', msgId: d.msgId, senderFP: d.senderFP };
    Object.values(state.registry).forEach((r) => {
      if (r.conn && !r.isMe && r.conn !== conn) { try { r.conn.send(relayPayload); } catch {} }
    });
  }

  // File relay: router relays file chunks to all members except sender
  if (d.type === 'group-file-start') {
    // Initialize incoming file assembly for router too
    if (!state.incomingFiles) state.incomingFiles = {};
    state.incomingFiles[d.tid] = { name: d.name, size: d.size, total: d.total, chunks: [], received: 0, senderFP: d.senderFP, senderName: d.senderName };
    // Relay to all except sender
    Object.values(state.registry).forEach((r) => {
      if (r.conn && !r.isMe && r.conn !== conn) { try { r.conn.send(d); } catch {} }
    });
  }
  if (d.type === 'group-file-chunk') {
    // Assemble locally for router
    const incoming = state.incomingFiles?.[d.tid];
    if (incoming) {
      const chunkBuf = base64ToArrayBuffer(d.data);
      incoming.chunks[d.index] = chunkBuf;
      incoming.received++;
    }
    // Relay
    Object.values(state.registry).forEach((r) => {
      if (r.conn && !r.isMe && r.conn !== conn) { try { r.conn.send(d); } catch {} }
    });
  }
  if (d.type === 'group-file-end') {
    // Assemble locally
    const incoming = state.incomingFiles?.[d.tid];
    if (incoming && incoming.received === incoming.total) {
      const blob = new Blob(incoming.chunks);
      const tid = d.tid;
      await saveFile(tid, blob, incoming.name);
      // Add message
      if (!state.messages.some(m => m.tid === tid)) {
        const fileMsg: GroupMessage = {
          id: crypto.randomUUID(),
          groupId,
          senderFP: incoming.senderFP,
          senderName: incoming.senderName,
          content: incoming.name,
          ts: Date.now(),
          type: 'file',
          name: incoming.name,
          tid,
          size: incoming.size,
          status: 'sent',
        };
        state.messages.push(fileMsg);
        saveGroupMessages(groupId, state.messages);
        groupEmit(mgr);
      }
      delete state.incomingFiles![tid];
    }
    // Relay
    Object.values(state.registry).forEach((r) => {
      if (r.conn && !r.isMe && r.conn !== conn) { try { r.conn.send(d); } catch {} }
    });
  }

  if (d.type === 'group-checkin') {
    // Update member info
    if (d.fingerprint && state.info.members[d.fingerprint]) {
      state.info.members[d.fingerprint].currentPID = d.pid;
      state.info.members[d.fingerprint].friendlyName = d.friendlyName || state.info.members[d.fingerprint].friendlyName;
      if (d.publicKey) state.info.members[d.fingerprint].publicKey = d.publicKey;
    } else if (d.fingerprint) {
      // New member joining
      state.info.members[d.fingerprint] = {
        fingerprint: d.fingerprint,
        friendlyName: d.friendlyName || 'Unknown',
        publicKey: d.publicKey,
        currentPID: d.pid,
        joinedAt: Date.now(),
        role: 'member',
      };
    }
    groupSave(mgr);

    // Send backfill + group info
    if (conn.open) {
      conn.send({ type: 'group-info-update', info: state.info });
      groupBackfill(mgr, groupId, conn, d.sinceTs || 0);
    }

    // Distribute group key to new/returning member
    if (state.groupKey && d.publicKey && conn.open) {
      try {
        const myECDH = await ecdsaToECDHPrivate(mgr.privateKey!);
        const theirECDH = await ecdsaToECDHPublic(d.publicKey);
        const pairwise = await deriveSharedKey(myECDH, theirECDH);
        const { iv, ct } = await encryptGroupKeyForPeer(state.groupKey, pairwise);
        conn.send({ type: 'group-key-distribute', iv, ct });
      } catch (e) {
        mgr.log(`[group:${groupId.slice(0,8)}] Failed to distribute group key: ${e}`, 'err');
      }
    }

    // Broadcast updated info to all
    const infoPayload = { type: 'group-info-update', info: state.info };
    Object.values(state.registry).forEach((r) => {
      if (r.conn && !r.isMe) {
        try { r.conn.send(infoPayload); } catch {}
      }
    });
    groupEmit(mgr);
  }

  if (d.type === 'group-leave' && d.fingerprint) {
    const leaverName = state.info.members[d.fingerprint]?.friendlyName || d.friendlyName || 'Unknown';
    delete state.info.members[d.fingerprint];

    // Add system message
    const sysMsg: GroupMessage = {
      id: crypto.randomUUID(),
      groupId,
      senderFP: '',
      senderName: '',
      content: `${leaverName} left the group`,
      ts: Date.now(),
      type: 'system',
      status: 'sent',
    };
    state.messages.push(sysMsg);
    saveGroupMessages(groupId, state.messages);

    groupSave(mgr);

    // Broadcast updated info + system message to all remaining
    const infoPayload = { type: 'group-info-update', info: state.info };
    const relayPayload = { type: 'group-relay', msg: sysMsg };
    Object.values(state.registry).forEach((r) => {
      if (r.conn && !r.isMe) {
        try { r.conn.send(infoPayload); } catch {}
        try { r.conn.send(relayPayload); } catch {}
      }
    });

    // Rotate key after member leaves
    groupRotateKey(mgr, groupId);
    groupEmit(mgr);
  }

  // ─── Group call signaling: router handles ──────────────────────────────────

  if (d.type === 'group-call-start') {
    const callInfo: GroupCallInfo = {
      callId: d.callId,
      groupId,
      kind: d.kind,
      startedBy: d.starterFP,
      startedAt: Date.now(),
      participants: {
        [d.starterFP]: { fingerprint: d.starterFP, friendlyName: d.starterName, pid: d.starterPID, joinedAt: Date.now() },
      },
    };
    state.activeCall = callInfo;
    // Broadcast to all members
    const signal = { type: 'group-call-signal', signalType: 'call-started', callInfo };
    Object.values(state.registry).forEach((r) => {
      if (r.conn && !r.isMe) { try { r.conn.send(signal); } catch {} }
    });
    groupEmit(mgr);
    mgr.dispatchEvent(new CustomEvent('group-call-update'));
  }

  if (d.type === 'group-call-join' && state.activeCall) {
    state.activeCall.participants[d.joinerFP] = {
      fingerprint: d.joinerFP,
      friendlyName: d.joinerName,
      pid: d.joinerPID,
      joinedAt: Date.now(),
    };
    // Broadcast to all members
    const signal = { type: 'group-call-signal', signalType: 'member-joined', joinerFP: d.joinerFP, joinerName: d.joinerName, joinerPID: d.joinerPID, callInfo: state.activeCall };
    Object.values(state.registry).forEach((r) => {
      if (r.conn && !r.isMe) { try { r.conn.send(signal); } catch {} }
    });
    groupEmit(mgr);
    mgr.dispatchEvent(new CustomEvent('group-call-update'));
  }

  if (d.type === 'group-call-leave' && state.activeCall && d.leaverFP) {
    delete state.activeCall.participants[d.leaverFP];
    const remaining = Object.keys(state.activeCall.participants).length;
    if (remaining <= 0) {
      const signal = { type: 'group-call-signal', signalType: 'call-ended', callId: state.activeCall.callId };
      Object.values(state.registry).forEach((r) => {
        if (r.conn && !r.isMe) { try { r.conn.send(signal); } catch {} }
      });
      state.activeCall = undefined;
    } else {
      const signal = { type: 'group-call-signal', signalType: 'member-left', leaverFP: d.leaverFP, callInfo: state.activeCall };
      Object.values(state.registry).forEach((r) => {
        if (r.conn && !r.isMe) { try { r.conn.send(signal); } catch {} }
      });
    }
    groupEmit(mgr);
    mgr.dispatchEvent(new CustomEvent('group-call-update'));
  }
}

// ─── Member: handle data from router ─────────────────────────────────────────

export async function groupHandleMemberData(mgr: P2PManager, groupId: string, d: any, conn: any) {
  const state = mgr.groups.get(groupId);
  if (!state) return;

  if (d.type === 'group-relay' && d.msg) {
    const msg = d.msg as GroupMessage;
    // Don't add our own messages again
    if (msg.senderFP === mgr.pubkeyFingerprint) return;
    if (!state.messages.some(m => m.id === msg.id)) {
      // Decrypt if encrypted
      const localMsg = { ...msg };
      if (localMsg.e2e && localMsg.iv && localMsg.ct && state.groupKey) {
        try {
          localMsg.content = await decryptMessage(state.groupKey, localMsg.iv, localMsg.ct);
        } catch {
          // Try history keys
          for (const hk of (state.groupKeyHistory || [])) {
            try { localMsg.content = await decryptMessage(hk, localMsg.iv!, localMsg.ct!); break; } catch {}
          }
        }
      }
      state.messages.push(localMsg);
      saveGroupMessages(groupId, state.messages);
      // ACK back to router
      if (conn?.open) {
        conn.send({ type: 'group-message-ack', id: msg.id, fingerprint: mgr.pubkeyFingerprint });
      }
      if (localMsg.type !== 'system') {
        mgr.notify(localMsg.senderName, localMsg.content?.slice(0, 100) || 'New group message', `group-${groupId}`);
      }
      groupEmit(mgr);
    }
  }

  if (d.type === 'group-edit-relay') {
    const msg = state.messages.find(m => m.id === d.msgId);
    if (msg) {
      if (d.e2e && d.iv && d.ct && state.groupKey) {
        try { msg.content = await decryptMessage(state.groupKey, d.iv, d.ct); } catch {}
      } else {
        msg.content = d.content;
      }
      msg.edited = true;
      saveGroupMessages(groupId, state.messages);
      groupEmit(mgr);
    }
  }

  if (d.type === 'group-delete-relay') {
    const msg = state.messages.find(m => m.id === d.msgId);
    if (msg) {
      msg.deleted = true;
      msg.content = '';
      saveGroupMessages(groupId, state.messages);
      groupEmit(mgr);
    }
  }

  // File assembly on member side
  if (d.type === 'group-file-start') {
    if (!state.incomingFiles) state.incomingFiles = {};
    state.incomingFiles[d.tid] = { name: d.name, size: d.size, total: d.total, chunks: [], received: 0, senderFP: d.senderFP, senderName: d.senderName };
  }
  if (d.type === 'group-file-chunk') {
    const incoming = state.incomingFiles?.[d.tid];
    if (incoming) {
      const chunkBuf = base64ToArrayBuffer(d.data);
      incoming.chunks[d.index] = chunkBuf;
      incoming.received++;
    }
  }
  if (d.type === 'group-file-end') {
    const incoming = state.incomingFiles?.[d.tid];
    if (incoming && incoming.received === incoming.total) {
      const blob = new Blob(incoming.chunks);
      const tid = d.tid;
      await saveFile(tid, blob, incoming.name);
      if (!state.messages.some(m => m.tid === tid)) {
        const fileMsg: GroupMessage = {
          id: crypto.randomUUID(),
          groupId,
          senderFP: incoming.senderFP,
          senderName: incoming.senderName,
          content: incoming.name,
          ts: Date.now(),
          type: 'file',
          name: incoming.name,
          tid,
          size: incoming.size,
          status: 'sent',
        };
        state.messages.push(fileMsg);
        saveGroupMessages(groupId, state.messages);
        mgr.notify(incoming.senderName, `Sent file: ${incoming.name}`, `group-${groupId}`);
        groupEmit(mgr);
      }
      delete state.incomingFiles![tid];
    }
  }

  if (d.type === 'group-info-update' && d.info) {
    state.info = d.info as GroupInfo;
    groupSave(mgr);
    groupEmit(mgr);
  }

  if (d.type === 'group-backfill' && d.messages) {
    const msgs = d.messages as GroupMessage[];
    let added = false;
    for (const msg of msgs) {
      if (!state.messages.some(m => m.id === msg.id)) {
        const localMsg = { ...msg };
        if (localMsg.e2e && localMsg.iv && localMsg.ct && state.groupKey) {
          try { localMsg.content = await decryptMessage(state.groupKey, localMsg.iv, localMsg.ct); } catch {
            for (const hk of (state.groupKeyHistory || [])) {
              try { localMsg.content = await decryptMessage(hk, localMsg.iv!, localMsg.ct!); break; } catch {}
            }
          }
        }
        state.messages.push(localMsg);
        added = true;
      }
    }
    if (added) {
      state.messages.sort((a, b) => a.ts - b.ts);
      saveGroupMessages(groupId, state.messages);
      groupEmit(mgr);
    }
  }

  // ACK relay from router — update sender's local deliveredTo
  if (d.type === 'group-ack-relay' && d.id && d.deliveredTo) {
    const msg = state.messages.find(m => m.id === d.id);
    if (msg) {
      msg.deliveredTo = d.deliveredTo;
      saveGroupMessages(groupId, state.messages);
      groupEmit(mgr);
    }
  }

  // Group key distribution from router
  if (d.type === 'group-key-distribute' && d.iv && d.ct) {
    try {
      const myECDH = await ecdsaToECDHPrivate(mgr.privateKey!);
      // Find the router's publicKey from registry or info
      const routerEntry = Object.values(state.registry).find(r => !r.isMe && r.publicKey);
      const routerPK = routerEntry?.publicKey || state.info.members[state.info.createdBy]?.publicKey;
      if (routerPK) {
        const theirECDH = await ecdsaToECDHPublic(routerPK);
        const pairwise = await deriveSharedKey(myECDH, theirECDH);
        const groupKey = await decryptGroupKeyFromPeer(pairwise, d.iv, d.ct);
        state.groupKey = groupKey;
        state.info.groupKeyBase64 = await exportGroupKey(groupKey);
        groupSave(mgr);
        mgr.log(`[group:${groupId.slice(0,8)}] Received group encryption key`, 'ok');
      }
    } catch (e) {
      mgr.log(`[group:${groupId.slice(0,8)}] Failed to decrypt group key: ${e}`, 'err');
    }
  }

  // Key rotation from router
  if (d.type === 'group-key-rotate' && d.iv && d.ct) {
    try {
      const myECDH = await ecdsaToECDHPrivate(mgr.privateKey!);
      const routerEntry = Object.values(state.registry).find(r => !r.isMe && r.publicKey);
      const routerPK = routerEntry?.publicKey || state.info.members[state.info.createdBy]?.publicKey;
      if (routerPK) {
        const theirECDH = await ecdsaToECDHPublic(routerPK);
        const pairwise = await deriveSharedKey(myECDH, theirECDH);
        const newKey = await decryptGroupKeyFromPeer(pairwise, d.iv, d.ct);
        // Archive old key
        if (state.groupKey) {
          if (!state.groupKeyHistory) state.groupKeyHistory = [];
          state.groupKeyHistory.push(state.groupKey);
        }
        state.groupKey = newKey;
        state.info.groupKeyBase64 = await exportGroupKey(newKey);
        groupSave(mgr);
        mgr.log(`[group:${groupId.slice(0,8)}] Group key rotated`, 'ok');
      }
    } catch (e) {
      mgr.log(`[group:${groupId.slice(0,8)}] Failed to decrypt rotated group key: ${e}`, 'err');
    }
  }

  // Kicked from group
  if (d.type === 'group-kicked') {
    mgr.log(`Kicked from group "${state.info.name}"`, 'err');
    // Leave group call if active
    if (mgr.activeGroupCallId === groupId) groupCallLeave(mgr, groupId);
    mgr.nsTeardown(state);
    mgr.groups.delete(groupId);
    try { localStorage.removeItem(`${APP_PREFIX}-group-msgs-${groupId}`); } catch {}
    groupSave(mgr);
    groupEmit(mgr);
  }

  // ─── Group call signaling from router ──────────────────────────────────────

  if (d.type === 'group-call-signal') {
    if (d.signalType === 'call-started' && d.callInfo) {
      state.activeCall = d.callInfo as GroupCallInfo;
      groupEmit(mgr);
      mgr.dispatchEvent(new CustomEvent('group-call-update'));
      // Notify user of incoming group call if not already in it
      const myFP = mgr.pubkeyFingerprint;
      if (!state.activeCall.participants[myFP]) {
        mgr.dispatchEvent(new CustomEvent('group-call-incoming', {
          detail: { groupId, groupName: state.info.name, callInfo: state.activeCall },
        }));
        mgr.notify('Group Call', `${state.info.name}: ${d.callInfo.kind} call started`, `group-call-${groupId}`);
      }
    }

    if (d.signalType === 'member-joined' && d.callInfo) {
      state.activeCall = d.callInfo as GroupCallInfo;
      groupEmit(mgr);
      mgr.dispatchEvent(new CustomEvent('group-call-update'));
    }

    if (d.signalType === 'member-left' && d.leaverFP) {
      if (d.callInfo) {
        state.activeCall = d.callInfo as GroupCallInfo;
      } else if (state.activeCall) {
        delete state.activeCall.participants[d.leaverFP];
      }
      // Close media connection to this participant if we have one
      const mc = mgr.groupCallMediaConns.get(d.leaverFP);
      if (mc) { try { mc.close(); } catch {} }
      mgr.groupCallMediaConns.delete(d.leaverFP);
      mgr.groupCallRemoteStreams.delete(d.leaverFP);
      groupEmit(mgr);
      mgr.dispatchEvent(new CustomEvent('group-call-update'));
    }

    if (d.signalType === 'call-ended') {
      state.activeCall = undefined;
      // If we were in this call, clean up
      if (mgr.activeGroupCallId === groupId) {
        groupCallLeave(mgr, groupId);
      }
      groupEmit(mgr);
      mgr.dispatchEvent(new CustomEvent('group-call-update'));
    }
  }
}

// ─── Router: send backfill to rejoining member ──────────────────────────────

export function groupBackfill(mgr: P2PManager, groupId: string, conn: any, sinceTs: number) {
  const state = mgr.groups.get(groupId);
  if (!state) return;

  const missed = state.messages.filter(m => m.ts > sinceTs);
  if (missed.length > 0 && conn.open) {
    conn.send({ type: 'group-backfill', messages: missed });
  }
}

// ─── Admin kick ──────────────────────────────────────────────────────────────

export async function groupKickMember(mgr: P2PManager, groupId: string, targetFP: string) {
  const state = mgr.groups.get(groupId);
  if (!state || !state.isRouter) return;

  // Only admin can kick
  const myFP = mgr.pubkeyFingerprint;
  if (state.info.createdBy !== myFP && state.info.members[myFP]?.role !== 'admin') return;
  if (targetFP === myFP) return; // Can't kick yourself

  const targetName = state.info.members[targetFP]?.friendlyName || 'Unknown';

  // Send kicked notification to target
  const targetEntry = Object.values(state.registry).find(r => r.publicKey && state.info.members[targetFP]?.publicKey === r.publicKey);
  if (targetEntry?.conn?.open) {
    try { targetEntry.conn.send({ type: 'group-kicked' }); } catch {}
  }

  // Remove from members
  delete state.info.members[targetFP];

  // System message
  const sysMsg: GroupMessage = {
    id: crypto.randomUUID(),
    groupId,
    senderFP: '',
    senderName: '',
    content: `${targetName} was removed from the group`,
    ts: Date.now(),
    type: 'system',
    status: 'sent',
  };
  state.messages.push(sysMsg);
  saveGroupMessages(groupId, state.messages);
  groupSave(mgr);

  // Broadcast info update + system message
  const infoPayload = { type: 'group-info-update', info: state.info };
  const relayPayload = { type: 'group-relay', msg: sysMsg };
  Object.values(state.registry).forEach((r) => {
    if (r.conn && !r.isMe) {
      try { r.conn.send(infoPayload); } catch {}
      try { r.conn.send(relayPayload); } catch {}
    }
  });

  // Rotate key
  await groupRotateKey(mgr, groupId);
  groupEmit(mgr);
}

// ─── Key Rotation ────────────────────────────────────────────────────────────

export async function groupRotateKey(mgr: P2PManager, groupId: string) {
  const state = mgr.groups.get(groupId);
  if (!state || !state.isRouter) return;

  // Archive old key
  if (state.groupKey) {
    if (!state.groupKeyHistory) state.groupKeyHistory = [];
    state.groupKeyHistory.push(state.groupKey);
  }

  // Generate new key
  const newKey = await generateGroupKey();
  state.groupKey = newKey;
  state.info.groupKeyBase64 = await exportGroupKey(newKey);
  groupSave(mgr);

  // Distribute to each remaining member
  const myECDH = await ecdsaToECDHPrivate(mgr.privateKey!);
  for (const [fp, member] of Object.entries(state.info.members)) {
    if (fp === mgr.pubkeyFingerprint) continue;
    if (!member.publicKey) continue;

    // Find their connection
    const entry = Object.values(state.registry).find(r => r.publicKey === member.publicKey && r.conn?.open);
    if (!entry?.conn) continue;

    try {
      const theirECDH = await ecdsaToECDHPublic(member.publicKey);
      const pairwise = await deriveSharedKey(myECDH, theirECDH);
      const { iv, ct } = await encryptGroupKeyForPeer(newKey, pairwise);
      entry.conn.send({ type: 'group-key-rotate', iv, ct });
    } catch {}
  }

  mgr.log(`[group:${groupId.slice(0,8)}] Group key rotated`, 'ok');
}

// ─── Invite a contact to a group ─────────────────────────────────────────────

export async function groupInvite(mgr: P2PManager, groupId: string, contactKey: string) {
  const state = mgr.groups.get(groupId);
  if (!state) return;

  const c = mgr.contacts[contactKey];
  if (!c?.conn?.open) {
    mgr.log(`Cannot invite ${contactKey} — no open connection`, 'err');
    return;
  }

  // Prepare invite payload
  const invitePayload: any = {
    type: 'group-invite',
    groupId: state.groupId,
    groupName: state.info.name,
    inviterName: mgr.friendlyName,
    inviterFP: mgr.pubkeyFingerprint,
    info: state.info,
  };

  // Include encrypted group key if available
  if (state.groupKey && c.publicKey) {
    try {
      const myECDH = await ecdsaToECDHPrivate(mgr.privateKey!);
      const theirECDH = await ecdsaToECDHPublic(c.publicKey);
      const pairwise = await deriveSharedKey(myECDH, theirECDH);
      const { iv, ct } = await encryptGroupKeyForPeer(state.groupKey, pairwise);
      invitePayload.groupKeyIV = iv;
      invitePayload.groupKeyCT = ct;
    } catch {}
  }

  c.conn.send(invitePayload);

  // Save invite as chat message in the contact's DM
  const chatMsg: ChatMessage = {
    id: crypto.randomUUID(),
    type: 'text',
    content: `Invited to group: ${state.info.name}`,
    ts: Date.now(),
    dir: 'sent',
    status: 'delivered',
  };
  if (!mgr.chats[contactKey]) mgr.chats[contactKey] = [];
  mgr.chats[contactKey].push(chatMsg);
  saveChats(mgr.chats);
  mgr.dispatchEvent(new CustomEvent('message', { detail: { pid: contactKey, msg: chatMsg } }));

  mgr.log(`Invited ${c.friendlyName} to group "${state.info.name}"`, 'ok');
}

// ─── Handle group invite received via contact DataConnection ────────────────

export async function groupHandleInvite(mgr: P2PManager, d: any) {
  // Decrypt group key from invite if present
  let groupKeyBase64: string | undefined;
  if (d.groupKeyIV && d.groupKeyCT && d.inviterFP) {
    try {
      const inviterPK = mgr.contacts[d.inviterFP]?.publicKey || d.info?.members?.[d.inviterFP]?.publicKey;
      if (inviterPK) {
        const myECDH = await ecdsaToECDHPrivate(mgr.privateKey!);
        const theirECDH = await ecdsaToECDHPublic(inviterPK);
        const pairwise = await deriveSharedKey(myECDH, theirECDH);
        const groupKey = await decryptGroupKeyFromPeer(pairwise, d.groupKeyIV, d.groupKeyCT);
        groupKeyBase64 = await exportGroupKey(groupKey);
      }
    } catch {}
  }

  // Attach decrypted key to info for groupJoin
  if (groupKeyBase64 && d.info) {
    d.info.groupKeyBase64 = groupKeyBase64;
  }

  // Save invite as received chat message from the inviter
  const inviterKey = d.inviterFP || '';
  if (inviterKey && mgr.contacts[inviterKey]) {
    const chatMsg: ChatMessage = {
      id: crypto.randomUUID(),
      type: 'text',
      content: `Group invite: ${d.groupName}`,
      ts: Date.now(),
      dir: 'recv',
      status: 'delivered',
    };
    if (!mgr.chats[inviterKey]) mgr.chats[inviterKey] = [];
    mgr.chats[inviterKey].push(chatMsg);
    saveChats(mgr.chats);
    mgr.dispatchEvent(new CustomEvent('message', { detail: { pid: inviterKey, msg: chatMsg } }));
  }

  mgr.dispatchEvent(new CustomEvent('group-invite', {
    detail: {
      groupId: d.groupId,
      groupName: d.groupName,
      inviterName: d.inviterName,
      inviterFP: d.inviterFP,
      info: d.info,
    },
  }));
}

// ─── Group Calls ────────────────────────────────────────────────────────────

export async function groupCallStart(mgr: P2PManager, groupId: string, kind: 'audio' | 'video' | 'screen') {
  const state = mgr.groups.get(groupId);
  if (!state) return;
  if (mgr.activeGroupCallId) return; // already in a group call

  const callId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const myFP = mgr.pubkeyFingerprint;

  // Acquire local media
  try {
    let stream: MediaStream;
    let cameraStream: MediaStream | undefined;
    if (kind === 'screen') {
      const displayStream = await (navigator.mediaDevices as any).getDisplayMedia({ video: true, audio: true });
      // Combine display video with mic audio so both are sent in one stream
      try {
        cameraStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream = new MediaStream([
          ...displayStream.getVideoTracks(),
          ...cameraStream.getAudioTracks(),
        ]);
      } catch {
        // Mic unavailable — use display stream as-is (may have system audio)
        stream = displayStream;
      }
      // Listen for user stopping screen share via browser UI
      displayStream.getVideoTracks()[0]?.addEventListener('ended', () => {
        groupCallLeave(mgr, groupId);
      });
    } else if (kind === 'video') {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    } else {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    mgr.groupCallLocalStream = stream;
    mgr.groupCallCameraStream = cameraStream || null;
  } catch (e: any) {
    mgr.log(`Group call failed: ${e.message}`, 'err');
    return;
  }

  const callInfo: GroupCallInfo = {
    callId,
    groupId,
    kind,
    startedBy: myFP,
    startedAt: Date.now(),
    participants: {
      [myFP]: { fingerprint: myFP, friendlyName: mgr.friendlyName, pid: mgr.persistentID, joinedAt: Date.now() },
    },
  };

  state.activeCall = callInfo;
  mgr.activeGroupCallId = groupId;
  mgr.groupCallKind = kind;

  // Send group-call-start to router (or broadcast if we are router)
  const payload = { type: 'group-call-start', callId, kind, starterFP: myFP, starterName: mgr.friendlyName, starterPID: mgr.persistentID };

  if (state.isRouter) {
    // We are the router — broadcast signal to all members
    const signal = { type: 'group-call-signal', signalType: 'call-started', callInfo };
    Object.values(state.registry).forEach((r) => {
      if (r.conn && !r.isMe) { try { r.conn.send(signal); } catch {} }
    });
  } else if (state.routerConn?.open) {
    state.routerConn.send(payload);
  }

  groupEmit(mgr);
  mgr.dispatchEvent(new CustomEvent('group-call-update'));
  mgr.log(`Started group ${kind} call in "${state.info.name}"`, 'ok');
}

export async function groupCallJoin(mgr: P2PManager, groupId: string) {
  const state = mgr.groups.get(groupId);
  if (!state?.activeCall) return;
  if (mgr.activeGroupCallId && mgr.activeGroupCallId !== groupId) return; // already in a different call

  const myFP = mgr.pubkeyFingerprint;
  if (state.activeCall.participants[myFP]) return; // already joined

  const kind = state.activeCall.kind;

  // Acquire local media — always include a video transceiver so WebRTC SDP
  // negotiation allows remote peers to send video (screen share, camera)
  try {
    let stream: MediaStream;
    let cameraStream: MediaStream | undefined;
    if (kind === 'video') {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    } else {
      // For audio and screen calls, get audio + a blank video track
      // The blank video track ensures WebRTC SDP includes a video transceiver,
      // allowing remote peers to send us their screen share or camera video
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const canvas = document.createElement('canvas');
      canvas.width = 2; canvas.height = 2;
      const blankStream = canvas.captureStream(0); // 0 fps = minimal CPU
      const blankVideoTrack = blankStream.getVideoTracks()[0];
      blankVideoTrack.enabled = false; // muted blank track
      stream = new MediaStream([...audioStream.getAudioTracks(), blankVideoTrack]);
    }
    mgr.groupCallLocalStream = stream;
    mgr.groupCallCameraStream = cameraStream || null;
  } catch (e: any) {
    mgr.log(`Group call join failed: ${e.message}`, 'err');
    return;
  }

  // Add self to participants
  state.activeCall.participants[myFP] = {
    fingerprint: myFP,
    friendlyName: mgr.friendlyName,
    pid: mgr.persistentID,
    joinedAt: Date.now(),
  };

  mgr.activeGroupCallId = groupId;
  mgr.groupCallKind = kind;

  // Notify router
  const payload = { type: 'group-call-join', joinerFP: myFP, joinerName: mgr.friendlyName, joinerPID: mgr.persistentID };
  if (state.isRouter) {
    // We are router — broadcast to all
    const signal = { type: 'group-call-signal', signalType: 'member-joined', joinerFP: myFP, joinerName: mgr.friendlyName, joinerPID: mgr.persistentID, callInfo: state.activeCall };
    Object.values(state.registry).forEach((r) => {
      if (r.conn && !r.isMe) { try { r.conn.send(signal); } catch {} }
    });
  } else if (state.routerConn?.open) {
    state.routerConn.send(payload);
  }

  // Call each existing participant via persPeer.call()
  const localStream = mgr.groupCallLocalStream!;
  for (const [fp, participant] of Object.entries(state.activeCall.participants)) {
    if (fp === myFP) continue;
    if (!participant.pid) continue;
    if (!mgr.persPeer || mgr.persPeer.destroyed) continue;

    try {
      const call = mgr.persPeer.call(participant.pid, localStream, { metadata: { groupCall: true, groupId, kind } });
      mgr.groupCallMediaConns.set(fp, call);

      call.on('stream', (remoteStream: MediaStream) => {
        mgr.groupCallRemoteStreams.set(fp, remoteStream);
        mgr.dispatchEvent(new CustomEvent('group-call-update'));
      });
      call.on('close', () => {
        mgr.groupCallMediaConns.delete(fp);
        mgr.groupCallRemoteStreams.delete(fp);
        mgr.dispatchEvent(new CustomEvent('group-call-update'));
      });
    } catch (e) {
      mgr.log(`Failed to call group participant ${fp.slice(0, 8)}: ${e}`, 'err');
    }
  }

  groupEmit(mgr);
  mgr.dispatchEvent(new CustomEvent('group-call-update'));
  mgr.log(`Joined group call in "${state.info.name}"`, 'ok');
}

export function groupCallLeave(mgr: P2PManager, groupId?: string) {
  const gid = groupId || mgr.activeGroupCallId;
  if (!gid) return;
  const state = mgr.groups.get(gid);

  // Close all media connections
  mgr.groupCallMediaConns.forEach((mc) => { try { mc.close(); } catch {} });
  mgr.groupCallMediaConns.clear();
  mgr.groupCallRemoteStreams.clear();

  // Stop local tracks
  mgr.groupCallLocalStream?.getTracks().forEach(t => t.stop());
  mgr.groupCallCameraStream?.getTracks().forEach(t => t.stop());
  mgr.groupCallLocalStream = null;
  mgr.groupCallCameraStream = null;

  const myFP = mgr.pubkeyFingerprint;

  // Notify router
  if (state) {
    const payload = { type: 'group-call-leave', leaverFP: myFP };
    if (state.isRouter) {
      // Remove self, check if call should end
      if (state.activeCall) {
        delete state.activeCall.participants[myFP];
        const remaining = Object.keys(state.activeCall.participants).length;
        if (remaining <= 0) {
          // Call ended
          const signal = { type: 'group-call-signal', signalType: 'call-ended', callId: state.activeCall.callId };
          Object.values(state.registry).forEach((r) => {
            if (r.conn && !r.isMe) { try { r.conn.send(signal); } catch {} }
          });
          state.activeCall = undefined;
        } else {
          // Notify remaining
          const signal = { type: 'group-call-signal', signalType: 'member-left', leaverFP: myFP, callInfo: state.activeCall };
          Object.values(state.registry).forEach((r) => {
            if (r.conn && !r.isMe) { try { r.conn.send(signal); } catch {} }
          });
        }
      }
    } else if (state.routerConn?.open) {
      state.routerConn.send(payload);
    }

    // Clear activeCall locally if we left
    if (state.activeCall?.participants[myFP]) {
      delete state.activeCall.participants[myFP];
    }
  }

  mgr.activeGroupCallId = null;
  groupEmit(mgr);
  mgr.dispatchEvent(new CustomEvent('group-call-update'));
  mgr.log('Left group call', 'info');
}

// ─── Group call: mid-call media controls ────────────────────────────────────

/** Replace the video track on all peer connections. Uses replaceTrack when possible,
 *  falls back to closing and reopening the MediaConnection if needed. */
function groupCallReplaceVideoTrack(mgr: P2PManager, newTrack: MediaStreamTrack | null) {
  const groupId = mgr.activeGroupCallId;
  if (!groupId) return;
  const state = mgr.groups.get(groupId);
  if (!state?.activeCall) return;
  const myFP = mgr.pubkeyFingerprint;

  // Try replaceTrack on each peer connection
  const needsReconnect: string[] = [];
  mgr.groupCallMediaConns.forEach((mc, fp) => {
    try {
      const pc = mc.peerConnection;
      if (pc) {
        const videoSender = pc.getSenders().find(s => s.track?.kind === 'video' || (s.track === null));
        if (videoSender) {
          videoSender.replaceTrack(newTrack);
          return; // success
        }
      }
    } catch {}
    // replaceTrack failed — need to reconnect
    needsReconnect.push(fp);
  });

  // Reconnect peers where replaceTrack failed
  for (const fp of needsReconnect) {
    const participant = state.activeCall!.participants[fp];
    if (!participant?.pid || !mgr.persPeer || mgr.persPeer.destroyed || !mgr.groupCallLocalStream) continue;

    // Close old connection
    const oldMc = mgr.groupCallMediaConns.get(fp);
    if (oldMc) { try { oldMc.close(); } catch {} }

    // Create new call with updated stream
    try {
      const call = mgr.persPeer.call(participant.pid, mgr.groupCallLocalStream, {
        metadata: { groupCall: true, groupId, kind: mgr.groupCallKind },
      });
      mgr.groupCallMediaConns.set(fp, call);
      call.on('stream', (remoteStream: MediaStream) => {
        mgr.groupCallRemoteStreams.set(fp, remoteStream);
        mgr.dispatchEvent(new CustomEvent('group-call-update'));
      });
      call.on('close', () => {
        mgr.groupCallMediaConns.delete(fp);
        mgr.groupCallRemoteStreams.delete(fp);
        mgr.dispatchEvent(new CustomEvent('group-call-update'));
      });
    } catch (e) {
      mgr.log(`Failed to reconnect to ${fp.slice(0, 8)}: ${e}`, 'err');
    }
  }
}

/** Toggle camera on/off during a group call. */
export async function groupCallToggleCamera(mgr: P2PManager): Promise<boolean> {
  if (!mgr.activeGroupCallId || !mgr.groupCallLocalStream) return false;

  const liveVideoTrack = mgr.groupCallLocalStream.getVideoTracks().find(t => t.readyState === 'live' && t.enabled);

  if (liveVideoTrack) {
    // Turn off: stop video track and replace with blank
    liveVideoTrack.stop();
    mgr.groupCallLocalStream.removeTrack(liveVideoTrack);
    // Add blank video track so transceiver stays open
    const canvas = document.createElement('canvas');
    canvas.width = 2; canvas.height = 2;
    const blankTrack = canvas.captureStream(0).getVideoTracks()[0];
    blankTrack.enabled = false;
    mgr.groupCallLocalStream.addTrack(blankTrack);
    groupCallReplaceVideoTrack(mgr, blankTrack);
    if (mgr.groupCallCameraStream) {
      mgr.groupCallCameraStream.getTracks().forEach(t => t.stop());
      mgr.groupCallCameraStream = null;
    }
    mgr.dispatchEvent(new CustomEvent('group-call-update'));
    return false;
  } else {
    try {
      const camStream = await navigator.mediaDevices.getUserMedia({ video: true });
      const newVideoTrack = camStream.getVideoTracks()[0];
      // Remove old blank/dead video tracks
      mgr.groupCallLocalStream.getVideoTracks().forEach(t => {
        mgr.groupCallLocalStream!.removeTrack(t);
        if (t.readyState === 'live') t.stop();
      });
      mgr.groupCallLocalStream.addTrack(newVideoTrack);
      mgr.groupCallCameraStream = camStream;
      groupCallReplaceVideoTrack(mgr, newVideoTrack);
      mgr.dispatchEvent(new CustomEvent('group-call-update'));
      return true;
    } catch (e: any) {
      mgr.log(`Failed to toggle camera: ${e.message}`, 'err');
      return false;
    }
  }
}

/** Toggle screen share during a group call. */
export async function groupCallToggleScreen(mgr: P2PManager): Promise<boolean> {
  if (!mgr.activeGroupCallId || !mgr.groupCallLocalStream) return false;

  const liveVideoTrack = mgr.groupCallLocalStream.getVideoTracks().find(t => t.readyState === 'live' && t.enabled);
  const label = liveVideoTrack?.label?.toLowerCase() || '';
  const isScreenSharing = label.includes('screen') || label.includes('window') || label.includes('tab') || label.includes('monitor');

  if (isScreenSharing) {
    // Stop screen share: replace with blank
    liveVideoTrack!.stop();
    mgr.groupCallLocalStream.removeTrack(liveVideoTrack!);
    const canvas = document.createElement('canvas');
    canvas.width = 2; canvas.height = 2;
    const blankTrack = canvas.captureStream(0).getVideoTracks()[0];
    blankTrack.enabled = false;
    mgr.groupCallLocalStream.addTrack(blankTrack);
    groupCallReplaceVideoTrack(mgr, blankTrack);
    mgr.dispatchEvent(new CustomEvent('group-call-update'));
    return false;
  } else {
    try {
      // Acquire screen
      const screenStream = await (navigator.mediaDevices as any).getDisplayMedia({ video: true, audio: false });
      const screenTrack = screenStream.getVideoTracks()[0];
      // Remove old video tracks
      mgr.groupCallLocalStream.getVideoTracks().forEach(t => {
        mgr.groupCallLocalStream!.removeTrack(t);
        if (t.readyState === 'live') t.stop();
      });
      if (mgr.groupCallCameraStream) {
        mgr.groupCallCameraStream.getTracks().forEach(t => t.stop());
        mgr.groupCallCameraStream = null;
      }
      mgr.groupCallLocalStream.addTrack(screenTrack);
      groupCallReplaceVideoTrack(mgr, screenTrack);
      // Listen for user stopping share via browser UI
      screenTrack.onended = () => {
        if (!mgr.groupCallLocalStream) return;
        mgr.groupCallLocalStream.removeTrack(screenTrack);
        const canvas = document.createElement('canvas');
        canvas.width = 2; canvas.height = 2;
        const blankTrack = canvas.captureStream(0).getVideoTracks()[0];
        blankTrack.enabled = false;
        mgr.groupCallLocalStream.addTrack(blankTrack);
        groupCallReplaceVideoTrack(mgr, blankTrack);
        mgr.dispatchEvent(new CustomEvent('group-call-update'));
      };
      mgr.dispatchEvent(new CustomEvent('group-call-update'));
      return true;
    } catch (e: any) {
      mgr.log(`Failed to toggle screen share: ${e.message}`, 'err');
      return false;
    }
  }
}

// ─── Group call: handle auto-answer for incoming PeerJS calls ───────────────

export function groupCallAutoAnswer(mgr: P2PManager, call: any) {
  if (!mgr.groupCallLocalStream) return;
  const callerPID = call.peer;
  const groupId = mgr.activeGroupCallId;
  if (!groupId) return;
  const state = mgr.groups.get(groupId);
  if (!state?.activeCall) return;

  // Find the caller's fingerprint from participants list, contact map, or PID itself
  let callerFP: string;
  const callerEntry = Object.entries(state.activeCall.participants).find(([, p]) => p.pid === callerPID);
  if (callerEntry) {
    callerFP = callerEntry[0];
  } else {
    // Participants list may not be updated yet (router relay latency) — resolve via contact map
    callerFP = mgr.contactKeyForPID(callerPID);
  }

  mgr.groupCallMediaConns.set(callerFP, call);

  // Set up handlers BEFORE answering — PeerJS may fire 'stream' synchronously
  call.on('stream', (remoteStream: MediaStream) => {
    mgr.groupCallRemoteStreams.set(callerFP, remoteStream);
    mgr.dispatchEvent(new CustomEvent('group-call-update'));
  });
  call.on('close', () => {
    mgr.groupCallMediaConns.delete(callerFP);
    mgr.groupCallRemoteStreams.delete(callerFP);
    mgr.dispatchEvent(new CustomEvent('group-call-update'));
  });

  call.answer(mgr.groupCallLocalStream);
}

// ─── Persistence ─────────────────────────────────────────────────────────────

export function groupSave(mgr: P2PManager) {
  const infos: GroupInfo[] = [];
  mgr.groups.forEach((state) => {
    infos.push(state.info);
  });
  saveGroups(infos);
}

export async function groupRestore(mgr: P2PManager) {
  const infos = loadGroups();
  for (let i = 0; i < infos.length; i++) {
    const info = infos[i];
    if (mgr.groups.has(info.id)) continue;
    const cfg = makeGroupNSConfig(info.id);

    // Import group key if persisted
    let groupKey: CryptoKey | undefined;
    if (info.groupKeyBase64) {
      try { groupKey = await importGroupKey(info.groupKeyBase64); } catch {}
    }

    const state: GroupNSState = {
      ...makeNSState(),
      groupId: info.id,
      info,
      cfg,
      messages: loadGroupMessages(info.id),
      pendingMessages: [],
      groupKey,
      groupKeyHistory: [],
      groupPairwiseKeys: new Map(),
    };
    mgr.groups.set(info.id, state);
    // Start routing for this group — stagger to avoid signaling rate-limit
    setTimeout(() => {
      if (!mgr.groups.has(info.id)) return;
      mgr.nsAttempt(state, cfg, 1);
    }, (i + 1) * 2000);
  }
  if (infos.length > 0) groupEmit(mgr);
}

// ─── Emit group update ──────────────────────────────────────────────────────

export function groupEmit(mgr: P2PManager) {
  mgr.dispatchEvent(new CustomEvent('group-update'));
}

// ─── Hook into namespace routing: intercept checkin/data on group namespaces ─

export function groupHandleNSData(mgr: P2PManager, groupId: string, d: any, conn: any) {
  const state = mgr.groups.get(groupId);
  if (!state) return;

  if (state.isRouter) {
    groupHandleRouterData(mgr, groupId, d, conn);
  } else {
    groupHandleMemberData(mgr, groupId, d, conn);
  }
}

// ─── After joining namespace, send group checkin ─────────────────────────────

export function groupSendCheckin(mgr: P2PManager, groupId: string) {
  const state = mgr.groups.get(groupId);
  if (!state || !state.routerConn?.open) return;

  const lastTs = state.messages.length > 0 ? state.messages[state.messages.length - 1].ts : 0;
  state.routerConn.send({
    type: 'group-checkin',
    fingerprint: mgr.pubkeyFingerprint,
    friendlyName: mgr.friendlyName,
    publicKey: mgr.publicKeyStr,
    pid: mgr.persistentID,
    sinceTs: lastTs,
  });
}

// ─── Helper ──────────────────────────────────────────────────────────────────

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = window.atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
