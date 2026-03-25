/**
 * Inundator Application
 * Main controller that coordinates all modules
 */

import { CONFIG } from './config.js';
import { ElevationService } from './core/elevation-service.js';
import { DamGeometry } from './core/dam-geometry.js';
import { PolygonGenerator } from './core/polygon-generator.js';
import { Statistics } from './core/statistics.js';
import { MapManager } from './ui/map-manager.js';
import { Visualization } from './ui/visualization.js';


export class InundatorApp {
    // Services
    elevationService = new ElevationService();
    mapManager = new MapManager('map');
    visualization = null; // Created after map init

    // State
    isDrawingDam = false;
    damPoints = [];
    damLine = null;
    crestElevation = null;
    floodPolygon = null;
    demData = null;
    originTileBounds = null; // Track grid origin for negative indices
    currentMousePosition = null;
    resumeState = null; // Track flood state for continuation after DEM expansion

    // Worker
    floodWorker = null;

    // UI state
    waterLevel = CONFIG.dam.waterLevelSafetyFactor; // Fixed at 95% (5% safety margin)
    safetyMargin = CONFIG.dam.defaultSafetyMargin;
    searchTimeout = null;
    currentBufferKm = CONFIG.dem.bufferKm; // Track current DEM buffer size
    currentBounds = null; // Track current DEM bounds [west, south, east, north]
    downstreamRejectionCount = 0; // Track consecutive downstream rejections

    constructor() {
        this.init();
    }

    init() {
        // Initialize map
        this.mapManager.init();
        const map = this.mapManager.getMap();

        // Initialize visualization
        this.visualization = new Visualization(map);

        // Set up map event handlers
        this.mapManager.onMapClick = (lngLat) => {
            if (this.isDrawingDam) {
                this.addDamPoint(lngLat);
            }
        };

        this.mapManager.onMapMouseMove = (lngLat) => {
            if (this.isDrawingDam && this.damPoints.length === 1) {
                this.currentMousePosition = [lngLat.lng, lngLat.lat];
                this.updateDrawingPreview();
            }
        };

        // Initialize worker
        this.initWorker();

        // Bind UI events
        this.bindEvents();
    }

    initWorker() {
        if (this.floodWorker) {
            this.floodWorker.terminate();
            this.floodWorker = null;
        }

        this.floodWorker = new Worker('js/workers/flood-worker.js');

        this.floodWorker.addEventListener('message', (e) => {
            if (e.data.error) {
                console.error('Worker error:', e.data.error);
                this.showMessage('Flood computation error: ' + e.data.error, 'error');
                this.hideStatus();
            } else if (e.data.debug) {
                console.log('%c[Worker] ' + e.data.debug, 'color: blue');
            } else if (e.data.progress !== undefined) {
                this.updateProgress(e.data.progress);
                if (e.data.status) {
                    this.showStatus(e.data.status);
                }
            } else if (e.data.incrementalUpdate) {
                this.updateIncrementalVisualization(e.data.flooded, e.data.cellCount);
            } else if (e.data.needMoreDEM) {
                this.handleDEMExpansionRequest(e.data);
            } else if (e.data.flooded) {
                this.onFloodFillComplete(e.data.flooded, e.data.barriers);
            }
        });
    }

