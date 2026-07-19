/**
 * Elevation Service
 * Handles DEM tile fetching and elevation queries
 */

import { CONFIG } from '../config.js';
import { PerformanceTimer } from '../utils/performance-timer.js';

/**
 * IndexedDB cache for DEM tiles
 */
class TileDBCache {
    dbName = 'InundatorDEMCache';
    storeName = 'tiles';
    version = 1;
    db = null;
    initPromise;

    constructor() {
        this.initPromise = this.init();
    }

    async init() {
        return new Promise((resolve) => {
            let request;
            try {
                request = indexedDB.open(this.dbName, this.version);
            } catch (error) {
                console.warn('IndexedDB unavailable, DEM tile caching disabled:', error);
                resolve(null);
                return;
            }

            request.onerror = () => {
                console.warn('IndexedDB init failed, DEM tile caching disabled:', request.error);
                resolve(null); // Continue without cache - callers must fall back to network
            };
            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName);
                }
            };
        });
    }

    async get(key) {
        await this.initPromise;
        if (!this.db) return null;

        return new Promise((resolve) => {
            try {
                const transaction = this.db.transaction([this.storeName], 'readonly');
                const store = transaction.objectStore(this.storeName);
                const request = store.get(key);

                request.onsuccess = () => resolve(request.result ?? null);
                request.onerror = () => resolve(null);
            } catch (error) {
                console.warn('Tile cache get failed:', error);
                resolve(null);
            }
        });
    }

    async put(key, value) {
        await this.initPromise;
        if (!this.db) return false;

        return new Promise((resolve) => {
            try {
                const transaction = this.db.transaction([this.storeName], 'readwrite');
                const store = transaction.objectStore(this.storeName);
                const request = store.put(value, key);

                request.onsuccess = () => resolve(true);
                request.onerror = () => resolve(false);
            } catch (error) {
                console.warn('Tile cache put failed:', error);
                resolve(false);
            }
        });
    }

    async clear() {
        await this.initPromise;
        if (!this.db) return false;

        return new Promise((resolve) => {
            try {
                const transaction = this.db.transaction([this.storeName], 'readwrite');
                const store = transaction.objectStore(this.storeName);
                const request = store.clear();

                request.onsuccess = () => resolve(true);
                request.onerror = () => resolve(false);
            } catch (error) {
                console.warn('Tile cache clear failed:', error);
                resolve(false);
            }
        });
    }
}

export class ElevationService {
    tileCache = new Map(); // In-memory cache for current session
    dbCache = new TileDBCache(); // Persistent IndexedDB cache

    /**
     * Decode elevation from Terrarium RGB format
     * @param {number} r - Red channel value (0-255)
     * @param {number} g - Green channel value (0-255)
     * @param {number} b - Blue channel value (0-255)
     * @returns {number} Elevation in meters
     */
    static decodeTerrarium(r, g, b) {
        // Terrarium format: elevation = (R * 256 + G + B / 256) - 32768
        return (r * 256 + g + b / 256) - 32768;
    }

    /**
     * Convert longitude to Web Mercator tile X coordinate
     * @param {number} lng - Longitude in degrees
     * @param {number} zoom - Zoom level
     * @returns {number} Tile X coordinate
     */
    static lngToTileX(lng, zoom) {
        const n = 1 << zoom;
        return Math.floor((lng + 180) / 360 * n);
    }

    /**
     * Convert latitude to Web Mercator tile Y coordinate
     * @param {number} lat - Latitude in degrees
     * @param {number} zoom - Zoom level
     * @returns {number} Tile Y coordinate
     */
    static latToTileY(lat, zoom) {
        const n = 1 << zoom;
        const latRad = lat * Math.PI / 180;
        return Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
    }

