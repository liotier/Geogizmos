/**
 * Flood Fill Worker
 * User's algorithm:
 * - Highest dam endpoint doesn't need extending (already on slope)
 * - Dam is level at height of highest endpoint
 * - Extend only from lower endpoint until hitting cell higher than dam
 * - Seed from middle of dam, flood all cells below (dam level - 1m)
 * - Real-time upstream/downstream partitioning to prune runaway flooding
 * - Cache dam geometry on first calculation, reuse on DEM expansions (don't recalculate!)
 * - Stateful continuation: preserve flood state across DEM expansions (don't restart!)
 */

const WORKER_VERSION = "2024.11.20.stateful";

// Worker configuration
const CONFIG = {
    maxIterations: 20000000,  // Allow for massive valley lakes up to 30km+
    maxDebugMessages: 100,
    progressUpdateInterval: 50000,
    edgeProximityThreshold: 500,  // Expand early to avoid re-flooding (5km from edge at zoom 13)
    noDataValue: -9999,
    safetyMargin: 1.0,        // Meters below dam crest to stop flooding
    minReservoirSize: 10,     // Minimum cells to be considered valid reservoir
    layerCheckInterval: 5000,  // Check for stagnation every N cells
    maxReservoirAreaKm2: 500,  // Maximum reasonable reservoir area (safety limit)
    areaSizeCheckInterval: 50000  // Check reservoir size every N iterations
};

// Cached dam geometry - calculated ONCE at start, reused on DEM expansions
let cachedDamGeometry = null;

let debugMessageCount = 0;

function debugLog(msg) {
    if (debugMessageCount < CONFIG.maxDebugMessages) {
        debugMessageCount++;
        self.postMessage({ debug: msg });
    }
}

/**
 * Calculate cell area in m² for a given DEM grid
 * Accounts for latitude (Mercator projection distortion)
 */
function calculateCellArea(demData, damCells) {
    const { width, height, zoom, tileBounds } = demData;

    // Get approximate latitude from dam center for area calculation
    const middleDamCell = damCells[Math.floor(damCells.length / 2)];
    const gridX = middleDamCell % width;
    const gridY = Math.floor(middleDamCell / width);

    // Convert grid to tile coordinates
    const [tileWest, tileNorth] = tileBounds;
    const tileSize = 256;
    const tileX = tileWest + (gridX + demData.minX) / tileSize;
    const tileY = tileNorth + (gridY + demData.minY) / tileSize;

    // Convert tile to lat/lng
    const n = Math.pow(2, zoom);
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * tileY / n))) * 180 / Math.PI;

    // Calculate cell size in meters at this latitude
    // Earth circumference at equator: 40,075,017 m
    const earthCircumference = 40075017;
    const metersPerTile = earthCircumference / n;
    const metersPerPixel = metersPerTile / tileSize;

    // Adjust for latitude (Mercator distortion)
    const latRadians = lat * Math.PI / 180;
    const adjustedMetersPerPixel = metersPerPixel * Math.cos(latRadians);

    return adjustedMetersPerPixel * adjustedMetersPerPixel; // m² per cell
}

/**
 * Remap cached barrier offsets to new grid after DEM expansion
 */
function remapBarrierToNewGrid(barrierOffsets, damCells, width, height) {
    const barriers = new Set();
    const firstCell = damCells[0];
    const x1 = firstCell % width;
    const y1 = Math.floor(firstCell / width);

    for (let offset of barrierOffsets) {
        const x = x1 + offset.dx;
        const y = y1 + offset.dy;

        // Check bounds
        if (x >= 0 && x < width && y >= 0 && y < height) {
            const cell = y * width + x;
            barriers.add(cell);
        }
    }

    return barriers;
}

/**
 * Remap a cell from old grid to new grid after DEM expansion
 * Uses logical grid coordinates (can be negative) as intermediate representation
 */
function remapCellToNewGrid(oldCell, oldDemData, newDemData) {
    const { width: oldWidth, minX: oldMinX, minY: oldMinY } = oldDemData;
    const { width: newWidth, height: newHeight, minX: newMinX, minY: newMinY } = newDemData;

    // Convert old array index to logical grid coordinates
    const oldArrayX = oldCell % oldWidth;
    const oldArrayY = Math.floor(oldCell / oldWidth);
    const gridX = oldArrayX + oldMinX;
    const gridY = oldArrayY + oldMinY;

    // Convert logical grid coordinates to new array index
    const newArrayX = gridX - newMinX;
    const newArrayY = gridY - newMinY;

    // Check if within new bounds
    if (newArrayX < 0 || newArrayX >= newWidth ||
        newArrayY < 0 || newArrayY >= newHeight) {
        return null;  // Outside new grid
    }

    return newArrayY * newWidth + newArrayX;
}

