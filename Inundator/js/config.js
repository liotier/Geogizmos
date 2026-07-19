/**
 * Inundator Configuration
 * All tunable parameters in one place
 */

// Attribution strings, per each provider's requirements (contributors, linked).
// Every basemap gets the elevation-data credit too, since flood computation
// depends on the Terrarium DEM regardless of which basemap is selected.
const OSM_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors';
const ELEVATION_ATTRIBUTION = 'Elevation: <a href="https://github.com/tilezen/joerd/blob/master/docs/data-sources.md" target="_blank">Mapzen terrain tiles</a> (SRTM, USGS, and others)';

export const CONFIG = {
    // DEM Data Configuration
    dem: {
        // Terrarium tile server
        tileServer: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium',

        // Zoom level for elevation queries
        queryZoom: 15,

        // Buffer around dam for DEM fetch (km)
        // Starts at 10km, expands dynamically if lake reaches edge
        bufferKm: 10,

        // Maximum buffer for dynamic expansion (km)
        maxBufferKm: 100,

        // Zoom level for DEM grid (adaptive based on area)
        adaptiveZoom: {
            smallAreaThreshold: 100, // km²
            smallAreaZoom: 14,
            largeAreaZoom: 13
        },

        // Maximum DEM grid size (prevents memory issues)
        maxCells: 100000000,

        // Maximum tiles to fetch
        maxTilesX: 40,
        maxTilesY: 40,

        // Tile size in pixels
        tileSize: 256,

        // No-data value
        noDataValue: -9999
    },

    // Flood Algorithm Configuration
    // These values are sent to the flood worker with every job so the worker
    // never falls back to its own (possibly stale) local defaults.
    flood: {
        // Maximum iterations for flood-fill (supports massive valley lakes)
        maxIterations: 20000000,

        // Maximum reasonable reservoir area (km²) - safety limit
        maxReservoirAreaKm2: 1000,

        // Cells from a DEM edge before the worker requests more terrain data
        edgeProximityThreshold: 500,

        // Check growth/stagnation/area every N iterations
        layerCheckInterval: 5000
    },

    // Dam Configuration
    dam: {
        // Meters below the highest sampled point along the dam line;
        // used only to gate the UI (has elevation data been fetched for this line?)
        defaultSafetyMargin: 5,

        // Freeboard (meters) the flood algorithm keeps below the dam crest
        // elevation it computes from DEM terrain at the dam endpoints
        floodSafetyMarginM: 1.0,

        // Sample interval along dam line (meters)
        elevationSampleInterval: 10,

        // Dam cell sampling interval (meters)
        cellSampleInterval: 30
    },

    // Visualization Configuration
    visualization: {
        // Default water colors
        waterColor: '#4A90E2',
        waterColorDeep: '#2E5D8B',
        waterOpacity: 0.6,

        // Dam line colors
        damColor: '#e74c3c',
        damWidth: 4,
        damPreviewOpacity: 0.7,

        // Polygon simplification tolerance
        simplificationTolerance: 0.00005,

        // Maximum points per polygon ring
        maxPolygonPoints: 1000,

        // Minimum polygon points
        minPolygonPoints: 4
    },

    // Map Configuration
    map: {
        // Default center (L'Olan, France - Écrins massif)
        defaultCenter: [6.2667, 44.9833],

        // Default zoom (11 ≈ 20km coverage)
        defaultZoom: 11,

        // Max zoom
        maxZoom: 18,

        // Base maps
        basemaps: {
            topo: {
                tiles: ['https://tile.opentopomap.org/{z}/{x}/{y}.png'],
                attribution: `Map data: ${OSM_ATTRIBUTION}, SRTM | Map display: © OpenTopoMap (CC-BY-SA) | ${ELEVATION_ATTRIBUTION}`,
                maxzoom: 15
            },
            osm: {
                tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
                attribution: `${OSM_ATTRIBUTION} | ${ELEVATION_ATTRIBUTION}`,
                maxzoom: 19
            },
            satellite: {
                tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
                attribution: `© Esri | ${ELEVATION_ATTRIBUTION}`,
                maxzoom: 19
            }
        }
    },

    // Geocoding Configuration
    geocoding: {
        nominatimUrl: 'https://nominatim.openstreetmap.org/search',
        searchLimit: 10,
        searchDebounce: 500 // ms - light throttling of Nominatim requests while typing
    },

    // Performance Configuration
    performance: {
        // Worker debug message limit
        maxWorkerDebugMessages: 200,

        // Progress update frequency
        progressUpdateInterval: 50000 // iterations
    }
};
