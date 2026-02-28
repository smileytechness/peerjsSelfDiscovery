// ─── ECDSA (signing / verification) ──────────────────────────────────────────

export async function generateKeyPair(): Promise<CryptoKeyPair> {
  return window.crypto.subtle.generateKey(
    {
      name: 'ECDSA',
      namedCurve: 'P-521',
    },
    true,
    ['sign', 'verify']
  );
}

export async function exportPublicKey(key: CryptoKey): Promise<string> {
  const exported = await window.crypto.subtle.exportKey('spki', key);
  return arrayBufferToBase64(exported);
}

export async function importPublicKey(base64Key: string): Promise<CryptoKey> {
  const binaryDer = base64ToArrayBuffer(base64Key);
  return window.crypto.subtle.importKey(
    'spki',
    binaryDer,
    {
      name: 'ECDSA',
      namedCurve: 'P-521',
    },
    true,
    ['verify']
  );
}

export async function signData(privateKey: CryptoKey, data: string): Promise<string> {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(data);
  const signature = await window.crypto.subtle.sign(
    {
      name: 'ECDSA',
      hash: { name: 'SHA-256' },
    },
    privateKey,
    encoded
  );
  return arrayBufferToBase64(signature);
}

export async function verifySignature(publicKey: CryptoKey, signature: string, data: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(data);
  const signatureBuffer = base64ToArrayBuffer(signature);
  return window.crypto.subtle.verify(
    {
      name: 'ECDSA',
      hash: { name: 'SHA-256' },
    },
    publicKey,
    signatureBuffer,
    encoded
  );
}

export async function exportPrivateKey(key: CryptoKey): Promise<string> {
  const exported = await window.crypto.subtle.exportKey('pkcs8', key);
  return arrayBufferToBase64(exported);
}

export async function importPrivateKey(base64Key: string): Promise<CryptoKey> {
  const binaryDer = base64ToArrayBuffer(base64Key);
  return window.crypto.subtle.importKey(
    'pkcs8',
    binaryDer,
    {
      name: 'ECDSA',
      namedCurve: 'P-521',
    },
    true,
    ['sign']
  );
}

// ─── ECDH (shared key derivation) ───────────────────────────────────────────
//
// Reuses the same P-521 curve points as ECDSA keys. We re-import via JWK
// to switch the algorithm from ECDSA → ECDH. The public key bytes stay
// identical, so "public key never changes."

/** Convert our ECDSA private key → ECDH private key for deriveBits */
export async function ecdsaToECDHPrivate(ecdsaPrivateKey: CryptoKey): Promise<CryptoKey> {
  const jwk = await window.crypto.subtle.exportKey('jwk', ecdsaPrivateKey);
  return window.crypto.subtle.importKey(
    'jwk',
    { ...jwk, key_ops: ['deriveBits'] },
    { name: 'ECDH', namedCurve: 'P-521' },
    false,
    ['deriveBits']
  );
}

/** Convert a peer's ECDSA public key (base64 SPKI) → ECDH public key */
export async function ecdsaToECDHPublic(base64Key: string): Promise<CryptoKey> {
  // Import as ECDSA first (to get the JWK), then re-import as ECDH
  const ecdsaKey = await importPublicKey(base64Key);
  const jwk = await window.crypto.subtle.exportKey('jwk', ecdsaKey);
  return window.crypto.subtle.importKey(
    'jwk',
    { ...jwk, key_ops: [] },
    { name: 'ECDH', namedCurve: 'P-521' },
    false,
    []
  );
}

/** Derive a shared AES-256-GCM key from our ECDH private + their ECDH public.
 *  Both peers compute the same key. */
