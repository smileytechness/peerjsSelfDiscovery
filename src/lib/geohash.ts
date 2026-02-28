// ─── Pure Geohash Utility Functions ──────────────────────────────────────────
// 7-character geohash ≈ 150m precision

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export function encode(lat: number, lng: number, precision: number = 7): string {
  let minLat = -90, maxLat = 90;
  let minLng = -180, maxLng = 180;
  let hash = '';
  let bit = 0;
  let ch = 0;
  let isLng = true;

  while (hash.length < precision) {
    if (isLng) {
      const mid = (minLng + maxLng) / 2;
      if (lng >= mid) {
        ch |= (1 << (4 - bit));
        minLng = mid;
      } else {
        maxLng = mid;
      }
    } else {
      const mid = (minLat + maxLat) / 2;
      if (lat >= mid) {
        ch |= (1 << (4 - bit));
        minLat = mid;
      } else {
        maxLat = mid;
      }
    }
    isLng = !isLng;
    bit++;
    if (bit === 5) {
      hash += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}

export function decode(hash: string): { lat: number; lng: number } {
  let minLat = -90, maxLat = 90;
  let minLng = -180, maxLng = 180;
  let isLng = true;

  for (const c of hash) {
    const idx = BASE32.indexOf(c);
    if (idx === -1) continue;
    for (let bit = 4; bit >= 0; bit--) {
      if (isLng) {
        const mid = (minLng + maxLng) / 2;
        if (idx & (1 << bit)) {
          minLng = mid;
        } else {
          maxLng = mid;
        }
      } else {
        const mid = (minLat + maxLat) / 2;
        if (idx & (1 << bit)) {
          minLat = mid;
        } else {
          maxLat = mid;
        }
      }
      isLng = !isLng;
    }
  }
  return {
    lat: (minLat + maxLat) / 2,
    lng: (minLng + maxLng) / 2,
  };
}

export function neighbors(hash: string): string[] {
  const { lat, lng } = decode(hash);
  const precision = hash.length;

  // Approximate cell dimensions in degrees for precision 7: ~0.001 lat, ~0.001 lng
  const latStep = 180 / Math.pow(2, Math.ceil(precision * 5 / 2));
  const lngStep = 360 / Math.pow(2, Math.floor(precision * 5 / 2));

  const offsets = [
    [-1, -1], [-1, 0], [-1, 1],
    [0, -1],           [0, 1],
    [1, -1],  [1, 0],  [1, 1],
  ];

  return offsets.map(([dlat, dlng]) =>
    encode(lat + dlat * latStep * 2, lng + dlng * lngStep * 2, precision)
  );
}

export function distance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000; // Earth radius in meters
  const toRad = (deg: number) => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Cardinal neighbors only: N, S, E, W (no diagonals) */
export function cardinalNeighbors(hash: string): string[] {
  const { lat, lng } = decode(hash);
  const precision = hash.length;

  const latStep = 180 / Math.pow(2, Math.ceil(precision * 5 / 2));
  const lngStep = 360 / Math.pow(2, Math.floor(precision * 5 / 2));

  const offsets: [number, number][] = [
    [-1, 0], // S
    [1, 0],  // N
    [0, -1], // W
    [0, 1],  // E
  ];

  return offsets.map(([dlat, dlng]) =>
    encode(lat + dlat * latStep * 2, lng + dlng * lngStep * 2, precision)
  );
}

/** Get unique geohashes for a position: center + cardinal neighbors (deduplicated, 5 total) */
export function coveringHashes(lat: number, lng: number, precision: number = 7): string[] {
  const center = encode(lat, lng, precision);
  const nbrs = cardinalNeighbors(center);
  const set = new Set([center, ...nbrs]);
  return [...set];
}
