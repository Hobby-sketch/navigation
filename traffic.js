/**
 * traffic.js — Traffic Engine
 * Live traffic overlay on top of the existing MapLibre map, built with an
 * Adapter Pattern so the provider can be swapped (or extended) without
 * touching this file's orchestration logic or any other engine.
 *
 * Provider priority: HERE -> TomTom -> Mapbox Traffic (first one with a
 * user-supplied API key wins; falls through to the next on failure).
 *
 * HONEST LIMITATION: HERE/TomTom/Mapbox Traffic are paid commercial APIs.
 * This app is 100% static (GitHub Pages, no backend), so there is nowhere
 * to safely hide a shared secret key. The user must supply their OWN key
 * in Pengaturan; it is stored only in their browser's localStorage via
 * storage.js and sent directly from their browser to the provider — never
 * seen by us. If no key is configured, the engine stays cleanly disabled.
 *
 * Congestion legend (rendered by the provider's own tiles):
 *   🟢 Lancar   🟡 Padat   🔴 Macet   🟣 Sangat Macet
 */

const SOURCE_ID = 'traffic-source';
const LAYER_ID = 'traffic-layer';

const MOVING_REFRESH_MS = 60_000;      // adaptive refresh: faster while riding
const STATIONARY_REFRESH_MS = 180_000; // ...slower while parked (battery/bandwidth saving)

/** Base adapter — concrete providers implement getSource()/getLayers(). */
class TrafficAdapter {
  constructor(apiKey) { this.apiKey = apiKey; }
  get name() { return 'base'; }
  get attribution() { return ''; }
  isConfigured() { return typeof this.apiKey === 'string' && this.apiKey.trim().length > 0; }
  /** MapLibre source spec. `cacheBust` lets the engine force fresh tiles on refresh. */
  getSource(_cacheBust) { throw new Error('getSource() not implemented'); }
  getLayers() { throw new Error('getLayers() not implemented'); }
}

class HereTrafficAdapter extends TrafficAdapter {
  get name() { return 'here'; }
  get attribution() { return 'Traffic \u00A9 HERE'; }
  getSource(cacheBust) {
    return {
      type: 'raster',
      tiles: [`https://traffic.maps.hereapi.com/v3/flow/mc/{z}/{x}/{y}/png8?apiKey=${this.apiKey}&style=reduced.day&_t=${cacheBust}`],
      tileSize: 256,
      attribution: this.attribution,
    };
  }
  getLayers() {
    return [{ id: LAYER_ID, type: 'raster', source: SOURCE_ID, paint: { 'raster-opacity': 0.85 } }];
  }
}

class TomTomTrafficAdapter extends TrafficAdapter {
  get name() { return 'tomtom'; }
  get attribution() { return 'Traffic \u00A9 TomTom'; }
  getSource(cacheBust) {
    return {
      type: 'raster',
      tiles: [`https://api.tomtom.com/traffic/map/4/tile/flow/relative/{z}/{x}/{y}.png?key=${this.apiKey}&_t=${cacheBust}`],
      tileSize: 256,
      attribution: this.attribution,
    };
  }
  getLayers() {
    return [{ id: LAYER_ID, type: 'raster', source: SOURCE_ID, paint: { 'raster-opacity': 0.85 } }];
  }
}

class MapboxTrafficAdapter extends TrafficAdapter {
  get name() { return 'mapbox'; }
  get attribution() { return 'Traffic \u00A9 Mapbox'; }
  getSource() {
    return {
      type: 'vector',
      tiles: [`https://api.mapbox.com/v4/mapbox.mapbox-traffic-v1/{z}/{x}/{y}.vector.pbf?access_token=${this.apiKey}`],
      attribution: this.attribution,
    };
  }
  getLayers() {
    return [{
      id: LAYER_ID,
      type: 'line',
      source: SOURCE_ID,
      'source-layer': 'traffic',
      paint: {
        'line-width': 2.5,
        'line-color': [
          'match', ['get', 'congestion'],
          'low', '#35d07f',
          'moderate', '#f5c542',
          'heavy', '#e0602a',
          'severe', '#b3001b',
          '#888888',
        ],
      },
    }];
  }
}

const ADAPTER_REGISTRY = {
  here: HereTrafficAdapter,
  tomtom: TomTomTrafficAdapter,
  mapbox: MapboxTrafficAdapter,
};

const PROVIDER_PRIORITY = ['here', 'tomtom', 'mapbox'];

