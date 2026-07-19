// ============================================================================
// CONFIGURATION CONSTANTS
// ============================================================================

// Detect mobile/tablet devices for memory optimization
// Include tablets (up to 1280px) to prevent WebGL context loss
const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
                 || (window.innerWidth <= 1280 && ('ontouchstart' in window || navigator.maxTouchPoints > 0));

const CONFIG = {
    // API Configuration
    OVERPASS_API_URL: 'https://overpass-api.de/api/interpreter',
    OVERPASS_TIMEOUT: 30,
    NOMINATIM_API_URL: 'https://nominatim.openstreetmap.org/search',

    // Retry Configuration
    MAX_RETRIES: 3,
    RETRY_DELAYS: [1000, 2000, 4000], // Exponential backoff in ms

    // WebGL Configuration (optimized for mobile to prevent context loss)
    MAX_FEATURES: isMobile ? 1000 : 5000,
    TEXTURE_SIZE: isMobile ? 64 : 128,
    WEBGL_CONTEXT_OPTIONS: {
        alpha: true,
        antialias: !isMobile, // Disable antialiasing on mobile to save memory
        preserveDrawingBuffer: true,
        failIfMajorPerformanceCaveat: false // Allow software rendering if needed
    },

    // Visualization Defaults
    DEFAULT_RADIUS_PERCENT: 0.12, // 12% of area characteristic dimension
    MIN_DISTANCE_KM: 0.01, // 10 meters
    MAX_VORONOI_COALESCE_KM: 20,
    DEFAULT_TRANSPARENCY: 0.5,
    DEFAULT_IDW_POWER: 2.0,
    DEFAULT_HEAT_BANDWIDTH: 0.3,

    // UI Timing
    SEARCH_DEBOUNCE_MS: 500, // Light throttling of Nominatim requests while typing
    VORONOI_UPDATE_DEBOUNCE_MS: 200,
    MESSAGE_TIMEOUT_MS: 5000,
    ERROR_MESSAGE_TIMEOUT_MS: 9000, // Errors stay up longer, especially valuable on mobile
    STATUS_HIDE_DELAY_MS: 1000,
    SLIDER_THROTTLE_MS: 16, // ~60fps

    // Color Interpolation
    PALETTE_INTERPOLATION_STEPS: 17,

    // Local Storage Keys
    STORAGE_PREFIX: 'isosmfar_',
    STORAGE_KEYS: {
        PALETTE: 'palette',
        BASEMAP: 'basemap',
        MODE: 'visualization_mode',
        TRANSPARENCY: 'transparency',
        LAST_QUERY: 'last_query'
    },

    // IndexedDB Configuration
    DB_NAME: 'isosmfar_cache',
    DB_VERSION: 1,
    CACHE_STORE_NAME: 'overpass_results',
    CACHE_MAX_AGE_DAYS: 7
};

// Attribution strings per OSM's/CARTO's requirements (contributors, linked)
const OSM_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors';
const CARTO_ATTRIBUTION = OSM_ATTRIBUTION + ' © <a href="https://carto.com/attributions" target="_blank">CARTO</a>';

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Creates a debounced function that delays execution until after wait milliseconds
 * have elapsed since the last call
 */
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

/**
 * Creates a throttled function that only invokes func at most once per every wait milliseconds
 * Uses leading + trailing edge execution for smooth updates during drag
 * Returns a function with a cancel() method to clear any pending execution
 */
function throttle(func, wait) {
    let timeoutId = null;
    let lastRan = 0;
    let lastArgs = null;

    const throttled = function(...args) {
        const context = this;
        const now = Date.now();
        const timeSinceLastRun = now - lastRan;

        // Store args for potential trailing call
        lastArgs = args;

        if (timeSinceLastRun >= wait) {
            // Enough time has passed, execute immediately (leading edge)
            func.apply(context, args);
            lastRan = now;

            // Clear any pending timeout since we just executed
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
        } else {
            // Not enough time has passed, schedule for later (trailing edge)
            if (timeoutId) {
                clearTimeout(timeoutId);
            }

            timeoutId = setTimeout(() => {
                func.apply(context, lastArgs);
                lastRan = Date.now();
                timeoutId = null;
            }, wait - timeSinceLastRun);
        }
    };

    // Add cancel method to clear pending execution
    throttled.cancel = function() {
        if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
        }
        lastArgs = null;
        // Don't reset lastRan - preserve timing for next call
    };

    return throttled;
}

/**
 * Retries an async function with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {number} maxRetries - Maximum number of retry attempts
 * @param {number[]} delays - Array of delay times in ms
 * @returns {Promise} Result of the function
 */
async function retryWithBackoff(fn, maxRetries = CONFIG.MAX_RETRIES, delays = CONFIG.RETRY_DELAYS) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (attempt < maxRetries) {
                const delay = delays[Math.min(attempt, delays.length - 1)];
                console.warn(`Attempt ${attempt + 1} failed, retrying in ${delay}ms...`, error);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    throw new Error(`Failed after ${maxRetries + 1} attempts: ${lastError.message}`, { cause: lastError });
}

/**
 * Local storage wrapper with prefix support
 */
const storage = {
    set(key, value) {
        try {
            localStorage.setItem(CONFIG.STORAGE_PREFIX + key, JSON.stringify(value));
            return true;
        } catch (e) {
            console.warn('LocalStorage set failed:', e);
            return false;
        }
    },
    get(key, defaultValue = null) {
        try {
            const item = localStorage.getItem(CONFIG.STORAGE_PREFIX + key);
            return item ? JSON.parse(item) : defaultValue;
        } catch (e) {
            console.warn('LocalStorage get failed:', e);
            return defaultValue;
        }
    },
    remove(key) {
        try {
            localStorage.removeItem(CONFIG.STORAGE_PREFIX + key);
            return true;
        } catch (e) {
            console.warn('LocalStorage remove failed:', e);
            return false;
        }
    }
};

/**
 * URL state management for sharing visualizations
 */
const urlState = {
    /**
     * Encodes current visualization state into URL hash
     */
    encode(state) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(state)) {
            if (value !== null && value !== undefined) {
                params.set(key, String(value));
            }
        }
        return params.toString();
    },

    // Keys that are always numeric/boolean; everything else (area, query,
    // mode, palette, basemap) is kept as a plain string even if its value
    // happens to look like a number or "true"/"false" (e.g. an area
    // literally named "2000" must round-trip as text, not a number).
    NUMERIC_KEYS: new Set(['lat', 'lng', 'zoom', 'radius', 'transparency', 'idwPower', 'heatBandwidth', 'coalesce']),
    BOOLEAN_KEYS: new Set(['voronoi']),

    /**
     * Decodes visualization state from URL hash
     */
    decode() {
        const hash = globalThis.location.hash.slice(1);
        if (!hash) return {};

        const params = new URLSearchParams(hash);
        const state = {};
        for (const [key, value] of params.entries()) {
            if (this.NUMERIC_KEYS.has(key) && value !== '' && !Number.isNaN(Number(value))) {
                state[key] = Number.parseFloat(value);
            } else if (this.BOOLEAN_KEYS.has(key)) {
                state[key] = value === 'true';
            } else {
                state[key] = value;
            }
        }
        return state;
    },

    /**
     * Updates URL hash without triggering navigation
     */
    update(state) {
        const encoded = this.encode(state);
        if (encoded) {
            globalThis.history.replaceState(null, '', '#' + encoded);
        }
    }
};

/**
 * IndexedDB cache for Overpass API results
 */
class CacheDB {
    constructor() {
        this.db = null;
        this.initPromise = this.init();
    }

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);

            request.onerror = () => {
                console.warn('IndexedDB init failed:', request.error);
                resolve(null); // Continue without cache
            };

            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(CONFIG.CACHE_STORE_NAME)) {
                    const store = db.createObjectStore(CONFIG.CACHE_STORE_NAME, { keyPath: 'key' });
                    store.createIndex('timestamp', 'timestamp', { unique: false });
                }
            };
        });
    }

    async get(key) {
        await this.initPromise;
        if (!this.db) return null;

        return new Promise((resolve) => {
            try {
                const transaction = this.db.transaction([CONFIG.CACHE_STORE_NAME], 'readonly');
                const store = transaction.objectStore(CONFIG.CACHE_STORE_NAME);
                const request = store.get(key);

                request.onsuccess = () => {
                    const result = request.result;
                    if (!result) {
                        resolve(null);
                        return;
                    }

                    // Check if cache is expired
                    const age = Date.now() - result.timestamp;
                    const maxAge = CONFIG.CACHE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
                    if (age > maxAge) {
                        this.delete(key); // Clean up expired entry
                        resolve(null);
                    } else {
                        resolve(result.data);
                    }
                };

                request.onerror = () => resolve(null);
            } catch (e) {
                console.warn('Cache get error:', e);
                resolve(null);
            }
        });
    }

    async set(key, data) {
        await this.initPromise;
        if (!this.db) return false;

        return new Promise((resolve) => {
            try {
                const transaction = this.db.transaction([CONFIG.CACHE_STORE_NAME], 'readwrite');
                const store = transaction.objectStore(CONFIG.CACHE_STORE_NAME);
                const request = store.put({
                    key,
                    data,
                    timestamp: Date.now()
                });

                request.onsuccess = () => resolve(true);
                request.onerror = () => resolve(false);
            } catch (e) {
                console.warn('Cache set error:', e);
                resolve(false);
            }
        });
    }

    async delete(key) {
        await this.initPromise;
        if (!this.db) return false;

        return new Promise((resolve) => {
            try {
                const transaction = this.db.transaction([CONFIG.CACHE_STORE_NAME], 'readwrite');
                const store = transaction.objectStore(CONFIG.CACHE_STORE_NAME);
                const request = store.delete(key);

                request.onsuccess = () => resolve(true);
                request.onerror = () => resolve(false);
            } catch (e) {
                console.warn('Cache delete error:', e);
                resolve(false);
            }
        });
    }
}

// ============================================================================
// MAIN APPLICATION CLASS
// ============================================================================

class IsosmfarApp {
    // =================================================================
    // Class Fields - Static Values
    // =================================================================
    // Color Palettes (9 colors each, interpolated to 17)
    colorPalettes = {
        blue: ['#f7fbff','#deebf7','#c6dbef','#9ecae1','#6baed6','#4292c6','#2171b5','#08519c','#08306b'],
        green: ['#f7fcf5','#e5f5e0','#c7e9c0','#a1d99b','#74c476','#41ab5d','#238b45','#006d2c','#00441b'],
        gray: ['#ffffff','#f0f0f0','#d9d9d9','#bdbdbd','#969696','#737373','#525252','#252525','#000000'],
        orange: ['#fff5eb','#fee6ce','#fdd0a2','#fdae6b','#fd8d3c','#f16913','#d94801','#a63603','#7f2704'],
        purple: ['#fcfbfd','#efedf5','#dadaeb','#bcbddc','#9e9ac8','#807dba','#6a51a3','#54278f','#3f007d'],
        red: ['#fff5f0','#fee0d2','#fcbba1','#fc9272','#fb6a4a','#ef3b2c','#cb181d','#a50f15','#67000d']
    };

    interpolatedPalettes = {};

