/**
 * Polygon Generator
 * Converts flooded cells to geographic polygons
 */

import { CONFIG } from '../config.js';

export class PolygonGenerator {
    /**
     * Create flood polygon from flooded cells
     * @param {Array} floodedCells - All flooded cells
     * @param {Object} demData - DEM grid information
     */
    static createFloodPolygon(floodedCells, demData) {
        if (!floodedCells || floodedCells.length === 0) return null;

        const { width, height, zoom, tileBounds, minX, minY } = demData;

        console.log(`Creating flood polygon from ${floodedCells.length} flooded cells, grid size: ${width}x${height}`);

        // Create binary grid for marching squares
        const values = new Uint8Array(width * height);

        for (const cell of floodedCells) {
            if (cell >= 0 && cell < width * height) {
                values[cell] = 1;
            }
        }

        // Use d3-contours marching squares algorithm
        const contours = globalThis.d3.contours()
            .size([width, height])
            .thresholds([0.5])(values);

        if (!contours || contours.length === 0) {
            console.log('No contours generated');
            return null;
        }

        const contour = contours[0];
        if (!contour || !contour.coordinates || contour.coordinates.length === 0) {
            console.log('Contour has no coordinates');
            return null;
        }

        // Normalize to an array of polygons, each an array of rings (first
        // ring is the exterior, remaining rings are holes) - this preserves
        // islands, multiple disconnected arms, and holes instead of
        // collapsing everything down to a single largest ring.
        const pixelPolygons = contour.type === 'MultiPolygon' ? contour.coordinates : [contour.coordinates];

        const geoPolygons = [];
        for (const polygon of pixelPolygons) {
            const geoRings = [];
            for (const ring of polygon) {
                if (!ring || ring.length <= 2) continue;
                const geoRing = this.transformRingToGeo(ring, zoom, tileBounds, width, height, minX, minY);
                if (geoRing) geoRings.push(geoRing);
            }
            // A polygon needs at least a valid exterior ring to be kept
            if (geoRings.length > 0) geoPolygons.push(geoRings);
        }

        if (geoPolygons.length === 0) {
            console.log('No valid geographic rings created');
            return null;
        }

        const totalRings = geoPolygons.reduce((n, p) => n + p.length, 0);
        console.log(`Created ${geoPolygons.length} geographic polygon(s), ${totalRings} ring(s) total`);

        // Create GeoJSON MultiPolygon - keeps every part of the flood extent
        const polygon = {
            type: 'Feature',
            properties: {},
            geometry: {
                type: 'MultiPolygon',
                coordinates: geoPolygons
            }
        };

        // Validate and simplify
        try {
            const area = globalThis.turf.area(polygon);
            if (Number.isNaN(area) || area <= 0) {
                console.error('Invalid polygon area:', area);
                return null;
            }

            console.log('Polygon area:', (area / 1000000).toFixed(2), 'km²');

            // Simplify if any ring is still too complex after per-ring subsampling
            const maxRingLength = Math.max(...geoPolygons.flatMap(p => p.map(r => r.length)));
            if (maxRingLength > CONFIG.visualization.maxPolygonPoints) {
                const simplified = globalThis.turf.simplify(polygon, {
                    tolerance: CONFIG.visualization.simplificationTolerance,
                    highQuality: true
                });
                console.log('Simplified polygon geometry (longest ring was', maxRingLength, 'points)');
                return simplified;
            }
        } catch (e) {
            console.error('Error validating polygon:', e);
            return null;
        }

        return polygon;
    }

    /**
     * Transform one pixel-space ring to geographic coordinates, subsampling
     * to CONFIG.visualization.maxPolygonPoints and closing the ring.
     * Returns null if the ring ends up degenerate.
     */
    static transformRingToGeo(ring, zoom, tileBounds, width, height, minX, minY) {
        const [tileWest, tileNorth] = tileBounds;
        const n = Math.pow(2, zoom);

        // Calculate origin tile coordinates from minX/minY offsets
        const originTileWest = tileWest - minX / CONFIG.dem.tileSize;
        const originTileNorth = tileNorth - minY / CONFIG.dem.tileSize;

        const geoRing = [];
        const step = Math.max(1, Math.floor(ring.length / CONFIG.visualization.maxPolygonPoints));

        for (let i = 0; i < ring.length; i += step) {
            const point = ring[i];
            if (!point || point.length < 2) continue;

            const x = point[0];
            const y = point[1];

            // Validate array coordinates
            if (Number.isNaN(x) || Number.isNaN(y) || x < 0 || x > width || y < 0 || y > height) {
                continue;
            }

            // Convert array coordinates to logical grid coordinates (can be negative)
            const gridX = x + minX;
            const gridY = y + minY;

            // Convert grid to tile coordinates
            const tileX = originTileWest + (gridX / CONFIG.dem.tileSize);
            const tileY = originTileNorth + (gridY / CONFIG.dem.tileSize);

            // Convert tile to lng/lat
            const lng = (tileX / n) * 360 - 180;
            const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * tileY / n))) * 180 / Math.PI;

            if (!Number.isNaN(lng) && !Number.isNaN(lat) && Number.isFinite(lng) && Number.isFinite(lat)) {
                geoRing.push([lng, lat]);
            }
        }

        if (geoRing.length <= 2) return null;

        // Close ring if needed
        const first = geoRing[0];
        const last = geoRing[geoRing.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) {
            geoRing.push([first[0], first[1]]);
        }

        return geoRing.length >= CONFIG.visualization.minPolygonPoints ? geoRing : null;
    }
}
