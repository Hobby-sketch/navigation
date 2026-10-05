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

import { angleDiff, clamp } from './geo.js';

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

/** Reverse geocode a tapped point (Nominatim). Always resolves with a usable name. */
export async function reversePlace(lat, lon) {
  const fallback = `Lokasi dipilih (${lat.toFixed(5)}, ${lon.toFixed(5)})`;
  try {
    const params = new URLSearchParams({ format: 'jsonv2', lat: String(lat), lon: String(lon), zoom: '18', addressdetails: '1' });
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?${params.toString()}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return fallback;
    const data = await res.json();
    const a = data.address || {};
    const name = data.name || a.road || a.neighbourhood || a.suburb || (data.display_name || '').split(',')[0];
    return name ? String(name) : fallback;
  } catch (e) {
    return fallback;
  }
}

/** Shared "Jadikan Tujuan" popup body (used by POI markers and map taps). */
function buildPlacePopup(name, onPick, subtitle = '') {
  const root = document.createElement('div');
  root.className = 'place-popup';
  const title = document.createElement('div');
  title.className = 'place-popup__name';
  title.textContent = name;
  root.appendChild(title);
  if (subtitle) {
    const sub = document.createElement('div');
    sub.className = 'place-popup__sub';
    sub.textContent = subtitle;
    root.appendChild(sub);
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'place-popup__btn';
  btn.textContent = 'Jadikan Tujuan';
  btn.addEventListener('click', (e) => { e.stopPropagation(); onPick(); });
  root.appendChild(btn);
  return { root, title };
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

    // --- navigation camera ---
    this.navMode = 'north';          // 'north' (North Up) | 'heading' (Heading Up)
    this.autoZoom = true;
    this.vehicleHeading = null;      // unified heading (deg) from heading.js
    this.vehicleHeadingValid = false;
    this.lastSpeedKmh = 0;
    this.navigating = false;         // route active (enables maneuver-aware zoom)
    this.nextManeuverM = null;
    this._lastCameraAt = 0;
    this._userZoomUntil = 0;
    this._targetZoom = null;
    this.tapMarker = null;
    this._tapToken = 0;
    this._fallbackHeading = null;
    this.isMoving = false;

    this.map.on('load', () => this._onLoad());
    this.map.on('rotate', () => { this._renderArrow(); this._emit({ type: 'bearing', bearing: this.map.getBearing() }); });
    this._bindFollowDisengage();
    this._bindTapSelect();
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit(evt) { this.listeners.forEach((fn) => fn(evt)); }

  _onLoad() {
    this.map.addSource('route', {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } },
    });
    // Route = blue (navigation colour), with a dark casing for contrast on any tile.
    this.map.addLayer({
      id: 'route-casing',
      type: 'line',
      source: 'route',
      paint: { 'line-color': '#0a1530', 'line-width': 9, 'line-opacity': 0.55 },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    });
    this.map.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route',
      paint: { 'line-color': '#2f8bff', 'line-width': 5.5, 'line-opacity': 0.96 },
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
    // While following, the camera is almost always mid-ease. MapLibre then does not fire a
    // fresh `movestart` for a user gesture, so listen to the gesture-specific start events too.
    // Programmatic easeTo/flyTo never carry an `originalEvent`, so they never disengage follow.
    const disengage = (e) => {
      if (e.originalEvent && this.following) {
        this.following = false;
        this.map.stop(); // cancel the in-flight follow ease so it cannot drag the view back
        this._emit({ type: 'follow-change', following: false });
      }
    };
    ['movestart', 'dragstart', 'zoomstart', 'rotatestart', 'pitchstart'].forEach((evt) => this.map.on(evt, disengage));
    // Touch/mouse down on the map itself is an explicit user take-over as well.
    const canvas = this.map.getCanvasContainer();
    const grab = () => { if (this.following && this._userDragIntent) disengage({ originalEvent: true }); };
    canvas.addEventListener('pointerdown', () => { this._userDragIntent = true; }, { passive: true });
    canvas.addEventListener('pointermove', (ev) => { if (ev.buttons) grab(); }, { passive: true });
    window.addEventListener('pointerup', () => { this._userDragIntent = false; }, { passive: true });
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
   * Update the "my location" marker position + accuracy circle. The ARROW now
   * points along the unified vehicleHeading (setVehicleHeading), not the raw
   * GPS bearing. `headingDeg` is only a legacy fallback used until a
   * vehicleHeading has ever been supplied.
   */
  setMyLocation(lat, lng, headingDeg, accuracy, isMoving, speedKmh) {
    this._ensureMeMarker();
    this.lastLngLat = [lng, lat];
    this.lastAccuracy = accuracy;
    this.isMoving = !!isMoving;
    if (typeof speedKmh === 'number') this.lastSpeedKmh = speedKmh;
    if (typeof headingDeg === 'number') this._fallbackHeading = headingDeg;
    this.meMarker.setLngLat([lng, lat]);
    this._renderArrow();

    if (this.sourcesReady && typeof accuracy === 'number' && accuracy > 0) {
      this.map.getSource('accuracy-circle').setData({
        type: 'Feature',
        geometry: geoCirclePolygon(lat, lng, Math.min(accuracy, 300)),
      });
    }

    if (this.following) this._followCamera();
  }

  /** Unified vehicle heading (from heading.js): drives arrow, Heading-Up bearing. */
  setVehicleHeading(headingDeg, valid = true) {
    this.vehicleHeading = Number.isFinite(headingDeg) ? headingDeg : null;
    this.vehicleHeadingValid = !!valid && this.vehicleHeading !== null;
    this._renderArrow();
    if (this.following && this.navMode === 'heading') this._followCamera();
  }

  /** Arrow is drawn relative to the MAP bearing so it stays right in Heading Up. */
  _renderArrow() {
    if (!this.meMarkerEls) return;
    let h = null;
    if (this.vehicleHeadingValid) h = this.vehicleHeading;
    else if (this.vehicleHeading === null && this.isMoving && typeof this._fallbackHeading === 'number') h = this._fallbackHeading;
    const arrow = this.meMarkerEls.arrow;
    if (h === null) { arrow.style.opacity = '0'; return; }
    arrow.style.opacity = '1';
    arrow.style.transform = `rotate(${(h - this.map.getBearing()).toFixed(1)}deg)`;
  }

  /* ------------------------------ navigation camera ------------------------------ */

  /** 'north' = North Up, 'heading' = Heading Up (map rotates with the vehicle). */
  setNavMode(mode, { engage = true } = {}) {
    const next = mode === 'heading' ? 'heading' : 'north';
    if (next === this.navMode) return;
    this.navMode = next;
    this._emit({ type: 'navmode-change', mode: next });
    if (!engage) return; // restoring a saved preference: don't move the camera
    if (next === 'north') {
      this.map.easeTo({ bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 500, easing: easeOutCubic });
    } else if (!this.following) {
      this.toggleFollow(true);
    } else {
      this._followCamera(true);
    }
  }

  setAutoZoom(on) { this.autoZoom = !!on; }
  setNavigating(on) { this.navigating = !!on; if (!on) this.nextManeuverM = null; }
  setNextManeuverDistance(m) { this.nextManeuverM = Number.isFinite(m) ? m : null; }

  /** Vehicle sits low-centre of the map in Heading Up (more road ahead visible). */
  _followPadding() {
    if (this.navMode !== 'heading') return { top: 0, bottom: 0, left: 0, right: 0 };
    const h = this.map.getContainer().clientHeight || 0;
    return { top: Math.round(h * 0.42), bottom: 0, left: 0, right: 0 };
  }

  _autoZoomTarget() {
    const v = this.lastSpeedKmh;
    let z = v < 8 ? 17.2 : v < 25 ? 16.8 : v < 45 ? 16.2 : v < 65 ? 15.6 : 15.0;
    if (this.navigating && this.nextManeuverM !== null && this.nextManeuverM < 180) z = Math.min(17.6, z + 0.6);
    return z;
  }

  /**
   * Single place that moves the camera while following. Programmatic easeTo has
   * no `originalEvent`, so it never disengages follow; a real user drag/pinch does
   * and the camera then stays where the user put it until "Kembali Ikuti".
   */
  _followCamera(force = false) {
    if (!this.lastLngLat) return;
    const now = performance.now();
    if (!force && now - this._lastCameraAt < 120) return;
    this._lastCameraAt = now;

    const opts = { center: this.lastLngLat, duration: force ? 450 : 260, easing: force ? easeOutCubic : (t) => t, essential: true };
    opts.padding = this._followPadding();

    if (this.navMode === 'heading' && this.vehicleHeadingValid) {
      const cur = this.map.getBearing();
      const diff = angleDiff(cur, this.vehicleHeading);
      if (force || Math.abs(diff) >= 1.5) opts.bearing = cur + diff;
    }

    if (this.autoZoom && now > this._userZoomUntil && !force) {
      const cur = this.map.getZoom();
      const target = this._autoZoomTarget();
      if (Math.abs(target - cur) > 0.12) opts.zoom = cur + clamp(target - cur, -0.12, 0.12);
    }
    this.map.easeTo(opts);
  }

  /** Enable/disable Follow GPS. Called by the locate button and the
   *  "Kembali Ikuti" resume button. */
  toggleFollow(enabled) {
    this.following = enabled;
    this._emit({ type: 'follow-change', following: enabled });
    if (enabled && this.lastLngLat) {
      const opts = {
        center: this.lastLngLat,
        zoom: Math.max(this.map.getZoom(), 16),
        padding: this._followPadding(),
        duration: 600,
        easing: easeOutCubic,
      };
      if (this.navMode === 'heading' && this.vehicleHeadingValid) {
        const cur = this.map.getBearing();
        opts.bearing = cur + angleDiff(cur, this.vehicleHeading);
      }
      this.map.easeTo(opts);
    }
  }

  isFollowing() { return this.following; }

  zoomIn() { this._userZoomUntil = performance.now() + 20000; this.map.easeTo({ zoom: this.map.getZoom() + 1, duration: 300, easing: easeOutCubic }); }
  zoomOut() { this._userZoomUntil = performance.now() + 20000; this.map.easeTo({ zoom: this.map.getZoom() - 1, duration: 300, easing: easeOutCubic }); }

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
    const popup = new maplibregl.Popup({ offset: 18, className: 'place-popup-wrap' });
    const body = buildPlacePopup(label, () => {
      popup.remove();
      this._emit({ type: 'pick-destination', lat, lon: lng, name: label });
    });
    popup.setDOMContent(body.root);
    marker.setPopup(popup);
    this.poiMarkers.push(marker);
    return marker;
  }

  /* ------------------------------ tap to choose ------------------------------ */

  _bindTapSelect() {
    this.map.on('click', (e) => {
      const target = e.originalEvent && e.originalEvent.target;
      if (target && target.closest && target.closest('.map-marker--poi, .map-marker--tap, .gmarker, .maplibregl-popup, .maplibregl-ctrl')) return;
      this._showTapPoint(e.lngLat.lat, e.lngLat.lng);
    });
  }

  async _showTapPoint(lat, lng) {
    this.clearTapMarker();
    const token = ++this._tapToken;
    const el = document.createElement('div');
    el.className = 'map-marker--tap';
    el.innerHTML = '<span></span>';
    const state = { name: 'Memuat alamat...' };
    const popup = new maplibregl.Popup({ offset: 22, closeButton: true, closeOnClick: false, className: 'place-popup-wrap' });
    const body = buildPlacePopup(state.name, () => {
      popup.remove();
      this._emit({ type: 'pick-destination', lat, lon: lng, name: state.name });
    }, `${lat.toFixed(5)}, ${lng.toFixed(5)}`);
    popup.setDOMContent(body.root);
    this.tapMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([lng, lat]).setPopup(popup).addTo(this.map);
    this.tapMarker.togglePopup();

    const name = await reversePlace(lat, lng);
    if (token !== this._tapToken || !this.tapMarker) return; // superseded by a newer tap
    state.name = name;
    body.title.textContent = name;
  }

  clearTapMarker() {
    if (this.tapMarker) { this.tapMarker.remove(); this.tapMarker = null; }
  }

  setDestination(lat, lng) {
    this.clearTapMarker();
    if (this.destMarker) this.destMarker.remove();
    const el = document.createElement('div');
    el.className = 'map-marker--poi';
    el.innerHTML = '<span>🏁</span>';
    this.destMarker = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(this.map);
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
