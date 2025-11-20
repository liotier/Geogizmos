/**
 * Statistics Module
 * Calculates reservoir metrics
 */

import { CONFIG } from '../config.js';
import { DamGeometry } from './dam-geometry.js';

export class Statistics {
    /**
     * Calculate all reservoir statistics
     */
    static calculate(polygon, floodedCells, demData, damLine, crestElevation, elapsedSeconds = null) {
        if (!polygon) return null;

        // Calculate surface area
        const areaM2 = window.turf.area(polygon);
        const areaKm2 = areaM2 / 1000000;

        // Calculate dam length
        const damLength = damLine ? window.turf.length(damLine, { units: 'meters' }) : 0;

        // Calculate depths and volume from DEM data
        let minElevation = Infinity;
        let totalVolume = 0;
        let depthSum = 0;
        let validCells = 0;

        if (demData && floodedCells) {
            const cellAreaM2 = DamGeometry.getCellArea(demData, damLine);

            for (const cell of floodedCells) {
                const elevation = demData.data[cell];
                if (elevation > CONFIG.dem.noDataValue) {
                    minElevation = Math.min(minElevation, elevation);
                    const depth = crestElevation - elevation;
                    totalVolume += depth * cellAreaM2;
                    depthSum += depth;
                    validCells++;
                }
            }
        }

        const maxDepth = minElevation < Infinity ? crestElevation - minElevation : 0;
        const avgDepth = validCells > 0 ? depthSum / validCells : 0;

        return {
            areaM2,
            areaKm2,
            volumeM3: totalVolume,
            volumeMillionM3: totalVolume / 1000000,
            maxDepthM: maxDepth,
            avgDepthM: avgDepth,
            damLengthM: damLength,
            floodedCellCount: floodedCells.length,
            validCellCount: validCells,
            minElevation,
            crestElevation,
            elapsedSeconds
        };
    }

    /**
     * Format statistics for display
     */
    static format(stats) {
        if (!stats) return null;

        // Format elapsed time
        let elapsedTime = null;
        if (stats.elapsedSeconds !== null && stats.elapsedSeconds !== undefined) {
            const totalSeconds = Math.round(stats.elapsedSeconds);
            if (totalSeconds < 60) {
                elapsedTime = `${totalSeconds} second${totalSeconds !== 1 ? 's' : ''}`;
            } else {
                const minutes = Math.floor(totalSeconds / 60);
                const seconds = totalSeconds % 60;
                elapsedTime = `${minutes} minute${minutes !== 1 ? 's' : ''}`;
                if (seconds > 0) {
                    elapsedTime += ` ${seconds} second${seconds !== 1 ? 's' : ''}`;
                }
            }
        }

        return {
            area: `${stats.areaKm2.toFixed(2)} km²`,
            volume: `${stats.volumeMillionM3.toFixed(2)} million m³`,
            maxDepth: `${stats.maxDepthM.toFixed(1)} m`,
            avgDepth: `${stats.avgDepthM.toFixed(1)} m`,
            damLength: `${stats.damLengthM.toFixed(0)} m`,
            elapsedTime
        };
    }
}