/**
 * Remap a set of cells from old grid to new grid
 */
function remapCellSet(oldCells, oldDemData, newDemData) {
    const newCells = new Set();
    for (let oldCell of oldCells) {
        const newCell = remapCellToNewGrid(oldCell, oldDemData, newDemData);
        if (newCell !== null) {
            newCells.add(newCell);
        }
    }
    return newCells;
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
        const { demData, damCells, crestElevation, resumeState } = e.data;

        self.postMessage({ progress: 0.1 });

        if (resumeState) {
            debugLog(`Worker v${WORKER_VERSION}: RESUMING from ${resumeState.iterations} iterations (${demData.width}x${demData.height} grid)`);
            const result = resumeIncrementalFlood(demData, damCells, crestElevation, resumeState);

            if (result !== null) {
                self.postMessage({
                    flooded: Array.from(result.flooded),
                    barriers: Array.from(result.barriers),
                    boundary: result.boundary ? Array.from(result.boundary) : []
                });
            }
        } else {
            debugLog(`Worker v${WORKER_VERSION}: FRESH START (${demData.width}x${demData.height} grid, crest: ${crestElevation.toFixed(1)}m)`);
            const result = performIncrementalFlood(demData, damCells, crestElevation);

            if (result !== null) {
                self.postMessage({
                    flooded: Array.from(result.flooded),
                    barriers: Array.from(result.barriers),
                    boundary: result.boundary ? Array.from(result.boundary) : []
                });
            }
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

    // Check if we already have cached dam geometry from a previous call
    // If endpoint elevations match, this is a DEM expansion of the same dam
    const firstCell = damCells[0];
    const lastCell = damCells[damCells.length - 1];
    const elev1 = data[firstCell];
    const elev2 = data[lastCell];

    let barriers, damLevel, maxWaterLevel;

    if (cachedDamGeometry &&
        Math.abs(cachedDamGeometry.elev1 - elev1) < 0.1 &&
        Math.abs(cachedDamGeometry.elev2 - elev2) < 0.1) {
        // Same dam - reuse cached geometry
        damLevel = cachedDamGeometry.damLevel;
        maxWaterLevel = cachedDamGeometry.maxWaterLevel;

        // Remap cached barrier cells to new grid
        barriers = remapBarrierToNewGrid(cachedDamGeometry.barrierOffsets, damCells, width, height);

        debugLog(`Reusing cached dam geometry (DEM expansion): dam level ${damLevel.toFixed(1)}m, ${barriers.size} barrier cells`);
    } else {
        // New dam - calculate and cache geometry
        debugLog(`Calculating dam geometry for first time`);

        const result = extendDamToMountainside(damCells, data, width, height, crestElevation);
        barriers = result.barriers;
        damLevel = result.damLevel;
        maxWaterLevel = damLevel - 1.0;

        // Cache dam geometry for future DEM expansions
        // Store barrier as offsets from first dam cell
        const barrierOffsets = [];
        const x1 = firstCell % width;
        const y1 = Math.floor(firstCell / width);

        for (let cell of barriers) {
            const x = cell % width;
            const y = Math.floor(cell / width);
            barrierOffsets.push({ dx: x - x1, dy: y - y1 });
        }

        cachedDamGeometry = {
            elev1,
            elev2,
            damLevel,
            maxWaterLevel,
            barrierOffsets
        };

        debugLog(`Cached dam geometry: endpoints ${elev1.toFixed(1)}m, ${elev2.toFixed(1)}m, dam level ${damLevel.toFixed(1)}m`);
    }

    debugLog(`Starting incremental flood: water level = ${maxWaterLevel.toFixed(1)}m (dam level ${damLevel.toFixed(1)}m - 1m)`);

    // Create visited array and mark barriers
    const visited = new Uint8Array(width * height);
    for (let cell of barriers) {
        visited[cell] = 2; // 2 = barrier
    }

    // Find initial seed cells (adjacent to middle of dam)
    const seeds = findValleyFloorSeeds(damCells, barriers, data, width, height, damLevel);

    if (seeds.length === 0) {
        debugLog('ERROR: No seed cells found');
        return { flooded: new Set(), barriers };
    }

    debugLog(`Starting from ${seeds.length} seed cells at valley floor`);

    // Calculate dam vector for partitioning (from first to last dam cell)
    const firstDamCell = damCells[0];
    const lastDamCell = damCells[damCells.length - 1];
    const damX1 = firstDamCell % width;
    const damY1 = Math.floor(firstDamCell / width);
    const damX2 = lastDamCell % width;
    const damY2 = Math.floor(lastDamCell / width);
    const damVectorX = damX2 - damX1;
    const damVectorY = damY2 - damY1;

    // Partition flooded cells by dam side as we flood
    // This allows us to detect when one side stops growing (upstream)
    // while the other runs away (downstream to ocean)
    const leftSide = new Set();
    const rightSide = new Set();
    const queue = new SimpleQueue();

    // Track boundary cells (cells adjacent to non-flooded cells)
    // This dramatically speeds up polygon generation (only process boundary instead of all cells)
    const boundaryCells = new Set();

    // Add seeds and partition them
    for (let seed of seeds) {
        const x = seed % width;
        const y = Math.floor(seed / width);
        const toCellX = x - damX1;
        const toCellY = y - damY1;
        const crossProduct = damVectorX * toCellY - damVectorY * toCellX;

        if (crossProduct > 0) {
            leftSide.add(seed);
        } else if (crossProduct < 0) {
            rightSide.add(seed);
        }

        visited[seed] = 1;
        queue.push(seed);
    }

    let iterations = 0;
    let lastLeftSize = 0;
    let lastRightSize = 0;
    let leftStagnant = 0;
    let rightStagnant = 0;
    let lastVisualizationUpdate = 0;
    const visualizationUpdateInterval = 10000; // Update visualization every 10k cells

    while (queue.length > 0 && iterations < CONFIG.maxIterations) {
        iterations++;

        if (iterations % CONFIG.progressUpdateInterval === 0) {
            const totalCells = leftSide.size + rightSide.size;
            debugLog(`Flooding: ${totalCells.toLocaleString()} cells, queue: ${queue.length}, left: ${leftSide.size}, right: ${rightSide.size}`);
            self.postMessage({
                progress: 0.1 + (iterations / CONFIG.maxIterations) * 0.8,
                status: `Flooding: ${totalCells.toLocaleString()} cells`
            });

            // Check if reservoir area exceeds reasonable limits (safety check for flat terrain)
            const cellAreaM2 = calculateCellArea(demData, damCells);
            const currentAreaKm2 = (totalCells * cellAreaM2) / 1000000;
            if (currentAreaKm2 > CONFIG.maxReservoirAreaKm2) {
                debugLog(`Reservoir area (${currentAreaKm2.toFixed(1)} km²) exceeds maximum (${CONFIG.maxReservoirAreaKm2} km²) - stopping`);
                self.postMessage({
                    error: `Computation stopped: Reservoir area reached ${currentAreaKm2.toFixed(1)} km² (limit: ${CONFIG.maxReservoirAreaKm2} km²). ` +
                           `This may indicate very flat terrain, a large valley, or incorrect dam placement. ` +
                           `Solutions: (1) Raise the dam crest elevation to reduce flooded area, ` +
                           `(2) Place the dam in a narrower section of the valley, or ` +
                           `(3) If this is a genuinely large valley, increase maxReservoirAreaKm2 in config.js.`
                });
                return null;
            }
        }

        // Check each side's growth separately to detect confined upstream vs runaway downstream
        if (iterations % CONFIG.layerCheckInterval === 0) {
            const leftGrowth = leftSide.size - lastLeftSize;
            const rightGrowth = rightSide.size - lastRightSize;
            const leftGrowing = leftGrowth > 0;
            const rightGrowing = rightGrowth > 0;

            // Detect stagnation: confined valley vs runaway downstream
            // A side is effectively stagnant (confined) if:
            // 1. It's not growing at all, OR
            // 2. The other side is running away (much larger AND growing much faster)
            const leftGrowthRate = lastLeftSize > 0 ? leftGrowth / lastLeftSize : 0;
            const rightGrowthRate = lastRightSize > 0 ? rightGrowth / lastRightSize : 0;

            // Very conservative threshold: only stop if one side is massively larger and faster
            // This prevents stopping when valley curves and both "sides" are part of upstream
            const leftEffectivelyStagnant = !leftGrowing ||
                (rightGrowing && rightGrowth > leftGrowth * 10 && rightSide.size > leftSide.size * 5);
            const rightEffectivelyStagnant = !rightGrowing ||
                (leftGrowing && leftGrowth > rightGrowth * 10 && leftSide.size > rightSide.size * 5);

            if (leftEffectivelyStagnant) leftStagnant++;
            else leftStagnant = 0;

            if (rightEffectivelyStagnant) rightStagnant++;
            else rightStagnant = 0;

            // Debug growth rates
            if (debugMessageCount < CONFIG.maxDebugMessages && iterations % (CONFIG.layerCheckInterval * 10) === 0) {
                debugLog(`Growth check: left +${leftGrowth} (${(leftGrowthRate*100).toFixed(2)}%), right +${rightGrowth} (${(rightGrowthRate*100).toFixed(2)}%), left stagnant: ${leftStagnant}, right stagnant: ${rightStagnant}`);
            }

            // If one side is stagnant (confined) and other is still growing (runaway),
            // select the stagnant side as upstream reservoir and stop
            if (leftStagnant >= 3 && rightGrowing) {
                debugLog(`Left side stagnant (growth: ${leftGrowth}, ${(leftGrowthRate*100).toFixed(1)}%) vs right growing (${rightGrowth}, ${(rightGrowthRate*100).toFixed(1)}%) - selecting left as upstream`);
                return { flooded: leftSide, barriers };
            }
            if (rightStagnant >= 3 && leftGrowing) {
                debugLog(`Right side stagnant (growth: ${rightGrowth}, ${(rightGrowthRate*100).toFixed(1)}%) vs left growing (${leftGrowth}, ${(leftGrowthRate*100).toFixed(1)}%) - selecting right as upstream`);
                return { flooded: rightSide, barriers };
            }

            // If both sides are stagnant, we're done - return the smaller (upstream) side
            if (leftStagnant >= 3 && rightStagnant >= 3) {
                const upstream = leftSide.size < rightSide.size ? leftSide : rightSide;
                debugLog(`Both sides stagnant - selecting smaller side (${upstream.size} cells) as upstream`);
                return { flooded: upstream, barriers };
            }

            lastLeftSize = leftSide.size;
            lastRightSize = rightSide.size;

            // Check if approaching edge - request expansion if needed
            const flooded = new Set([...leftSide, ...rightSide]);
            const edgeInfo = isApproachingEdge(flooded, width, height);
            if (edgeInfo) {
                debugLog(`Flooding approaching DEM edge (left: ${leftSide.size}, right: ${rightSide.size}) - requesting expansion`);

                // Prepare state for resumption after DEM expansion
                // Extract remaining queue items (from head onwards)
                const queueCells = queue.items.slice(queue.head);

                const resumeState = {
                    queueCells: queueCells,
                    leftSideCells: Array.from(leftSide),
                    rightSideCells: Array.from(rightSide),
                    boundaryCells: Array.from(boundaryCells),
                    lastLeftSize: lastLeftSize,
                    lastRightSize: lastRightSize,
                    leftStagnant: leftStagnant,
                    rightStagnant: rightStagnant,
                    iterations: iterations,
                    oldDemData: {
                        width: width,
                        height: height,
                        minX: demData.minX,
                        minY: demData.minY
                    }
                };

                debugLog(`Saving state: ${queueCells.length} queued, ${leftSide.size} left, ${rightSide.size} right, ${iterations} iterations`);

                // Request expansion with state for continuation
                self.postMessage({
                    needMoreDEM: true,
                    currentSize: flooded.size,
                    iterations: iterations,
                    edges: edgeInfo,
                    resumeState: resumeState
                });
                return null;  // Signal expansion needed
            }
        }

        // Incremental visualization disabled - too fast now, only show final result
        // const totalCells = leftSide.size + rightSide.size;
        // if (totalCells - lastVisualizationUpdate >= visualizationUpdateInterval) {
        //     lastVisualizationUpdate = totalCells;
        //     const upstream = leftSide.size < rightSide.size ? leftSide : rightSide;
        //     self.postMessage({
        //         incrementalUpdate: true,
        //         flooded: Array.from(upstream),
        //         cellCount: upstream.size,
        //         leftSize: leftSide.size,
        //         rightSize: rightSide.size
        //     });
        // }

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

                // Partition this cell by which side of dam it's on
                const x = neighbor % width;
                const y = Math.floor(neighbor / width);
                const toCellX = x - damX1;
                const toCellY = y - damY1;
                const crossProduct = damVectorX * toCellY - damVectorY * toCellX;

                if (crossProduct > 0) {
                    leftSide.add(neighbor);
                } else if (crossProduct < 0) {
                    rightSide.add(neighbor);
                }

                queue.push(neighbor);

                // Check if this cell is on the boundary (has at least one non-flooded neighbor)
                const neighborNeighbors = getNeighbors(neighbor, width, height);
                for (let nn of neighborNeighbors) {
                    if (visited[nn] === 0 && data[nn] >= maxWaterLevel) {
                        // This cell borders a non-flooded cell - it's on the boundary
                        boundaryCells.add(neighbor);
                        break;
                    }
                }
            }
        }
    }

    const totalCells = leftSide.size + rightSide.size;

    if (iterations >= CONFIG.maxIterations) {
        debugLog(`WARNING: Reached iteration limit - left: ${leftSide.size}, right: ${rightSide.size}`);
    }

    debugLog(`Incremental flooding complete - left: ${leftSide.size}, right: ${rightSide.size}`);

    // Determine if this is a V-shaped valley (both sides are upstream) or one-sided valley
    const sizeRatio = Math.max(leftSide.size, rightSide.size) / Math.min(leftSide.size, rightSide.size);
    const isVShaped = sizeRatio < 4; // Both sides within 4x of each other = V-shaped valley

    let flooded, selectedName;
    if (isVShaped) {
        // V-shaped valley: both arms are legitimate upstream - keep both
        flooded = new Set([...leftSide, ...rightSide]);
        selectedName = "both sides (V-shaped valley)";
        debugLog(`V-shaped valley detected (size ratio ${sizeRatio.toFixed(1)}x) - keeping both sides`);
    } else {
        // One side clearly dominant: select smaller as upstream, reject larger as downstream
        flooded = leftSide.size < rightSide.size ? leftSide : rightSide;
        const downstream = leftSide.size < rightSide.size ? rightSide : leftSide;
        selectedName = leftSide.size < rightSide.size ? "left (confined)" : "right (confined)";
        debugLog(`One-sided valley (ratio ${sizeRatio.toFixed(1)}x) - selecting ${selectedName}`);
        debugLog(`Rejected ${downstream.size} cells from larger side`);
    }

    debugLog(`Final reservoir: ${flooded.size} cells from ${selectedName}`);
    debugLog(`Boundary cells: ${boundaryCells.size} (${((boundaryCells.size / flooded.size) * 100).toFixed(1)}% of total)`);

    return { flooded, barriers, boundary: boundaryCells };
}

