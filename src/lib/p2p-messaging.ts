import { DataConnection } from 'peerjs';
import { APP_PREFIX, ChatMessage, CHUNK_SIZE, Contact } from './types';
import { importPublicKey, verifySignature, encryptMessage, decryptMessage, signData } from './crypto';
import { saveContacts, saveChats, saveFile } from './store';
import type { P2PManager } from './p2p';

export async function handlePersistentData(mgr: P2PManager, d: any, conn: DataConnection) {
    const pid = conn.peer;
    const ck = mgr.contactKeyForPID(pid); // fingerprint key or PID fallback

    if (['request', 'confirm'].includes(d.type)) {
      return mgr.handleHandshakeData(d, conn);
    }

    if (d.type === 'hello') {
      // If they send a publicKey, compute fingerprint and potentially rekey
      let contactKey = ck;
      if (d.publicKey) {
        const fp = await mgr.computeFingerprint(d.publicKey);
        // Check for existing contact under a different key with same pubkey
        const dupKey = mgr.findContactByPublicKey(d.publicKey, contactKey);
        if (dupKey && dupKey !== contactKey) mgr.migrateContact(dupKey, fp || contactKey);

        if (fp) {
          // If contact was stored under PID (pending), rekey to fingerprint
          if (contactKey !== fp && mgr.contacts[contactKey]) {
            const oldContact = mgr.contacts[contactKey];
            const oldChats = mgr.chats[contactKey];
            delete mgr.contacts[contactKey];
            mgr.contacts[fp] = { ...oldContact, fingerprint: fp, currentPID: pid, knownPIDs: [pid] };
            if (oldChats) {
              mgr.chats[fp] = oldChats;
              delete mgr.chats[contactKey];
            }
            // Migrate lastRead
            try {
              const lr = JSON.parse(localStorage.getItem(`${APP_PREFIX}-lastread`) || '{}');
              if (lr[contactKey]) { lr[fp] = lr[contactKey]; delete lr[contactKey]; localStorage.setItem(`${APP_PREFIX}-lastread`, JSON.stringify(lr)); }
            } catch {}
            mgr.dispatchEvent(new CustomEvent('contact-migrated', { detail: { oldPID: contactKey, newPID: fp } }));
          } else if (!mgr.contacts[fp]) {
            // Brand new contact
            mgr.contacts[fp] = { friendlyName: d.friendlyname, fingerprint: fp, currentPID: pid, knownPIDs: [pid], discoveryID: null, discoveryUUID: '' };
          }
          // Update PID mappings
          mgr.pidToFP.set(pid, fp);
          mgr.contacts[fp].currentPID = pid;
          if (!mgr.contacts[fp].knownPIDs?.includes(pid)) {
            mgr.contacts[fp].knownPIDs = [...(mgr.contacts[fp].knownPIDs || []), pid];
          }
          contactKey = fp;
        }
      }

      const isNew = !mgr.contacts[contactKey] || !mgr.contacts[contactKey].conn;

      if (d.publicKey && d.signature && d.ts) {
        if (window.crypto?.subtle) {
          try {
            const key = await importPublicKey(d.publicKey);
            const valid = await verifySignature(key, d.signature, d.ts);
            if (!valid) {
              mgr.log(`Invalid signature from ${d.friendlyname}`, 'err');
              conn.close();
              return;
            }
            if (!mgr.contacts[contactKey]) mgr.contacts[contactKey] = { friendlyName: d.friendlyname, discoveryID: null, discoveryUUID: '', currentPID: pid, conn, publicKey: d.publicKey };
            mgr.contacts[contactKey].publicKey = d.publicKey;
            mgr.log(`Verified identity for ${d.friendlyname}`, 'ok');
            mgr.getOrDeriveSharedKey(contactKey);
          } catch {
            mgr.log(`Identity verification failed for ${d.friendlyname}`, 'err');
          }
        } else {
          mgr.log(`No secure context — skipping identity check for ${d.friendlyname}`, 'info');
        }
      }

      if (!mgr.contacts[contactKey]) mgr.contacts[contactKey] = { friendlyName: d.friendlyname, discoveryID: null, discoveryUUID: '', currentPID: pid, conn };
      mgr.contacts[contactKey].conn = conn;
      mgr.contacts[contactKey].friendlyName = d.friendlyname;
      mgr.contacts[contactKey].lastSeen = Date.now();
      mgr.contacts[contactKey].currentPID = pid;
      delete mgr.contacts[contactKey].pending;
      if (!mgr.chats[contactKey]) mgr.chats[contactKey] = [];

      if (isNew) {
        const ts = Date.now().toString();
        let signature = '';
        if (mgr.privateKey) {
          signature = await signData(mgr.privateKey, ts);
        }
        conn.send({
          type: 'hello',
          friendlyname: mgr.friendlyName,
          publicKey: mgr.publicKeyStr,
          ts,
          signature
        });
      }
      // Clean up failure counts for all known PIDs of this contact
      delete mgr.connectFailures[pid];
      const contact = mgr.contacts[contactKey];
      if (contact?.knownPIDs) {
        contact.knownPIDs.forEach(oldPID => delete mgr.connectFailures[oldPID]);
      }

      // Handle duplicate connections: if we already have an open conn that's different
      // from this one, close the older one (keep the newer incoming)
      if (contact?.conn && contact.conn !== conn && contact.conn.open) {
        try { contact.conn.close(); } catch {}
      }
      if (contact) contact.conn = conn;

      saveContacts(mgr.contacts);
      mgr.emitPeerListUpdate();
      // Flush any queued messages now that we're connected
      mgr.flushMessageQueue(contactKey);
      // Contact connected — clean up any active rendezvous namespace for them
      mgr.rvzContactConnected(contactKey);
      mgr.log(`Hello from ${d.friendlyname}`, 'ok');
    }

    if (d.type === 'message') {
      if (!mgr.chats[ck]) mgr.chats[ck] = [];
      let content = d.content || '';
      if (d.e2e && d.ct && d.iv) {
        try {
          const sk = await mgr.getOrDeriveSharedKey(ck);
          const contact = mgr.contacts[ck];
          if (sk && contact?.publicKey) {
            const pubKey = await importPublicKey(contact.publicKey);
            const sigValid = await verifySignature(pubKey, d.sig, d.ct);
            if (sigValid) {
              content = await decryptMessage(sk.key, d.iv, d.ct);
            } else {
              mgr.log(`E2E signature mismatch from ${contact.friendlyName} — showing as unverified`, 'err');
              content = '[unverified encrypted message]';
            }
          } else {
            content = '[encrypted — no shared key]';
          }
        } catch (e) {
          mgr.log(`E2E decrypt failed from ${pid}: ${e}`, 'err');
          content = '[encrypted — decryption failed]';
        }
      }
      const msg: ChatMessage = { id: d.id || crypto.randomUUID(), dir: 'recv', content, ts: d.ts, type: 'text' };
      mgr.chats[ck].push(msg);
      saveChats(mgr.chats);
      if (conn.open) conn.send({ type: 'message-ack', id: d.id });
      const fname = mgr.contacts[ck]?.friendlyName || 'Someone';
      mgr.notify(fname, content.slice(0, 100) || 'New message', `msg-${ck}`);
      mgr.dispatchEvent(new CustomEvent('message', { detail: { pid: ck, msg } }));
    }

    if (d.type === 'message-ack') {
      const msgs = mgr.chats[ck];
      if (msgs) {
        const msg = msgs.find(m => m.id === d.id && m.dir === 'sent');
        if (msg) {
          msg.status = 'delivered';
          saveChats(mgr.chats);
          mgr.dispatchEvent(new CustomEvent('message', { detail: { pid: ck } }));
        }
      }
    }

    if (d.type === 'message-edit') {
      const msgs = mgr.chats[ck];
      if (msgs) {
        const msg = msgs.find(m => m.id === d.id);
        if (msg && !msg.deleted) {
          let editContent = d.content || '';
          if (d.e2e && d.ct && d.iv) {
            try {
              const sk = await mgr.getOrDeriveSharedKey(ck);
              const contact = mgr.contacts[ck];
              if (sk && contact?.publicKey) {
                const pubKey = await importPublicKey(contact.publicKey);
                const sigValid = await verifySignature(pubKey, d.sig, d.ct);
                if (sigValid) {
                  editContent = await decryptMessage(sk.key, d.iv, d.ct);
                } else {
                  editContent = '[unverified edit]';
                }
              } else {
                editContent = '[encrypted edit — no shared key]';
              }
            } catch {
              editContent = '[encrypted edit — decryption failed]';
            }
          }
          msg.content = editContent;
          msg.edited = true;
          saveChats(mgr.chats);
          mgr.dispatchEvent(new CustomEvent('message', { detail: { pid: ck } }));
        }
      }
    }

    if (d.type === 'message-delete') {
      const msgs = mgr.chats[ck];
      if (msgs) {
        let msg = msgs.find(m => m.id === d.id);
        if (!msg && d.tid) msg = msgs.find(m => m.tid === d.tid);
        if (msg) {
          msg.content = '';
          msg.deleted = true;
          saveChats(mgr.chats);
          mgr.dispatchEvent(new CustomEvent('message', { detail: { pid: ck } }));
        }
      }
    }

    // Call-notify: reliable pre-call heads-up via DataConnection.
    // Ensures our signaling is alive so the PeerJS MediaConnection offer can arrive.
    if (d.type === 'call-notify') {
      const fname = mgr.contacts[ck]?.friendlyName || pid;
      mgr.log(`Call-notify from ${fname} (${d.kind}) — ensuring signaling alive`, 'info');
      // If signaling is dead, reconnect so PeerJS can deliver the actual call
      if (mgr.persPeer?.disconnected) {
        mgr.log('Signaling dead on call-notify — reconnecting', 'info');
        mgr.schedulePersReconnect();
      }
      // Dispatch event so UI can pre-warm (notification + ring even before MediaConnection arrives)
      mgr.notify(`Incoming ${d.kind || 'video'} call`, `${fname} is calling`, `call-${ck}`);
      mgr.dispatchEvent(new CustomEvent('call-notify', { detail: { contactKey: ck, kind: d.kind, fname } }));
      return;
    }

    // Call ACK messages
    if (d.type === 'call-received') {
      mgr.dispatchEvent(new CustomEvent('call-received', { detail: { contactKey: ck, kind: d.kind } }));
    }
    if (d.type === 'call-answered') {
      mgr.dispatchEvent(new CustomEvent('call-answered', { detail: { contactKey: ck, kind: d.kind } }));
    }
    if (d.type === 'call-rejected') {
      mgr.dispatchEvent(new CustomEvent('call-rejected', { detail: { contactKey: ck, kind: d.kind } }));
    }

    // Connection request ACK
    if (d.type === 'request-received') {
      mgr.dispatchEvent(new CustomEvent('connect-request-acked', { detail: { contactKey: ck } }));
    }

    // Group invite via contact DataConnection
    if (d.type === 'group-invite') {
      mgr.groupHandleInvite(d);
      return;
    }

    if (d.type === 'file-start') {
      mgr.incomingFiles[d.tid] = { tid: d.tid, name: d.name, size: d.size, total: d.total, chunks: [], received: 0 };
      mgr.log(`Receiving: ${d.name}`, 'info');
    }
    if (d.type === 'file-chunk') {
      const f = mgr.incomingFiles[d.tid];
      if (f) {
        f.chunks[d.index] = d.chunk;
        f.received++;
        mgr.dispatchEvent(new CustomEvent('file-progress', { detail: { tid: d.tid, progress: f.received / f.total, name: f.name } }));
      }
    }
    if (d.type === 'file-end') {
      const f = mgr.incomingFiles[d.tid];
      if (!f) return;
      const blob = new Blob(f.chunks);
      const ts = Date.now();
      saveFile(d.tid, blob, f.name, ts).then(() => {
        if (!mgr.chats[ck]) mgr.chats[ck] = [];
        const msg: ChatMessage = { id: crypto.randomUUID(), dir: 'recv', type: 'file', name: f.name, tid: d.tid, size: f.size, ts };
        mgr.chats[ck].push(msg);
        saveChats(mgr.chats);
        delete mgr.incomingFiles[d.tid];
        if (conn.open) conn.send({ type: 'file-ack', tid: d.tid });
        const fileFname = mgr.contacts[ck]?.friendlyName || 'Someone';
        mgr.notify(fileFname, `Sent you a file: ${f.name}`, `file-${ck}`);
        mgr.log(`File received: ${f.name}`, 'ok');
        mgr.dispatchEvent(new CustomEvent('message', { detail: { pid: ck, msg } }));
      });
    }

    if (d.type === 'file-ack') {
      const msgs = mgr.chats[ck];
      if (msgs) {
        const msg = msgs.find(m => m.tid === d.tid && m.dir === 'sent');
        if (msg) {
          msg.status = 'delivered';
          saveChats(mgr.chats);
          mgr.dispatchEvent(new CustomEvent('message', { detail: { pid: ck } }));
        }
      }
    }

    if (d.type === 'name-update' && d.name) {
      if (mgr.contacts[ck]) {
        mgr.contacts[ck].friendlyName = d.name;
        saveContacts(mgr.contacts);
        mgr.emitPeerListUpdate();
        mgr.log(`${d.name} updated their name`, 'info');
      }
    }
  }

