/**
 * Flood Fill Worker
 * Simple fixed-water-level flooding algorithm
 * Water level is constant at dam crest - flood all contiguous cells below that elevation
 */

const WORKER_VERSION = "2024.11.19.9";

// Worker configuration
const CONFIG = {
    maxIterations: 20000000,  // Allow for massive valley lakes up to 30km+
    maxDebugMessages: 100,
    progressUpdateInterval: 50000,
    edgeProximityThreshold: 200,  // Check for edge proximity conservatively (2-4km from edge)
    noDataValue: -9999,
    safetyMargin: 1.0,        // Meters below dam crest to stop flooding
    minReservoirSize: 10,     // Minimum cells to be considered valid reservoir
    layerCheckInterval: 5000  // Check for stagnation every N cells
};

let debugMessageCount = 0;

function debugLog(msg) {
    if (debugMessageCount < CONFIG.maxDebugMessages) {
        debugMessageCount++;
        self.postMessage({ debug: msg });
    }
}

/**
 * Simple queue for breadth-first flood-fill
 * Grows layer by layer, one cell at a time from all sides equally
 */
class SimpleQueue {
    constructor() {
        this.items = [];
        this.head = 0;
    }

    get length() {
        return this.items.length - this.head;
    }

    push(item) {
        this.items.push(item);
    }

    shift() {
        if (this.head >= this.items.length) return undefined;
        const item = this.items[this.head];
        this.head++;

        // Periodically compact the array to avoid memory bloat
        if (this.head > 10000) {
            this.items = this.items.slice(this.head);
            this.head = 0;
        }

        return item;
    }
}

self.addEventListener('message', function (e) {
    try {
        const { demData, damCells, crestElevation } = e.data;

        self.postMessage({ progress: 0.1 });

        debugLog(`Worker v${WORKER_VERSION}: ${demData.width}x${demData.height} grid, crest: ${crestElevation.toFixed(1)}m`);

        const flooded = performIncrementalFlood(demData, damCells, crestElevation);

        // Only send completion if we got actual results (null means expansion requested)
        if (flooded !== null) {
            self.postMessage({ flooded: Array.from(flooded) });
        }
    } catch (error) {
        self.postMessage({
            error: 'Worker error: ' + error.toString() + ' at ' + error.stack
        });
    }
});

/**
 * Simple incremental flood algorithm
 * Grows layer-by-layer from dam, equally on both sides
 * Stops when water reaches dam crest minus safety margin
 * The side that stops growing (confined) is upstream
 */
