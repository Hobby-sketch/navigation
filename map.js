/**
 * map.js
 * MapLibre GL JS + OpenStreetMap raster tiles.
 * - Free-text search via Nominatim; category POI lookup via the Overpass API.
 * - Google-Maps-style "my location" marker: blue dot + GPU-friendly pulse
 *   (transform/opacity only) + heading arrow + a geographically-accurate
 *   accuracy circle (real meters, not a fixed pixel radius).
 * - Follow GPS with automatic disengage on user pan/zoom/rotate, surfaced via
 *   a 'follow-change' event so the UI can show a "Kembali Ikuti" button.
 * - All camera moves (follow, flyTo, fitBounds) use a shared ease-out curve
 *   for a smooth, premium feel instead of linear/abrupt jumps.
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

export const CATEGORY_EMOJI = {
  pabrik: '🏭', kantor: '🏢', spbu: '⛽', 'rumah sakit': '🏥',
  hotel: '🏨', restoran: '🍽️', atm: '🏧', bengkel: '🔧', parkir: '🅿️',
};

/** Shared ease-out curve so every camera move (follow/fly/fit) feels the same. */
export function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

/** Small equirectangular circle generator — good enough for accuracy rings
 *  of a few to a few hundred meters (no geodesic library needed). */
function geoCirclePolygon(lat, lon, radiusM, points = 48) {
  const coords = [];
  const latRad = (lat * Math.PI) / 180;
  const R = 6371000;
  for (let i = 0; i <= points; i++) {
    const angle = (i / points) * 2 * Math.PI;
    const dLat = (radiusM * Math.cos(angle)) / R;
    const dLon = (radiusM * Math.sin(angle)) / (R * Math.cos(latRad));
    coords.push([lon + (dLon * 180) / Math.PI, lat + (dLat * 180) / Math.PI]);
  }
  return { type: 'Polygon', coordinates: [coords] };
}

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
    this.meMarkerEls = null; // { root, dot, pulse, arrow }
    this.poiMarkers = [];
    this.destMarker = null;
    this.following = false;
    this.lastLngLat = null;
    this.lastAccuracy = null;
    this.sourcesReady = false;
    this.listeners = new Set();

    this.map.on('load', () => this._onLoad());
    this._bindFollowDisengage();
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit(evt) { this.listeners.forEach((fn) => fn(evt)); }

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

    this.map.addSource('accuracy-circle', {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[]] } },
    });
    this.map.addLayer({
      id: 'accuracy-circle-fill',
      type: 'fill',
      source: 'accuracy-circle',
      paint: { 'fill-color': '#4a9eff', 'fill-opacity': 0.14 },
    });
    this.map.addLayer({
      id: 'accuracy-circle-outline',
      type: 'line',
      source: 'accuracy-circle',
      paint: { 'line-color': '#4a9eff', 'line-width': 1.5, 'line-opacity': 0.35 },
    });

    this.sourcesReady = true;
  }

  /** Only user-driven camera changes (drag/scroll/pinch/keyboard) should
   *  disengage Follow GPS — programmatic easeTo/flyTo must not. MapLibre
   *  sets `originalEvent` only when a real DOM input event triggered the move. */
  _bindFollowDisengage() {
    this.map.on('movestart', (e) => {
      if (e.originalEvent && this.following) {
        this.following = false;
        this._emit({ type: 'follow-change', following: false });
      }
    });
  }

  _ensureMeMarker() {
    if (this.meMarker) return;
    const root = document.createElement('div');
    root.className = 'gmarker';
    root.innerHTML = `
      <div class="gmarker__pulse"></div>
      <div class="gmarker__arrow"></div>
      <div class="gmarker__dot"></div>
    `;
    this.meMarkerEls = {
      root,
      pulse: root.querySelector('.gmarker__pulse'),
      arrow: root.querySelector('.gmarker__arrow'),
      dot: root.querySelector('.gmarker__dot'),
    };
    this.meMarker = new maplibregl.Marker({ element: root })
      .setLngLat([0, 0])
      .addTo(this.map);
  }

  /**
   * Update the "my location" marker: geographic position, heading arrow
   * (only shown while actually moving), and the real-meters accuracy circle.
   */
  setMyLocation(lat, lng, headingDeg, accuracy, isMoving) {
    this._ensureMeMarker();
    this.lastLngLat = [lng, lat];
    this.lastAccuracy = accuracy;
    this.meMarker.setLngLat([lng, lat]);

    const showArrow = isMoving && typeof headingDeg === 'number';
    this.meMarkerEls.arrow.style.opacity = showArrow ? '1' : '0';
    if (showArrow) {
      this.meMarkerEls.arrow.style.transform = `rotate(${headingDeg}deg)`;
    }

    if (this.sourcesReady && typeof accuracy === 'number' && accuracy > 0) {
      this.map.getSource('accuracy-circle').setData({
        type: 'Feature',
        geometry: geoCirclePolygon(lat, lng, Math.min(accuracy, 300)),
      });
    }

    if (this.following) {
      this.map.easeTo({
        center: [lng, lat],
        duration: 500,
        easing: easeOutCubic,
      });
    }
  }

  /** Enable/disable Follow GPS. Called by the locate button and the
   *  "Kembali Ikuti" resume button. */
  toggleFollow(enabled) {
    this.following = enabled;
    this._emit({ type: 'follow-change', following: enabled });
    if (enabled && this.lastLngLat) {
      this.map.easeTo({
        center: this.lastLngLat,
        zoom: Math.max(this.map.getZoom(), 16),
        duration: 600,
        easing: easeOutCubic,
      });
    }
  }

  isFollowing() { return this.following; }

  zoomIn() { this.map.easeTo({ zoom: this.map.getZoom() + 1, duration: 300, easing: easeOutCubic }); }
  zoomOut() { this.map.easeTo({ zoom: this.map.getZoom() - 1, duration: 300, easing: easeOutCubic }); }

  flyTo(lat, lng, zoom = 16) {
    this.map.flyTo({ center: [lng, lat], zoom, duration: 900, easing: easeOutCubic });
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
    if (!this.sourcesReady) return null;
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
        this.map.fitBounds(bounds, { padding: 60, duration: 800, easing: easeOutCubic });
        return data.routes[0];
      }
    } catch (e) {
      console.warn('Route lookup failed', e);
    }
    return null;
  }

  clearRoute() {
    if (this.sourcesReady) {
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