/**
 * Resume incremental flood from saved state after DEM expansion
 * This avoids restarting from scratch - just continues where we left off
 */
function resumeIncrementalFlood(demData, damCells, crestElevation, resumeState) {
    const { width, height, data } = demData;

    debugLog(`Resuming flood: ${resumeState.leftSideCells.length} left, ${resumeState.rightSideCells.length} right, ${resumeState.queueCells.length} queued`);

    // Get/remap barriers (uses existing cache)
    const firstCell = damCells[0];
    const lastCell = damCells[damCells.length - 1];
    const elev1 = data[firstCell];
    const elev2 = data[lastCell];

    let barriers, damLevel, maxWaterLevel;

    if (cachedDamGeometry &&
        Math.abs(cachedDamGeometry.elev1 - elev1) < 0.1 &&
        Math.abs(cachedDamGeometry.elev2 - elev2) < 0.1) {
        // Reuse cached geometry
        damLevel = cachedDamGeometry.damLevel;
        maxWaterLevel = cachedDamGeometry.maxWaterLevel;
        barriers = remapBarrierToNewGrid(cachedDamGeometry.barrierOffsets, damCells, width, height);
        debugLog(`Reusing cached dam geometry: ${barriers.size} barrier cells`);
    } else {
        debugLog('ERROR: Dam geometry cache missing on resume - this should not happen');
        return { flooded: new Set(), barriers: new Set() };
    }

    // Create visited array and mark barriers
    const visited = new Uint8Array(width * height);
    for (let cell of barriers) {
        visited[cell] = 2; // 2 = barrier
    }

    // Remap queue cells from old grid to new grid
    const queue = new SimpleQueue();
    for (let oldCell of resumeState.queueCells) {
        const newCell = remapCellToNewGrid(oldCell, resumeState.oldDemData, demData);
        if (newCell !== null && visited[newCell] === 0) {
            queue.push(newCell);
            visited[newCell] = 1;
        }
    }

    // Remap left side cells
    const leftSide = new Set();
    for (let oldCell of resumeState.leftSideCells) {
        const newCell = remapCellToNewGrid(oldCell, resumeState.oldDemData, demData);
        if (newCell !== null) {
            leftSide.add(newCell);
            visited[newCell] = 1;
        }
    }

    // Remap right side cells
    const rightSide = new Set();
    for (let oldCell of resumeState.rightSideCells) {
        const newCell = remapCellToNewGrid(oldCell, resumeState.oldDemData, demData);
        if (newCell !== null) {
            rightSide.add(newCell);
            visited[newCell] = 1;
        }
    }

    debugLog(`Remapped state: queue=${queue.length}, left=${leftSide.size}, right=${rightSide.size}`);

    // Restore growth tracking
    let lastLeftSize = resumeState.lastLeftSize;
    let lastRightSize = resumeState.lastRightSize;
    let leftStagnant = resumeState.leftStagnant;
    let rightStagnant = resumeState.rightStagnant;
    let iterations = resumeState.iterations;

    // Calculate dam vector for partitioning (same as fresh start)
    const firstDamCell = damCells[0];
    const lastDamCell = damCells[damCells.length - 1];
    const damX1 = firstDamCell % width;
    const damY1 = Math.floor(firstDamCell / width);
    const damX2 = lastDamCell % width;
    const damY2 = Math.floor(lastDamCell / width);
    const damVectorX = damX2 - damX1;
    const damVectorY = damY2 - damY1;

    // Restore and remap boundary cells from previous state
    const boundaryCells = new Set();
    if (resumeState.boundaryCells) {
        for (let oldCell of resumeState.boundaryCells) {
            const newCell = remapCellToNewGrid(oldCell, resumeState.oldDemData, demData);
            if (newCell !== null) {
                boundaryCells.add(newCell);
            }
        }
        debugLog(`Restored ${boundaryCells.size} boundary cells from previous state`);
    }

    debugLog(`Continuing flood from iteration ${iterations} with ${queue.length} cells in queue`);

    // Continue the flood loop (identical to performIncrementalFlood)
    while (queue.length > 0 && iterations < CONFIG.maxIterations) {
        iterations++;

        if (iterations % CONFIG.progressUpdateInterval === 0) {
            const totalCells = leftSide.size + rightSide.size;
            debugLog(`Flooding: ${totalCells.toLocaleString()} cells, queue: ${queue.length}, left: ${leftSide.size}, right: ${rightSide.size}`);
            self.postMessage({
                progress: 0.1 + (iterations / CONFIG.maxIterations) * 0.8,
                status: `Flooding: ${totalCells.toLocaleString()} cells`
            });

            // Check if reservoir area exceeds reasonable limits (safety check for flat terrain)
            const cellAreaM2 = calculateCellArea(demData, damCells);
            const currentAreaKm2 = (totalCells * cellAreaM2) / 1000000;
            if (currentAreaKm2 > CONFIG.maxReservoirAreaKm2) {
                debugLog(`Reservoir area (${currentAreaKm2.toFixed(1)} km²) exceeds maximum (${CONFIG.maxReservoirAreaKm2} km²) - stopping`);
                self.postMessage({
                    error: `Computation stopped: Reservoir area reached ${currentAreaKm2.toFixed(1)} km² (limit: ${CONFIG.maxReservoirAreaKm2} km²). ` +
                           `This may indicate very flat terrain, a large valley, or incorrect dam placement. ` +
                           `Solutions: (1) Raise the dam crest elevation to reduce flooded area, ` +
                           `(2) Place the dam in a narrower section of the valley, or ` +
                           `(3) If this is a genuinely large valley, increase maxReservoirAreaKm2 in config.js.`
                });
                return null;
            }
        }

        // Check each side's growth separately to detect confined upstream vs runaway downstream
        if (iterations % CONFIG.layerCheckInterval === 0) {
            const leftGrowth = leftSide.size - lastLeftSize;
            const rightGrowth = rightSide.size - lastRightSize;
            const leftGrowing = leftGrowth > 0;
            const rightGrowing = rightGrowth > 0;

            const leftGrowthRate = lastLeftSize > 0 ? leftGrowth / lastLeftSize : 0;
            const rightGrowthRate = lastRightSize > 0 ? rightGrowth / lastRightSize : 0;

            const leftEffectivelyStagnant = !leftGrowing ||
                (rightGrowing && rightGrowth > leftGrowth * 10 && rightSide.size > leftSide.size * 5);
            const rightEffectivelyStagnant = !rightGrowing ||
                (leftGrowing && leftGrowth > rightGrowth * 10 && leftSide.size > rightSide.size * 5);

            if (leftEffectivelyStagnant) leftStagnant++;
            else leftStagnant = 0;

            if (rightEffectivelyStagnant) rightStagnant++;
            else rightStagnant = 0;

            // Debug growth rates
            if (debugMessageCount < CONFIG.maxDebugMessages && iterations % (CONFIG.layerCheckInterval * 10) === 0) {
                debugLog(`Growth check: left +${leftGrowth} (${(leftGrowthRate*100).toFixed(2)}%), right +${rightGrowth} (${(rightGrowthRate*100).toFixed(2)}%), left stagnant: ${leftStagnant}, right stagnant: ${rightStagnant}`);
            }

            // If one side is stagnant (confined) and other is still growing (runaway), select stagnant side
            if (leftStagnant >= 3 && rightGrowing) {
                debugLog(`Left side stagnant (growth: ${leftGrowth}, ${(leftGrowthRate*100).toFixed(1)}%) vs right growing (${rightGrowth}, ${(rightGrowthRate*100).toFixed(1)}%) - selecting left as upstream`);
                return { flooded: leftSide, barriers };
            }
            if (rightStagnant >= 3 && leftGrowing) {
                debugLog(`Right side stagnant (growth: ${rightGrowth}, ${(rightGrowthRate*100).toFixed(1)}%) vs left growing (${leftGrowth}, ${(leftGrowthRate*100).toFixed(1)}%) - selecting right as upstream`);
                return { flooded: rightSide, barriers };
            }

            // If both sides are stagnant, return smaller side
            if (leftStagnant >= 3 && rightStagnant >= 3) {
                const upstream = leftSide.size < rightSide.size ? leftSide : rightSide;
                debugLog(`Both sides stagnant - selecting smaller side (${upstream.size} cells) as upstream`);
                return { flooded: upstream, barriers };
            }

            lastLeftSize = leftSide.size;
            lastRightSize = rightSide.size;

            // Check if approaching edge - request expansion if needed
            const flooded = new Set([...leftSide, ...rightSide]);
            const edgeInfo = isApproachingEdge(flooded, width, height);
            if (edgeInfo) {
                debugLog(`Flooding approaching DEM edge again (left: ${leftSide.size}, right: ${rightSide.size}) - requesting expansion`);

                // Prepare state for another resumption
                const queueCells = queue.items.slice(queue.head);

                const newResumeState = {
                    queueCells: queueCells,
                    leftSideCells: Array.from(leftSide),
                    rightSideCells: Array.from(rightSide),
                    boundaryCells: Array.from(boundaryCells),
                    lastLeftSize: lastLeftSize,
                    lastRightSize: lastRightSize,
                    leftStagnant: leftStagnant,
                    rightStagnant: rightStagnant,
                    iterations: iterations,
                    oldDemData: {
                        width: width,
                        height: height,
                        minX: demData.minX,
                        minY: demData.minY
                    }
                };

                debugLog(`Saving state again: ${queueCells.length} queued, ${leftSide.size} left, ${rightSide.size} right, ${iterations} iterations`);

                self.postMessage({
                    needMoreDEM: true,
                    currentSize: flooded.size,
                    iterations: iterations,
                    edges: edgeInfo,
                    resumeState: newResumeState
                });
                return null;  // Signal expansion needed
            }
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

            // Flood all contiguous cells below the fixed water level
            if (neighborElev < maxWaterLevel) {
                visited[neighbor] = 1;

                // Partition this cell by which side of dam it's on
                const x = neighbor % width;
                const y = Math.floor(neighbor / width);
                const toCellX = x - damX1;
                const toCellY = y - damY1;
                const crossProduct = damVectorX * toCellY - damVectorY * toCellX;

                if (crossProduct > 0) {
                    leftSide.add(neighbor);
                } else if (crossProduct < 0) {
                    rightSide.add(neighbor);
                }

                queue.push(neighbor);

                // Check if this cell is on the boundary
                const neighborNeighbors = getNeighbors(neighbor, width, height);
                for (let nn of neighborNeighbors) {
                    if (visited[nn] === 0 && data[nn] >= maxWaterLevel) {
                        boundaryCells.add(neighbor);
                        break;
                    }
                }
            }
        }
    }

    const totalCells = leftSide.size + rightSide.size;

    if (iterations >= CONFIG.maxIterations) {
        debugLog(`WARNING: Reached iteration limit - left: ${leftSide.size}, right: ${rightSide.size}`);
    }

    debugLog(`Resumed flooding complete - left: ${leftSide.size}, right: ${rightSide.size}`);

    // Determine if this is a V-shaped valley (both sides are upstream) or one-sided valley
    const sizeRatio = Math.max(leftSide.size, rightSide.size) / Math.min(leftSide.size, rightSide.size);
    const isVShaped = sizeRatio < 4; // Both sides within 4x of each other = V-shaped valley

    let flooded, selectedName;
    if (isVShaped) {
        // V-shaped valley: both arms are legitimate upstream - keep both
        flooded = new Set([...leftSide, ...rightSide]);
        selectedName = "both sides (V-shaped valley)";
        debugLog(`V-shaped valley detected (size ratio ${sizeRatio.toFixed(1)}x) - keeping both sides`);
    } else {
        // One side clearly dominant: select smaller as upstream, reject larger as downstream
        flooded = leftSide.size < rightSide.size ? leftSide : rightSide;
        const downstream = leftSide.size < rightSide.size ? rightSide : leftSide;
        selectedName = leftSide.size < rightSide.size ? "left (confined)" : "right (confined)";
        debugLog(`One-sided valley (ratio ${sizeRatio.toFixed(1)}x) - selecting ${selectedName}`);
        debugLog(`Rejected ${downstream.size} cells from larger side`);
    }

    debugLog(`Final reservoir: ${flooded.size} cells from ${selectedName}`);
    debugLog(`Boundary cells: ${boundaryCells.size} (${((boundaryCells.size / flooded.size) * 100).toFixed(1)}% of total)`);

    return { flooded, barriers, boundary: boundaryCells };
}

