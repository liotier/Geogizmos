/**
 * Dam Geometry Module
 * Handles dam line operations and coordinate transformations
 */

import { CONFIG } from '../config.js';

export class DamGeometry {
    /**
     * Sample points along a line at regular intervals
     */
    static sampleLinePoints(coordinates, distanceM) {
        const line = globalThis.turf.lineString(coordinates);
        const length = globalThis.turf.length(line, { units: 'meters' });
        const samples = [];

        for (let dist = 0; dist <= length; dist += distanceM) {
            const point = globalThis.turf.along(line, dist, { units: 'meters' });
            samples.push(point.geometry.coordinates);
        }

        return samples;
    }

    /**
     * Convert dam line to grid cell indices
     */
    static getDamCells(damLine, demData) {
        if (!damLine) return [];

        const damCells = [];
        const samples = this.sampleLinePoints(
            damLine.geometry.coordinates,
            CONFIG.dam.cellSampleInterval
        );

        const n = Math.pow(2, demData.zoom);
        const [tileWest, tileNorth] = demData.tileBounds;

        // Calculate origin tile coordinates from minX/minY offsets
        const originTileWest = tileWest - demData.minX / CONFIG.dem.tileSize;
        const originTileNorth = tileNorth - demData.minY / CONFIG.dem.tileSize;

        console.log('Getting dam cells for', samples.length, 'sample points');

        for (const [lng, lat] of samples) {
            // Convert lng/lat to tile coordinates
            const tileX = (lng + 180) / 360 * n;
            const tileY = (1 - Math.log(Math.tan(lat * Math.PI / 180) +
                1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n;

            // Convert to logical grid coordinates (relative to origin, can be negative)
            const gridX = Math.floor((tileX - originTileWest) * CONFIG.dem.tileSize);
            const gridY = Math.floor((tileY - originTileNorth) * CONFIG.dem.tileSize);

            // Convert to array indices (0-based within current DEM)
            const arrayX = gridX - demData.minX;
            const arrayY = gridY - demData.minY;

            if (arrayX >= 0 && arrayX < demData.width &&
                arrayY >= 0 && arrayY < demData.height) {
                const cell = arrayY * demData.width + arrayX;
                damCells.push(cell);

                // Debug first few cells
                if (damCells.length <= 3) {
                    console.log(`Dam point: lng=${lng.toFixed(4)}, lat=${lat.toFixed(4)} -> tile=(${tileX.toFixed(2)}, ${tileY.toFixed(2)}) -> grid=(${gridX}, ${gridY}) -> array=(${arrayX}, ${arrayY}) -> cell=${cell}`);
                }
            }
        }

        console.log('Found', damCells.length, 'dam cells in DEM grid');
        return damCells;
    }

    /**
     * Calculate bounding box with buffer for DEM fetch
     * @param {object} damLine - GeoJSON line feature
     * @param {number} bufferKm - Optional buffer distance in km (defaults to CONFIG value)
     */
    static calculateDEMBounds(damLine, bufferKm = null) {
        const center = globalThis.turf.center(damLine);
        const [centerLng, centerLat] = center.geometry.coordinates;

        const buffer = bufferKm || CONFIG.dem.bufferKm;

        const bounds = [
            centerLng - buffer / 111, // West
            centerLat - buffer / 111, // South
            centerLng + buffer / 111, // East
            centerLat + buffer / 111  // North
        ];

        return bounds;
    }

    /**
     * Expand bounds in specified directions
     * @param {Array} currentBounds - Current bounds [west, south, east, north]
     * @param {object} edges - Which edges to expand {west, south, east, north}
     * @param {number} expansionKm - How much to expand in km
     */
    static expandBounds(currentBounds, edges, expansionKm) {
        const expansion = expansionKm / 111; // Convert km to degrees (approximate)
        const [west, south, east, north] = currentBounds;

        return [
            edges.west ? west - expansion : west,
            edges.south ? south - expansion : south,
            edges.east ? east + expansion : east,
            edges.north ? north + expansion : north
        ];
    }

    /**
     * Get approximate cell area in m²
     */
    static getCellArea(demData, damLine) {
        const zoom = demData.zoom;
        const resolution = 40075016.686 / Math.pow(2, zoom) / CONFIG.dem.tileSize;

        // Adjust for latitude
        const center = globalThis.turf.center(damLine);
        const lat = center.geometry.coordinates[1];
        const latAdjustment = Math.cos(lat * Math.PI / 180);

        return resolution * resolution * latAdjustment;
    }
}