    bindEvents() {
        // Location search
        const locationInput = document.getElementById('location-search');
        locationInput.addEventListener('input', (e) => {
            clearTimeout(this.searchTimeout);
            const query = e.target.value.trim();

            if (query.length < 2) {
                this.hideLocationDropdown();
                return;
            }

            this.searchTimeout = setTimeout(() => {
                this.searchLocation(query);
            }, CONFIG.geocoding.searchDebounce);
        });

        // Dam drawing
        document.getElementById('draw-dam-btn').addEventListener('click', () => {
            this.toggleDamDrawing();
        });

        document.getElementById('clear-dam-btn').addEventListener('click', () => {
            this.clearDam();
        });

        // Basemap
        document.getElementById('basemap-selector').addEventListener('change', (e) => {
            this.mapManager.switchBasemap(e.target.value);
        });

        // Actions
        document.getElementById('compute-btn').addEventListener('click', () => {
            this.computeInundation();
        });

        document.getElementById('export-png').addEventListener('click', () => {
            this.exportPNG();
        });

        document.getElementById('export-geojson').addEventListener('click', () => {
            this.exportGeoJSON();
        });

        // Close dropdowns on outside click
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.location-input-container')) {
                this.hideLocationDropdown();
            }
        });

        // Mobile menu toggle
        this.initMobileMenu();
    }

    initMobileMenu() {
        const sidebar = document.getElementById('sidebar');

        // Create hamburger menu button
        const menuToggle = document.createElement('button');
        menuToggle.id = 'menu-toggle';
        menuToggle.innerHTML = '<span></span><span></span><span></span>';
        document.body.insertBefore(menuToggle, document.body.firstChild);

        // Create mobile backdrop
        const backdrop = document.createElement('div');
        backdrop.id = 'mobile-backdrop';
        document.body.appendChild(backdrop);

        // Toggle menu on hamburger click
        menuToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            sidebar.classList.toggle('open');
            menuToggle.classList.toggle('active');
            backdrop.classList.toggle('active');
        });

        // Close menu on backdrop click
        backdrop.addEventListener('click', () => {
            sidebar.classList.remove('open');
            menuToggle.classList.remove('active');
            backdrop.classList.remove('active');
        });

        // Close menu when clicking inside sidebar (after interaction)
        sidebar.addEventListener('click', (e) => {
            // Only close if clicking a button or completing an action
            if (e.target.tagName === 'BUTTON' && window.innerWidth <= 600) {
                setTimeout(() => {
                    sidebar.classList.remove('open');
                    menuToggle.classList.remove('active');
                    backdrop.classList.remove('active');
                }, 300);
            }
        });
    }

    // Location search
    async searchLocation(query) {
        try {
            const response = await fetch(
                `${CONFIG.geocoding.nominatimUrl}?format=jsonv2&q=${encodeURIComponent(query)}&limit=${CONFIG.geocoding.searchLimit}`
            );

            const results = await response.json();
            this.showLocationResults(results);
        } catch (error) {
            console.error('Location search error:', error);
        }
    }

    showLocationResults(results) {
        const dropdown = document.getElementById('location-results');
        dropdown.innerHTML = '';

        if (results.length === 0) {
            dropdown.innerHTML = '<div class="dropdown-item">No results found</div>';
        } else {
            results.forEach(result => {
                const item = document.createElement('div');
                item.className = 'dropdown-item';
                item.textContent = result.display_name;
                item.addEventListener('click', () => {
                    this.selectLocation(result);
                });
                dropdown.appendChild(item);
            });
        }

        dropdown.classList.add('active');
    }

    hideLocationDropdown() {
        document.getElementById('location-results').classList.remove('active');
    }

    selectLocation(location) {
        document.getElementById('location-search').value = location.display_name.split(',')[0];
        this.hideLocationDropdown();

        this.mapManager.flyTo(Number.parseFloat(location.lon), Number.parseFloat(location.lat));
    }

    // Dam drawing
    toggleDamDrawing() {
        this.isDrawingDam = !this.isDrawingDam;
        const btn = document.getElementById('draw-dam-btn');
        const hint = document.getElementById('drawing-hint');

        if (this.isDrawingDam) {
            btn.classList.add('active');
            document.getElementById('draw-dam-text').textContent = 'Cancel drawing';
            hint.classList.add('active');
            this.mapManager.setCursor('drawing');
            this.clearDam();
        } else {
            btn.classList.remove('active');
            document.getElementById('draw-dam-text').textContent = 'Draw dam line';
            hint.classList.remove('active');
            this.mapManager.setCursor('');
            this.visualization.removeDamPreview();
        }
    }

    addDamPoint(lngLat) {
        this.damPoints.push([lngLat.lng, lngLat.lat]);

        if (this.damPoints.length === 1) {
            this.visualization.updateDamPoints(this.damPoints);
        } else if (this.damPoints.length === 2) {
            this.completeDamLine();
        }
    }

    updateDrawingPreview() {
        if (!this.currentMousePosition || this.damPoints.length !== 1) return;

        this.visualization.updateDamPreview(this.damPoints[0], this.currentMousePosition);
    }

    completeDamLine() {
        this.isDrawingDam = false;
        const btn = document.getElementById('draw-dam-btn');
        btn.classList.remove('active');
        document.getElementById('draw-dam-text').textContent = 'Draw dam line';
        document.getElementById('drawing-hint').classList.remove('active');
        this.mapManager.setCursor('');

        this.visualization.removeDamPreview();
        this.visualization.removeDamPoints();

        this.damLine = {
            type: 'Feature',
            geometry: {
                type: 'LineString',
                coordinates: this.damPoints
            }
        };

        this.visualization.updateDamLine(this.damLine);

        document.getElementById('clear-dam-btn').disabled = false;
        document.getElementById('compute-btn').disabled = false;

        this.calculateCrestElevation();

        this.showMessage('Dam line created. Adjust parameters and click "Compute inundation"', 'info');
    }

    clearDam() {
        this.damPoints = [];
        this.damLine = null;
        this.crestElevation = null;

        this.visualization.clearAll();

        document.getElementById('clear-dam-btn').disabled = true;
        document.getElementById('compute-btn').disabled = true;
        document.getElementById('export-png').disabled = true;
        document.getElementById('export-geojson').disabled = true;
        document.getElementById('stats').style.display = 'none';
    }

    async calculateCrestElevation() {
        if (!this.damLine) return;

        this.showStatus('Calculating crest elevation...');

        try {
            const samples = DamGeometry.sampleLinePoints(
                this.damLine.geometry.coordinates,
                CONFIG.dam.elevationSampleInterval
            );
            const elevations = await this.elevationService.fetchElevations(samples);

            const maxElevation = Math.max(...elevations);
            this.crestElevation = maxElevation - this.safetyMargin;

            this.hideStatus();
        } catch (error) {
            console.error('Error calculating crest elevation:', error);
            this.showMessage('Failed to calculate crest elevation', 'error');
            this.hideStatus();
        }
    }

    // Inundation computation
    async computeInundation() {
        if (!this.damLine) return;

        // Track computation start time
        this.computationStartTime = Date.now();

        // Reset downstream rejection counter for new computation
        this.downstreamRejectionCount = 0;

        // Reset resume state for fresh computation
        this.resumeState = null;

        // Calculate crest elevation if not already set
        if (!this.crestElevation) {
            await this.calculateCrestElevation();
        }

        if (!this.crestElevation) {
            this.showMessage('Please wait for crest elevation calculation or enter manually', 'warning');
            return;
        }

        // Reset buffer to initial size for new computation
        this.currentBufferKm = CONFIG.dem.bufferKm;

        this.showStatus('Fetching elevation data...');

        try {
            const bounds = DamGeometry.calculateDEMBounds(this.damLine, this.currentBufferKm);
            this.currentBounds = bounds; // Store initial bounds for directional expansion

            this.showStatus('Loading terrain data...');
            const demData = await this.elevationService.fetchDEMData(bounds, (progress) => {
                this.updateProgress(progress);
            }, this.originTileBounds);
            this.demData = demData;

            // Store origin tile bounds from first fetch
            if (!this.originTileBounds) {
                this.originTileBounds = demData.tileBounds;
            }

            this.showStatus('Computing flood extent...');
            await this.runFloodFill(demData);

        } catch (error) {
            console.error('Inundation computation error:', error);
            this.showMessage('Failed to compute inundation: ' + error.message, 'error');
            this.hideStatus();
        }
    }

    async runFloodFill(demData) {
        const damCells = DamGeometry.getDamCells(this.damLine, demData);

        if (damCells.length === 0) {
            throw new Error('Dam line outside DEM bounds');
        }

        const effectiveCrest = this.crestElevation * this.waterLevel;

        // Pass resumeState if available (for continuation after DEM expansion)
        const message = {
            demData: demData,
            damCells: damCells,
            crestElevation: effectiveCrest
        };

        if (this.resumeState) {
            message.resumeState = this.resumeState;
            console.log('Passing resume state to worker for continuation');
        }

        this.floodWorker.postMessage(message);
    }

    async handleDEMExpansionRequest(data) {
        console.log(`DEM expansion requested at ${data.currentSize} cells (iteration ${data.iterations})`);

        // Store resume state for continuation after expansion
        this.resumeState = data.resumeState || null;

        if (this.resumeState) {
            console.log(`Preserving state: ${this.resumeState.leftSideCells.length} left, ${this.resumeState.rightSideCells.length} right, ${this.resumeState.queueCells.length} queued`);
        }

        // Track downstream rejections and stop if we keep finding only downstream
        if (data.foundDownstream) {
            this.downstreamRejectionCount++;
            console.warn(`Downstream body rejected (${this.downstreamRejectionCount} times)`);

            if (this.downstreamRejectionCount >= 3) {
                console.error('No upstream reservoir found after 3 attempts - only downstream flow detected');
                this.showMessage('No viable upstream reservoir at this location - water flows downstream only', 'error');
                this.hideStatus();
                return;
            }
        } else {
            // Reset counter if we're not finding downstream (might find upstream on next expansion)
            this.downstreamRejectionCount = 0;
        }

        // Identify which directions to expand
        const edges = data.edges || { north: true, south: true, east: true, west: true };
        const directions = [];
        if (edges.north) directions.push('north');
        if (edges.south) directions.push('south');
        if (edges.east) directions.push('east');
        if (edges.west) directions.push('west');

        console.log(`Expanding in directions: ${directions.join(', ')}`);

        // Calculate expansion amount - expand aggressively to reduce DEM fetches
        const expansionKm = Math.min(this.currentBufferKm, 30); // Expand by current buffer or 30km, whichever is smaller

        // Check if we're within tile limits
        const testBounds = DamGeometry.expandBounds(this.currentBounds, edges, expansionKm);
        const boundsWidth = (testBounds[2] - testBounds[0]) * 111;  // Degrees to km
        const boundsHeight = (testBounds[3] - testBounds[1]) * 111;

        if (boundsWidth > CONFIG.dem.maxBufferKm * 2 || boundsHeight > CONFIG.dem.maxBufferKm * 2) {
            console.warn('Already at maximum buffer size, cannot expand further');
            this.showMessage('Lake reached maximum computable extent', 'warning');
            this.hideStatus();
            return;
        }

        this.currentBufferKm += expansionKm;
        this.showStatusMessage(`Lake extending ${directions.join('/')}`);

        // Re-fetch DEM with expanded bounds
        try {
            this.showStatus(`Expanding terrain data ${directions.join('/')} by ${expansionKm}km...`);

            const bounds = DamGeometry.expandBounds(this.currentBounds, edges, expansionKm);
            this.currentBounds = bounds; // Update tracked bounds

            const demData = await this.elevationService.fetchDEMData(bounds, (progress) => {
                this.updateProgress(progress);
            }, this.originTileBounds);
            this.demData = demData;

            // Restart flooding with expanded DEM
            this.showStatus('Resuming flood computation with expanded area...');
            await this.runFloodFill(demData);

        } catch (error) {
            console.error('DEM expansion error:', error);
            this.showMessage('Failed to expand terrain data: ' + error.message, 'error');
            this.hideStatus();
        }
    }

    updateIncrementalVisualization(floodedCells, cellCount) {
        // Update status to show progress
        this.showStatus(`Flooding: ${cellCount.toLocaleString()} cells...`);

        // Create and display polygon
        const polygon = PolygonGenerator.createFloodPolygon(floodedCells, this.demData);

        if (polygon) {
            this.visualization.visualizeFlood(polygon);
        }
    }

    onFloodFillComplete(floodedCells, barrierCells) {
        this.showStatus('Creating flood polygon...');

        // Create flood polygon
        const polygon = PolygonGenerator.createFloodPolygon(floodedCells, this.demData);

        if (polygon) {
            this.floodPolygon = polygon;
            this.visualization.visualizeFlood(polygon);

            // Visualize dam extension (barriers) in different color
            if (barrierCells && barrierCells.length > 0) {
                this.visualization.visualizeBarriers(barrierCells, this.demData);
            }

            // Calculate elapsed time
            const elapsedSeconds = this.computationStartTime ?
                (Date.now() - this.computationStartTime) / 1000 : null;

            const stats = Statistics.calculate(
                polygon,
                floodedCells,
                this.demData,
                this.damLine,
                this.crestElevation,
                elapsedSeconds
            );

            this.displayStatistics(stats);

            document.getElementById('export-png').disabled = false;
            document.getElementById('export-geojson').disabled = false;

            this.showMessage('Inundation computed successfully', 'success');
        } else {
            this.showMessage('No flooding detected - check crest elevation', 'warning');
        }

        this.hideStatus();
    }

    displayStatistics(stats) {
        const formatted = Statistics.format(stats);

        document.getElementById('stat-area').textContent = formatted.area;
        document.getElementById('stat-volume').textContent = formatted.volume;
        document.getElementById('stat-depth').textContent = formatted.maxDepth;
        document.getElementById('stat-dam-length').textContent = formatted.damLength;
        document.getElementById('stat-avg-depth').textContent = formatted.avgDepth;
        document.getElementById('stat-elapsed-time').textContent = formatted.elapsedTime || '-';

        document.getElementById('stats').style.display = 'block';
    }

    // Export
    exportPNG() {
        const map = this.mapManager.getMap();

        map.once('idle', () => {
            const canvas = this.mapManager.getCanvas();
            canvas.toBlob(blob => {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `inundation-${Date.now()}.png`;
                a.click();
                URL.revokeObjectURL(url);
            });
        });

        map.triggerRepaint();
    }

    exportGeoJSON() {
        if (!this.floodPolygon) return;

        const geoJSON = {
            type: 'FeatureCollection',
            features: [this.floodPolygon]
        };

        geoJSON.features[0].properties = {
            crestElevation: this.crestElevation,
            waterLevel: this.waterLevel,
            area: document.getElementById('stat-area').textContent,
            volume: document.getElementById('stat-volume').textContent,
            maxDepth: document.getElementById('stat-depth').textContent,
            avgDepth: document.getElementById('stat-avg-depth').textContent,
            exportDate: new Date().toISOString()
        };

        const blob = new Blob([JSON.stringify(geoJSON, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `inundation-${Date.now()}.geojson`;
        a.click();
        URL.revokeObjectURL(url);
    }

    // UI helpers
    showStatus(text) {
        const status = document.getElementById('status');
        document.getElementById('status-text').textContent = text;
        status.classList.add('active');
    }

    hideStatus() {
        setTimeout(() => {
            document.getElementById('status').classList.remove('active');
        }, 500);
    }

    showStatusMessage(text) {
        const statusMessage = document.getElementById('status-message');
        statusMessage.textContent = text;
        statusMessage.classList.add('active');

        // Auto-hide after 10 seconds (twice the original 5 second duration)
        setTimeout(() => {
            statusMessage.classList.remove('active');
        }, 10000);
    }

    updateProgress(value) {
        document.getElementById('progress-fill').style.width = `${value * 100}%`;
    }

    showMessage(text, type = 'info') {
        const messages = document.getElementById('messages');
        messages.innerHTML = `<div class="message ${type}-message">${text}</div>`;

        setTimeout(() => {
            messages.innerHTML = '';
        }, 5000);
    }
}

// Initialize app when page loads
document.addEventListener('DOMContentLoaded', () => {
    new InundatorApp();
});
