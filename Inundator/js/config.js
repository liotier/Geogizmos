/**
 * Inundator Configuration
 * All tunable parameters in one place
 */

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
    flood: {
        // Maximum iterations for flood-fill (increased 10x for massive valley lakes)
        maxIterations: 20000000,

        // Maximum reasonable reservoir area (km²) - safety limit
        maxReservoirAreaKm2: 500,

        // Seed search radius (cells from dam)
        seedSearchRadius: 2,

        // Water body selection thresholds
        selection: {
            // Minimum cells for valid water body
            minBodySize: 100,

            // Maximum cells before considering downstream (increased 10x for massive reservoirs)
            maxBodySize: 2000000,

            // Scoring weights
            elevationWeight: 2.0,
            edgePenalty: 10000,
            distancePenalty: 0.5,
            smallSizePenalty: 1000,
            largeSizePenalty: 2000
        },

        // Connectivity type (4 or 8)
        connectivity: 4
    },

    // Dam Configuration
    dam: {
        // Default safety margin (meters below peak)
        defaultSafetyMargin: 5,

        // Water level safety factor (0-1)
        // 0.95 = 95% fill level (5% freeboard for safety)
        waterLevelSafetyFactor: 0.95,

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
        // Default center (Mont Blanc / Monte Bianco, France/Italy border)
        defaultCenter: [6.8651, 45.8326],

        // Default zoom
        defaultZoom: 13,

        // Max zoom
        maxZoom: 18,

        // Base maps
        basemaps: {
            topo: {
                tiles: ['https://tile.opentopomap.org/{z}/{x}/{y}.png'],
                attribution: '© OpenTopoMap (CC-BY-SA)',
                maxzoom: 15
            },
            osm: {
                tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
                attribution: '© OpenStreetMap',
                maxzoom: 19
            },
            satellite: {
                tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
                attribution: '© Esri',
                maxzoom: 19
            }
        }
    },

    // Geocoding Configuration
    geocoding: {
        nominatimUrl: 'https://nominatim.openstreetmap.org/search',
        searchLimit: 10,
        searchDebounce: 300 // ms
    },

    // Performance Configuration
    performance: {
        // Worker debug message limit
        maxWorkerDebugMessages: 200,

        // Progress update frequency
        progressUpdateInterval: 5000 // iterations
    }
};
