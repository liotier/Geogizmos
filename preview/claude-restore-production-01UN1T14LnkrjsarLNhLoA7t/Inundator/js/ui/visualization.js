/**
 * Visualization Module
 * Handles rendering of dam lines and flood polygons on the map
 */

import { CONFIG } from '../config.js';

export class Visualization {
    constructor(map) {
        this.map = map;
    }

    /**
     * Add or update dam point markers
     */
    updateDamPoints(points) {
        if (points.length === 0) {
            this.removeDamPoints();
            return;
        }

        const features = points.map(coord => ({
            type: 'Feature',
            geometry: {
                type: 'Point',
                coordinates: coord
            }
        }));

        if (this.map.getSource('dam-points')) {
            this.map.getSource('dam-points').setData({
                type: 'FeatureCollection',
                features: features
            });
        } else {
            this.map.addSource('dam-points', {
                type: 'geojson',
                data: {
                    type: 'FeatureCollection',
                    features: features
                }
            });

            this.map.addLayer({
                id: 'dam-points',
                type: 'circle',
                source: 'dam-points',
                paint: {
                    'circle-radius': 8,
                    'circle-color': CONFIG.visualization.damColor,
                    'circle-stroke-color': '#fff',
                    'circle-stroke-width': 2
                }
            });
        }
    }

    /**
     * Remove dam point markers
     */
    removeDamPoints() {
        if (this.map.getLayer('dam-points')) {
            this.map.removeLayer('dam-points');
            this.map.removeSource('dam-points');
        }
    }

    /**
     * Update dam line preview (while drawing)
     */
    updateDamPreview(start, end) {
        const previewLine = {
            type: 'Feature',
            geometry: {
                type: 'LineString',
                coordinates: [start, end]
            }
        };

        if (this.map.getSource('dam-preview')) {
            this.map.getSource('dam-preview').setData(previewLine);
        } else {
            this.map.addSource('dam-preview', {
                type: 'geojson',
                data: previewLine
            });

            this.map.addLayer({
                id: 'dam-preview',
                type: 'line',
                source: 'dam-preview',
                paint: {
                    'line-color': CONFIG.visualization.damColor,
                    'line-width': 2,
                    'line-dasharray': [2, 2],
                    'line-opacity': CONFIG.visualization.damPreviewOpacity
                }
            });
        }
    }

    /**
     * Remove dam preview
     */
    removeDamPreview() {
        if (this.map.getLayer('dam-preview')) {
            this.map.removeLayer('dam-preview');
            this.map.removeSource('dam-preview');
        }
    }

    /**
     * Add or update dam line
     */
    updateDamLine(damLine) {
        if (this.map.getSource('dam-line')) {
            this.map.getSource('dam-line').setData(damLine);
        } else {
            this.map.addSource('dam-line', {
                type: 'geojson',
                data: damLine
            });

            this.map.addLayer({
                id: 'dam-line',
                type: 'line',
                source: 'dam-line',
                paint: {
                    'line-color': CONFIG.visualization.damColor,
                    'line-width': CONFIG.visualization.damWidth
                }
            });
        }
    }

    /**
     * Remove dam line
     */
    removeDamLine() {
        if (this.map.getLayer('dam-line')) {
            this.map.removeLayer('dam-line');
            this.map.removeSource('dam-line');
        }
    }

    /**
     * Visualize flood polygon
     */
    visualizeFlood(polygon) {
        // Remove existing flood layers
        this.removeFlood();

        // Add flood polygon source
        this.map.addSource('flood-polygon', {
            type: 'geojson',
            data: polygon
        });

        // Add fill layer with semi-transparent water color
        this.map.addLayer({
            id: 'flood-polygon',
            type: 'fill',
            source: 'flood-polygon',
            paint: {
                'fill-color': CONFIG.visualization.waterColor,
                'fill-opacity': CONFIG.visualization.waterOpacity
            }
        });

        // Add outline
        this.map.addLayer({
            id: 'flood-outline',
            type: 'line',
            source: 'flood-polygon',
            paint: {
                'line-color': CONFIG.visualization.waterColorDeep,
                'line-width': 2
            }
        });
    }

    /**
     * Visualize dam barriers (extension) in different color
     */
    visualizeBarriers(barrierCells, demData) {
        // Remove existing barrier visualization
        this.removeBarriers();

        // Convert barrier cells to geographic points
        const { width, zoom, tileBounds, minX, minY } = demData;
        const [tileWest, tileNorth] = tileBounds;
        const n = Math.pow(2, zoom);

        // Calculate origin tile coordinates from minX/minY offsets
        const originTileWest = tileWest - minX / 256;
        const originTileNorth = tileNorth - minY / 256;

        const points = [];
        for (const cell of barrierCells) {
            const arrayX = cell % width;
            const arrayY = Math.floor(cell / width);

            // Convert to logical grid coordinates
            const gridX = arrayX + minX;
            const gridY = arrayY + minY;

            // Convert to tile coordinates
            const tileX = originTileWest + (gridX / 256);
            const tileY = originTileNorth + (gridY / 256);

            // Convert to lng/lat
            const lng = (tileX / n) * 360 - 180;
            const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * tileY / n))) * 180 / Math.PI;

            points.push([lng, lat]);
        }

        // Create line from barrier points
        if (points.length > 0) {
            const barrierLine = {
                type: 'Feature',
                geometry: {
                    type: 'LineString',
                    coordinates: points
                }
            };

            this.map.addSource('barrier-extension', {
                type: 'geojson',
                data: barrierLine
            });

            this.map.addLayer({
                id: 'barrier-extension',
                type: 'line',
                source: 'barrier-extension',
                paint: {
                    'line-color': '#ff6600',  // Orange color to distinguish from user-drawn dam
                    'line-width': 3,
                    'line-opacity': 0.8
                }
            });
        }
    }

    /**
     * Remove barrier visualization
     */
    removeBarriers() {
        if (this.map.getLayer('barrier-extension')) {
            this.map.removeLayer('barrier-extension');
        }
        if (this.map.getSource('barrier-extension')) {
            this.map.removeSource('barrier-extension');
        }
    }

    /**
     * Remove flood visualization
     */
    removeFlood() {
        if (this.map.getLayer('flood-polygon')) {
            this.map.removeLayer('flood-polygon');
        }
        if (this.map.getLayer('flood-outline')) {
            this.map.removeLayer('flood-outline');
        }
        if (this.map.getSource('flood-polygon')) {
            this.map.removeSource('flood-polygon');
        }
    }

    /**
     * Clear all visualizations
     */
    clearAll() {
        this.removeDamPoints();
        this.removeDamPreview();
        this.removeDamLine();
        this.removeFlood();
        this.removeBarriers();
    }
}
