import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { GeoRegistryEntry, Contact } from '../lib/types';

interface NearbyMapProps {
  peers: { peer: GeoRegistryEntry; overlapCount: number; totalHashes: number }[];
  contacts: Record<string, Contact>;
  userLat: number;
  userLng: number;
}

function overlapHexColor(overlap: number, total: number): string {
  const ratio = overlap / total;
  if (ratio >= 0.8) return '#22c55e'; // green-500
  if (ratio >= 0.5) return '#eab308'; // yellow-500
  return '#f97316'; // orange-500
}

export function NearbyMap({ peers, contacts, userLat, userLng }: NearbyMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<L.Map | null>(null);

  useEffect(() => {
    if (!mapRef.current) return;
    if (mapInstance.current) return; // already initialized

    const map = L.map(mapRef.current, {
      center: [userLat, userLng],
      zoom: 16,
      zoomControl: false,
      attributionControl: false,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
    }).addTo(map);

    // Compact attribution
    L.control.attribution({ prefix: false, position: 'bottomright' })
      .addAttribution('<a href="https://openstreetmap.org">OSM</a>')
      .addTo(map);

    mapInstance.current = map;

    return () => {
      map.remove();
      mapInstance.current = null;
    };
  }, []);

  // Update markers when peers or position changes
  useEffect(() => {
    const map = mapInstance.current;
    if (!map) return;

    // Clear existing markers (except tiles)
    map.eachLayer(layer => {
      if (layer instanceof L.Marker || layer instanceof L.CircleMarker) {
        map.removeLayer(layer);
      }
    });

    // Re-center on user
    map.setView([userLat, userLng], map.getZoom());

    // User marker — blue pulsing dot
    L.circleMarker([userLat, userLng], {
      radius: 8,
      fillColor: '#3b82f6',
      fillOpacity: 0.9,
      color: '#93c5fd',
      weight: 3,
      opacity: 0.6,
    }).addTo(map).bindPopup('You');

    // Peer markers
    peers.forEach(({ peer, overlapCount, totalHashes }) => {
      // Use peer's geohash center if available, or fall back to decoded position
      let lat = peer.lat;
      let lng = peer.lng;
      if (!lat && !lng) return;

      const color = overlapHexColor(overlapCount, totalHashes);

      L.circleMarker([lat, lng], {
        radius: 7,
        fillColor: color,
        fillOpacity: 0.85,
        color: '#fff',
        weight: 2,
        opacity: 0.5,
      }).addTo(map).bindTooltip(peer.friendlyName, {
        permanent: true,
        direction: 'top',
        offset: [0, -10],
        className: 'nearby-label',
      });
    });
  }, [peers, userLat, userLng, contacts]);

  return (
    <div
      ref={mapRef}
      className="w-full rounded-lg overflow-hidden border border-gray-800"
      style={{ height: 200 }}
    />
  );
}
