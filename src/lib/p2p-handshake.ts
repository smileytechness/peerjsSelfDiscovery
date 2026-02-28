import { DataConnection } from 'peerjs';
import { APP_PREFIX, Contact } from './types';
import { importPublicKey, verifySignature, signData, exportPublicKey } from './crypto';
import { saveContacts, saveChats } from './store';
import type { P2PManager } from './p2p';

export function requestConnect(mgr: P2PManager, targetID: string, fname: string) {
    if (targetID === mgr.discoveryID || targetID === mgr.persistentID) return;
    mgr.log(`Requesting connection to: ${targetID}`, 'info');

    const isPersistent = targetID.split('-').length === 2;
    const peer = isPersistent ? mgr.persPeer : (mgr.publicNS.discPeer || mgr.persPeer);

    if (!peer) {
      mgr.log('No active peer instance to connect', 'err');
      return;
    }

    if (!mgr.contacts[targetID]) {
      mgr.contacts[targetID] = { friendlyName: fname, discoveryID: isPersistent ? null : targetID, discoveryUUID: '', currentPID: targetID, pending: 'outgoing' };
      if (!mgr.chats[targetID]) mgr.chats[targetID] = [];
      saveContacts(mgr.contacts);
      saveChats(mgr.chats);
      mgr.emitPeerListUpdate();
    }

    const conn = peer.connect(targetID, { reliable: true });
    let responded = false;

    // Timeout: if no response within 30s, close and notify UI
    const handshakeTimeout = setTimeout(() => {
      if (responded) return;
      mgr.log(`Connection request to ${fname} timed out (30s)`, 'err');
      try { conn.close(); } catch {}
      mgr.dispatchEvent(new CustomEvent('connect-request-failed', { detail: { targetID, error: 'timeout' } }));
    }, 30000);

    conn.on('open', async () => {
      mgr.log(`Handshake channel open with ${targetID}`, 'info');
      const ts = String(Date.now());
      const signature = mgr.privateKey ? await signData(mgr.privateKey, ts) : '';
      conn.send({ type: 'request', friendlyname: mgr.friendlyName, publicKey: mgr.publicKeyStr, persistentID: mgr.persistentID, ts, signature });
    });

    conn.on('data', (d: any) => {
      if (d.type === 'accepted') {
        responded = true;
        clearTimeout(handshakeTimeout);
        mgr.log(`Request accepted by ${fname}`, 'ok');
        conn.send({
          type: 'confirm',
          persistentID: mgr.persistentID,
          friendlyname: mgr.friendlyName,
          discoveryUUID: mgr.discoveryUUID,
          publicKey: mgr.publicKeyStr,
        });

        const remotePID = d.persistentID;
        const dupKey = d.publicKey ? mgr.findContactByPublicKey(d.publicKey, remotePID) : null;
        if (dupKey) mgr.migrateContact(dupKey, remotePID);

        // Clean up pending contact under targetID
        if (mgr.contacts[targetID]?.pending) {
          const pendingChats = mgr.chats[targetID];
          delete mgr.contacts[targetID];
          if (pendingChats) delete mgr.chats[targetID];
        }

        // Store under PID for now — will be rekeyed to fingerprint on hello handshake
        mgr.contacts[remotePID] = {
          ...(mgr.contacts[remotePID] || {}),
          friendlyName: fname,
          discoveryID: isPersistent ? null : targetID,
          discoveryUUID: d.discoveryUUID,
          currentPID: remotePID,
          conn: null,
        };

        if (!mgr.chats[remotePID]) mgr.chats[remotePID] = [];
        saveContacts(mgr.contacts);
        saveChats(mgr.chats);

        setTimeout(() => conn.close(), 1000);
        mgr.connectPersistent(remotePID, fname);
        mgr.emitPeerListUpdate();
      }
      if (d.type === 'rejected') {
        responded = true;
        clearTimeout(handshakeTimeout);
        mgr.log(`${fname} rejected the connection`, 'err');
        if (mgr.contacts[targetID]?.pending) {
          delete mgr.contacts[targetID];
          saveContacts(mgr.contacts);
          mgr.emitPeerListUpdate();
        }
        conn.close();
      }
    });

    conn.on('error', (err) => {
      clearTimeout(handshakeTimeout);
      mgr.log(`Connect request error for ${targetID}: ${err.type}`, 'err');
      mgr.dispatchEvent(new CustomEvent('connect-request-failed', { detail: { targetID, error: err.type } }));
    });

    conn.on('close', () => {
      clearTimeout(handshakeTimeout);
      // If the connection closes and the contact is still pending, it may have failed
      if (!responded && mgr.contacts[targetID]?.pending === 'outgoing') {
        mgr.dispatchEvent(new CustomEvent('connect-request-failed', { detail: { targetID, error: 'connection-closed' } }));
      }
    });
  }