export async function deriveSharedKey(
  myECDHPrivate: CryptoKey,
  theirECDHPublic: CryptoKey
): Promise<CryptoKey> {
  // Raw ECDH shared secret (P-521 → 66 bytes)
  const sharedBits = await window.crypto.subtle.deriveBits(
    { name: 'ECDH', public: theirECDHPublic },
    myECDHPrivate,
    528 // P-521 output is 66 bytes = 528 bits
  );

  // HKDF to derive a clean 256-bit AES key
  const hkdfKey = await window.crypto.subtle.importKey(
    'raw',
    sharedBits,
    'HKDF',
    false,
    ['deriveKey']
  );

  return window.crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32), // fixed empty salt (deterministic)
      info: new TextEncoder().encode('peerns-e2e-v1'),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    true, // extractable so we can fingerprint it
    ['encrypt', 'decrypt']
  );
}

/** Fingerprint a shared AES key (first 16 hex chars of SHA-256 of raw key bytes) */
export async function fingerprintSharedKey(sharedKey: CryptoKey): Promise<string> {
  const raw = await window.crypto.subtle.exportKey('raw', sharedKey);
  const hash = await window.crypto.subtle.digest('SHA-256', raw);
  return Array.from(new Uint8Array(hash))
    .slice(0, 8)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ─── AES-GCM encrypt / decrypt ─────────────────────────────────────────────

export async function encryptMessage(
  sharedKey: CryptoKey,
  plaintext: string
): Promise<{ iv: string; ct: string }> {
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    sharedKey,
    encoded
  );
  return {
    iv: arrayBufferToBase64(iv.buffer),
    ct: arrayBufferToBase64(ciphertext),
  };
}

export async function decryptMessage(
  sharedKey: CryptoKey,
  iv: string,
  ct: string
): Promise<string> {
  const ivBuf = base64ToArrayBuffer(iv);
  const ctBuf = base64ToArrayBuffer(ct);
  const decrypted = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBuf },
    sharedKey,
    ctBuf
  );
  return new TextDecoder().decode(decrypted);
}

// ─── Group Key Management ───────────────────────────────────────────────────

/** Generate a random AES-256-GCM key for group encryption */
export async function generateGroupKey(): Promise<CryptoKey> {
  return window.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

/** Export group key to base64 for persistence */
export async function exportGroupKey(key: CryptoKey): Promise<string> {
  const raw = await window.crypto.subtle.exportKey('raw', key);
  return arrayBufferToBase64(raw);
}

/** Import group key from base64 */
export async function importGroupKey(base64: string): Promise<CryptoKey> {
  const raw = base64ToArrayBuffer(base64);
  return window.crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

/** Encrypt a group key for pairwise distribution using a shared ECDH key */
export async function encryptGroupKeyForPeer(
  groupKey: CryptoKey,
  pairwiseKey: CryptoKey
): Promise<{ iv: string; ct: string }> {
  const raw = await window.crypto.subtle.exportKey('raw', groupKey);
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const ct = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    pairwiseKey,
    raw
  );
  return {
    iv: arrayBufferToBase64(iv.buffer),
    ct: arrayBufferToBase64(ct),
  };
}

/** Decrypt a received group key using pairwise ECDH key */
export async function decryptGroupKeyFromPeer(
  pairwiseKey: CryptoKey,
  iv: string,
  ct: string
): Promise<CryptoKey> {
  const ivBuf = base64ToArrayBuffer(iv);
  const ctBuf = base64ToArrayBuffer(ct);
  const raw = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBuf },
    pairwiseKey,
    ctBuf
  );
  return window.crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

// ─── Rendezvous ─────────────────────────────────────────────────────────────

/** Derive a time-rotating rendezvous slug from a shared AES key.
 *  Both peers compute the same HMAC because they share the same ECDH-derived key. */
export async function deriveRendezvousSlug(sharedKey: CryptoKey, timeWindow: number): Promise<string> {
  const rawKey = await window.crypto.subtle.exportKey('raw', sharedKey);
  const hmacKey = await window.crypto.subtle.importKey('raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const message = new TextEncoder().encode(`peerns-rvz-v1-${timeWindow}`);
  const sig = await window.crypto.subtle.sign('HMAC', hmacKey, message);
  return Array.from(new Uint8Array(sig)).slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary_string = window.atob(base64);
  const len = binary_string.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary_string.charCodeAt(i);
  }
  return bytes.buffer;
}
