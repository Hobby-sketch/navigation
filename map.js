/**
 * map.js
 * MapLibre GL JS + OpenStreetMap raster tiles.
 * - Free-text search via Nominatim.
 * - Quick category POI lookup via the Overpass API (tag-accurate nearby search).
 * - "Current location" marker that can follow GPS + auto-rotate with heading.
 * - Simple navigation line to a chosen destination via the public OSRM demo router.
 */

const OSM_STYLE = {
  version: 8,
  sources: {
    'osm-tiles': {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '&copy; OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm-tiles-layer', type: 'raster', source: 'osm-tiles', minzoom: 0, maxzoom: 19 }],
};

// category -> Overpass tag filter fragment
const CATEGORY_TAGS = {
  pabrik: '["landuse"="industrial"]',
  kantor: '["office"]',
  spbu: '["amenity"="fuel"]',
  'rumah sakit': '["amenity"="hospital"]',
  hotel: '["tourism"="hotel"]',
  restoran: '["amenity"="restaurant"]',
  atm: '["amenity"="atm"]',
  bengkel: '["shop"="car_repair"]',
  parkir: '["amenity"="parking"]',
};

export class MapManager {
  constructor(containerId) {
    this.map = new maplibregl.Map({
      container: containerId,
      style: OSM_STYLE,
      center: [106.8456, -6.2088], // fallback: Jakarta, ID
      zoom: 14,
      pitch: 0,
      attributionControl: { compact: true },
    });

    this.meMarker = null;
    this.poiMarkers = [];
    this.destMarker = null;
    this.following = false;
    this.rotateWithHeading = false;
    this.lastLngLat = null;
    this.routeSourceAdded = false;

    this.map.on('load', () => this._onLoad());
  }

  _onLoad() {
    this.map.addSource('route', {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } },
    });
    this.map.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route',
      paint: { 'line-color': '#d81f2a', 'line-width': 5, 'line-opacity': 0.9 },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    });
    this.routeSourceAdded = true;
  }

  setMyLocation(lat, lng, headingDeg) {
    this.lastLngLat = [lng, lat];
    if (!this.meMarker) {
      const el = document.createElement('div');
      el.className = 'map-marker--me';
      this.meMarker = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(this.map);
    } else {
      this.meMarker.setLngLat([lng, lat]);
    }
    if (this.following) {
      this.map.easeTo({
        center: [lng, lat],
        bearing: this.rotateWithHeading && typeof headingDeg === 'number' ? headingDeg : this.map.getBearing(),
        duration: 400,
      });
    }
  }

  toggleFollow(enabled) {
    this.following = enabled;
    this.rotateWithHeading = enabled;
    if (enabled && this.lastLngLat) {
      this.map.easeTo({ center: this.lastLngLat, zoom: Math.max(this.map.getZoom(), 16), duration: 500 });
    }
  }

  zoomIn() { this.map.zoomIn(); }
  zoomOut() { this.map.zoomOut(); }

  flyTo(lat, lng, zoom = 16) {
    this.map.flyTo({ center: [lng, lat], zoom, duration: 900 });
  }

  clearPois() {
    this.poiMarkers.forEach((m) => m.remove());
    this.poiMarkers = [];
  }

  addPoiMarker(lat, lng, label, emoji) {
    const el = document.createElement('div');
    el.className = 'map-marker--poi';
    el.innerHTML = `<span>${emoji || '📍'}</span>`;
    const marker = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(this.map);
    marker.setPopup(new maplibregl.Popup({ offset: 18 }).setText(label));
    this.poiMarkers.push(marker);
    return marker;
  }

  setDestination(lat, lng) {
    if (this.destMarker) this.destMarker.remove();
    const el = document.createElement('div');
    el.className = 'map-marker--poi';
    el.innerHTML = '<span>🏁</span>';
    this.destMarker = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(this.map);
  }

  async drawRoute(fromLat, fromLng, toLat, toLng) {
    if (!this.routeSourceAdded) return;
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson`;
      const res = await fetch(url);
      const data = await res.json();
      const coords = data?.routes?.[0]?.geometry?.coordinates;
      if (coords) {
        this.map.getSource('route').setData({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: coords },
        });
        const bounds = coords.reduce(
          (b, c) => b.extend(c),
          new maplibregl.LngLatBounds(coords[0], coords[0])
        );
        this.map.fitBounds(bounds, { padding: 60, duration: 800 });
        return data.routes[0];
      }
    } catch (e) {
      console.warn('Route lookup failed', e);
    }
    return null;
  }

  clearRoute() {
    if (this.routeSourceAdded) {
      this.map.getSource('route').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [] } });
    }
    if (this.destMarker) { this.destMarker.remove(); this.destMarker = null; }
  }
}

/** Free-text place search via Nominatim. */
export async function searchPlaces(query, { lat, lng } = {}) {
  const params = new URLSearchParams({
    format: 'json',
    q: query,
    limit: '8',
    addressdetails: '1',
  });
  if (typeof lat === 'number' && typeof lng === 'number') {
    params.set('viewbox', `${lng - 0.3},${lat + 0.3},${lng + 0.3},${lat - 0.3}`);
    params.set('bounded', '0');
  }
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return [];
    return await res.json();
  } catch (e) {
    console.warn('Nominatim search failed', e);
    return [];
  }
}

/** Category POI search around a point via the Overpass API. */
export async function searchCategory(category, lat, lng, radiusM = 3000) {
  const tag = CATEGORY_TAGS[category];
  if (!tag) return [];
  const query = `
    [out:json][timeout:15];
    (
      node${tag}(around:${radiusM},${lat},${lng});
      way${tag}(around:${radiusM},${lat},${lng});
    );
    out center 25;
  `;
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: query,
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.elements || []).map((el) => ({
      lat: el.lat || el.center?.lat,
      lon: el.lon || el.center?.lon,
      name: el.tags?.name || category,
    })).filter((p) => p.lat && p.lon);
  } catch (e) {
    console.warn('Overpass search failed', e);
    return [];
  }
}

export const CATEGORY_EMOJI = {
  pabrik: '🏭', kantor: '🏢', spbu: '⛽', 'rumah sakit': '🏥',
  hotel: '🏨', restoran: '🍽️', atm: '🏧', bengkel: '🔧', parkir: '🅿️',
};