    constructor() {
        // =================================================================
        // Core State
        // =================================================================
        this.map = null;
        this.selectedArea = null;
        this.lastResults = null;
        this.searchTimeout = null;

        // Initialize cache for API results
        this.cache = new CacheDB();

        // Voronoi Web Worker for non-blocking computation
        this.voronoiWorker = new Worker('voronoi-worker.js');
        this.voronoiRequestId = 0;
        this.voronoiWorker.onmessage = (e) => {
            const { voronoiGeoJSON, coalesceInfo, requestId } = e.data;
            // Discard stale results from superseded requests
            if (requestId !== this.voronoiRequestId) return;
            this.voronoiGeoJSON = voronoiGeoJSON;
            document.getElementById('coalesce-info').textContent = coalesceInfo;
            this.updateVoronoiOverlay();
        };
        this.voronoiWorker.onerror = (e) => {
            console.error('Voronoi worker error:', e.message, e);
            this.showMessage('Voronoi computation failed: ' + e.message, 'error');
        };

        // Taginfo autocomplete caches
        this.taginfoKeysCache = null;  // Cache of popular OSM keys
        this.taginfoValuesCache = {};   // Cache of values per key
        this.selectedQueryIndex = -1;   // Currently selected dropdown index for keyboard navigation
        this.selectedAreaIndex = -1;    // Currently selected area-dropdown index for keyboard navigation
        this.currentQueryTagInfo = null; // Current tag info for keyboard selection
        this.currentQueryCursorPos = 0;  // Cursor position when dropdown was shown

        // =================================================================
        // Visualization Mode & Parameters
        // =================================================================
        // Initialize from localStorage/defaults only. loadStateFromURL(),
        // called from init() before the map is created, applies any URL
        // overrides on top of these - keeping URL parsing in one place
        // avoids the two going out of sync (and dropping falsy overrides
        // like transparency=0 or voronoi=false, which `||` would ignore).
        this.visualizationMode = storage.get(CONFIG.STORAGE_KEYS.MODE, 'distance');

        // Mode-specific parameters
        this.idwPower = CONFIG.DEFAULT_IDW_POWER;
        this.heatBandwidth = CONFIG.DEFAULT_HEAT_BANDWIDTH;

        // Voronoi overlay state
        this.showVoronoiBorders = false;
        this.voronoiCoalesceKm = 0;

        // Visualization parameters
        this.maxDistanceKm = 50;
        this.maxDistanceLimit = null;
        this.transparency = storage.get(CONFIG.STORAGE_KEYS.TRANSPARENCY, CONFIG.DEFAULT_TRANSPARENCY);

        // =================================================================
        // Layer & Feature State
        // =================================================================
        this.gradientFieldLayer = null;
        this.voronoiGeoJSON = null;
        this.originalFeatures = null;
        this.areaBoundary = null;

        // =================================================================
        // UI State
        // =================================================================
        this.draggingCursor = null;
        this.sliderRefs = {}; // type -> {cursor, track}, populated by initSlider()
        this.voronoiUpdateTimer = null;

        // Create throttled visualization update for slider drag performance
        // Using CONFIG.SLIDER_THROTTLE_MS (16ms = ~60fps) to balance smoothness and performance
        this.throttledVisualizationUpdate = throttle(() => {
            this.updateVisualization();
        }, CONFIG.SLIDER_THROTTLE_MS);

        // Basemap selection
        this.currentBasemap = storage.get(CONFIG.STORAGE_KEYS.BASEMAP, 'standard');

        // Current palette selection (loaded from storage or default)
        this.currentPalette = storage.get(CONFIG.STORAGE_KEYS.PALETTE, 'blue');

        this.init();
    }

    // =====================================================================
    // INITIALIZATION
    // =====================================================================

    init() {
        this.interpolatePalettes();
        this.initPaletteSelector();

        // Load URL parameters first to get initial map position
        this.loadStateFromURL();

        // Initialize map with correct position from URL (or defaults)
        this.initMap();

        this.bindEvents();
        this.initSliderControls();
        this.initModeToggle();
        this.initVoronoiCheckbox();
        this.initCoalesceSlider();
        this.initModeSpecificSliders();

        // Wait for map to be fully loaded before restoring UI and auto-executing
        this.map.once('load', () => {
            // Show mobile optimization info
            if (isMobile) {
                console.log('Mobile device detected - using optimized settings:');
                console.log(`- Max features: ${CONFIG.MAX_FEATURES} (reduced from 5000)`);
                console.log(`- Texture size: ${CONFIG.TEXTURE_SIZE}x${CONFIG.TEXTURE_SIZE} (reduced from 128x128)`);
                console.log('- Antialiasing disabled');
                console.log('Tip: Use smaller areas or simpler queries to avoid memory issues');
            }

            // Restore UI to match loaded state
            this.restoreUIFromState();
            // Auto-execute query if URL has area and query
            this.autoExecuteFromURL();
        });
    }

    /**
     * Load state from URL parameters (if present)
     * Called before map initialization to get initial position
     */
    loadStateFromURL() {
        const urlParams = urlState.decode();

        // Flag to indicate we loaded from URL (so generate() preserves values)
        this.loadedFromURL = !!(urlParams.area && urlParams.query);

        // Store initial map position for initMap() to use
        this.initialMapCenter = urlParams.lat !== undefined && urlParams.lng !== undefined
            ? [urlParams.lng, urlParams.lat]
            : null;
        this.initialMapZoom = urlParams.zoom !== undefined ? urlParams.zoom : null;

        // Restore visualization parameters
        if (urlParams.mode) {
            this.visualizationMode = urlParams.mode;
        }
        if (urlParams.palette) {
            this.currentPalette = urlParams.palette;
        }
        if (urlParams.basemap) {
            this.currentBasemap = urlParams.basemap;
        }
        if (urlParams.transparency !== undefined) {
            this.transparency = urlParams.transparency;
        }
        if (urlParams.radius !== undefined) {
            this.maxDistanceKm = urlParams.radius;
        }
        if (urlParams.idwPower !== undefined) {
            this.idwPower = urlParams.idwPower;
        }
        if (urlParams.heatBandwidth !== undefined) {
            this.heatBandwidth = urlParams.heatBandwidth;
        }
        if (urlParams.voronoi !== undefined) {
            this.showVoronoiBorders = urlParams.voronoi;
        }
        if (urlParams.coalesce !== undefined) {
            this.voronoiCoalesceKm = urlParams.coalesce;
        }

        // Restore area and query inputs
        if (urlParams.area) {
            document.getElementById('area').value = urlParams.area;
        }
        if (urlParams.query) {
            document.getElementById('query').value = urlParams.query;
        } else {
            // No query in the URL - prefill with the last query the user ran, if any
            const lastQuery = storage.get(CONFIG.STORAGE_KEYS.LAST_QUERY);
            if (lastQuery) {
                document.getElementById('query').value = lastQuery;
            }
        }
    }

    /**
     * Auto-execute query if URL has both area and query
     * Called after map is fully loaded
     */
    autoExecuteFromURL() {
        const urlParams = urlState.decode();

        // Auto-execute query if both area and query are present
        if (urlParams.area && urlParams.query) {
            // Small delay to ensure all initialization is complete
            setTimeout(() => {
                this.generate();
            }, 200);
        }
    }

    /**
     * Restore UI controls to match current state
     */
    restoreUIFromState() {
        // Set basemap dropdown and apply basemap
        const basemapSelect = document.getElementById('basemap-selector');
        if (basemapSelect) {
            basemapSelect.value = this.currentBasemap;
        }
        // Switch to the correct basemap (important for URL params)
        this.switchBasemap(this.currentBasemap);

        // Set voronoi checkbox and show/hide controls
        const voronoiCheckbox = document.getElementById('voronoi-overlay');
        if (voronoiCheckbox) {
            voronoiCheckbox.checked = this.showVoronoiBorders;
        }
        // Show/hide Voronoi controls based on checkbox state
        const voronoiControls = document.getElementById('voronoi-controls');
        if (this.showVoronoiBorders) {
            voronoiControls.classList.add('active');
        } else {
            voronoiControls.classList.remove('active');
        }

        // Set visualization mode buttons
        const modeButtons = document.querySelectorAll('.toggle-button');
        modeButtons.forEach(btn => {
            const isActive = btn.dataset.mode === this.visualizationMode;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-pressed', String(isActive));
        });

        // Update palette selector display
        this.updatePaletteDisplay();

        // Restore distance/radius slider position (exponential scale)
        if (this.maxDistanceLimit) {
            const logPosition = Math.log(this.maxDistanceKm / CONFIG.MIN_DISTANCE_KM) /
                               Math.log(this.maxDistanceLimit / CONFIG.MIN_DISTANCE_KM);
            const distancePercent = Math.max(0, Math.min(100, logPosition * 100));
            document.getElementById('distance-cursor').style.left = distancePercent + '%';
        }

        // Restore transparency slider position
        const transparencyPercent = this.transparency * 100;
        document.getElementById('transparency-cursor').style.left = transparencyPercent + '%';

        // Restore IDW power slider position (linear scale 1.0 to 5.0)
        const idwPercent = ((this.idwPower - 1.0) / 4.0) * 100;
        document.getElementById('idw-power-cursor').style.left = idwPercent + '%';
        document.getElementById('idw-power-value').textContent = this.idwPower.toFixed(1);

        // Restore heat bandwidth slider position (linear scale 0.1 to 1.0)
        const heatPercent = ((this.heatBandwidth - 0.1) / 0.9) * 100;
        document.getElementById('heat-bandwidth-cursor').style.left = heatPercent + '%';
        document.getElementById('heat-bandwidth-value').textContent = `${Math.round(this.heatBandwidth * 100)}%`;

        // Restore coalesce slider position (exponential scale)
        if (this.voronoiCoalesceKm === 0) {
            document.getElementById('coalesce-cursor').style.left = '0%';
        } else {
            const coalesceLogPosition = Math.log(this.voronoiCoalesceKm / 0.001) /
                                        Math.log(CONFIG.MAX_VORONOI_COALESCE_KM / 0.001);
            const coalescePercent = Math.max(0, Math.min(100, coalesceLogPosition * 100));
            document.getElementById('coalesce-cursor').style.left = coalescePercent + '%';
        }

        // Update slider value displays
        this.updateSliderValues();
        this.updateCoalesceValue();

        // Sync ARIA value attributes to match the restored state
        document.getElementById('distance-cursor').setAttribute('aria-valuenow', String(this.maxDistanceKm));
        document.getElementById('distance-cursor').setAttribute('aria-valuetext', document.getElementById('distance-value').textContent);
        document.getElementById('transparency-cursor').setAttribute('aria-valuenow', String(Math.round(this.transparency * 100)));
        document.getElementById('transparency-cursor').setAttribute('aria-valuetext', document.getElementById('transparency-value').textContent);
        document.getElementById('idw-power-cursor').setAttribute('aria-valuenow', String(this.idwPower));
        document.getElementById('idw-power-cursor').setAttribute('aria-valuetext', this.idwPower.toFixed(1));
        document.getElementById('heat-bandwidth-cursor').setAttribute('aria-valuenow', String(Math.round(this.heatBandwidth * 100)));
        document.getElementById('heat-bandwidth-cursor').setAttribute('aria-valuetext', document.getElementById('heat-bandwidth-value').textContent);
        document.getElementById('coalesce-cursor').setAttribute('aria-valuenow', String(this.voronoiCoalesceKm));
        document.getElementById('coalesce-cursor').setAttribute('aria-valuetext', document.getElementById('coalesce-value').textContent);

        // Update UI for current mode
        this.updateUIForMode();
    }

    /**
     * Save current state to both URL and localStorage
     */
    saveState() {
        // Don't save state if map isn't loaded yet
        if (!this.map || !this.map.loaded()) {
            return;
        }

        // Get current map position
        const center = this.map.getCenter();
        const zoom = this.map.getZoom();

        const state = {
            mode: this.visualizationMode,
            palette: this.currentPalette,
            basemap: this.currentBasemap,
            transparency: this.transparency,
            radius: this.maxDistanceKm,
            idwPower: this.idwPower,
            heatBandwidth: this.heatBandwidth,
            voronoi: this.showVoronoiBorders,
            coalesce: this.voronoiCoalesceKm,
            lat: center.lat.toFixed(4),
            lng: center.lng.toFixed(4),
            zoom: zoom.toFixed(2)
        };

        // Add area and query if present
        const area = document.getElementById('area').value;
        const query = document.getElementById('query').value;
        if (area) state.area = area;
        if (query) state.query = query;

        // Save to URL
        urlState.update(state);

        // Save preferences to localStorage
        storage.set(CONFIG.STORAGE_KEYS.MODE, this.visualizationMode);
        storage.set(CONFIG.STORAGE_KEYS.PALETTE, this.currentPalette);
        storage.set(CONFIG.STORAGE_KEYS.BASEMAP, this.currentBasemap);
        storage.set(CONFIG.STORAGE_KEYS.TRANSPARENCY, this.transparency);
        if (query) {
            storage.set(CONFIG.STORAGE_KEYS.LAST_QUERY, query);
        }
    }

    // =====================================================================
    // UI INITIALIZATION
    // =====================================================================

    initModeToggle() {
        const toggleButtons = document.querySelectorAll('.toggle-button');
        toggleButtons.forEach(button => {
            button.addEventListener('click', () => {
                // Update active state
                toggleButtons.forEach(b => {
                    b.classList.remove('active');
                    b.setAttribute('aria-pressed', 'false');
                });
                button.classList.add('active');
                button.setAttribute('aria-pressed', 'true');

                // Update mode
                this.visualizationMode = button.dataset.mode;

                // Update UI labels based on mode
                this.updateUIForMode();

                // Save state
                this.saveState();

                // Re-render if we have data
                if (this.gradientFieldLayer) {
                    this.updateVisualization();
                }
            });
        });
    }

