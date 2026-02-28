import { APP_PREFIX, NSConfig, GeoRegistryEntry } from './types';
import { makeNSState, GeoNSState } from './p2p-types';
import { encode, neighbors, distance, coveringHashes } from './geohash';
import type { P2PManager } from './p2p';

// ─── NSConfig factory ────────────────────────────────────────────────────────

function makeGeoNSConfig(geohash: string): NSConfig {
  return {
    label: `geo:${geohash}`,
    makeRouterID: (level) => `${APP_PREFIX}-geo-${geohash}-${level}`,
    makeDiscID: (uuid) => `${APP_PREFIX}-geo-${geohash}-${uuid}`,
    makePeerSlotID: () => `${APP_PREFIX}-geo-${geohash}-p1`,
  };
}

// ─── Start geo discovery ────────────────────────────────────────────────────

export function geoStart(mgr: P2PManager) {
  if (mgr.geoWatchId !== null) return; // Already active

  if (!navigator.geolocation) {
    mgr.log('Geolocation not available', 'err');
    return;
  }

  mgr.log('Starting geo discovery...', 'info');

  mgr.geoWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      geoUpdatePosition(mgr, pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
    },
    (err) => {
      mgr.log(`Geo error: ${err.message}`, 'err');
    },
    {
      enableHighAccuracy: true,
      maximumAge: 30000,
      timeout: 15000,
    }
  );

  mgr.dispatchEvent(new CustomEvent('geo-update'));
}

// ─── Refresh GPS — force a fresh position reading ───────────────────────────

export function geoRefresh(mgr: P2PManager) {
  if (mgr.geoWatchId === null) return; // not active
  if (!navigator.geolocation) return;

  mgr.geoRefreshing = true;
  mgr.dispatchEvent(new CustomEvent('geo-update'));
  mgr.log('Refreshing GPS position...', 'info');

  const done = (pos: GeolocationPosition) => {
    geoUpdatePosition(mgr, pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
    mgr.geoRefreshing = false;
    mgr.dispatchEvent(new CustomEvent('geo-update'));
  };
  const fail = () => {
    mgr.geoRefreshing = false;
    mgr.dispatchEvent(new CustomEvent('geo-update'));
  };

  // Try high accuracy first, fall back to coarse on timeout
  navigator.geolocation.getCurrentPosition(
    done,
    (err) => {
      if (err.code === err.TIMEOUT) {
        mgr.log('High-accuracy GPS timed out, trying coarse...', 'info');
        navigator.geolocation.getCurrentPosition(done, (err2) => {
          mgr.log(`Geo refresh error: ${err2.message}`, 'err');
          fail();
        }, { enableHighAccuracy: false, maximumAge: 60000, timeout: 10000 });
      } else {
        mgr.log(`Geo refresh error: ${err.message}`, 'err');
        fail();
      }
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
  );
}

// ─── Stop geo discovery ──────────────────────────────────────────────────────

export function geoStop(mgr: P2PManager) {
  if (mgr.geoWatchId !== null) {
    navigator.geolocation.clearWatch(mgr.geoWatchId);
    mgr.geoWatchId = null;
  }

  // Teardown all geo namespaces
  mgr.geoStates.forEach(s => mgr.nsTeardown(s));
  mgr.geoStates = [];
  mgr.log('Geo discovery stopped', 'info');
  mgr.dispatchEvent(new CustomEvent('geo-update'));
}

// ─── Update position — recompute geohashes, join new / leave old ────────────

export function geoUpdatePosition(mgr: P2PManager, lat: number, lng: number, accuracy: number) {
  mgr.geoLat = lat;
  mgr.geoLng = lng;
  const hashes = coveringHashes(lat, lng, 7);
  const currentHashes = new Set(mgr.geoStates.map(s => s.geohash));
  const newHashes = hashes.filter(h => !currentHashes.has(h));
  const oldHashes = mgr.geoStates.filter(s => !hashes.includes(s.geohash));

  // Teardown old namespaces
  oldHashes.forEach(s => {
    mgr.nsTeardown(s);
    mgr.log(`[geo] Left geohash ${s.geohash}`, 'info');
  });
  mgr.geoStates = mgr.geoStates.filter(s => hashes.includes(s.geohash));

  // Join new namespaces — stagger to avoid signaling rate-limit
  newHashes.forEach((hash, i) => {
    const cfg = makeGeoNSConfig(hash);
    const state: GeoNSState = {
      ...makeNSState(),
      geohash: hash,
      cfg,
    };
    mgr.geoStates.push(state);
    setTimeout(() => {
      // Guard: still active when timer fires
      if (mgr.geoWatchId === null) return;
      mgr.nsAttempt(state, cfg, 1);
      mgr.log(`[geo] Joined geohash ${hash}`, 'info');
    }, i * 1500);
  });

  if (newHashes.length > 0 || oldHashes.length > 0) {
    mgr.log(`[geo] Active hashes: ${hashes.length}, lat=${lat.toFixed(4)}, lng=${lng.toFixed(4)}, accuracy=${accuracy.toFixed(0)}m`, 'info');
  }

  mgr.dispatchEvent(new CustomEvent('geo-update'));
}

// ─── Get nearby peers aggregated by overlap count ────────────────────────────

export interface NearbyPeer {
  peer: GeoRegistryEntry;
  overlapCount: number;
  totalHashes: number;
  fingerprint?: string;
}

export function geoGetNearbyPeers(mgr: P2PManager): NearbyPeer[] {
  if (mgr.geoStates.length === 0) return [];

  const totalHashes = mgr.geoStates.length;

  // Build map: uniqueKey → { peer, overlapCount }
  const peerMap = new Map<string, { peer: GeoRegistryEntry; overlapCount: number }>();

  mgr.geoStates.forEach(state => {
    Object.values(state.registry).forEach(entry => {
      if (entry.isMe) return;
      const key = entry.publicKey || entry.discoveryID;
      const existing = peerMap.get(key);
      if (existing) {
        existing.overlapCount++;
      } else {
        const geoEntry = (entry as GeoRegistryEntry);
        peerMap.set(key, {
          peer: geoEntry.lat !== undefined
            ? geoEntry
            : { ...entry, lat: 0, lng: 0, accuracy: 0 } as GeoRegistryEntry,
          overlapCount: 1,
        });
      }
    });
  });

  // Convert to array with cached fingerprints, sorted by overlap descending
  const results: NearbyPeer[] = Array.from(peerMap.values()).map(({ peer, overlapCount }) => {
    let fingerprint: string | undefined;
    if (peer.publicKey) {
      const cached = mgr.geoFPCache.get(peer.publicKey);
      if (cached) {
        fingerprint = cached;
      } else {
        // Mark as pending (empty string) to prevent re-dispatching
        const pk = peer.publicKey;
        mgr.geoFPCache.set(pk, '');
        mgr.computeFingerprint(pk).then(fp => {
          if (fp) {
            mgr.geoFPCache.set(pk, fp);
            mgr.dispatchEvent(new CustomEvent('geo-update'));
          }
        });
      }
    }
    return { peer, overlapCount, totalHashes, fingerprint: fingerprint || undefined };
  });

  results.sort((a, b) => b.overlapCount - a.overlapCount);
  return results;
}