/**
 * Find seed cells - adjacent to middle of dam on both sides
 * "Seeding can be anywhere - but the middle of the dam on both sides is good"
 */
function findValleyFloorSeeds(damCells, barriers, data, width, height, damLevel) {
    // Find middle point of original dam (not extended barrier)
    const midIndex = Math.floor(damCells.length / 2);
    const middleCell = damCells[midIndex];
    const midX = middleCell % width;
    const midY = Math.floor(middleCell / width);

    debugLog(`Seeding from middle of dam at cell (${midX}, ${midY})`);

    // Get all neighbors of the middle dam cell
    const neighbors = getNeighbors(middleCell, width, height);
    const seeds = [];

    for (let neighbor of neighbors) {
        // Skip if it's part of the barrier
        if (barriers.has(neighbor)) continue;

        const elevation = data[neighbor];

        // Skip no-data cells
        if (elevation <= CONFIG.noDataValue) continue;

        // Seed if below dam level (can be flooded)
        if (elevation < damLevel) {
            seeds.push(neighbor);
        }
    }

    debugLog(`Found ${seeds.length} seed cells adjacent to dam middle`);
    return seeds;
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
 * Extend dam from lower endpoint until hitting mountainside
 * User's algorithm:
 * - Highest extremity doesn't need extending (already on slope)
 * - Dam is level at height of highest extremity
 * - Extend only from lower extremity until hitting cell higher than dam level
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

    // Get elevations at dam endpoints
    const elev1 = data[firstCell];
    const elev2 = data[lastCell];

    // Dam level = highest endpoint (the one already on the slope)
    const damLevel = Math.max(elev1, elev2);

    debugLog(`Dam endpoint elevations: ${elev1.toFixed(1)}m, ${elev2.toFixed(1)}m`);
    debugLog(`Dam level (highest endpoint): ${damLevel.toFixed(1)}m`);

    // Extend only from the LOWER endpoint, along the dam line direction
    // This closes the gap between the lower endpoint and the valley wall
    let extendFromEnd1 = elev1 < elev2;  // true if endpoint 1 is lower
    let extCount = 0;
    let currentX = extendFromEnd1 ? x1 : x2;
    let currentY = extendFromEnd1 ? y1 : y2;

    // Extension direction: continue along the dam line from the lower endpoint
    // If extending from end1 (lower), go in opposite direction (backward from end1)
    // If extending from end2 (lower), go in same direction (forward from end2)
    const extDirX = extendFromEnd1 ? -dirX : dirX;
    const extDirY = extendFromEnd1 ? -dirY : dirY;

    debugLog(`Extending from ${extendFromEnd1 ? 'endpoint 1' : 'endpoint 2'} (lower end) at ${extendFromEnd1 ? elev1.toFixed(1) : elev2.toFixed(1)}m along dam line`);

    for (let i = 0; i < 1000; i++) {  // Max 1000 cells for large valleys
        currentX += extDirX;
        currentY += extDirY;

        const x = Math.round(currentX);
        const y = Math.round(currentY);

        // Check bounds
        if (x < 0 || x >= width || y < 0 || y >= height) break;

        const cell = y * width + x;
        const elevation = data[cell];

        // Stop if no-data
        if (elevation <= CONFIG.noDataValue) break;

        // Stop if next cell is higher than dam level (hit valley wall/slope)
        if (elevation > damLevel) {
            debugLog(`Hit valley wall after ${extCount} cells (elev: ${elevation.toFixed(1)}m > dam level ${damLevel.toFixed(1)}m)`);
            break;
        }

        barriers.add(cell);
        extCount++;
    }

    debugLog(`Dam extended: +${extCount} cells from lower endpoint (total ${barriers.size} barrier cells)`);

    return { barriers, damLevel };
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

