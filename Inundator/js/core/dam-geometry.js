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
        const line = window.turf.lineString(coordinates);
        const length = window.turf.length(line, { units: 'meters' });
        const samples = [];

        for (let dist = 0; dist <= length; dist += distanceM) {
            const point = window.turf.along(line, dist, { units: 'meters' });
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

        console.log('Getting dam cells for', samples.length, 'sample points');

        for (const [lng, lat] of samples) {
            // Convert lng/lat to tile coordinates
            const tileX = (lng + 180) / 360 * n;
            const tileY = (1 - Math.log(Math.tan(lat * Math.PI / 180) +
                1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n;

            // Convert to pixel coordinates within our DEM grid
            const pixelX = Math.floor((tileX - tileWest) * CONFIG.dem.tileSize);
            const pixelY = Math.floor((tileY - tileNorth) * CONFIG.dem.tileSize);

            if (pixelX >= 0 && pixelX < demData.width &&
                pixelY >= 0 && pixelY < demData.height) {
                const cell = pixelY * demData.width + pixelX;
                damCells.push(cell);

                // Debug first few cells
                if (damCells.length <= 3) {
                    console.log(`Dam point: lng=${lng.toFixed(4)}, lat=${lat.toFixed(4)} -> tile=(${tileX.toFixed(2)}, ${tileY.toFixed(2)}) -> pixel=(${pixelX}, ${pixelY}) -> cell=${cell}`);
                }
            }
        }

        console.log('Found', damCells.length, 'dam cells in DEM grid');
        return damCells;
    }

    /**
     * Calculate bounding box with buffer for DEM fetch
     */
    static calculateDEMBounds(damLine) {
        const center = window.turf.center(damLine);
        const [centerLng, centerLat] = center.geometry.coordinates;

        const buffer = CONFIG.dem.bufferKm;

        const bounds = [
            centerLng - buffer / 111, // West
            centerLat - buffer / 111, // South
            centerLng + buffer / 111, // East
            centerLat + buffer / 111  // North
        ];

        return bounds;
    }

    /**
     * Get approximate cell area in m²
     */
    static getCellArea(demData, damLine) {
        const zoom = demData.zoom;
        const resolution = 40075016.686 / Math.pow(2, zoom) / CONFIG.dem.tileSize;

        // Adjust for latitude
        const center = window.turf.center(damLine);
        const lat = center.geometry.coordinates[1];
        const latAdjustment = Math.cos(lat * Math.PI / 180);

        return resolution * resolution * latAdjustment;
    }
}