export async function flushMessageQueue(mgr: P2PManager, contactKey: string) {
    const c = mgr.contacts[contactKey];
    if (!c || !c.conn || !c.conn.open) return;

    const queue = mgr.chats[contactKey]?.filter(m => m.dir === 'sent' && (m.status === 'waiting' || m.status === 'failed')) || [];
    let updated = false;
    for (const msg of queue) {
      if (msg.type === 'text') {
        try {
          await mgr.sendEncryptedMessage(contactKey, c.conn, msg);
          msg.status = 'sent';
          updated = true;
        } catch (e) {
          mgr.log(`Failed to flush message ${msg.id?.slice(-6)}: ${e}`, 'err');
          // Leave as waiting/failed — will retry on next flush
        }
      }
    }
    if (updated) {
      saveChats(mgr.chats);
      mgr.dispatchEvent(new CustomEvent('message', { detail: { pid: contactKey } }));
      // Only reset failure counter when messages actually sent successfully
      const pid = c.currentPID || contactKey;
      delete mgr.connectFailures[pid];
    }

    const files = mgr.pendingFiles[contactKey];
    if (files?.length) {
      files.forEach(file => mgr._sendFileNow(contactKey, file, c.conn));
      delete mgr.pendingFiles[contactKey];
    }
  }