export class TrafficEngine {
  /** @param {import('./map.js').MapManager} mapManager */
  constructor(mapManager) {
    this.mapManager = mapManager;
    this.map = mapManager.map; // underlying maplibregl.Map
    this.enabled = false;
    this.activeAdapter = null;
    this.remainingChain = [];
    this.refreshTimer = null;
    this.listeners = new Set();
    this._visibilityBound = this._onVisibilityChange.bind(this);
    this._boundMapError = this._onMapError.bind(this);
    this.map.on('error', this._boundMapError);
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit(evt) { this.listeners.forEach((fn) => fn(evt)); }

  /** Build the adapter chain from stored settings: { apiKeys: { here, tomtom, mapbox } }. */
  _buildAdapterChain(apiKeys = {}) {
    return PROVIDER_PRIORITY
      .map((name) => new ADAPTER_REGISTRY[name](apiKeys[name]))
      .filter((a) => a.isConfigured());
  }

  hasAnyProviderConfigured(apiKeys = {}) {
    return this._buildAdapterChain(apiKeys).length > 0;
  }

  /** Try adapters in priority order until one's tiles actually load. */
  async enable(apiKeys = {}) {
    const chain = this._buildAdapterChain(apiKeys);
    if (!chain.length) {
      this._emit({ type: 'error', reason: 'no-provider' });
      return false;
    }
    this.remainingChain = chain.slice(1);
    const first = chain[0];
    const ok = await this._tryAdapter(first);
    if (ok) {
      this.enabled = true;
      this.activeAdapter = first;
      document.addEventListener('visibilitychange', this._visibilityBound);
      this._scheduleRefresh(false);
      this._emit({ type: 'enabled', provider: first.name });
      return true;
    }
    return this._fallbackToNext();
  }

  /** Called when the active provider's tiles fail to load at runtime
   *  (network error / invalid key / quota) — advances to the next adapter
   *  in the priority chain, or disables cleanly if none remain. */
  async _fallbackToNext() {
    while (this.remainingChain.length) {
      const next = this.remainingChain.shift();
      const ok = await this._tryAdapter(next);
      if (ok) {
        this.enabled = true;
        this.activeAdapter = next;
        document.addEventListener('visibilitychange', this._visibilityBound);
        this._scheduleRefresh(false);
        this._emit({ type: 'enabled', provider: next.name, fallback: true });
        return true;
      }
    }
    this.enabled = false;
    this.activeAdapter = null;
    this._emit({ type: 'error', reason: 'all-providers-failed' });
    return false;
  }

  _onMapError(e) {
    if (!this.enabled || !this.activeAdapter) return;
    const failedSource = e?.sourceId === SOURCE_ID || e?.source?.id === SOURCE_ID;
    if (!failedSource) return;
    console.warn(`Traffic provider "${this.activeAdapter.name}" tile load failed, falling back`);
    this._removeLayer();
    this._fallbackToNext();
  }

  disable() {
    this.enabled = false;
    clearTimeout(this.refreshTimer);
    document.removeEventListener('visibilitychange', this._visibilityBound);
    this._removeLayer();
    this.activeAdapter = null;
    this._emit({ type: 'disabled' });
  }

  destroy() {
    this.disable();
    this.map.off('error', this._boundMapError);
    this.listeners.clear();
  }

  /** Adaptive refresh: slower while parked to save battery/bandwidth; paused
   *  entirely while the tab/app is hidden. */
  onMotionUpdate(isMoving) {
    if (!this.enabled) return;
    this._isMoving = isMoving;
  }

  _scheduleRefresh(immediate) {
    clearTimeout(this.refreshTimer);
    const interval = this._isMoving ? MOVING_REFRESH_MS : STATIONARY_REFRESH_MS;
    const run = () => {
      if (document.visibilityState === 'hidden') { this._scheduleRefresh(false); return; }
      this._refreshTiles();
      this._scheduleRefresh(false);
    };
    this.refreshTimer = setTimeout(run, immediate ? 0 : interval);
  }

  _onVisibilityChange() {
    if (document.visibilityState === 'visible' && this.enabled) this._refreshTiles();
  }

  _refreshTiles() {
    if (!this.enabled || !this.activeAdapter) return;
    const cacheBust = Math.floor(Date.now() / 1000);
    const source = this.map.getSource(SOURCE_ID);
    const spec = this.activeAdapter.getSource(cacheBust);
    if (source && typeof source.setTiles === 'function' && spec.tiles) {
      source.setTiles(spec.tiles);
    } else {
      // Older MapLibre builds without setTiles(): remove + re-add.
      this._removeLayer();
      this._addLayer(this.activeAdapter, cacheBust);
    }
  }

  async _tryAdapter(adapter) {
    try {
      this._removeLayer();
      this._addLayer(adapter, Math.floor(Date.now() / 1000));
      return true;
    } catch (e) {
      console.warn(`Traffic provider "${adapter.name}" failed, trying next`, e);
      this._removeLayer();
      return false;
    }
  }

  _addLayer(adapter, cacheBust) {
    if (!this.map.getSource(SOURCE_ID)) {
      this.map.addSource(SOURCE_ID, adapter.getSource(cacheBust));
    }
    adapter.getLayers().forEach((layer) => {
      if (!this.map.getLayer(layer.id)) this.map.addLayer(layer);
    });
  }

  _removeLayer() {
    if (this.map.getLayer(LAYER_ID)) this.map.removeLayer(LAYER_ID);
    if (this.map.getSource(SOURCE_ID)) this.map.removeSource(SOURCE_ID);
  }
}

export const TRAFFIC_PROVIDERS = PROVIDER_PRIORITY;