    initModeSpecificSliders() {
        this.initSlider('idw-power', 'idw-power-cursor', 'idw-power-slider', 'IDW Power');
        this.initSlider('heat-bandwidth', 'heat-bandwidth-cursor', 'heat-bandwidth-slider', 'Heat Bandwidth');
    }

    initVoronoiCheckbox() {
        const checkbox = document.getElementById('voronoi-overlay');
        checkbox.addEventListener('change', (e) => {
            this.showVoronoiBorders = e.target.checked;

            // Show/hide Voronoi controls
            const voronoiControls = document.getElementById('voronoi-controls');
            if (this.showVoronoiBorders) {
                voronoiControls.classList.add('active');
            } else {
                voronoiControls.classList.remove('active');
            }

            this.updateVoronoiOverlay();
        });
    }

    initCoalesceSlider() {
        this.initSlider('coalesce', 'coalesce-cursor', 'coalesce-slider', 'Voronoi coalesce distance');
    }

    updateUIForMode() {
        const radiusLabel = document.getElementById('radius-label');
        const radiusTooltip = radiusLabel;

        // Hide all mode-specific controls
        document.querySelectorAll('.mode-specific-controls').forEach(el => {
            el.classList.remove('active');
        });

        if (this.visualizationMode === 'distance') {
            radiusLabel.textContent = 'Gradient radius';
            radiusTooltip.dataset.tooltip = 'Adjust gradient radius around data points';
        } else if (this.visualizationMode === 'density') {
            radiusLabel.textContent = 'Density kernel radius';
            radiusTooltip.dataset.tooltip = 'Count features within this radius for density calculation';
        } else if (this.visualizationMode === 'idw') {
            radiusLabel.textContent = 'IDW influence radius';
            radiusTooltip.dataset.tooltip = 'Maximum distance for inverse distance weighting';
            document.getElementById('idw-controls').classList.add('active');
        } else if (this.visualizationMode === 'heat') {
            radiusLabel.textContent = 'Heat diffusion radius';
            radiusTooltip.dataset.tooltip = 'Maximum heat spread from source points';
            document.getElementById('heat-controls').classList.add('active');
        }

        document.getElementById('distance-cursor').setAttribute('aria-label', radiusLabel.textContent);
    }

    hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
            r: Number.parseInt(result[1], 16),
            g: Number.parseInt(result[2], 16),
            b: Number.parseInt(result[3], 16)
        } : null;
    }

    rgbToHex(r, g, b) {
        return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
    }

    interpolateColor(color1, color2, factor) {
        const c1 = this.hexToRgb(color1);
        const c2 = this.hexToRgb(color2);
        const r = Math.round(c1.r + (c2.r - c1.r) * factor);
        const g = Math.round(c1.g + (c2.g - c1.g) * factor);
        const b = Math.round(c1.b + (c2.b - c1.b) * factor);
        return this.rgbToHex(r, g, b);
    }

    interpolatePalettes() {
        for (const [name, palette] of Object.entries(this.colorPalettes)) {
            const interpolated = [];
            for (let i = 0; i < palette.length - 1; i++) {
                interpolated.push(palette[i]);
                const midColor = this.interpolateColor(palette[i], palette[i + 1], 0.5);
                interpolated.push(midColor);
            }
            interpolated.push(palette[palette.length - 1]);
            this.interpolatedPalettes[name] = interpolated;
        }
    }

    initPaletteSelector() {
        const dropdown = document.getElementById('palette-dropdown');
        const selectedContainer = document.getElementById('palette-selected');

        // Create dropdown options with visual gradients
        for (const [name, palette] of Object.entries(this.colorPalettes)) {
            const option = document.createElement('div');
            option.className = 'palette-option';
            option.dataset.palette = name;

            const gradient = document.createElement('div');
            gradient.className = 'palette-gradient';
            const colors = palette.map((c, i) => `${c} ${(i / (palette.length - 1)) * 100}%`).join(', ');
            gradient.style.background = `linear-gradient(to right, ${colors})`;

            option.appendChild(gradient);
            dropdown.appendChild(option);

            option.addEventListener('click', () => {
                this.switchPalette(name);
                this.updatePaletteDisplay();
                dropdown.classList.remove('active');
            });
        }

        // Set initial display
        this.updatePaletteDisplay();

        // Toggle dropdown
        selectedContainer.addEventListener('click', () => {
            dropdown.classList.toggle('active');
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.palette-selector-container')) {
                dropdown.classList.remove('active');
            }
        });
    }

    updatePaletteDisplay() {
        const selectedDisplay = document.getElementById('selected-gradient');
        const palette = this.colorPalettes[this.currentPalette];
        const colors = palette.map((c, i) => `${c} ${(i / (palette.length - 1)) * 100}%`).join(', ');
        selectedDisplay.style.background = `linear-gradient(to right, ${colors})`;
    }

    initMap() {
        // Use URL parameters for initial position, or defaults
        const initialCenter = this.initialMapCenter || [-11.5, 8.5];
        const initialZoom = this.initialMapZoom !== null ? this.initialMapZoom : 7;

        this.map = new maplibregl.Map({
            container: 'map',
            canvasContextAttributes: CONFIG.WEBGL_CONTEXT_OPTIONS,
            style: {
                version: 8,
                sources: {
                    'osm': {
                        type: 'raster',
                        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
                        tileSize: 256,
                        attribution: OSM_ATTRIBUTION
                    }
                },
                layers: [{
                    id: 'osm',
                    type: 'raster',
                    source: 'osm'
                }]
            },
            center: initialCenter,
            zoom: initialZoom
        });

        // Add WebGL context loss detection for mobile debugging
        const canvas = this.map.getCanvas();
        canvas.addEventListener('webglcontextlost', (event) => {
            event.preventDefault();
            console.error('WebGL context lost!');
            this.showMessage('WebGL context lost - this can happen on mobile due to memory constraints. Try reloading.', 'error');
            this.showStatus('❌ WebGL context lost - try reloading');
        }, false);

        canvas.addEventListener('webglcontextrestored', () => {
            console.log('WebGL context restored');
            this.showStatus('WebGL context restored');
        }, false);

        this.map.addControl(new maplibregl.NavigationControl());

        // Save map position to URL when user moves the map
        // Debounce to avoid excessive URL updates during pan/zoom
        const debouncedSaveState = debounce(() => {
            this.saveState();
        }, 1000);
        this.map.on('moveend', debouncedSaveState);
    }

    switchBasemap(basemapType) {
        let tiles, attribution;

        switch(basemapType) {
            case 'humanitarian':
                tiles = ['https://a.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
                        'https://b.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png'];
                attribution = OSM_ATTRIBUTION;
                break;
            case 'carto-light':
                tiles = ['https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
                        'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png'];
                attribution = CARTO_ATTRIBUTION;
                break;
            default: // standard
                tiles = ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'];
                attribution = OSM_ATTRIBUTION;
        }

        // Remove old source and layer
        if (this.map.getLayer('osm')) {
            this.map.removeLayer('osm');
        }
        if (this.map.getSource('osm')) {
            this.map.removeSource('osm');
        }

        // Add new source and layer
        this.map.addSource('osm', {
            type: 'raster',
            tiles: tiles,
            tileSize: 256,
            attribution: attribution
        });

        // Add the layer at the bottom
        this.map.addLayer({
            id: 'osm',
            type: 'raster',
            source: 'osm'
        }, this.map.getLayer('gradient-field') ? 'gradient-field' : undefined);

        this.currentBasemap = basemapType;
        this.saveState(); // Save basemap preference
    }

    switchPalette(paletteName) {
        this.currentPalette = paletteName;
        this.saveState(); // Save palette preference

        if (this.gradientFieldLayer) {
            this.updateVisualization();
        }
        if (this.map.getLayer('features')) {
            // Update point colors
            const palette = this.interpolatedPalettes[paletteName];
            const pointColor = palette[Math.floor(palette.length * 0.75)]; // Use color from 75% position
            this.map.setPaintProperty('features', 'circle-color', '#ffffff');
            this.map.setPaintProperty('features', 'circle-stroke-color', pointColor);
        }
    }

    // Static ARIA min/max per slider type (distance's max is set dynamically
    // in generate() once the area-dependent limit is known)
    static SLIDER_ARIA_RANGE = {
        distance: { min: CONFIG.MIN_DISTANCE_KM },
        transparency: { min: 0, max: 100 },
        coalesce: { min: 0, max: CONFIG.MAX_VORONOI_COALESCE_KM },
        'idw-power': { min: 1.0, max: 5.0 },
        'heat-bandwidth': { min: 10, max: 100 }
    };

    /**
     * Wire up one custom slider: pointer drag (mouse, touch, pen, with
     * capture so the drag keeps tracking outside the element) and keyboard
     * (arrow keys, Home/End), plus the ARIA attributes that make both the
     * value and the interaction model available to assistive tech.
     */
    initSlider(type, cursorId, sliderId, ariaLabel) {
        const cursor = document.getElementById(cursorId);
        const track = document.getElementById(sliderId);
        this.sliderRefs[type] = { cursor, track };

        cursor.setAttribute('role', 'slider');
        cursor.setAttribute('tabindex', '0');
        cursor.setAttribute('aria-orientation', 'horizontal');
        if (ariaLabel) cursor.setAttribute('aria-label', ariaLabel);

        const range = IsosmfarApp.SLIDER_ARIA_RANGE[type];
        if (range) {
            cursor.setAttribute('aria-valuemin', String(range.min));
            if (range.max !== undefined) cursor.setAttribute('aria-valuemax', String(range.max));
        }

        cursor.addEventListener('pointerdown', (e) => {
            this.draggingCursor = { cursor, slider: track, type };
            cursor.setPointerCapture(e.pointerId);
            e.preventDefault();
        });

        cursor.addEventListener('keydown', (e) => {
            this.handleSliderKeydown(type, e);
        });
    }

    /**
     * Apply a 0-100 track percentage to the given slider type: updates the
     * cursor position, the underlying value (using each slider's own scale -
     * exponential for distance/coalesce, linear for the rest), the visible
     * value label, ARIA value attributes, and triggers the appropriate
     * (throttled or debounced) visualization update.
     */
    applySliderPercent(type, percent) {
        const cursor = this.sliderRefs[type].cursor;
        cursor.style.left = percent + '%';

        if (type === 'distance') {
            // Use exponential scale for better control at lower values
            const logValue = percent / 100;
            // Calculate distance with exponential scale, minimum configured
            const calculatedDistance = Math.pow(this.maxDistanceLimit / CONFIG.MIN_DISTANCE_KM, logValue) * CONFIG.MIN_DISTANCE_KM;
            this.maxDistanceKm = Math.min(calculatedDistance, this.maxDistanceLimit);
            // Round to appropriate precision based on scale
            if (this.maxDistanceKm < 1) {
                this.maxDistanceKm = Math.round(this.maxDistanceKm * 100) / 100;
            } else {
                this.maxDistanceKm = Math.round(this.maxDistanceKm);
            }
            this.updateSliderValues();
            this.throttledVisualizationUpdate();
            cursor.setAttribute('aria-valuenow', String(this.maxDistanceKm));
            cursor.setAttribute('aria-valuetext', document.getElementById('distance-value').textContent);
        } else if (type === 'transparency') {
            this.transparency = percent / 100;
            this.updateSliderValues();
            this.throttledVisualizationUpdate();
            cursor.setAttribute('aria-valuenow', String(Math.round(this.transparency * 100)));
            cursor.setAttribute('aria-valuetext', document.getElementById('transparency-value').textContent);
        } else if (type === 'coalesce') {
            // Exponential scale from 0 to max configured
            if (percent === 0) {
                this.voronoiCoalesceKm = 0;
            } else {
                const logValue = percent / 100;
                this.voronoiCoalesceKm = Math.pow(CONFIG.MAX_VORONOI_COALESCE_KM / 0.001, logValue) * 0.001;
                if (this.voronoiCoalesceKm < 0.01) {
                    this.voronoiCoalesceKm = Math.round(this.voronoiCoalesceKm * 1000) / 1000;
                } else if (this.voronoiCoalesceKm < 1) {
                    this.voronoiCoalesceKm = Math.round(this.voronoiCoalesceKm * 100) / 100;
                } else {
                    this.voronoiCoalesceKm = Math.round(this.voronoiCoalesceKm * 10) / 10;
                }
            }
            this.updateCoalesceValue();
            this.debouncedVoronoiUpdate();
            cursor.setAttribute('aria-valuenow', String(this.voronoiCoalesceKm));
            cursor.setAttribute('aria-valuetext', document.getElementById('coalesce-value').textContent);
        } else if (type === 'idw-power') {
            // Linear scale from 1.0 to 5.0
            this.idwPower = 1.0 + (percent / 100) * 4.0;
            this.idwPower = Math.round(this.idwPower * 10) / 10;
            document.getElementById('idw-power-value').textContent = this.idwPower.toFixed(1);
            this.throttledVisualizationUpdate();
            cursor.setAttribute('aria-valuenow', String(this.idwPower));
            cursor.setAttribute('aria-valuetext', this.idwPower.toFixed(1));
        } else if (type === 'heat-bandwidth') {
            // Linear scale from 0.1 to 1.0 (10% to 100%)
            this.heatBandwidth = 0.1 + (percent / 100) * 0.9;
            this.heatBandwidth = Math.round(this.heatBandwidth * 100) / 100;
            document.getElementById('heat-bandwidth-value').textContent = `${Math.round(this.heatBandwidth * 100)}%`;
            this.throttledVisualizationUpdate();
            cursor.setAttribute('aria-valuenow', String(Math.round(this.heatBandwidth * 100)));
            cursor.setAttribute('aria-valuetext', document.getElementById('heat-bandwidth-value').textContent);
        }
    }

    /**
     * Finalize a slider change (drag end or a keyboard step): cancel any
     * pending throttled update, apply the final state directly, and persist it.
     */
    commitSliderChange() {
        this.throttledVisualizationUpdate.cancel();
        this.updateVisualization();
        this.saveState();
    }

    /**
     * Keyboard interaction for a slider cursor: arrow keys step by 2%,
     * Home/End jump to the extremes. Each press is a complete, discrete
     * action (unlike a drag), so it commits immediately.
     */
    handleSliderKeydown(type, e) {
        const STEP_PERCENT = 2;
        const cursor = this.sliderRefs[type].cursor;
        const current = Number.parseFloat(cursor.style.left) || 0;
        let percent;

        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
            percent = Math.max(0, current - STEP_PERCENT);
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
            percent = Math.min(100, current + STEP_PERCENT);
        } else if (e.key === 'Home') {
            percent = 0;
        } else if (e.key === 'End') {
            percent = 100;
        } else {
            return; // Not a key this slider handles
        }

        e.preventDefault();
        this.applySliderPercent(type, percent);
        this.commitSliderChange();
    }

    initSliderControls() {
        this.initSlider('distance', 'distance-cursor', 'distance-slider', 'Gradient radius');
        this.initSlider('transparency', 'transparency-cursor', 'transparency-slider', 'Transparency');

        document.addEventListener('pointermove', (e) => {
            if (!this.draggingCursor) return;

            const rect = this.draggingCursor.slider.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const percent = Math.max(0, Math.min(100, (x / rect.width) * 100));

            this.applySliderPercent(this.draggingCursor.type, percent);
        });

        document.addEventListener('pointerup', () => {
            if (this.draggingCursor) {
                this.commitSliderChange();
            }
            this.draggingCursor = null;
        });

        document.addEventListener('pointercancel', () => {
            this.draggingCursor = null;
        });
    }

    updateSliderValues() {
        // Display distance with appropriate units
        let distanceText;
        if (this.maxDistanceKm < 1) {
            distanceText = `${Math.round(this.maxDistanceKm * 1000)} m`;
        } else {
            distanceText = `${Math.round(this.maxDistanceKm)} km`;
        }
        document.getElementById('distance-value').textContent = distanceText;
        document.getElementById('transparency-value').textContent = `${Math.round(this.transparency * 100)}%`;
    }

    updateCoalesceValue() {
        let coalesceText;
        if (this.voronoiCoalesceKm === 0) {
            coalesceText = 'Off';
        } else if (this.voronoiCoalesceKm < 1) {
            coalesceText = `${Math.round(this.voronoiCoalesceKm * 1000)} m`;
        } else {
            coalesceText = `${this.voronoiCoalesceKm.toFixed(1)} km`;
        }
        document.getElementById('coalesce-value').textContent = coalesceText;
    }

    /**
     * Debounced Voronoi diagram recomputation
     * Delays computation to avoid excessive recalculation during slider dragging
     */
    debouncedVoronoiUpdate() {
        clearTimeout(this.voronoiUpdateTimer);
        this.voronoiUpdateTimer = setTimeout(() => {
            if (this.originalFeatures) {
                this.recomputeVoronoi();
            }
        }, CONFIG.VORONOI_UPDATE_DEBOUNCE_MS);
    }

    updateVisualization() {
        if (!this.gradientFieldLayer) return;

        this.gradientFieldLayer.maxDistanceKm = this.maxDistanceKm;
        this.gradientFieldLayer.transparency = this.transparency;
        this.gradientFieldLayer.currentPalette = this.currentPalette;
        this.gradientFieldLayer.visualizationMode = this.visualizationMode;
        this.gradientFieldLayer.idwPower = this.idwPower;
        this.gradientFieldLayer.heatBandwidth = this.heatBandwidth;
        this.map.triggerRepaint();
    }

    updateVoronoiOverlay() {
        if (this.showVoronoiBorders && this.voronoiGeoJSON) {
            // Add or update Voronoi layer
            if (!this.map.getSource('voronoi-lines')) {
                this.map.addSource('voronoi-lines', {
                    type: 'geojson',
                    data: this.voronoiGeoJSON
                });

                this.map.addLayer({
                    id: 'voronoi-lines',
                    type: 'line',
                    source: 'voronoi-lines',
                    paint: {
                        'line-color': '#000000',
                        'line-width': 1,
                        'line-opacity': 0.6
                    }
                });
            } else {
                // Update existing source with new data
                this.map.getSource('voronoi-lines').setData(this.voronoiGeoJSON);
            }
        } else {
            // Remove Voronoi layer
            if (this.map.getLayer('voronoi-lines')) {
                this.map.removeLayer('voronoi-lines');
            }
            if (this.map.getSource('voronoi-lines')) {
                this.map.removeSource('voronoi-lines');
            }
        }
    }

    bindEvents() {
        document.getElementById('area').addEventListener('input', (e) => {
            clearTimeout(this.searchTimeout);
            const query = e.target.value.trim();

            if (query.length < 2) {
                this.hideDropdown();
                return;
            }

            this.searchTimeout = setTimeout(() => {
                this.searchArea(query);
            }, CONFIG.SEARCH_DEBOUNCE_MS);
        });

        // Query autocomplete using Taginfo
        document.getElementById('query').addEventListener('input', (e) => {
            clearTimeout(this.querySearchTimeout);
            const input = e.target.value;
            const cursorPos = e.target.selectionStart;

            // Extract the current tag being edited
            const tagInfo = this.extractCurrentTag(input, cursorPos);

            // Only show autocomplete if we have a meaningful search term
            if (!tagInfo || !tagInfo.key || tagInfo.key.trim().length < 1) {
                this.hideQueryDropdown();
                return;
            }

            this.querySearchTimeout = setTimeout(() => {
                this.searchQueryTags(tagInfo, cursorPos);
            }, 300);
        });

        // Keyboard navigation for area autocomplete
        document.getElementById('area').addEventListener('keydown', (e) => {
            this.handleDropdownKeydown(
                e, 'area-results',
                () => this.selectedAreaIndex,
                (i) => { this.selectedAreaIndex = i; },
                () => this.hideDropdown()
            );
        });

        // Keyboard navigation for query autocomplete
        document.getElementById('query').addEventListener('keydown', (e) => {
            this.handleDropdownKeydown(
                e, 'query-results',
                () => this.selectedQueryIndex,
                (i) => { this.selectedQueryIndex = i; },
                () => this.hideQueryDropdown()
            );
        });

        document.addEventListener('click', (e) => {
            if (!e.target.closest('.area-input-container')) {
                this.hideDropdown();
            }
            if (!e.target.closest('.query-input-container')) {
                this.hideQueryDropdown();
            }
        });

        document.getElementById('basemap-selector').addEventListener('change', (e) => {
            this.switchBasemap(e.target.value);
        });

        document.getElementById('generate').addEventListener('click', () => this.generate());
        document.getElementById('export-png').addEventListener('click', () => this.exportPNG());
    }

    /**
     * Search for areas using Nominatim geocoding API with retry logic
     * @param {string} query - Search query string
     */
    async searchArea(query) {
        try {
            const results = await retryWithBackoff(async () => {
                const response = await fetch(
                    `${CONFIG.NOMINATIM_API_URL}?` +
                    `format=jsonv2&q=${encodeURIComponent(query)}&` +
                    `limit=10&addressdetails=1&polygon_geojson=1`
                );

                if (!response.ok) {
                    throw new Error(`Nominatim API error: ${response.status} ${response.statusText}`);
                }

                return await response.json();
            });

            this.showAreaResults(results);
        } catch (error) {
            console.error('Area search error:', error);
            this.showMessage(`Area search failed: ${error.message}. Please try again.`, 'error');
        }
    }

    showAreaResults(results) {
        const dropdown = document.getElementById('area-results');
        dropdown.innerHTML = '';

        // Reset keyboard navigation
        this.selectedAreaIndex = -1;

        if (results.length === 0) {
            dropdown.innerHTML = '<div class="dropdown-item">No results found</div>';
        } else {
            results.forEach(result => {
                const item = document.createElement('div');
                item.className = 'dropdown-item';
                item.textContent = result.display_name;
                item.addEventListener('click', () => {
                    this.selectArea(result);
                });
                dropdown.appendChild(item);
            });
        }

        dropdown.classList.add('active');
    }

    hideDropdown() {
        document.getElementById('area-results').classList.remove('active');
        this.selectedAreaIndex = -1;
    }

    selectArea(area) {
        this.selectedArea = area;
        document.getElementById('area').value = area.display_name.split(',')[0];
        this.hideDropdown();

        if (area.boundingbox) {
            const bounds = [
                [Number.parseFloat(area.boundingbox[2]), Number.parseFloat(area.boundingbox[0])],
                [Number.parseFloat(area.boundingbox[3]), Number.parseFloat(area.boundingbox[1])]
            ];
            this.map.fitBounds(bounds, { padding: 50 });
        }
    }

    /**
     * Extract the current tag being edited at cursor position
     * @param {string} input - Full input string
     * @param {number} cursorPos - Cursor position
     * @returns {Object} - {key, value, isValue, startPos, endPos}
     */
    extractCurrentTag(input, cursorPos) {
        // Find the tag boundaries around cursor
        // Tags can be separated by spaces, commas, or 'and'
        const beforeCursor = input.substring(0, cursorPos);
        const afterCursor = input.substring(cursorPos);

        // Find start of current tag (last separator before cursor)
        const separatorRegex = /[,\s](?:and\s+)?/g;
        let startPos = 0;
        let match;
        while ((match = separatorRegex.exec(beforeCursor)) !== null) {
            startPos = match.index + match[0].length;
        }

        // Find end of current tag (next separator after cursor)
        const endMatch = afterCursor.match(/[,\s](?:and\s+)?/);
        const endPos = endMatch ? cursorPos + endMatch.index : input.length;

        const currentTag = input.substring(startPos, endPos).trim();

        // Parse the tag
        const equalPos = currentTag.indexOf('=');
        if (equalPos === -1) {
            // Just a key, no value yet
            return {
                key: currentTag,
                value: null,
                isValue: false,
                startPos,
                endPos
            };
        } else {
            // Key=value or key= (incomplete value)
            const key = currentTag.substring(0, equalPos);
            const value = currentTag.substring(equalPos + 1);
            const cursorInValue = cursorPos > (startPos + equalPos);

            return {
                key: key,
                value: value,
                isValue: cursorInValue,
                startPos,
                endPos
            };
        }
    }

    /**
     * Search Taginfo API for tag suggestions
     * Uses correct Taginfo API endpoints with client-side caching
     * @param {Object} tagInfo - Current tag info from extractCurrentTag
     * @param {number} cursorPos - Cursor position
     */
    async searchQueryTags(tagInfo, cursorPos) {
        try {
            let results;

            if (tagInfo.isValue) {
                // Get prevalent values for this key
                const cacheKey = tagInfo.key;
                if (!this.taginfoValuesCache[cacheKey]) {
                    // Fetch and cache prevalent values for this key
                    const apiUrl = `https://taginfo.openstreetmap.org/api/4/key/prevalent_values?key=${encodeURIComponent(tagInfo.key)}`;
                    const response = await fetch(apiUrl);
                    if (!response.ok) {
                        throw new Error(`Taginfo API error: ${response.status}`);
                    }
                    const data = await response.json();
                    this.taginfoValuesCache[cacheKey] = data.data || [];
                }

                // Filter cached values client-side (skip null values)
                const searchTerm = (tagInfo.value || '').toLowerCase();
                results = this.taginfoValuesCache[cacheKey].filter(item =>
                    item.value && item.value.toLowerCase().includes(searchTerm)
                );

                // Sort values alphabetically
                results.sort((a, b) => a.value.localeCompare(b.value));
            } else {
                // Search for keys (API ignores sort params, we'll sort client-side)
                const searchTerm = tagInfo.key || '';
                const apiUrl = `https://taginfo.openstreetmap.org/api/4/keys/all?query=${encodeURIComponent(searchTerm)}`;

                const response = await fetch(apiUrl);
                if (!response.ok) {
                    throw new Error(`Taginfo API error: ${response.status}`);
                }
                const data = await response.json();
                results = data.data || [];

                // Sort keys alphabetically
                results.sort((a, b) => a.key.localeCompare(b.key));
            }

            this.showQueryResults(results, tagInfo, cursorPos);
        } catch (error) {
            console.error('Taginfo search error:', error);
            this.hideQueryDropdown();
        }
    }

    /**
     * Display Taginfo search results in dropdown
     * @param {Array} results - Array of tag results from Taginfo
     * @param {Object} tagInfo - Current tag info
     * @param {number} cursorPos - Cursor position
     */
    showQueryResults(results, tagInfo, cursorPos) {
        const dropdown = document.getElementById('query-results');
        dropdown.innerHTML = '';

        // Reset keyboard navigation
        this.selectedQueryIndex = -1;
        this.currentQueryTagInfo = tagInfo;
        this.currentQueryCursorPos = cursorPos;

        if (results.length === 0) {
            dropdown.innerHTML = '<div class="dropdown-item">No suggestions</div>';
        } else {
            // Show all results (alphabetically sorted)
            results.forEach(result => {
                const item = document.createElement('div');
                item.className = 'dropdown-item';

                if (tagInfo.isValue) {
                    // Showing values
                    const value = result.value;
                    const count = result.count ? ` (${this.formatCount(result.count)})` : '';
                    item.textContent = `${value}${count}`;
                    item.addEventListener('click', () => {
                        this.selectQueryTag(tagInfo, value, cursorPos);
                    });
                } else {
                    // Showing keys
                    const key = result.key;
                    const count = result.count ? ` (${this.formatCount(result.count)})` : '';
                    item.textContent = `${key}${count}`;
                    item.addEventListener('click', () => {
                        this.selectQueryTag(tagInfo, key, cursorPos);
                    });
                }

                dropdown.appendChild(item);
            });
        }

        dropdown.classList.add('active');
    }

    /**
     * Format count for display (e.g., 1234567 -> 1.2M)
     */
    formatCount(count) {
        if (count >= 1000000) {
            return (count / 1000000).toFixed(1) + 'M';
        } else if (count >= 1000) {
            return (count / 1000).toFixed(1) + 'K';
        }
        return count.toString();
    }

    /**
     * Insert selected tag into query input
     * @param {Object} tagInfo - Current tag info
     * @param {string} selection - Selected key or value
     * @param {number} cursorPos - Cursor position when search started
     */
    selectQueryTag(tagInfo, selection, cursorPos) {
        const input = document.getElementById('query');
        const currentValue = input.value;

        let newValue;
        let newCursorPos;

        if (tagInfo.isValue) {
            // Replace the value part
            newValue = currentValue.substring(0, tagInfo.startPos) +
                       tagInfo.key + '=' + selection +
                       currentValue.substring(tagInfo.endPos);
            newCursorPos = tagInfo.startPos + tagInfo.key.length + 1 + selection.length;
        } else {
            // Replace the key part and append "="
            newValue = currentValue.substring(0, tagInfo.startPos) +
                       selection + '=' +
                       currentValue.substring(tagInfo.endPos);
            newCursorPos = tagInfo.startPos + selection.length + 1;
        }

        input.value = newValue;
        input.setSelectionRange(newCursorPos, newCursorPos);
        input.focus();

        this.hideQueryDropdown();
    }

    /**
     * Hide the query autocomplete dropdown
     */
    hideQueryDropdown() {
        document.getElementById('query-results').classList.remove('active');
        this.selectedQueryIndex = -1;
    }

    /**
     * Arrow/Enter/Tab/Escape keyboard navigation for a `.dropdown-item` list,
     * shared by the area and query autocomplete dropdowns.
     * @param {KeyboardEvent} e
     * @param {string} dropdownId - Element id of the dropdown container
     * @param {() => number} getIndex - Reads the currently selected item index (-1 = none)
     * @param {(index: number) => void} setIndex - Writes the selected item index
     * @param {() => void} hideFn - Hides this dropdown (also resets its index)
     */
    handleDropdownKeydown(e, dropdownId, getIndex, setIndex, hideFn) {
        const dropdown = document.getElementById(dropdownId);
        if (!dropdown.classList.contains('active')) {
            return;
        }

        const items = dropdown.querySelectorAll('.dropdown-item');
        if (items.length === 0) {
            return;
        }

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            const index = Math.min(getIndex() + 1, items.length - 1);
            setIndex(index);
            this.updateDropdownSelection(items, index);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            const index = Math.max(getIndex() - 1, 0);
            setIndex(index);
            this.updateDropdownSelection(items, index);
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            const index = getIndex();
            if (index >= 0 && index < items.length) {
                e.preventDefault();
                items[index].click();
            }
        } else if (e.key === 'Escape') {
            hideFn();
        }
    }

    /**
     * Update visual selection in a dropdown for keyboard navigation
     * @param {NodeList} items - Dropdown items
     * @param {number} selectedIndex
     */
    updateDropdownSelection(items, selectedIndex) {
        items.forEach((item, index) => {
            if (index === selectedIndex) {
                item.classList.add('selected');
                item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            } else {
                item.classList.remove('selected');
            }
        });
    }

    processOverpassFilter(rawQuery) {
        let query = rawQuery.trim();

        // Check if query contains comparison operators - these are NOT supported in basic Overpass filters
        if (query.match(/[<>]=?/) && !query.includes('[')) {
            console.warn('Note: Comparison operators (<, >, <=, >=) are not supported in Overpass filter syntax. Use regex patterns instead.');
            // Don't process these as they won't work
        }

        // Auto-quote keys with special characters (like colons) if not already quoted
        // e.g., recycling:glass=yes → "recycling:glass"=yes
        query = query.replace(/\b([a-zA-Z_][a-zA-Z0-9_:]*:[a-zA-Z0-9_:]+)(?=\s*[=!~])/g, '"$1"');

        // Handle multiple conditions with 'and' or comma (but only if not already bracketed)
        if (!query.includes('[')) {
            if (query.includes(' and ')) {
                const parts = query.split(' and ').map(p => p.trim());
                return parts.map(part => `[${part}]`).join('');
            } else if (query.includes(', ')) {
                const parts = query.split(', ').map(p => p.trim());
                return parts.map(part => `[${part}]`).join('');
            }
        }

        // Check if the query starts with [ and ends with ]
        const hasOuterBrackets = query.startsWith('[') && query.endsWith(']');

        if (hasOuterBrackets) {
            // Already properly bracketed - use as-is
            return query;
        } else {
            // No outer brackets or partial brackets - wrap the whole thing
            return `[${query}]`;
        }
    }

    async generate() {
        try {
            this.showStatus('Starting generation...');
            await new Promise(resolve => setTimeout(resolve, 50)); // Allow UI update

            const rawQuery = document.getElementById('query').value.trim();
            const areaName = document.getElementById('area').value.trim();

            if (!rawQuery || !areaName) {
                this.showMessage('Please enter both query and area', 'error');
                return;
            }

            this.showStatus('Processing query...');
            await new Promise(resolve => setTimeout(resolve, 50));

            // Clear old cache entries to prevent memory bloat
            this.clearOldCacheEntries();

            // Process the query with improved logic
            let query = this.processOverpassFilter(rawQuery);

            this.showStatus('Searching for area...');
            await new Promise(resolve => setTimeout(resolve, 50));

            if (!this.selectedArea || !this.selectedArea.display_name.toLowerCase().includes(areaName.toLowerCase())) {
                const areas = await retryWithBackoff(async () => {
                    const response = await fetch(
                        `${CONFIG.NOMINATIM_API_URL}?` +
                        `format=jsonv2&q=${encodeURIComponent(areaName)}&` +
                        `limit=1&polygon_geojson=1`
                    );

                    if (!response.ok) {
                        throw new Error(`Nominatim API error: ${response.status} ${response.statusText}`);
                    }

                    return await response.json();
                });

                if (areas.length === 0) {
                    throw new Error('Area not found');
                }

                this.selectedArea = areas[0];

                // Check if we got the full geometry
                if (!this.selectedArea.geojson) {
                    console.warn('No detailed boundary geometry received, will use bounding box');
                }
            }

            const areaSelector = this.determineAreaSelector(this.selectedArea);
            const boundary = this.selectedArea.geojson || this.makeBoundingBox(this.selectedArea.boundingbox);

            const areaSizeKm2 = turf.area(boundary) / 1000000;

            this.showStatus('Querying OSM features...');

            const features = await this.queryOSMFeatures(query, areaSelector);

            if (features.length === 0) {
                throw new Error('No features found matching the query');
            }

            const modeTextMap = {
                'distance': 'distance field',
                'density': 'density field',
                'idw': 'inverse distance weighting',
                'heat': 'heat diffusion'
            };
            const modeText = modeTextMap[this.visualizationMode];
            this.showStatus(`Found ${features.length} features. Creating ${modeText}...`);

            // Calculate max distance limit based on area
            const previousMaxDistanceLimit = this.maxDistanceLimit;
            this.maxDistanceLimit = Math.round(Math.sqrt(areaSizeKm2) * 0.5);

            // Preserve values loaded from URL or set by user
            // If loaded from URL (this.loadedFromURL) or regenerating (previousMaxDistanceLimit !== null)
            if (this.loadedFromURL || previousMaxDistanceLimit !== null) {
                // Keep current value but ensure it's within the new limits
                this.maxDistanceKm = Math.max(CONFIG.MIN_DISTANCE_KM, Math.min(this.maxDistanceKm, this.maxDistanceLimit));
            } else {
                // First generation without URL params - use default
                const defaultDistance = this.maxDistanceLimit * CONFIG.DEFAULT_RADIUS_PERCENT;
                this.maxDistanceKm = Math.max(CONFIG.MIN_DISTANCE_KM, Math.min(defaultDistance, this.maxDistanceLimit));
            }

            // Clear the flag after first use
            this.loadedFromURL = false;

            // Calculate position on exponential scale
            const logPosition = Math.log(this.maxDistanceKm / CONFIG.MIN_DISTANCE_KM) / Math.log(this.maxDistanceLimit / CONFIG.MIN_DISTANCE_KM);
            const percent = Math.max(0, Math.min(100, logPosition * 100));
            document.getElementById('distance-cursor').style.left = percent + '%';
            document.getElementById('distance-cursor').setAttribute('aria-valuemax', String(this.maxDistanceLimit));
            document.getElementById('max-km-label').textContent = `${this.maxDistanceLimit} km`;
            this.updateSliderValues();

            document.getElementById('advanced-controls').style.display = 'block';
            this.updateUIForMode(); // Make sure UI is correct for current mode

            this.showStats({
                featureCount: features.length,
                areaSizeKm2: areaSizeKm2,
                density: features.length / areaSizeKm2
            });

            const bounds = turf.bbox(boundary);

            // Store original features and boundary
            this.originalFeatures = features;
            this.areaBoundary = boundary;

            this.showStatus('Rendering visualization...');
            await new Promise(resolve => setTimeout(resolve, 50));

            // Compute Voronoi diagram in worker (non-blocking)
            this.computeVoronoiAsync(features, bounds, boundary);

            try {
                this.renderWebGL(features, boundary, bounds);
            } catch (renderError) {
                console.error('WebGL rendering error:', renderError);
                throw new Error('Failed to render map: ' + renderError.message);
            }

            this.lastResults = { features, boundary, bounds };

            document.getElementById('export-png').disabled = false;

            this.showStatus('✓ Complete!');
            await new Promise(resolve => setTimeout(resolve, 1500));
            this.hideStatus();

        } catch (error) {
            console.error('Error in generate():', error);
            const errorMsg = error.message || 'An error occurred';
            // showMessage() keeps errors up longer (CONFIG.ERROR_MESSAGE_TIMEOUT_MS),
            // which is enough visibility on mobile without a blocking alert()
            this.showMessage(errorMsg, 'error');

            this.showStatus('❌ Error: ' + errorMsg);
            setTimeout(() => this.hideStatus(), 5000);
        }
    }

    recomputeVoronoi() {
        if (!this.originalFeatures) return;

        const bounds = turf.bbox(this.areaBoundary);
        this.computeVoronoiAsync(this.originalFeatures, bounds, this.areaBoundary);
    }

    computeVoronoiAsync(features, bounds, boundary) {
        this.voronoiRequestId++;
        this.voronoiWorker.postMessage({
            features,
            bounds,
            boundary,
            voronoiCoalesceKm: this.voronoiCoalesceKm,
            requestId: this.voronoiRequestId
        });
    }

    makeBoundingBox(bbox) {
        const [minLat, maxLat, minLon, maxLon] = bbox.map(parseFloat);
        return {
            type: 'Polygon',
            coordinates: [[
                [minLon, minLat],
                [maxLon, minLat],
                [maxLon, maxLat],
                [minLon, maxLat],
                [minLon, minLat]
            ]]
        };
    }

    /**
     * Determine how to select the query area in Overpass QL.
     * Overpass area IDs are derived differently per OSM element type:
     * relations use 3600000000+id, ways use 2400000000+id. Nodes (and
     * anything else Nominatim might return) have no Overpass "area" at
     * all, so fall back to a bounding-box filter instead.
     * @param {Object} area - Nominatim result (osm_type, osm_id, boundingbox)
     * @returns {{type: 'area', areaId: number} | {type: 'bbox', bbox: number[]}}
     */
    determineAreaSelector(area) {
        const osmId = Number.parseInt(area.osm_id, 10);

        if (area.osm_type === 'relation') {
            return { type: 'area', areaId: 3600000000 + osmId };
        }
        if (area.osm_type === 'way') {
            return { type: 'area', areaId: 2400000000 + osmId };
        }

        // Node or unknown type - no Overpass area concept, use bbox instead
        const [minLat, maxLat, minLon, maxLon] = area.boundingbox.map(Number.parseFloat);
        return { type: 'bbox', bbox: [minLat, minLon, maxLat, maxLon] }; // [south, west, north, east]
    }

    /**
     * Query OSM features using Overpass API with caching and retry logic
     * @param {string} query - Overpass QL query fragment
     * @param {{type: 'area', areaId: number} | {type: 'bbox', bbox: number[]}} areaSelector - From determineAreaSelector()
     * @returns {Promise<Array>} Array of features with lat/lon
     */
    async queryOSMFeatures(query, areaSelector) {
        // Create cache key from query and area
        const areaKeyPart = areaSelector.type === 'area'
            ? `area_${areaSelector.areaId}`
            : `bbox_${areaSelector.bbox.join(',')}`;
        const cacheKey = `overpass_${areaKeyPart}_${query}`;

        // Try cache first
        const cachedData = await this.cache.get(cacheKey);
        if (cachedData) {
            console.log('Using cached Overpass results');
            return cachedData;
        }

        // Build the element-selection clause for the chosen area strategy
        let selectionClause;
        if (areaSelector.type === 'area') {
            selectionClause = `
            area(id:${areaSelector.areaId})->.a;
            (
                node(area.a)${query};
                way(area.a)${query};
                relation(area.a)${query};
            );`;
        } else {
            const [south, west, north, east] = areaSelector.bbox;
            const bbox = `${south},${west},${north},${east}`;
            selectionClause = `
            (
                node(${bbox})${query};
                way(${bbox})${query};
                relation(${bbox})${query};
            );`;
        }

        // Build Overpass query
        const overpassQuery = `
            [out:csv(::id,::lat,::lon)][timeout:${CONFIG.OVERPASS_TIMEOUT}];
            ${selectionClause}
            out center;
        `;

        // Fetch with retry logic
        const csv = await retryWithBackoff(async () => {
            const response = await fetch(CONFIG.OVERPASS_API_URL, {
                method: 'POST',
                body: `data=${encodeURIComponent(overpassQuery)}`,
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });

            if (!response.ok) {
                throw new Error(`Overpass API error: ${response.status} ${response.statusText}`);
            }

            return await response.text();
        });

        // Parse results
        const features = this.parseCSV(csv);

        // Cache the results
        await this.cache.set(cacheKey, features);

        return features;
    }

    parseCSV(csv) {
        const lines = csv.trim().split('\n');
        const features = [];
        const seen = new Set();

        for (let i = 1; i < lines.length; i++) {
            const parts = lines[i].split('\t');
            if (parts.length >= 3) {
                const lat = Number.parseFloat(parts[1]);
                const lon = Number.parseFloat(parts[2]);
                if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
                    const key = `${lat.toFixed(6)},${lon.toFixed(6)}`;
                    if (!seen.has(key)) {
                        seen.add(key);
                        features.push({ lat, lon });
                    }
                }
            }
        }

        return features;
    }

    /**
     * Clean up WebGL resources to prevent memory leaks
     * Deletes textures, buffers, and programs from previous visualizations
     */
    cleanupWebGLResources() {
        if (!this.gradientFieldLayer || !this.gradientFieldLayer.gl) {
            return;
        }

        const gl = this.gradientFieldLayer.gl;
        const layer = this.gradientFieldLayer;

        try {
            // Delete textures
            if (layer.featuresTexture) {
                gl.deleteTexture(layer.featuresTexture);
                layer.featuresTexture = null;
            }
            if (layer.paletteTexture) {
                gl.deleteTexture(layer.paletteTexture);
                layer.paletteTexture = null;
            }
            if (layer.boundaryTexture) {
                gl.deleteTexture(layer.boundaryTexture);
                layer.boundaryTexture = null;
            }

            // Delete shader program
            if (layer.program) {
                gl.deleteProgram(layer.program);
                layer.program = null;
            }
        } catch (error) {
            console.warn('Error cleaning up WebGL resources:', error);
        }
    }

    /**
     * Clear cached data that's no longer needed
     * Helps prevent memory bloat from accumulated cache
     */
    clearOldCacheEntries() {
        // Clear Taginfo caches periodically to prevent unbounded growth
        const MAX_CACHE_ENTRIES = 100;

        try {
            if (this.taginfoValuesCache && Object.keys(this.taginfoValuesCache).length > MAX_CACHE_ENTRIES) {
                // Keep only the most recently used entries
                const entries = Object.entries(this.taginfoValuesCache);
                this.taginfoValuesCache = Object.fromEntries(
                    entries.slice(-MAX_CACHE_ENTRIES)
                );
            }
        } catch (error) {
            console.warn('Error clearing cache entries:', error);
        }
    }

    /**
     * Comprehensive cleanup method
     * Called before regenerating or on page unload
     */
    cleanup() {
        // Cancel any pending throttled updates
        if (this.throttledVisualizationUpdate && this.throttledVisualizationUpdate.cancel) {
            this.throttledVisualizationUpdate.cancel();
        }

        // Clear all pending timers
        if (this.searchTimeout) {
            clearTimeout(this.searchTimeout);
            this.searchTimeout = null;
        }
        if (this.voronoiUpdateTimer) {
            clearTimeout(this.voronoiUpdateTimer);
            this.voronoiUpdateTimer = null;
        }
        if (this.querySearchTimeout) {
            clearTimeout(this.querySearchTimeout);
            this.querySearchTimeout = null;
        }

        // Clean up WebGL resources
        this.cleanupWebGLResources();

        // Release references to large objects
        this.lastResults = null;
        this.originalFeatures = null;
        this.voronoiGeoJSON = null;
        this.areaBoundary = null;
    }

    /**
     * Uniformly sample `count` items from `features` without replacement
     * (reservoir sampling, one pass, no bias toward Overpass result order)
     */
    sampleFeatures(features, count) {
        const sample = features.slice(0, count);
        for (let i = count; i < features.length; i++) {
            const j = Math.floor(Math.random() * (i + 1));
            if (j < count) {
                sample[j] = features[i];
            }
        }
        return sample;
    }

    renderWebGL(features, boundary, bounds) {
        // Clean up existing WebGL resources before creating new ones
        this.cleanupWebGLResources();

        // The GPU field shader has a hard cap on feature count (CONFIG.MAX_FEATURES).
        // Beyond that, use a uniform random sample rather than silently taking the
        // first N - Overpass results are spatially biased (grouped by type/location),
        // so truncating produces a visibly wrong field. The point layer below still
        // renders every feature regardless of this cap.
        let fieldFeatures = features;
        if (features.length > CONFIG.MAX_FEATURES) {
            fieldFeatures = this.sampleFeatures(features, CONFIG.MAX_FEATURES);
            this.showMessage(
                `Gradient uses a random sample of ${CONFIG.MAX_FEATURES.toLocaleString()} of ${features.length.toLocaleString()} features (all points are shown)`,
                'info'
            );
        }

        // Remove existing layers and sources
        if (this.gradientFieldLayer) {
            this.map.removeLayer('gradient-field');
            this.gradientFieldLayer = null;
        }
        if (this.map.getLayer('boundary-outline')) {
            this.map.removeLayer('boundary-outline');
        }
        if (this.map.getSource('boundary-outline')) {
            this.map.removeSource('boundary-outline');
        }
        if (this.map.getLayer('voronoi-lines')) {
            this.map.removeLayer('voronoi-lines');
        }
        if (this.map.getSource('voronoi-lines')) {
            this.map.removeSource('voronoi-lines');
        }
        if (this.map.getLayer('features')) {
            this.map.removeLayer('features');
        }
        if (this.map.getSource('features')) {
            this.map.removeSource('features');
        }

        const interpolatedPalettes = this.interpolatedPalettes;
        const currentPalette = this.currentPalette;
        const visualizationMode = this.visualizationMode;
        const idwPower = this.idwPower;
        const heatBandwidth = this.heatBandwidth;

        // Ground distance per unit of normalized Mercator distance shrinks
        // away from the equator by cos(latitude); compute it once for this
        // area's center latitude instead of assuming the equatorial value.
        const centerLat = (bounds[1] + bounds[3]) / 2;
        const kmPerMercUnit = 40075.0 * Math.cos(centerLat * Math.PI / 180);

        // Process boundary for clipping
        const boundaryCoords = [];
        if (boundary && boundary.coordinates) {
            let coords;
            if (boundary.type === 'Polygon') {
                coords = boundary.coordinates[0];
            } else if (boundary.type === 'MultiPolygon') {
                // For MultiPolygon, use the largest polygon
                let maxArea = 0;
                let largestPolygon = boundary.coordinates[0][0];
                for (const polygon of boundary.coordinates) {
                    const area = turf.area({ type: 'Polygon', coordinates: polygon });
                    if (area > maxArea) {
                        maxArea = area;
                        largestPolygon = polygon[0];
                    }
                }
                coords = largestPolygon;
            } else {
                coords = [];
            }

            // Simplify polygon progressively until it fits in texture
            const maxVertices = 4096;
            let tolerance = 0.0001;

            while (coords.length > maxVertices && tolerance < 0.1) {
                const simplified = turf.simplify(
                    { type: 'Polygon', coordinates: [coords] },
                    { tolerance: tolerance, highQuality: false }
                );
                coords = simplified.coordinates[0];
                tolerance *= 2;
            }

            // If still too many vertices, sample evenly
            if (coords.length > maxVertices) {
                const step = Math.ceil(coords.length / maxVertices);
                const sampled = [];
                for (let i = 0; i < coords.length; i += step) {
                    sampled.push(coords[i]);
                }
                // Ensure polygon is closed
                if (sampled[sampled.length - 1] !== sampled[0]) {
                    sampled.push(sampled[0]);
                }
                coords = sampled;
            }

            // Convert to Mercator
            for (const coord of coords) {
                const mc = maplibregl.MercatorCoordinate.fromLngLat(coord);
                boundaryCoords.push(mc);
            }
        }

        // Create gradient field layer
        const gradientLayer = {
            id: 'gradient-field',
            type: 'custom',
            features: fieldFeatures,
            bounds: bounds,
            boundaryCoords: boundaryCoords,
            maxDistanceKm: this.maxDistanceKm,
            transparency: this.transparency,
            currentPalette: currentPalette,
            visualizationMode: visualizationMode,
            idwPower: idwPower,
            heatBandwidth: heatBandwidth,
            kmPerMercUnit: kmPerMercUnit,

            onAdd: function(map, gl) {
                // =========================================================
                // WebGL VERSION DETECTION
                // =========================================================
                // Detect WebGL version and capabilities
                const isWebGL2 = gl instanceof WebGL2RenderingContext;
                this.isWebGL2 = isWebGL2;

                if (isWebGL2) {
                    console.log('Using WebGL 2.0 for enhanced performance');
                } else {
                    console.log('Using WebGL 1.0 with extensions');
                    // Check for required extensions in WebGL 1
                    const floatTextureExt = gl.getExtension('OES_texture_float');
                    if (!floatTextureExt) {
                        console.warn('Float textures not fully supported, performance may be reduced');
                    }
                }

                // =========================================================
                // SHADER DEFINITIONS
                // =========================================================
                const vertexShader = `
                    attribute vec2 a_position;
                    uniform mat4 u_matrix;
                    varying vec2 v_pos;

                    void main() {
                        gl_Position = u_matrix * vec4(a_position.x, a_position.y, 0.0, 1.0);
                        v_pos = a_position;
                    }
                `;

                const fragmentShader = `
                    precision highp float;

                    uniform sampler2D u_features_texture;
                    uniform sampler2D u_palette_texture;
                    uniform sampler2D u_boundary_texture;
                    uniform int u_featureCount;
                    uniform int u_boundaryCount;
                    uniform float u_maxDistanceKm;
                    uniform float u_transparency;
                    uniform float u_textureSize;
                    uniform float u_boundaryTextureSize;
                    uniform int u_mode; // 0=distance, 1=density, 2=idw, 3=heat
                    uniform float u_idwPower;
                    uniform float u_heatBandwidth;
                    // km per unit of normalized Mercator distance at this area's
                    // latitude (40075 * cos(lat)) - replaces a flat equator-only
                    // constant so distances are correct away from the equator
                    uniform float u_kmPerMercUnit;
                    varying vec2 v_pos;

                    // Point in polygon test
                    bool pointInPolygon(vec2 point) {
                        if (u_boundaryCount == 0) return true;

                        bool inside = false;

                        for (int i = 0; i < 4096; i++) {
                            if (i >= u_boundaryCount) break;

                            int j = i - 1;
                            if (i == 0) j = u_boundaryCount - 1;

                            float row_i = floor(float(i) / u_boundaryTextureSize);
                            float col_i = mod(float(i), u_boundaryTextureSize);
                            vec2 texCoord_i = vec2((col_i + 0.5) / u_boundaryTextureSize, (row_i + 0.5) / u_boundaryTextureSize);
                            vec4 vertex_i = texture2D(u_boundary_texture, texCoord_i);

                            float row_j = floor(float(j) / u_boundaryTextureSize);
                            float col_j = mod(float(j), u_boundaryTextureSize);
                            vec2 texCoord_j = vec2((col_j + 0.5) / u_boundaryTextureSize, (row_j + 0.5) / u_boundaryTextureSize);
                            vec4 vertex_j = texture2D(u_boundary_texture, texCoord_j);

                            float xi = vertex_i.x, yi = vertex_i.y;
                            float xj = vertex_j.x, yj = vertex_j.y;

                            if (((yi > point.y) != (yj > point.y)) &&
                                (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi)) {
                                inside = !inside;
                            }
                        }

                        return inside;
                    }

                    void main() {
                        // Check if point is inside boundary
                        if (!pointInPolygon(v_pos)) {
                            discard;
                        }

                        // Pre-compute squared distance threshold to skip sqrt for out-of-range features
                        float maxDistMerc = u_maxDistanceKm / u_kmPerMercUnit;
                        float maxDistSq = maxDistMerc * maxDistMerc;

                        if (u_mode == 0) {
                            // Distance field mode - use squared distances throughout, sqrt only once at end
                            float minDistSq = 999999.0;

                            for (int i = 0; i < 5000; i++) {
                                if (i >= u_featureCount) break;

                                float row = floor(float(i) / u_textureSize);
                                float col = mod(float(i), u_textureSize);
                                vec2 texCoord = vec2((col + 0.5) / u_textureSize, (row + 0.5) / u_textureSize);

                                vec4 featureData = texture2D(u_features_texture, texCoord);
                                vec2 feature = featureData.xy;

                                float dx = v_pos.x - feature.x;
                                float dy = v_pos.y - feature.y;
                                float distSq = dx * dx + dy * dy;

                                minDistSq = min(minDistSq, distSq);
                            }

                            if (minDistSq >= maxDistSq) {
                                discard;
                            }

                            float distKm = sqrt(minDistSq) * u_kmPerMercUnit;
                            float normalized = 1.0 - (distKm / u_maxDistanceKm);
                            vec4 color = texture2D(u_palette_texture, vec2(normalized, 0.5));

                            gl_FragColor = vec4(color.rgb, u_transparency * normalized);

                        } else if (u_mode == 1) {
                            // Density field mode - skip sqrt for out-of-range features
                            float density = 0.0;
                            float bandwidth = u_maxDistanceKm * 0.25;

                            for (int i = 0; i < 5000; i++) {
                                if (i >= u_featureCount) break;

                                float row = floor(float(i) / u_textureSize);
                                float col = mod(float(i), u_textureSize);
                                vec2 texCoord = vec2((col + 0.5) / u_textureSize, (row + 0.5) / u_textureSize);

                                vec4 featureData = texture2D(u_features_texture, texCoord);
                                vec2 feature = featureData.xy;

                                float dx = v_pos.x - feature.x;
                                float dy = v_pos.y - feature.y;
                                float distSq = dx * dx + dy * dy;

                                if (distSq < maxDistSq) {
                                    float distKm = sqrt(distSq) * u_kmPerMercUnit;
                                    float weight = exp(-2.0 * pow(distKm / bandwidth, 2.0));
                                    density += weight;
                                }
                            }

                            if (density < 0.001) {
                                discard;
                            }

                            float maxDensity = 3.0;
                            float x = density / maxDensity;
                            float k = 4.0;
                            float sigmoid = 1.0 / (1.0 + exp(-k * (x - 0.3)));
                            float normalized = pow(sigmoid, 0.85);
                            normalized = mix(density * 0.05, normalized, smoothstep(0.0, 0.1, density));

                            vec4 color = texture2D(u_palette_texture, vec2(normalized, 0.5));
                            gl_FragColor = vec4(color.rgb, u_transparency * normalized);

                        } else if (u_mode == 2) {
                            // IDW (Inverse Distance Weighting) mode - skip sqrt for out-of-range features
                            float sumWeights = 0.0;
                            float sumValues = 0.0;

                            for (int i = 0; i < 5000; i++) {
                                if (i >= u_featureCount) break;

                                float row = floor(float(i) / u_textureSize);
                                float col = mod(float(i), u_textureSize);
                                vec2 texCoord = vec2((col + 0.5) / u_textureSize, (row + 0.5) / u_textureSize);

                                vec4 featureData = texture2D(u_features_texture, texCoord);
                                vec2 feature = featureData.xy;

                                float dx = v_pos.x - feature.x;
                                float dy = v_pos.y - feature.y;
                                float distSq = dx * dx + dy * dy;

                                if (distSq < maxDistSq) {
                                    float distKm = sqrt(distSq) * u_kmPerMercUnit;
                                    // Avoid division by zero at exact point locations
                                    if (distKm < 0.001) distKm = 0.001;

                                    float weight = 1.0 / pow(distKm, u_idwPower);
                                    sumWeights += weight;
                                    sumValues += weight * (1.0 - distKm / u_maxDistanceKm);
                                }
                            }

                            if (sumWeights < 0.001) {
                                discard;
                            }

                            float normalized = sumValues / sumWeights;
                            vec4 color = texture2D(u_palette_texture, vec2(normalized, 0.5));

                            gl_FragColor = vec4(color.rgb, u_transparency * normalized);

                        } else if (u_mode == 3) {
                            // Heat Diffusion mode (Gaussian kernel) - skip sqrt for out-of-range features
                            float heat = 0.0;
                            float bandwidth = u_maxDistanceKm * u_heatBandwidth;

                            for (int i = 0; i < 5000; i++) {
                                if (i >= u_featureCount) break;

                                float row = floor(float(i) / u_textureSize);
                                float col = mod(float(i), u_textureSize);
                                vec2 texCoord = vec2((col + 0.5) / u_textureSize, (row + 0.5) / u_textureSize);

                                vec4 featureData = texture2D(u_features_texture, texCoord);
                                vec2 feature = featureData.xy;

                                float dx = v_pos.x - feature.x;
                                float dy = v_pos.y - feature.y;
                                float distSq = dx * dx + dy * dy;

                                if (distSq < maxDistSq) {
                                    float distKm = sqrt(distSq) * u_kmPerMercUnit;
                                    // Gaussian kernel
                                    float gaussian = exp(-0.5 * pow(distKm / bandwidth, 2.0));
                                    heat += gaussian;
                                }
                            }

                            if (heat < 0.001) {
                                discard;
                            }

                            // Normalize using sigmoid function for better visualization
                            float maxHeat = 2.5;
                            float x = heat / maxHeat;
                            float k = 3.0;
                            float sigmoid = 1.0 / (1.0 + exp(-k * (x - 0.4)));
                            float normalized = pow(sigmoid, 0.9);

                            vec4 color = texture2D(u_palette_texture, vec2(normalized, 0.5));
                            gl_FragColor = vec4(color.rgb, u_transparency * normalized);
                        }
                    }
                `;

                const vs = gl.createShader(gl.VERTEX_SHADER);
                gl.shaderSource(vs, vertexShader);
                gl.compileShader(vs);
                if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
                    console.error('Vertex shader error:', gl.getShaderInfoLog(vs));
                }

                const fs = gl.createShader(gl.FRAGMENT_SHADER);
                gl.shaderSource(fs, fragmentShader);
                gl.compileShader(fs);
                if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
                    console.error('Fragment shader error:', gl.getShaderInfoLog(fs));
                }

                this.program = gl.createProgram();
                gl.attachShader(this.program, vs);
                gl.attachShader(this.program, fs);
                gl.linkProgram(this.program);
                if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
                    console.error('Program link error:', gl.getProgramInfoLog(this.program));
                }                        
                this.gl = gl;
                this.map = map;

                // =========================================================
                // FEATURE TEXTURE CREATION
                // =========================================================
                // Create texture for storing feature positions
                // Uses configured texture size and max features limit
                const textureSize = CONFIG.TEXTURE_SIZE;
                this.textureSize = textureSize;

                const textureData = new Float32Array(textureSize * textureSize * 4);
                const maxFeatures = Math.min(this.features.length, CONFIG.MAX_FEATURES);

                // Convert feature coordinates to Mercator projection for GPU
                for (let i = 0; i < maxFeatures; i++) {
                    const mc = maplibregl.MercatorCoordinate.fromLngLat([
                        this.features[i].lon,
                        this.features[i].lat
                    ]);
                    textureData[i * 4] = mc.x;
                    textureData[i * 4 + 1] = mc.y;
                }

                // Create and configure features texture
                this.featuresTexture = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D, this.featuresTexture);

                // Use WebGL 2.0 internal format if available, fallback to WebGL 1.0
                const internalFormat = isWebGL2 ? gl.RGBA32F : gl.RGBA;
                gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, textureSize, textureSize, 0,
                             gl.RGBA, gl.FLOAT, textureData);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

                // =========================================================
                // BOUNDARY TEXTURE CREATION
                // =========================================================
                // Create texture for storing boundary polygon vertices
                const boundaryTextureSize = 64;
                this.boundaryTextureSize = boundaryTextureSize;

                const boundaryTextureData = new Float32Array(boundaryTextureSize * boundaryTextureSize * 4);
                const boundaryVertexCount = Math.min(this.boundaryCoords.length, 4096);

                for (let i = 0; i < boundaryVertexCount; i++) {
                    boundaryTextureData[i * 4] = this.boundaryCoords[i].x;
                    boundaryTextureData[i * 4 + 1] = this.boundaryCoords[i].y;
                }

                this.boundaryTexture = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D, this.boundaryTexture);
                gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, boundaryTextureSize, boundaryTextureSize, 0,
                             gl.RGBA, gl.FLOAT, boundaryTextureData);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

                this.boundaryVertexCount = boundaryVertexCount;

                // Create palette texture
                this.paletteTexture = gl.createTexture();
                this.updatePaletteTexture(gl);

                // Get uniform locations
                this.matrixLocation = gl.getUniformLocation(this.program, 'u_matrix');
                this.featuresTextureLocation = gl.getUniformLocation(this.program, 'u_features_texture');
                this.paletteTextureLocation = gl.getUniformLocation(this.program, 'u_palette_texture');
                this.boundaryTextureLocation = gl.getUniformLocation(this.program, 'u_boundary_texture');
                this.featureCountLocation = gl.getUniformLocation(this.program, 'u_featureCount');
                this.boundaryCountLocation = gl.getUniformLocation(this.program, 'u_boundaryCount');
                this.maxDistanceKmLocation = gl.getUniformLocation(this.program, 'u_maxDistanceKm');
                this.transparencyLocation = gl.getUniformLocation(this.program, 'u_transparency');
                this.textureSizeLocation = gl.getUniformLocation(this.program, 'u_textureSize');
                this.boundaryTextureSizeLocation = gl.getUniformLocation(this.program, 'u_boundaryTextureSize');
                this.modeLocation = gl.getUniformLocation(this.program, 'u_mode');
                this.idwPowerLocation = gl.getUniformLocation(this.program, 'u_idwPower');
                this.heatBandwidthLocation = gl.getUniformLocation(this.program, 'u_heatBandwidth');
                this.kmPerMercUnitLocation = gl.getUniformLocation(this.program, 'u_kmPerMercUnit');
                this.positionLocation = gl.getAttribLocation(this.program, 'a_position');

                this.featureCount = maxFeatures;

                // Pre-allocate position buffer (reused every frame)
                this.positionBuffer = gl.createBuffer();
                this.positions = new Float32Array(12); // 6 vertices × 2 coords
            },

            updatePaletteTexture: function(gl) {
                const palette = interpolatedPalettes[this.currentPalette];
                const steps = CONFIG.PALETTE_INTERPOLATION_STEPS;
                const paletteData = new Uint8Array(steps * 4);

                for (let i = 0; i < steps; i++) {
                    const hex = palette[i];
                    const rgb = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
                    paletteData[i * 4] = Number.parseInt(rgb[1], 16);
                    paletteData[i * 4 + 1] = Number.parseInt(rgb[2], 16);
                    paletteData[i * 4 + 2] = Number.parseInt(rgb[3], 16);
                    paletteData[i * 4 + 3] = 255;
                }

                gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, steps, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, paletteData);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            },

            render: function(gl, args) {
                const matrix = args.defaultProjectionData.mainMatrix;
                if (this.lastPalette !== this.currentPalette) {
                    this.updatePaletteTexture(gl);
                    this.lastPalette = this.currentPalette;
                }

                gl.useProgram(this.program);

                const [minLon, minLat, maxLon, maxLat] = this.bounds;
                const sw = maplibregl.MercatorCoordinate.fromLngLat([minLon, minLat]);
                const ne = maplibregl.MercatorCoordinate.fromLngLat([maxLon, maxLat]);

                // Reuse pre-allocated buffer and typed array
                const p = this.positions;
                p[0] = sw.x; p[1] = sw.y;
                p[2] = ne.x; p[3] = sw.y;
                p[4] = sw.x; p[5] = ne.y;
                p[6] = ne.x; p[7] = sw.y;
                p[8] = ne.x; p[9] = ne.y;
                p[10] = sw.x; p[11] = ne.y;

                gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
                gl.bufferData(gl.ARRAY_BUFFER, p, gl.DYNAMIC_DRAW);

                gl.uniformMatrix4fv(this.matrixLocation, false, new Float32Array(matrix));

                // Bind textures
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, this.featuresTexture);
                gl.uniform1i(this.featuresTextureLocation, 0);

                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
                gl.uniform1i(this.paletteTextureLocation, 1);

                gl.activeTexture(gl.TEXTURE2);
                gl.bindTexture(gl.TEXTURE_2D, this.boundaryTexture);
                gl.uniform1i(this.boundaryTextureLocation, 2);

                gl.uniform1i(this.featureCountLocation, this.featureCount);
                gl.uniform1i(this.boundaryCountLocation, this.boundaryVertexCount);
                gl.uniform1f(this.maxDistanceKmLocation, this.maxDistanceKm);
                gl.uniform1f(this.transparencyLocation, this.transparency);
                gl.uniform1f(this.textureSizeLocation, this.textureSize);
                gl.uniform1f(this.boundaryTextureSizeLocation, this.boundaryTextureSize);
                gl.uniform1f(this.idwPowerLocation, this.idwPower);
                gl.uniform1f(this.heatBandwidthLocation, this.heatBandwidth);
                gl.uniform1f(this.kmPerMercUnitLocation, this.kmPerMercUnit);

                let modeValue = 0;
                if (this.visualizationMode === 'density') modeValue = 1;
                else if (this.visualizationMode === 'idw') modeValue = 2;
                else if (this.visualizationMode === 'heat') modeValue = 3;
                gl.uniform1i(this.modeLocation, modeValue);

                gl.enableVertexAttribArray(this.positionLocation);
                gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 0, 0);

                gl.enable(gl.BLEND);
                gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                gl.drawArrays(gl.TRIANGLES, 0, 6);
            }
        };

        this.gradientFieldLayer = gradientLayer;

        // Add gradient layer
        this.map.addLayer(gradientLayer);

        // Add Voronoi overlay if checkbox is checked
        if (this.showVoronoiBorders) {
            this.updateVoronoiOverlay();
        }

        // Add features as dots
        const palette = this.interpolatedPalettes[this.currentPalette];
        const pointColor = palette[Math.floor(palette.length * 0.75)];

        this.map.addSource('features', {
            type: 'geojson',
            data: {
                type: 'FeatureCollection',
                features: features.map(f => ({
                    type: 'Feature',
                    geometry: {
                        type: 'Point',
                        coordinates: [f.lon, f.lat]
                    }
                }))
            }
        });

        this.map.addLayer({
            id: 'features',
            type: 'circle',
            source: 'features',
            paint: {
                'circle-radius': 5,
                'circle-color': '#ffffff',
                'circle-stroke-color': pointColor,
                'circle-stroke-width': 2
            }
        });
    }

    showStats(stats) {
        document.getElementById('stats').style.display = 'block';
        document.getElementById('feature-count').textContent = `Features found: ${stats.featureCount}`;
        document.getElementById('area-size').textContent = `Area size: ${Math.round(stats.areaSizeKm2)} km²`;
        document.getElementById('computed-max-distance').textContent = `Feature density: ${stats.density.toFixed(3)}/km²`;
    }

    exportPNG() {
        this.showStatus('Preparing PNG export...');

        this.map.once('idle', () => {
            this.map.triggerRepaint();

            requestAnimationFrame(() => {
                try {
                    const canvas = this.map.getCanvas();
                    const exportCanvas = document.createElement('canvas');
                    exportCanvas.width = canvas.width;
                    exportCanvas.height = canvas.height;
                    const ctx = exportCanvas.getContext('2d');

                    ctx.fillStyle = 'white';
                    ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
                    ctx.drawImage(canvas, 0, 0);

                    exportCanvas.toBlob(blob => {
                        if (!blob) {
                            this.showMessage('Failed to export PNG', 'error');
                            this.hideStatus();
                            return;
                        }

                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `isosmfar-${this.visualizationMode}-${Date.now()}.png`;
                        a.click();
                        URL.revokeObjectURL(url);

                        this.hideStatus();
                        this.showMessage('PNG exported successfully', 'info');
                    }, 'image/png', 1.0);
                } catch (error) {
                    console.error('PNG export error:', error);
                    this.showMessage('Failed to export PNG: ' + error.message, 'error');
                    this.hideStatus();
                }
            });
        });

        this.map.triggerRepaint();
    }

    // =================================================================
    // UI FEEDBACK METHODS
    // =================================================================

    /**
     * Show status message in bottom bar
     * @param {string} text - Status message to display
     */
    showStatus(text) {
        document.getElementById('status').classList.add('active');
        document.getElementById('status-text').textContent = text;
    }

    /**
     * Hide status bar with configured delay
     */
    hideStatus() {
        setTimeout(() => {
            document.getElementById('status').classList.remove('active');
        }, CONFIG.STATUS_HIDE_DELAY_MS);
    }

    /**
     * Show temporary message to user
     * @param {string} text - Message text
     * @param {string} type - Message type: 'info', 'error', 'warning'
     */
    showMessage(text, type = 'info') {
        const messages = document.getElementById('messages');
        messages.innerHTML = '';
        const div = document.createElement('div');
        div.className = `message ${type}-message`;
        div.textContent = text;
        messages.appendChild(div);
        const timeout = type === 'error' ? CONFIG.ERROR_MESSAGE_TIMEOUT_MS : CONFIG.MESSAGE_TIMEOUT_MS;
        setTimeout(() => {
            messages.innerHTML = '';
        }, timeout);
    }
}