export function markWaitingMessagesFailed(mgr: P2PManager, contactKey: string) {
    const msgs = mgr.chats[contactKey];
    if (!msgs) return;
    let changed = false;
    msgs.forEach(m => {
      if (m.dir === 'sent' && m.status === 'waiting') {
        m.status = 'failed';
        changed = true;
      }
    });
    if (changed) {
      saveChats(mgr.chats);
      mgr.dispatchEvent(new CustomEvent('message', { detail: { pid: contactKey } }));
    }
  }

/**
 * Reset unACK'd 'sent' messages for a single contact back to 'waiting'.
 * Called when a contact's DataConnection closes — the messages never actually
 * reached them, so they need to be re-sent on reconnect.
 */
export function resetContactMessages(mgr: P2PManager, contactKey: string) {
    const msgs = mgr.chats[contactKey];
    if (!msgs) return;
    let changed = false;
    msgs.forEach(m => {
      if (m.dir === 'sent' && m.status === 'sent') {
        m.status = 'waiting';
        changed = true;
      }
    });
    if (changed) {
      saveChats(mgr.chats);
      mgr.dispatchEvent(new CustomEvent('message', { detail: { pid: contactKey } }));
    }
  }

export function resetUnackedMessages(mgr: P2PManager) {
    let changed = false;
    Object.keys(mgr.chats).forEach(pid => {
      mgr.chats[pid]?.forEach(m => {
        if (m.dir === 'sent' && m.status === 'sent') {
          m.status = 'waiting';
          changed = true;
        }
      });
    });
    if (changed) saveChats(mgr.chats);
  }

