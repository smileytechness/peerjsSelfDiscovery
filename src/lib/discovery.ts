import { APP_PREFIX } from './types';

export function isValidPublicIPv4(ip: string): boolean {
  if (!ip || ip.includes(':') || ip.endsWith('.local')) return false;
  if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|169\.254\.)/.test(ip)) return false;
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip);
}

export function getIPviaSTUN(): Promise<string | null> {
  return new Promise((resolve) => {
    console.log('[STUN] Starting...');
    let pc: RTCPeerConnection | null = null;
    let srflx: string | null = null;
    let host: string | null = null;

    try {
      pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun.cloudflare.com:3478' },
        ],
      });
    } catch (e) {
      console.error('[STUN] RTCPeerConnection failed:', e);
      return resolve(null);
    }

    pc.createDataChannel('x');
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const p = e.candidate.candidate.split(' ');
      // candidate:1 1 UDP 2013266431 192.168.1.10 56032 typ host ...
      // candidate:2 1 UDP 1677729535 203.0.113.1 56032 typ srflx ...
      const type = p[7];
      const ip = p[4];
      console.log(`[STUN] candidate type=${type} ip=${ip}`);
      if (type === 'srflx' && isValidPublicIPv4(ip)) {
        srflx = ip;
        console.log('[STUN] ✅ srflx:', ip);
      } else if (type === 'host' && !host && isValidPublicIPv4(ip)) {
        host = ip;
        console.log('[STUN] 📌 host fallback:', ip);
      }
    };

    pc.onicegatheringstatechange = () => {
      if (pc?.iceGatheringState === 'complete') {
        try {
          pc.close();
        } catch (e) {}
        resolve(srflx || host || null);
      }
    };

    pc.createOffer()
      .then((o) => pc?.setLocalDescription(o))
      .catch((e) => {
        console.error('[STUN] offer failed:', e);
        resolve(null);
      });

    setTimeout(() => {
      console.warn('[STUN] timeout, best:', srflx || host || 'none');
      try {
        pc?.close();
      } catch (e) {}
      resolve(srflx || host || null);
    }, 6000);
  });
}

export async function getIPviaHTTP(): Promise<string | null> {
  const services = [
    'https://api.ipify.org?format=json',
    'https://api4.my-ip.io/ip.json',
  ];
  for (const url of services) {
    try {
      console.log('[IP-HTTP] Trying', url);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      const j = await r.json();
      const ip = j.ip || j.IPv4;
      if (isValidPublicIPv4(ip)) {
        console.log('[IP-HTTP] ✅', ip);
        return ip;
      }
    } catch (e: any) {
      console.warn('[IP-HTTP] failed:', url, e.message);
    }
  }
  return null;
}

export async function getPublicIP(): Promise<string | null> {
  const stun = await getIPviaSTUN();
  if (stun) return stun;
  return await getIPviaHTTP();
}

export function makeRouterID(ip: string, level: number = 1): string {
  return `${APP_PREFIX}-${ip.replace(/\./g, '-')}-${level}`;
}

export function makeDiscID(ip: string, uuid: string): string {
  return `${APP_PREFIX}-${ip.replace(/\./g, '-')}-${uuid}`;
}

export function extractDiscUUID(did: string): string {
  // format: myapp-{ip}-{uuid}
  const parts = did.split('-');
  return parts[parts.length - 1];
}

/** Sanitize any user string into a PeerJS-safe namespace slug */
export function slugifyNamespace(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'default';
}

export function makeCustomRouterID(slug: string, level: number): string {
  return `${APP_PREFIX}-ns-${slug}-${level}`;
}

export function makeCustomDiscID(slug: string, uuid: string): string {
  return `${APP_PREFIX}-ns-${slug}-${uuid}`;
}