export function handleDiscData(mgr: P2PManager, d: any, conn: DataConnection) {
    if (d.type === 'rvz-exchange') {
      mgr.rvzHandleExchange(d, conn);
      return;
    }
    mgr.handleHandshakeData(d, conn);
  }

export async function handleHandshakeData(mgr: P2PManager, d: any, conn: DataConnection) {
    if (d.type === 'request') {
      const fname = d.friendlyname;
      let verified = false;
      let fingerprint = '';
      if (d.publicKey && d.ts && d.signature && window.crypto?.subtle) {
        try {
          const key = await importPublicKey(d.publicKey);
          verified = await verifySignature(key, d.signature, d.ts);
          const bytes = new TextEncoder().encode(d.publicKey);
          const hash = await crypto.subtle.digest('SHA-256', bytes);
          fingerprint = Array.from(new Uint8Array(hash)).slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
        } catch {}
      }
      const requesterPID = d.persistentID as string | undefined;
      mgr.log(`Incoming connection request from ${fname}${verified ? ' (verified)' : ''}`, 'info');
      mgr.notify('Connection Request', `${fname} wants to connect`, `conn-req-${requesterPID || Date.now()}`);
      // ACK: tell requester we received the request
      conn.send({ type: 'request-received' });
      const event = new CustomEvent('connection-request', {
        detail: {
          fname,
          publicKey: d.publicKey || null,
          fingerprint,
          verified,
          accept: () => {
            conn.send({ type: 'accepted', persistentID: mgr.persistentID, discoveryUUID: mgr.discoveryUUID });
            mgr.log(`Accepted request from ${fname}`, 'ok');
          },
          reject: () => {
            conn.send({ type: 'rejected' });
            setTimeout(() => conn.close(), 500);
          },
          saveForLater: () => {
            if (!requesterPID) return;
            mgr.contacts[requesterPID] = {
              friendlyName: fname,
              discoveryID: null,
              discoveryUUID: '',
              currentPID: requesterPID,
              pending: 'incoming',
              publicKey: d.publicKey || undefined,
              pendingFingerprint: fingerprint || undefined,
              pendingVerified: verified,
            };
            if (!mgr.chats[requesterPID]) mgr.chats[requesterPID] = [];
            saveContacts(mgr.contacts);
            saveChats(mgr.chats);
            mgr.emitPeerListUpdate();
            mgr.log(`Saved incoming request from ${fname} for later`, 'info');
            conn.close();
          },
        }
      });
      mgr.dispatchEvent(event);
    }
    if (d.type === 'confirm') {
      const pid = d.persistentID;
      mgr.log(`Handshake confirmed by ${d.friendlyname} (${pid})`, 'ok');

      const dupKey = d.publicKey ? mgr.findContactByPublicKey(d.publicKey, pid) : null;
      if (dupKey) mgr.migrateContact(dupKey, pid);

      // Store under PID for now — will be rekeyed to fingerprint on hello handshake
      mgr.contacts[pid] = {
        ...(mgr.contacts[pid] || {}),
        friendlyName: d.friendlyname,
        discoveryID: null,
        discoveryUUID: d.discoveryUUID,
        currentPID: pid,
        conn: null
      };
      if (!mgr.chats[pid]) mgr.chats[pid] = [];
      saveContacts(mgr.contacts);
      saveChats(mgr.chats);
      setTimeout(() => conn.close(), 500);
      mgr.emitPeerListUpdate();
    }
  }