    /**
     * Fetch tile with retry logic using exponential backoff
     * @param {string} url - Tile URL to fetch
     * @param {number} maxRetries - Maximum number of retry attempts
     * @param {number} baseDelay - Base delay in milliseconds
     * @returns {Promise<Blob>} Tile image blob
     * @throws {Error} If all retries fail
     */
    async fetchTileWithRetry(url, maxRetries = 3, baseDelay = 1000) {
        let lastError;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const response = await fetch(url);

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                return await response.blob();
            } catch (error) {
                lastError = error;

                if (attempt < maxRetries - 1) {
                    const delay = baseDelay * Math.pow(2, attempt);
                    console.log(`Retry ${attempt + 1}/${maxRetries} for ${url} after ${delay}ms`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }

        throw lastError;
    }

    /**
     * Get elevation at a single point
     * @param {number} lng - Longitude in degrees (-180 to 180)
     * @param {number} lat - Latitude in degrees (-90 to 90)
     * @returns {Promise<number>} Elevation in meters, or CONFIG.dem.noDataValue if unavailable
     * @throws {Error} If tile fetching fails
     */
    async getElevationAtPoint(lng, lat) {
        const zoom = CONFIG.dem.queryZoom;
        const tileSize = CONFIG.dem.tileSize;

        // Convert to tile coordinates
        const tileCoords = this.lngLatToTile(lng, lat, zoom);
        const { tileX, tileY } = tileCoords;

        // Fetch tile if not cached
        const tileKey = `${zoom}/${tileX}/${tileY}`;

        if (!this.tileCache.has(tileKey)) {
            try {
                // Check IndexedDB cache first
                let imageData = await this.dbCache.get(tileKey);

                if (!imageData) {
                    // Fetch from network if not in IndexedDB
                    const url = `${CONFIG.dem.tileServer}/${tileKey}.png`;
                    const blob = await this.fetchTileWithRetry(url);
                    imageData = await this.loadImageData(blob);

                    // Store in IndexedDB for future use
                    await this.dbCache.put(tileKey, imageData);
                }

                this.tileCache.set(tileKey, imageData);
            } catch (error) {
                console.warn(`Failed to fetch tile ${tileKey}:`, error);
                return CONFIG.dem.noDataValue;
            }
        }

        // Get pixel position within tile
        const pixelCoords = this.lngLatToPixel(lng, lat, zoom, tileX, tileY);
        const { pixelX, pixelY } = pixelCoords;

        const px = Math.floor(pixelX);
        const py = Math.floor(pixelY);

        const imageData = this.tileCache.get(tileKey);
        const idx = (py * tileSize + px) * 4;

        // Validate pixel coordinates are within tile bounds
        if (px < 0 || px >= tileSize || py < 0 || py >= tileSize) {
            console.warn(`Pixel coordinates out of tile bounds: (${px}, ${py}) in tile ${tileKey}`);
            return CONFIG.dem.noDataValue;
        }

        // Validate array access is within imageData bounds
        if (idx < 0 || idx + 2 >= imageData.data.length) {
            console.warn(`Image data index out of bounds: ${idx} (max: ${imageData.data.length}) for tile ${tileKey}`);
            return CONFIG.dem.noDataValue;
        }

        const r = imageData.data[idx];
        const g = imageData.data[idx + 1];
        const b = imageData.data[idx + 2];

        return ElevationService.decodeTerrarium(r, g, b);
    }

    /**
     * Fetch elevations for multiple points
     * @param {Array<[number, number]>} points - Array of [lng, lat] coordinate pairs
     * @returns {Promise<Array<number>>} Array of elevations in meters
     */
    async fetchElevations(points) {
        const elevations = await Promise.all(
            points.map(([lng, lat]) => this.getElevationAtPoint(lng, lat))
        );
        return elevations;
    }

    /**
     * Fetch DEM data for a geographic bounding box
     * @param {[number, number, number, number]} bounds - Geographic bounds [west, south, east, north] in degrees
     * @param {((progress: number, status: string) => void)|null} progressCallback - Optional progress callback (0-1, status message)
     * @param {[number, number, number, number]|null} originTileBounds - Original tile bounds [tileWest, tileNorth, tileEast, tileSouth] for grid origin
     * @returns {Promise<{data: Float32Array, width: number, height: number, zoom: number, tileBounds: number[], minX: number, minY: number}>} DEM grid data
     * @throws {Error} If bounds are invalid or area is too large
     */
    async fetchDEMData(bounds, progressCallback = null, originTileBounds = null) {
        // Validate bounds parameter
        if (!Array.isArray(bounds) || bounds.length !== 4) {
            throw new Error('Invalid bounds: expected array [west, south, east, north]');
        }

        const [west, south, east, north] = bounds;

        // Validate bounds values
        if (!Number.isFinite(west) || !Number.isFinite(south) || !Number.isFinite(east) || !Number.isFinite(north)) {
            throw new Error(`Invalid bounds: all values must be finite numbers, got [${west}, ${south}, ${east}, ${north}]`);
        }

        if (west >= east) {
            throw new Error(`Invalid bounds: west (${west}) must be less than east (${east})`);
        }

        if (south >= north) {
            throw new Error(`Invalid bounds: south (${south}) must be less than north (${north})`);
        }

        if (Math.abs(west) > 180 || Math.abs(east) > 180) {
            throw new Error(`Longitude out of range [-180, 180]: west=${west}, east=${east}`);
        }

        if (Math.abs(south) > 90 || Math.abs(north) > 90) {
            throw new Error(`Latitude out of range [-90, 90]: south=${south}, north=${north}`);
        }

        // Determine zoom level based on area
        const area = (east - west) * (north - south) * 111 * 111; // Rough km²
        const zoom = area < CONFIG.dem.adaptiveZoom.smallAreaThreshold
            ? CONFIG.dem.adaptiveZoom.smallAreaZoom
            : CONFIG.dem.adaptiveZoom.largeAreaZoom;

        // Calculate tile bounds using Web Mercator projection
        const tileWest = ElevationService.lngToTileX(west, zoom);
        const tileEast = ElevationService.lngToTileX(east, zoom);
        const tileNorth = ElevationService.latToTileY(north, zoom);
        const tileSouth = ElevationService.latToTileY(south, zoom);

        // Limit tile count
        const tilesX = Math.max(1, Math.min(tileEast - tileWest + 1, CONFIG.dem.maxTilesX));
        const tilesY = Math.max(1, Math.min(tileSouth - tileNorth + 1, CONFIG.dem.maxTilesY));
        const width = tilesX * CONFIG.dem.tileSize;
        const height = tilesY * CONFIG.dem.tileSize;

        // Calculate grid origin offset (negative when expanding west/north)
        let minX = 0;
        let minY = 0;
        if (originTileBounds) {
            const [originTileWest, originTileNorth] = originTileBounds;
            minX = (tileWest - originTileWest) * CONFIG.dem.tileSize;
            minY = (tileNorth - originTileNorth) * CONFIG.dem.tileSize;
        }

        console.log(`DEM fetch: zoom=${zoom}, tiles=${tilesX}x${tilesY}, dimensions=${width}x${height}, origin offset=(${minX}, ${minY})`);

        if (width * height > CONFIG.dem.maxCells) {
            throw new Error('Area too large. Please zoom in or reduce the reservoir size.');
        }

        // Create combined elevation array
        const elevationData = new Float32Array(width * height);

        // Build list of all tiles to fetch
        const totalTiles = tilesX * tilesY;
        const tilesToFetch = [];

        for (let ty = tileNorth; ty <= tileNorth + tilesY - 1; ty++) {
            for (let tx = tileWest; tx <= tileWest + tilesX - 1; tx++) {
                tilesToFetch.push({ tx, ty });
            }
        }

        console.log(`Fetching ${totalTiles} tiles in parallel (${tilesX}x${tilesY})`);

        PerformanceTimer.start('DEM tile fetch');

        // Fetch all tiles in parallel
        const tilePromises = tilesToFetch.map(async ({ tx, ty }) => {
            const tileKey = `${zoom}/${tx}/${ty}`;

            try {
                // Check IndexedDB cache first
                let imageData = await this.dbCache.get(tileKey);
                let fromCache = !!imageData;

                if (!imageData) {
                    // Fetch from network with retry logic
                    const url = `${CONFIG.dem.tileServer}/${tileKey}.png`;
                    const blob = await this.fetchTileWithRetry(url);
                    imageData = await this.loadImageData(blob);

                    // Store in IndexedDB cache for future use
                    await this.dbCache.put(tileKey, imageData);
                }

                return { tx, ty, imageData, error: null, fromCache };
            } catch (error) {
                const url = `${CONFIG.dem.tileServer}/${tileKey}.png`;
                console.warn(`Failed to load tile ${tileKey}:`, {
                    message: error.message,
                    url,
                    zoom,
                    tileX: tx,
                    tileY: ty,
                    timestamp: new Date().toISOString(),
                    errorType: error.name
                });
                return { tx, ty, imageData: null, error, fromCache: false };
            }
        });

        // Wait for all tiles to complete, with progress updates
        let loadedTiles = 0;
        const tileResults = [];

        // Process results as they complete
        for (const promise of tilePromises) {
            const result = await promise;
            tileResults.push(result);

            loadedTiles++;
            if (progressCallback) {
                // Phase-relative progress (0-1); callers compose this into their own display range
                progressCallback(loadedTiles / totalTiles);
            }
        }

        PerformanceTimer.end('DEM tile fetch');

        // Report cache statistics
        const cachedCount = tileResults.filter(r => r.fromCache).length;
        const fetchedCount = tileResults.filter(r => !r.fromCache && !r.error).length;
        const failedCount = tileResults.filter(r => r.error).length;

        console.log(`Tiles: ${cachedCount} from cache, ${fetchedCount} fetched, ${failedCount} failed`);

        // Copy all tiles to elevation array
        for (const { tx, ty, imageData } of tileResults) {
            const offsetX = (tx - tileWest) * CONFIG.dem.tileSize;
            const offsetY = (ty - tileNorth) * CONFIG.dem.tileSize;

            if (imageData) {
                // Copy image data to elevation array
                for (let y = 0; y < CONFIG.dem.tileSize; y++) {
                    for (let x = 0; x < CONFIG.dem.tileSize; x++) {
                        const idx = (y * CONFIG.dem.tileSize + x) * 4;
                        const r = imageData.data[idx];
                        const g = imageData.data[idx + 1];
                        const b = imageData.data[idx + 2];

                        const elevation = ElevationService.decodeTerrarium(r, g, b);

                        const destIdx = (offsetY + y) * width + (offsetX + x);
                        elevationData[destIdx] = elevation;
                    }
                }
            } else {
                // Fill with no-data value
                for (let y = 0; y < CONFIG.dem.tileSize; y++) {
                    for (let x = 0; x < CONFIG.dem.tileSize; x++) {
                        const destIdx = (offsetY + y) * width + (offsetX + x);
                        elevationData[destIdx] = CONFIG.dem.noDataValue;
                    }
                }
            }
        }

        return {
            data: elevationData,
            width: width,
            height: height,
            minX: minX,  // Grid origin offset - negative when expanding west/north
            minY: minY,
            tileBounds: [tileWest, tileNorth, tileWest + tilesX - 1, tileNorth + tilesY - 1],
            zoom: zoom,
            geoBounds: bounds
        };
    }

    /**
     * Convert lng/lat to tile coordinates
     */
    lngLatToTile(lng, lat, zoom) {
        const n = 1 << zoom;
        const tileX = Math.floor((lng + 180) / 360 * n);
        const tileY = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) +
            1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n);