function performIncrementalFlood(demData, damCells, crestElevation) {
    const { width, height, data } = demData;
    const maxWaterLevel = crestElevation - CONFIG.safetyMargin;

    debugLog(`Starting incremental flood: max water level = ${maxWaterLevel.toFixed(1)}m`);

    // Create barrier from dam line extended to mountainside
    const barriers = extendDamToMountainside(damCells, data, width, height, crestElevation);

    // Create visited array and mark barriers
    const visited = new Uint8Array(width * height);
    for (let cell of barriers) {
        visited[cell] = 2; // 2 = barrier
    }

    // Find initial seed cells (adjacent to dam barriers, at valley floor)
    const seeds = findValleyFloorSeeds(Array.from(barriers), barriers, data, width, height, crestElevation);

    if (seeds.length === 0) {
        debugLog('ERROR: No seed cells found');
        return new Set();
    }

    debugLog(`Starting from ${seeds.length} seed cells at valley floor`);

    // Breadth-first flood - grow layer by layer from seeds
    // Water level is FIXED at dam crest (maxWaterLevel)
    // We flood all contiguous cells below this fixed water level
    const flooded = new Set();
    const queue = new SimpleQueue();

    for (let seed of seeds) {
        flooded.add(seed);
        visited[seed] = 1;
        queue.push(seed);
    }

    let iterations = 0;
    let lastSize = 0;
    let stagnantCount = 0;
    let lastVisualizationUpdate = 0;
    const visualizationUpdateInterval = 10000; // Update visualization every 10k cells

    while (queue.length > 0 && iterations < CONFIG.maxIterations) {
        iterations++;

        if (iterations % CONFIG.progressUpdateInterval === 0) {
            debugLog(`Iteration ${iterations}, queue: ${queue.length}, flooded: ${flooded.size}`);
            self.postMessage({ progress: 0.1 + (iterations / CONFIG.maxIterations) * 0.8 });
        }

        // Check for stagnation (flooding not growing)
        if (iterations % CONFIG.layerCheckInterval === 0) {
            if (flooded.size === lastSize) {
                stagnantCount++;
                if (stagnantCount > 3) {
                    debugLog(`Flooding stagnant at ${flooded.size} cells - stopping`);
                    break;
                }
            } else {
                stagnantCount = 0;
                lastSize = flooded.size;
            }

            // Check if approaching edge - request expansion if needed
            const edgeInfo = isApproachingEdge(flooded, width, height);
            if (edgeInfo) {
                debugLog(`Flooding approaching DEM edge at ${flooded.size} cells - requesting expansion`);

                // Always request expansion when approaching edges
                // Don't try to determine "confined" vs "spreading" - let it expand and find natural boundaries
                self.postMessage({
                    needMoreDEM: true,
                    currentSize: flooded.size,
                    iterations: iterations,
                    edges: edgeInfo
                });
                return null;  // Signal expansion needed
            }
        }

        // Send incremental visualization updates
        if (flooded.size - lastVisualizationUpdate >= visualizationUpdateInterval) {
            lastVisualizationUpdate = flooded.size;
            self.postMessage({
                incrementalUpdate: true,
                flooded: Array.from(flooded),
                cellCount: flooded.size
            });
        }

        const cell = queue.shift();

        // Get neighbors
        const neighbors = getNeighbors(cell, width, height);

        for (let neighbor of neighbors) {
            // Skip if already processed or is a barrier
            if (visited[neighbor] !== 0) continue;

            const neighborElev = data[neighbor];

            // Skip no-data cells
            if (neighborElev <= CONFIG.noDataValue) continue;

            // Flood all contiguous cells below the fixed water level (dam crest)
            // Water level is constant at maxWaterLevel - we're not simulating gradual filling
            if (neighborElev < maxWaterLevel) {
                visited[neighbor] = 1;
                flooded.add(neighbor);
                queue.push(neighbor);
            }
        }
    }

    if (iterations >= CONFIG.maxIterations) {
        debugLog(`WARNING: Reached iteration limit at ${flooded.size} cells`);
    }

    debugLog(`Incremental flooding complete: ${flooded.size} cells`);

    // Partition by dam side and select upstream (smaller, confined side)
    const partitions = partitionByDamSide(flooded, damCells, width, height, data, crestElevation);

    debugLog(`Left side: ${partitions.left.size} cells`);
    debugLog(`Right side: ${partitions.right.size} cells`);

    // The smaller side is likely upstream (confined valley)
    // The larger side is likely downstream (spreading out)
    const upstream = partitions.left.size < partitions.right.size ? partitions.left : partitions.right;
    const downstream = partitions.left.size < partitions.right.size ? partitions.right : partitions.left;

    debugLog(`Selected upstream: ${upstream.size} cells (smaller/confined)`);
    debugLog(`Rejected downstream: ${downstream.size} cells (larger/spreading)`);

    return upstream;
}

/**
 * Find seed cells at valley floor (lowest elevation adjacent to dam)
 */
function findValleyFloorSeeds(damCells, barriers, data, width, height, crestElevation) {
    const potentialSeeds = [];

    // Find all cells adjacent to EXTENDED BARRIER (not just original dam)
    // This ensures we seed from the full barrier that abuts valley sides
    for (let barrierCell of barriers) {
        const neighbors = getNeighbors(barrierCell, width, height);

        for (let neighbor of neighbors) {
            if (barriers.has(neighbor)) continue;

            const elevation = data[neighbor];
            if (elevation > CONFIG.noDataValue && elevation < crestElevation) {
                potentialSeeds.push({ cell: neighbor, elevation });
            }
        }
    }

    // Remove duplicates
    const uniqueSeeds = new Map();
    for (let seed of potentialSeeds) {
        if (!uniqueSeeds.has(seed.cell)) {
            uniqueSeeds.set(seed.cell, seed.elevation);
        }
    }

    // Return all seeds (breadth-first will handle layer-by-layer growth)
    return Array.from(uniqueSeeds.keys());
}

/**
 * Partition flooded cells by which side of the dam they're on
 * Simple geometric partitioning using cross product
 */