export function connectPersistent(mgr: P2PManager, pid: string, fname: string) {
    if (!mgr.persPeer || mgr.persPeer.destroyed) return;
    if (mgr.persPeer.disconnected) {
      mgr.log(`Signaling down — will reconnect to ${fname} when online`, 'info');
      return;
    }
    if (mgr.connectingPIDs.has(pid)) return; // already in progress

    const ck = mgr.contactKeyForPID(pid);

    if (mgr.contacts[ck]?.conn && !mgr.contacts[ck].conn.open) {
      mgr.contacts[ck].conn = null;
    }

    if (mgr.contacts[ck]?.conn?.open) {
      mgr.log(`Already connected to ${fname}`, 'info');
      return;
    }

    mgr.log(`Opening persistent connection to ${fname} (${pid})...`, 'info');
    mgr.connectingPIDs.add(pid);
    const conn = mgr.persPeer.connect(pid, { reliable: true });
    let settled = false;

    // Safety timeout: if neither open nor error fires (NAT/WebRTC hang), clean up
    const hangTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      mgr.connectingPIDs.delete(pid);
      mgr.log(`Connection to ${fname} timed out (no open/error in 15s)`, 'err');
      try { conn.close(); } catch {}
    }, 15000);

    conn.on('open', async () => {
      settled = true;
      clearTimeout(hangTimeout);
      mgr.connectingPIDs.delete(pid);
      if (!mgr.contacts[ck]) mgr.contacts[ck] = { friendlyName: fname, discoveryID: null, discoveryUUID: '', currentPID: pid };
      mgr.contacts[ck].conn = conn;
      mgr.contacts[ck].currentPID = pid;

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

      mgr.flushMessageQueue(ck);
      mgr.emitPeerListUpdate();
      mgr.log(`Persistent channel open with ${fname}`, 'ok');
    });

    conn.on('data', (d) => mgr.handlePersistentData(d, conn));

    conn.on('close', () => {
      settled = true;
      clearTimeout(hangTimeout);
      mgr.connectingPIDs.delete(pid);
      mgr.log(`Persistent channel closed with ${fname}`, 'info');
      if (mgr.contacts[ck]) {
        mgr.contacts[ck].conn = null;
        // Reset unACK'd 'sent' messages to 'waiting' so they re-send on reconnect
        mgr.resetContactMessages(ck);
        mgr.emitPeerListUpdate();
      }
    });

    conn.on('error', (err) => {
      settled = true;
      clearTimeout(hangTimeout);
      mgr.connectingPIDs.delete(pid);
      mgr.log(`Persistent connection error with ${fname}: ${err.type}`, 'err');
      if (mgr.persPeer?.disconnected || mgr.offlineMode) return;
      mgr.connectFailures[pid] = (mgr.connectFailures[pid] || 0) + 1;
      if (mgr.connectFailures[pid] < mgr.MAX_CONNECT_RETRIES) {
        const delay = 5000 * mgr.connectFailures[pid];
        mgr.log(`Retry ${mgr.connectFailures[pid]}/${mgr.MAX_CONNECT_RETRIES} for ${fname} in ${delay / 1000}s`, 'info');
        setTimeout(() => {
          if (!mgr.contacts[ck]?.conn?.open && !mgr.connectingPIDs.has(pid)) {
            mgr.connectPersistent(pid, fname);
          }
        }, delay);
      } else {
        mgr.log(`${fname} unreachable after ${mgr.MAX_CONNECT_RETRIES} attempts — marking messages failed`, 'err');
        mgr.markWaitingMessagesFailed(ck);
        mgr.rvzEnqueue(ck);
      }
    });
  }

