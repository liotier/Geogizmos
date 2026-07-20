/**
 * Map Manager
 * Handles MapLibre GL map initialization and interactions
 */

import { CONFIG } from '../config.js';

export class MapManager {
    map = null;
    onMapClick = null;
    onMapMouseMove = null;

    constructor(container) {
        this.container = container;
    }

    /**
     * Initialize map
     */
    init() {
        try {
            this.map = new globalThis.maplibregl.Map({
                container: this.container,
                canvasContextAttributes: {
                    preserveDrawingBuffer: true,
                    failIfMajorPerformanceCaveat: false,
                    antialias: false
                },
                style: this.createStyle('topo'),
                center: CONFIG.map.defaultCenter,
                zoom: CONFIG.map.defaultZoom,
                maxZoom: CONFIG.map.maxZoom
            });
        } catch (error) {
            console.error('Failed to initialize map with default settings, trying fallback:', error);

            this.map = new globalThis.maplibregl.Map({
                container: this.container,
                canvasContextAttributes: {
                    preserveDrawingBuffer: false,
                    failIfMajorPerformanceCaveat: false,
                    antialias: false
                },
                maxPitch: 0,
                style: this.createStyle('topo'),
                center: CONFIG.map.defaultCenter,
                zoom: CONFIG.map.defaultZoom,
                maxZoom: CONFIG.map.maxZoom
            });
        }

        this.map.addControl(new globalThis.maplibregl.NavigationControl());

        // Add scale bar (metric) at bottom-left
        this.map.addControl(new globalThis.maplibregl.ScaleControl({
            maxWidth: 100,
            unit: 'metric'
        }), 'bottom-left');

        // Set up event handlers
        this.map.on('click', (e) => {
            if (this.onMapClick) {
                this.onMapClick(e.lngLat);
            }
        });

        this.map.on('mousemove', (e) => {
            if (this.onMapMouseMove) {
                this.onMapMouseMove(e.lngLat);
            }
        });
    }

    /**
     * Create map style
     */
    createStyle(basemapType) {
        const basemap = CONFIG.map.basemaps[basemapType];

        return {
            version: 8,
            sources: {
                [basemapType]: {
                    type: 'raster',
                    tiles: basemap.tiles,
                    tileSize: 256,
                    maxzoom: basemap.maxzoom,
                    attribution: basemap.attribution
                }
            },
            layers: [{
                id: basemapType,
                type: 'raster',
                source: basemapType
            }]
        };
    }

    /**
     * Switch basemap
     */
    switchBasemap(type) {
        // Remove existing basemap layers
        ['topo', 'osm', 'satellite'].forEach(id => {
            if (this.map.getLayer(id)) {
                this.map.removeLayer(id);
            }
            if (this.map.getSource(id)) {
                this.map.removeSource(id);
            }
        });

        const basemap = CONFIG.map.basemaps[type];

        // Add new source and layer
        this.map.addSource(type, {
            type: 'raster',
            tiles: basemap.tiles,
            tileSize: 256,
            maxzoom: basemap.maxzoom,
            attribution: basemap.attribution
        });

        // Add at bottom of layer stack
        let beforeLayer = null;
        if (this.map.getLayer('dam-line')) {
            beforeLayer = 'dam-line';
        } else if (this.map.getLayer('flood-polygon')) {
            beforeLayer = 'flood-polygon';
        }

        this.map.addLayer({
            id: type,
            type: 'raster',
            source: type
        }, beforeLayer);
    }

    /**
     * Fly to location
     */
    flyTo(lng, lat, zoom = 12) {
        this.map.flyTo({
            center: [lng, lat],
            zoom: zoom
        });
    }

    /**
     * Get map instance
     */
    getMap() {
        return this.map;
    }

    /**
     * Get canvas
     */
    getCanvas() {
        return this.map.getCanvas();
    }

    /**
     * Set cursor style
     */
    setCursor(cursorClass) {
        const canvas = this.getCanvas();
        canvas.className = cursorClass ? `maplibregl-canvas ${cursorClass}` : 'maplibregl-canvas';
    }
}