function partitionByDamSide(flooded, damCells, width, height, data, crestElevation) {
    if (damCells.length < 2) {
        debugLog('WARNING: Dam too short to partition');
        return { left: flooded, right: new Set() };
    }

    // Calculate dam line vector from first to last point
    const firstCell = damCells[0];
    const lastCell = damCells[damCells.length - 1];
    const x1 = firstCell % width;
    const y1 = Math.floor(firstCell / width);
    const x2 = lastCell % width;
    const y2 = Math.floor(lastCell / width);

    const damVectorX = x2 - x1;
    const damVectorY = y2 - y1;

    // Partition flooded cells by side using cross product
    const leftSide = new Set();
    const rightSide = new Set();

    for (let cell of flooded) {
        const x = cell % width;
        const y = Math.floor(cell / width);

        // Vector from dam start to this cell
        const toCellX = x - x1;
        const toCellY = y - y1;

        // Cross product determines which side
        // Positive = left side, Negative = right side
        const crossProduct = damVectorX * toCellY - damVectorY * toCellX;

        if (crossProduct > 0) {
            leftSide.add(cell);
        } else if (crossProduct < 0) {
            rightSide.add(cell);
        }
        // crossProduct === 0 means exactly on the line (rare, ignore)
    }

    return { left: leftSide, right: rightSide };
}

/**
 * Create barrier wall from dam cells
 */
function createDamBarrier(damCells, width, height) {
    const barriers = new Set(damCells);

    // Thicken dam line to ensure continuous barrier
    for (let i = 0; i < damCells.length - 1; i++) {
        const cell1 = damCells[i];
        const cell2 = damCells[i + 1];
        const x1 = cell1 % width;
        const y1 = Math.floor(cell1 / width);
        const x2 = cell2 % width;
        const y2 = Math.floor(cell2 / width);

        const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));

        for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            const x = Math.round(x1 + (x2 - x1) * t);
            const y = Math.round(y1 + (y2 - y1) * t);
            const cell = y * width + x;

            if (cell >= 0 && cell < width * height) {
                barriers.add(cell);
            }
        }
    }

    return barriers;
}

/**
 * Extend dam parallel to itself from both endpoints until hitting mountainside
 * "Prolong the dam on both sides until each side hits a cell whose altitude
 * is more than the dam's highest extremity"
 */
function extendDamToMountainside(damCells, data, width, height, crestElevation) {
    if (damCells.length < 2) {
        debugLog('Dam too short to extend');
        return createDamBarrier(damCells, width, height);
    }

    // Start with thickened dam barrier
    const barriers = createDamBarrier(damCells, width, height);

    // Calculate dam direction vector
    const firstCell = damCells[0];
    const lastCell = damCells[damCells.length - 1];
    const x1 = firstCell % width;
    const y1 = Math.floor(firstCell / width);
    const x2 = lastCell % width;
    const y2 = Math.floor(lastCell / width);

    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);

    if (len === 0) {
        debugLog('Dam has zero length');
        return barriers;
    }

    // Normalized direction vector
    const dirX = dx / len;
    const dirY = dy / len;

    debugLog(`Dam direction: (${dirX.toFixed(3)}, ${dirY.toFixed(3)}), extending until hitting valley wall`);

    // Get starting elevations at dam endpoints
    const startElev1 = data[firstCell];
    const startElev2 = data[lastCell];

    // Extend from first endpoint BACKWARD (opposite direction)
    let extCount1 = 0;
    let currentX = x1;
    let currentY = y1;

    for (let i = 0; i < 1000; i++) {  // Max 1000 cells for large valleys
        currentX -= dirX;
        currentY -= dirY;

        const x = Math.round(currentX);
        const y = Math.round(currentY);

        // Check bounds
        if (x < 0 || x >= width || y < 0 || y >= height) break;

        const cell = y * width + x;
        const elevation = data[cell];

        // Stop if no-data
        if (elevation <= CONFIG.noDataValue) break;

        // Stop if we hit valley wall: either above crest OR cumulative climb from start
        // Using cumulative climb catches gradual slopes (e.g., V-shaped valley walls)
        const cumulativeClimb = elevation - startElev1;
        if (elevation > crestElevation || cumulativeClimb > 20) {
            debugLog(`Hit valley wall at endpoint 1 after ${extCount1} cells (elev: ${elevation.toFixed(1)}m, climb: ${cumulativeClimb.toFixed(1)}m)`);
            break;
        }

        barriers.add(cell);
        extCount1++;
    }

    // Extend from last endpoint FORWARD
    let extCount2 = 0;
    currentX = x2;
    currentY = y2;

    for (let i = 0; i < 1000; i++) {  // Max 1000 cells for large valleys
        currentX += dirX;
        currentY += dirY;

        const x = Math.round(currentX);
        const y = Math.round(currentY);

        // Check bounds
        if (x < 0 || x >= width || y < 0 || y >= height) break;

        const cell = y * width + x;
        const elevation = data[cell];

        // Stop if no-data
        if (elevation <= CONFIG.noDataValue) break;

        // Stop if we hit valley wall: either above crest OR cumulative climb from start
        const cumulativeClimb = elevation - startElev2;
        if (elevation > crestElevation || cumulativeClimb > 20) {
            debugLog(`Hit valley wall at endpoint 2 after ${extCount2} cells (elev: ${elevation.toFixed(1)}m, climb: ${cumulativeClimb.toFixed(1)}m)`);
            break;
        }

        barriers.add(cell);
        extCount2++;
    }

    debugLog(`Dam extended: +${extCount1} cells from start, +${extCount2} cells from end (total ${barriers.size} barrier cells)`);

    return barriers;
}


