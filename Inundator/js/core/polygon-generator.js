/**
 * Polygon Generator
 * Converts flooded cells to geographic polygons
 */

import { CONFIG } from '../config.js';

export class PolygonGenerator {
    /**
     * Create flood polygon from flooded cells
     */
    static createFloodPolygon(floodedCells, demData) {
        if (!floodedCells || floodedCells.length === 0) return null;

        const { width, height, zoom, tileBounds } = demData;

        console.log(`Creating flood polygon from ${floodedCells.length} cells, grid size: ${width}x${height}`);

        // Create binary grid for marching squares
        const values = new Array(width * height).fill(0);

        for (const cell of floodedCells) {
            if (cell >= 0 && cell < width * height) {
                values[cell] = 1;
            }
        }

        // Use d3-contours marching squares algorithm
        const contours = d3.contours()
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

        // Extract all rings
        const allRings = [];

        if (contour.type === 'MultiPolygon') {
            for (const polygon of contour.coordinates) {
                for (const ring of polygon) {
                    if (ring && ring.length > 2) {
                        allRings.push(ring);
                    }
                }
            }
        } else {
            for (const ring of contour.coordinates) {
                if (ring && ring.length > 2) {
                    allRings.push(ring);
                }
            }
        }

        if (allRings.length === 0) {
            console.log('No valid rings found');
            return null;
        }

        // Transform to geographic coordinates
        const geoRings = this.transformRingsToGeo(allRings, zoom, tileBounds, width, height);

        if (geoRings.length === 0) {
            console.log('No valid geographic rings created');
            return null;
        }

        // Take largest ring
        geoRings.sort((a, b) => b.length - a.length);

        console.log(`Created ${geoRings.length} geographic rings, using largest with ${geoRings[0].length} points`);

        // Create GeoJSON polygon
        const polygon = {
            type: 'Feature',
            properties: {},
            geometry: {
                type: 'Polygon',
                coordinates: [geoRings[0]]
            }
        };

        // Validate and simplify
        try {
            const area = turf.area(polygon);
            if (isNaN(area) || area <= 0) {
                console.error('Invalid polygon area:', area);
                return null;
            }

            console.log('Polygon area:', (area / 1000000).toFixed(2), 'km²');

            // Simplify if too complex
            if (geoRings[0].length > CONFIG.visualization.maxPolygonPoints) {
                const simplified = turf.simplify(polygon, {
                    tolerance: CONFIG.visualization.simplificationTolerance,
                    highQuality: true
                });
                console.log('Simplified from', geoRings[0].length, 'to', simplified.geometry.coordinates[0].length, 'points');
                return simplified;
            }
        } catch (e) {
            console.error('Error validating polygon:', e);
            return null;
        }

        return polygon;
    }

    /**
     * Transform pixel rings to geographic coordinates
     */
    static transformRingsToGeo(rings, zoom, tileBounds, width, height) {
        const [tileWest, tileNorth] = tileBounds;
        const n = Math.pow(2, zoom);
        const geoRings = [];

        for (const ring of rings) {
            const geoRing = [];
            const step = Math.max(1, Math.floor(ring.length / CONFIG.visualization.maxPolygonPoints));

            for (let i = 0; i < ring.length; i += step) {
                const point = ring[i];
                if (!point || point.length < 2) continue;

                let x = point[0];
                let y = point[1];

                // Validate pixel coordinates
                if (isNaN(x) || isNaN(y) || x < 0 || x > width || y < 0 || y > height) {
                    continue;
                }

                // Convert pixel to tile coordinates
                const tileX = tileWest + (x / CONFIG.dem.tileSize);
                const tileY = tileNorth + (y / CONFIG.dem.tileSize);

                // Convert tile to lng/lat
                const lng = (tileX / n) * 360 - 180;
                const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * tileY / n))) * 180 / Math.PI;

                if (!isNaN(lng) && !isNaN(lat) && isFinite(lng) && isFinite(lat)) {
                    geoRing.push([lng, lat]);
                }
            }

            // Close ring if needed
            if (geoRing.length > 2) {
                const first = geoRing[0];
                const last = geoRing[geoRing.length - 1];

                if (first[0] !== last[0] || first[1] !== last[1]) {
                    geoRing.push([first[0], first[1]]);
                }

                if (geoRing.length >= CONFIG.visualization.minPolygonPoints) {
                    geoRings.push(geoRing);
                }
            }
        }

        return geoRings;
    }
}