        return { tileX, tileY };
    }

    /**
     * Convert lng/lat to pixel coordinates within a tile
     */
    lngLatToPixel(lng, lat, zoom, tileX, tileY) {
        const n = 1 << zoom;
        const pixelX = ((lng + 180) / 360 * n - tileX) * CONFIG.dem.tileSize;
        const pixelY = ((1 - Math.log(Math.tan(lat * Math.PI / 180) +
            1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n - tileY) * CONFIG.dem.tileSize;

        return { pixelX, pixelY };
    }

    /**
     * Load image and extract ImageData
     */
    async loadImageData(blob) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            const objectUrl = URL.createObjectURL(blob);

            img.onload = () => {
                URL.revokeObjectURL(objectUrl);

                const canvas = document.createElement('canvas');
                canvas.width = CONFIG.dem.tileSize;
                canvas.height = CONFIG.dem.tileSize;
                const ctx = canvas.getContext('2d', {
                    alpha: false,
                    desynchronized: true
                });
                ctx.drawImage(img, 0, 0);

                const imageData = ctx.getImageData(0, 0, CONFIG.dem.tileSize, CONFIG.dem.tileSize);
                resolve(imageData);
            };
            img.onerror = (error) => {
                URL.revokeObjectURL(objectUrl);
                reject(error);
            };
            img.src = objectUrl;
        });
    }

    /**
     * Clear tile cache
     */
    clearCache() {
        this.tileCache.clear();
    }
}