/**
 * Identify separate water bodies using connected components
 */
function identifyWaterBodies(flooded, visited, width, height, data, crestElevation) {
    const bodies = [];
    const assigned = new Set();
    let bodyId = 0;

    for (let floodedCell of flooded) {
        if (assigned.has(floodedCell)) continue;

        bodyId++;
        const bodyCells = new Set();
        const queue = [floodedCell];
        bodyCells.add(floodedCell);
        assigned.add(floodedCell);

        let totalDepth = 0;
        let minElevation = Infinity;
        let maxElevation = -Infinity;
        let touchesEdge = false;
        const edgesTouched = { north: false, south: false, east: false, west: false };
        let minX = width, maxX = 0, minY = height, maxY = 0;

        while (queue.length > 0) {
            const cell = queue.shift();
            const x = cell % width;
            const y = Math.floor(cell / width);

            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;

            // Track which edges this body touches
            if (x === 0) { touchesEdge = true; edgesTouched.west = true; }
            if (x === width - 1) { touchesEdge = true; edgesTouched.east = true; }
            if (y === 0) { touchesEdge = true; edgesTouched.north = true; }
            if (y === height - 1) { touchesEdge = true; edgesTouched.south = true; }

            const elevation = data[cell];
            if (elevation > CONFIG.noDataValue) {
                totalDepth += (crestElevation - elevation);
                if (elevation < minElevation) minElevation = elevation;
                if (elevation > maxElevation) maxElevation = elevation;
            }

            const neighbors = getNeighbors(cell, width, height);
            for (let neighbor of neighbors) {
                if (flooded.has(neighbor) && !assigned.has(neighbor)) {
                    bodyCells.add(neighbor);
                    assigned.add(neighbor);
                    queue.push(neighbor);
                }
            }
        }

        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        const avgDepth = totalDepth / bodyCells.size;

        bodies.push({
            id: bodyId,
            cells: bodyCells,
            size: bodyCells.size,
            avgDepth,
            minElevation,
            maxElevation,
            touchesEdge,
            edgesTouched,
            centerX,
            centerY,
            bounds: [minX, minY, maxX, maxY]
        });

        debugLog(`Body ${bodyId}: size=${bodyCells.size}, avgDepth=${avgDepth.toFixed(1)}m, minElev=${minElevation.toFixed(1)}m, touchesEdge=${touchesEdge}`);
    }

    return bodies;
}


/**
 * Get 4-connected neighbors
 */
function getNeighbors(cell, width, height) {
    const neighbors = [];
    const x = cell % width;
    const y = Math.floor(cell / width);

    if (x > 0) neighbors.push(cell - 1);
    if (x < width - 1) neighbors.push(cell + 1);
    if (y > 0) neighbors.push(cell - width);
    if (y < height - 1) neighbors.push(cell + width);

    return neighbors;
}

/**
 * Check if flooding is approaching DEM edge
 * Returns true if any flooded cells are within threshold distance of edge
 */
function isApproachingEdge(flooded, width, height) {
    const threshold = CONFIG.edgeProximityThreshold;
    const edges = { west: false, east: false, north: false, south: false };

    for (let cell of flooded) {
        const x = cell % width;
        const y = Math.floor(cell / width);

        if (x < threshold) edges.west = true;
        if (x >= width - threshold) edges.east = true;
        if (y < threshold) edges.north = true;
        if (y >= height - threshold) edges.south = true;
    }

    const approaching = edges.west || edges.east || edges.north || edges.south;

    if (approaching) {
        const directions = [];
        if (edges.north) directions.push('north');
        if (edges.south) directions.push('south');
        if (edges.east) directions.push('east');
        if (edges.west) directions.push('west');
        debugLog(`Approaching edges: ${directions.join(', ')}`);
    }

    return approaching ? edges : null;
}