// ============================================================================
// NOTE: Service Worker registration removed
// ============================================================================
// Service Workers cannot be registered from blob: or data: URLs due to
// browser security restrictions. While inline Service Workers are possible
// with proper server configuration, they conflict with the single-file
// architecture requirement. The app uses IndexedDB for API response caching
// which provides the main performance benefit.

// ============================================================================
// APPLICATION INITIALIZATION
// ============================================================================

/**
 * Initialize the application when all libraries are loaded
 */
function initializeApp() {
    // Check if required libraries are loaded
    if (typeof maplibregl === 'undefined') {
        console.error('MapLibre GL JS not loaded');
        return;
    }
    if (typeof turf === 'undefined') {
        console.error('Turf.js not loaded');
        return;
    }
    // D3-Delaunay runs inside voronoi-worker.js (its own importScripts) -
    // not loaded on the main thread

    // Initialize app
    const app = new IsosmfarApp();

    // ============================================================================
    // CLEANUP ON PAGE UNLOAD - Prevent memory leaks
    // ============================================================================

    // Clean up resources when page is about to unload
    window.addEventListener('beforeunload', function() {
        try {
            app.cleanup();
        } catch (error) {
            console.error('Error during cleanup:', error);
        }
    });

    // ============================================================================
    // MOBILE MENU TOGGLE
    // ============================================================================

    // Create and add mobile menu toggle button
    const menuToggle = document.createElement('button');
    menuToggle.id = 'menu-toggle';
    menuToggle.setAttribute('aria-label', 'Toggle menu');
    menuToggle.innerHTML = '<span></span><span></span><span></span>';
    document.body.insertBefore(menuToggle, document.body.firstChild);

    // Create backdrop element
    const backdrop = document.createElement('div');
    backdrop.id = 'mobile-backdrop';
    document.body.appendChild(backdrop);

    const sidebar = document.getElementById('sidebar');

    // Toggle menu on button click
    menuToggle.addEventListener('click', function(e) {
        e.stopPropagation();
        sidebar.classList.toggle('open');
        menuToggle.classList.toggle('active');
        backdrop.classList.toggle('active');
    });

    // Close menu when clicking on backdrop
    backdrop.addEventListener('click', function() {
        sidebar.classList.remove('open');
        menuToggle.classList.remove('active');
        backdrop.classList.remove('active');
    });

    // Close menu when selecting an area or after generating
    const generateButton = document.getElementById('generate');
    if (generateButton) {
        generateButton.addEventListener('click', function() {
            if (window.innerWidth <= 600) {
                setTimeout(() => {
                    sidebar.classList.remove('open');
                    menuToggle.classList.remove('active');
                    backdrop.classList.remove('active');
                }, 300);
            }
        });
    }
}

// Initialize when DOM and scripts are ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    // DOM already loaded, initialize immediately
    initializeApp();
}