export async function sendEncryptedMessage(mgr: P2PManager, contactKey: string, conn: DataConnection, msg: ChatMessage) {
    const sk = await mgr.getOrDeriveSharedKey(contactKey);
    if (sk && mgr.privateKey) {
      try {
        const { iv, ct } = await encryptMessage(sk.key, msg.content || '');
        const sig = await signData(mgr.privateKey, ct);
        conn.send({ type: 'message', iv, ct, sig, ts: msg.ts, id: msg.id, e2e: true });
        return;
      } catch (e) {
        mgr.log(`E2E encrypt failed for ${contactKey}, sending plaintext`, 'err');
      }
    }
    // Fallback: plaintext
    conn.send({ type: 'message', content: msg.content, ts: msg.ts, id: msg.id });
  }

export function _sendFileNow(mgr: P2PManager, contactKey: string, file: File, conn: DataConnection) {
    const tid = crypto.randomUUID().replace(/-/g, '');
    const reader = new FileReader();
    reader.onload = async (e) => {
      const buf = e.target?.result as ArrayBuffer;
      const total = Math.ceil(buf.byteLength / CHUNK_SIZE);
      conn.send({ type: 'file-start', tid, name: file.name, size: buf.byteLength, total });

      for (let i = 0; i < total; i++) {
        conn.send({
          type: 'file-chunk',
          tid,
          index: i,
          chunk: buf.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
        });
      }
      conn.send({ type: 'file-end', tid });

      const blob = new Blob([buf]);
      await saveFile(tid, blob, file.name, Date.now());

      if (!mgr.chats[contactKey]) mgr.chats[contactKey] = [];
      const msg: ChatMessage = { id: crypto.randomUUID(), dir: 'sent', type: 'file', name: file.name, tid, size: file.size, ts: Date.now(), status: 'sent' };
      mgr.chats[contactKey].push(msg);
      saveChats(mgr.chats);
      mgr.dispatchEvent(new CustomEvent('message', { detail: { pid: contactKey, msg } }));
      mgr.log(`Sent: ${file.name}`, 'ok');
    };
    reader.readAsArrayBuffer(file);
  }

