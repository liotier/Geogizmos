/**
 * Elevation Service
 * Handles DEM tile fetching and elevation queries
 */

import { CONFIG } from '../config.js';

/**
 * IndexedDB cache for DEM tiles
 */
class TileDBCache {
    constructor() {
        this.dbName = 'InundatorDEMCache';
        this.storeName = 'tiles';
        this.version = 1;
        this.db = null;
        this.initPromise = this.init();
    }

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve();
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
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.get(key);

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async put(key, value) {
        await this.initPromise;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.put(value, key);

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async clear() {
        await this.initPromise;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.clear();

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }
}

export class ElevationService {
    constructor() {
        this.tileCache = new Map(); // In-memory cache for current session
        this.dbCache = new TileDBCache(); // Persistent IndexedDB cache
    }

    /**
     * Get elevation at a single point
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
                    const response = await fetch(url);
                    const blob = await response.blob();
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

        const r = imageData.data[idx];
        const g = imageData.data[idx + 1];
        const b = imageData.data[idx + 2];

        // Decode Terrarium format: elevation = (R * 256 + G + B / 256) - 32768
        const elevation = (r * 256 + g + b / 256) - 32768;

        return elevation;
    }

    /**
     * Fetch elevations for multiple points
     */
    async fetchElevations(points) {
        const elevations = [];

        for (const point of points) {
            const [lng, lat] = point;
            const elevation = await this.getElevationAtPoint(lng, lat);
            elevations.push(elevation);
        }

        return elevations;
    }

    /**
     * Fetch DEM data for a geographic bounding box
     * @param {Array} bounds - [west, south, east, north]
     * @param {Function} progressCallback - Progress callback
     * @param {Array} originTileBounds - Original tile bounds [tileWest, tileNorth, tileEast, tileSouth] to use as grid origin (0,0)
     */
    async fetchDEMData(bounds, progressCallback = null, originTileBounds = null) {
        const [west, south, east, north] = bounds;

        // Determine zoom level based on area
        const area = (east - west) * (north - south) * 111 * 111; // Rough km²
        const zoom = area < CONFIG.dem.adaptiveZoom.smallAreaThreshold
            ? CONFIG.dem.adaptiveZoom.smallAreaZoom
            : CONFIG.dem.adaptiveZoom.largeAreaZoom;

        // Calculate tile bounds
        const n = Math.pow(2, zoom);
        const tileWest = Math.floor((west + 180) / 360 * n);
        const tileEast = Math.floor((east + 180) / 360 * n);
        const tileNorth = Math.floor((1 - Math.log(Math.tan(north * Math.PI / 180) +
            1 / Math.cos(north * Math.PI / 180)) / Math.PI) / 2 * n);
        const tileSouth = Math.floor((1 - Math.log(Math.tan(south * Math.PI / 180) +
            1 / Math.cos(south * Math.PI / 180)) / Math.PI) / 2 * n);

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

        // Fetch all tiles in parallel
        const tilePromises = tilesToFetch.map(async ({ tx, ty }) => {
            const tileKey = `${zoom}/${tx}/${ty}`;

            try {
                // Check IndexedDB cache first
                let imageData = await this.dbCache.get(tileKey);
                let fromCache = !!imageData;

                if (!imageData) {
                    // Fetch from network
                    const url = `${CONFIG.dem.tileServer}/${tileKey}.png`;
                    const response = await fetch(url);
                    const blob = await response.blob();
                    imageData = await this.loadImageData(blob);

                    // Store in IndexedDB cache for future use
                    await this.dbCache.put(tileKey, imageData);
                }

                return { tx, ty, imageData, error: null, fromCache };
            } catch (error) {
                console.warn(`Failed to load tile ${tileKey}:`, error);
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
                progressCallback(loadedTiles / totalTiles * 0.5);
            }
        }

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

                        const elevation = (r * 256 + g + b / 256) - 32768;

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
        const n = Math.pow(2, zoom);
        const tileX = Math.floor((lng + 180) / 360 * n);
        const tileY = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) +
            1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n);

        return { tileX, tileY };
    }

    /**
     * Convert lng/lat to pixel coordinates within a tile
     */
    lngLatToPixel(lng, lat, zoom, tileX, tileY) {
        const n = Math.pow(2, zoom);
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
            img.onload = () => {
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
            img.onerror = reject;
            img.src = URL.createObjectURL(blob);
        });
    }

    /**
     * Clear tile cache
     */
    clearCache() {
        this.tileCache.clear();
    }
}
