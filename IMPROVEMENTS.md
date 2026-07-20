# Geogizmos — Repository Review & Improvement Plan

Full-repository review performed 2026-07-19. Items are grouped by priority and
written so each can be implemented independently. Each item states **where**
(file:line as of this commit), **what is wrong**, and **how to fix it**.
Prefer one commit (or small commit series) per item ID so changes stay reviewable.

Priorities:

- **P1 — Correctness bugs**: user-visible wrong behaviour or wrong numbers.
- **P2 — Robustness**: failure paths, error handling, API-usage hygiene.
- **P3 — UX & accessibility**.
- **P4 — Code quality**: dead code, duplication, consistency.
- **P5 — Infrastructure, docs, deployment**.

---

## P1 — Correctness bugs

### P1.1 Inundator: flood worker ignores `config.js`; limits contradict docs and error messages

- **Where:** `Inundator/js/workers/flood-worker.js:26-37` (worker-local `CONFIG`),
  `Inundator/js/config.js:44-72` (`flood` section), `Inundator/README.md:262-280`.
- **Problem:** The worker defines its own constants. They disagree with `config.js`:
  worker `maxReservoirAreaKm2: 500` vs config `1000` (README also says 1000);
  worker `progressUpdateInterval: 50000` vs config `5000`; worker `maxDebugMessages: 100`
  vs config `performance.maxWorkerDebugMessages: 200`. Worst of all, the worker's own
  error message (flood-worker.js:361-366 and 675-679) tells the user to
  "increase maxReservoirAreaKm2 in config.js" — which has **no effect whatsoever**.
- **Fix:** Pass the needed config values into the worker with each job: in
  `InundatorApp.runFloodFill()` (`Inundator/js/app.js:418-440`) add a `config` field to the
  posted message containing `maxIterations`, `maxReservoirAreaKm2`, `progressUpdateInterval`,
  `maxDebugMessages`, `edgeProximityThreshold`, `layerCheckInterval`, `noDataValue`,
  `safetyMargin`, `minReservoirSize` sourced from `CONFIG`. In the worker, merge these over
  defaults at the top of the message handler. Move the flood-related values that currently
  only exist in the worker (`edgeProximityThreshold`, `layerCheckInterval`, `safetyMargin`,
  `areaSizeCheckInterval`) into `config.js`'s `flood` section, and delete the config entries
  that are dead (see P4.3). Align README numbers with the final values.

### P1.2 Inundator: statistics computed against a different water level than the flood used

- **Where:** `Inundator/js/app.js:353-355` (`crestElevation = maxElevation - safetyMargin`),
  `app.js:425` (`effectiveCrest = crestElevation * waterLevel`),
  `Inundator/js/workers/flood-worker.js:248-251` (`maxWaterLevel = damLevel - 1.0`, where
  `damLevel = max(endpoint elevations)` — the `crestElevation` argument is accepted but never
  used), `app.js:550-557` + `Inundator/js/core/statistics.js:32-45` (depth/volume computed
  from `this.crestElevation`).
- **Problem:** Three different water surfaces exist:
  1. The **flood algorithm** floods everything below `max(endpoint elev) - 1 m`.
  2. **Statistics** compute depth/volume against `max(sampled dam-line elev) - 5 m`.
  3. `effectiveCrest` multiplies an **absolute elevation ASL by 0.95**, which is physically
     meaningless (at 2000 m ASL that is 100 m below the crest) — and is then ignored by the
     worker anyway.
  Result: reported volume, max depth and average depth are systematically wrong relative to
  the simulated lake (off by ~4 m of water level with default settings, more in edge cases).
- **Fix:** Make the worker the single source of truth. Have it include the `maxWaterLevel` it
  actually used in its completion message; use that value in `Statistics.calculate` instead of
  `crestElevation`. Delete the `* this.waterLevel` multiplication and the
  `waterLevelSafetyFactor` config (or reinterpret it as freeboard **in meters** and feed it to
  the worker to replace the hard-coded `- 1.0`). Update `Inundator/README.md` §"Why Fixed
  Water Level?" to describe the final model.

### P1.3 Inundator: `extendDamToMountainside` returns the wrong shape on degenerate dams

- **Where:** `Inundator/js/workers/flood-worker.js:983-985` and `1003-1006`; caller at `248-251`.
- **Problem:** The normal return is `{ barriers, damLevel }`, but the `damCells.length < 2`
  branch returns `createDamBarrier(...)` (a bare `Set`) and the `len === 0` branch returns
  `barriers` (also a bare `Set`). The caller destructures `result.barriers` /
  `result.damLevel`, so `damLevel` becomes `undefined`, `maxWaterLevel` becomes `NaN`, every
  elevation comparison is false, and the app silently reports "No flooding detected".
- **Fix:** Return `{ barriers, damLevel }` from all paths (`damLevel = Math.max(data[firstCell],
  data[lastCell])`, or `data[damCells[0]]` for a single-cell dam).

### P1.4 Isosmfar: Overpass area ID assumes the Nominatim match is a relation

- **Where:** `Isosmfar/app.js:1627` — `const areaId = 3600000000 + Number.parseInt(this.selectedArea.osm_id);`
- **Problem:** Overpass derives area IDs as `3600000000 + id` **only for relations**; for ways
  it is `2400000000 + id`. Nominatim frequently returns ways (parks, campuses, some admin
  boundaries). For those, the query silently targets a nonexistent or wrong area and returns
  "No features found".
- **Fix:** Branch on `this.selectedArea.osm_type`: `'relation'` → `3600000000 + id`,
  `'way'` → `2400000000 + id`, anything else (e.g. `'node'`) → fall back to a bbox-based query
  (`node(south,west,north,east)` from `boundingbox`) or show a clear error asking the user to
  pick an administrative area. Add the same `osm_type` check to the fallback lookup inside
  `generate()` (app.js:1607-1625).

### P1.5 Isosmfar: distance scale is wrong away from the equator

- **Where:** `Isosmfar/app.js` fragment shader — the constant `40000.0` at lines 2125, 2153,
  2179, 2219, 2258; also the coalesce conversion `distanceKm / 111` in
  `Isosmfar/voronoi-worker.js:14`.
- **Problem:** Distances are computed in normalized Mercator units and converted with a flat
  `× 40000` km factor, which is only valid at the equator. Ground distance is
  `mercator × 40075 × cos(latitude)`. At 45°N the displayed "10 km" band is really ~7 km;
  at 60°N it is ~5 km. For a distance-field tool this is the headline number.
- **Fix:** Compute `cos(centerLat)` of the area (e.g. from `turf.center(boundary)` or the bbox
  midpoint) in `renderWebGL()`, pass it as a new uniform `u_cosLat`, and change the conversion
  to `distKm = sqrt(distSq) * 40075.0 * u_cosLat` (all four modes; also the
  `maxDistMerc = u_maxDistanceKm / (40075.0 * u_cosLat)` precomputation at line 2125).
  In `voronoi-worker.js` `coalescePoints`, scale the longitude delta by `cos(lat)` (use the
  mean latitude of the dataset) so coalescing distance is isotropic. Keep single-area accuracy
  in mind — a per-area constant latitude is fine; no per-pixel correction needed.

### P1.6 Isosmfar: broken icon and manifest references (404s)

- **Where:** `Isosmfar/index.html:19-20` (references `icons/icon-192.png`, `icons/icon-180.png`),
  `Isosmfar/manifest.json:11-22` (references `icons/icon-192.png`, `icons/icon-512.png`),
  actual files: `icons/favicon-32.png`, `icons/favicon-180.png`, `icons/favicon-192.png`.
- **Problem:** Only the 32 px favicon resolves. The PWA install icons and apple-touch icon are
  404s, and there is no 512 px icon at all. Additionally `manifest.json` `start_url` is
  `"Isosmfar.html"` — a meta-refresh redirect stub — so an installed PWA opens via a redirect.
- **Fix:** Rename the files to match the references (`icon-192.png`, `icon-180.png`), generate a
  512 px icon from the 192 px source (or drop the 512 entry), and set `"start_url": "./"`.
  Verify with Lighthouse's installability audit.

### P1.7 Isosmfar: duplicated URL-state initialization with falsy-value bugs

- **Where:** `Isosmfar/app.js:413-431` (constructor) vs `app.js:508-556` (`loadStateFromURL()`).
- **Problem:** The constructor parses URL params with `||` fallbacks, so
  `transparency=0`, `coalesce=0`, `voronoi=false` in a shared URL are discarded.
  `loadStateFromURL()` re-parses the same params correctly (`!== undefined`) during `init()`
  and overwrites the fields, masking the bug — but the duplication is confusing and only
  accidentally correct.
- **Fix:** Remove all URL parsing from the constructor; initialize fields from
  localStorage/defaults only, and let `loadStateFromURL()` remain the single URL reader.
  While there: `urlState.decode()` (app.js:217-234) number-coerces every numeric-looking
  string, so an area literally named "2000" would round-trip as a number — harmless today,
  but restrict numeric coercion to known-numeric keys (`lat`, `lng`, `zoom`, `radius`,
  `transparency`, `idwPower`, `heatBandwidth`, `coalesce`).

### P1.8 Inundator: unavailable IndexedDB silently produces an all-no-data DEM

- **Where:** `Inundator/js/core/elevation-service.js:23-40` (`TileDBCache.init` rejects),
  used at `:173` and `:327`.
- **Problem:** If IndexedDB is unavailable (private browsing, storage blocked), `init()`
  rejects, every `dbCache.get()` rejects, the per-tile `catch` classifies that as a tile
  failure, and the entire DEM is filled with `noDataValue` — **the network is never tried**.
  Isosmfar's `CacheDB` (Isosmfar/app.js:256-277) already handles this correctly by resolving
  `null`.
- **Fix:** Mirror the Isosmfar behaviour: resolve `null`/no-op on init, get, and put failures
  so the code falls through to the network fetch. Keep a one-time `console.warn`.

### P1.9 Inundator: object-URL leak for every decoded tile

- **Where:** `Inundator/js/core/elevation-service.js:450-469` (`loadImageData`).
- **Problem:** `img.src = URL.createObjectURL(blob)` is never revoked. A single computation
  fetches hundreds to thousands of tiles; each leaks a blob URL (and pins the blob) for the
  page's lifetime.
- **Fix:** `const url = URL.createObjectURL(blob)`, then `URL.revokeObjectURL(url)` in both
  `onload` (after `drawImage`) and `onerror`.

### P1.10 Inundator: flood polygon keeps only the largest ring — islands and secondary basins vanish

- **Where:** `Inundator/js/core/polygon-generator.js:78-91` (`geoRings.sort(...); coordinates: [geoRings[0]]`).
- **Problem:** d3-contour returns full MultiPolygon topology (outer rings + holes). The code
  flattens all rings, keeps only the largest, and discards the rest. Consequences: islands
  inside the reservoir are painted as water; in V-shaped valleys where the worker keeps both
  arms, disconnected parts disappear; and `turf.area(polygon)` (used for the "Surface area"
  stat) disagrees with the cell-count-based volume.
- **Fix:** Preserve the contour's nesting: transform `contour.coordinates` ring-by-ring with the
  existing `transformRingsToGeo` math but keep the `[polygon][ring]` structure, and emit a
  `MultiPolygon` feature. Drop only degenerate rings (< `minPolygonPoints`). Simplify with
  `turf.simplify` on the whole geometry. Update `Statistics.calculate` — nothing to change
  there once the polygon is correct, since `turf.area` handles holes.

### P1.11 Inundator: progress bar barely moves during flooding

- **Where:** `Inundator/js/workers/flood-worker.js:351` and `:665` —
  `progress = 0.1 + (iterations / CONFIG.maxIterations) * 0.8` with `maxIterations = 20_000_000`.
- **Problem:** A typical flood runs well under 2 M iterations, so the bar sits below ~15 %
  for the whole computation, then jumps to done.
- **Fix:** Progress against a meaningful denominator is impossible to know in advance, so make
  the in-flood phase visually honest instead: either switch the bar to an indeterminate
  animation during flooding (CSS), or normalize against a running estimate such as
  `min(0.95, cells / (maxReservoirAreaKm2 * 1e6 / cellAreaM2))`. Keep the tile-fetch phase
  (0 → 0.5) as is, and rescale the flood phase to 0.5 → 1.0 (currently fetch uses 0→0.5 but
  flood restarts at 0.1, so the bar jumps backwards).

### P1.12 Isosmfar: features beyond the GPU cap are silently ignored by the field

- **Where:** `Isosmfar/app.js:2315` (`Math.min(features.length, CONFIG.MAX_FEATURES)` — 5000
  desktop / 1000 mobile), while the dot layer (app.js:2486-2510) renders **all** features.
- **Problem:** For dense queries (e.g. `amenity=restaurant` over a country) the gradient uses
  only the first N features in Overpass result order (which is spatially biased — grouped by
  type and location), while every dot still renders. The field is visibly wrong with no
  warning.
- **Fix:** When `features.length > CONFIG.MAX_FEATURES`: (a) sample uniformly at random rather
  than truncating (`for` loop with stride or reservoir sampling), and (b) call
  `this.showMessage(...)` telling the user how many of the total features are used in the
  gradient. Consider capping the dot layer the same way for consistency.

---

## P2 — Robustness & API hygiene

### P2.1 Nominatim autocomplete violates the usage policy

- **Where:** `Isosmfar/app.js:1174-1186` and `Inundator/js/app.js:121-134` — search-as-you-type
  against `nominatim.openstreetmap.org` with a 300 ms debounce.
- **Problem:** The [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/)
  explicitly disallows autocomplete and requires ≤ 1 req/s. Both apps are public deployments.
- **Fix (pick one):** (a) trigger search only on Enter/blur instead of on input;
  (b) raise the debounce to ≥ 1000 ms *and* only fire when input has settled;
  (c) switch the autocomplete to a service that permits it (e.g. Photon,
  `https://photon.komoot.io/api/?q=...`) and keep Nominatim only for the final one-shot
  lookup in `generate()`. Option (c) preserves UX best. Apply the same choice to both apps.

### P2.2 OSM attribution is malformed

- **Where:** `Isosmfar/app.js:901, 945, 950, 954` — `attribution: '© Openstreetmap'`.
- **Problem:** OSM's attribution requirement is "© OpenStreetMap contributors" with a link to
  openstreetmap.org/copyright. Also relevant for the tile usage policy of tile.openstreetmap.org.
- **Fix:** Use `'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'`
  in all Isosmfar basemap definitions (MapLibre renders HTML in attributions). Inundator's
  config (`Inundator/js/config.js:124-140`) should get the same treatment; also add elevation
  data attribution there (Terrarium tiles: "Elevation data: Mapzen/Amazon terrain tiles —
  SRTM, USGS, and others"), e.g. appended to the basemap attribution or as a
  `map.addControl(new AttributionControl(...))` entry.

### P2.3 Unpinned CDN dependencies without SRI

- **Where:** `Isosmfar/index.html:246-248`, `Isosmfar/voronoi-worker.js:4-7`,
  `Inundator/index.html:120-123`.
- **Problem:** Loading `maplibre-gl@5`, `@turf/turf@7`, `d3-*@N` floats on the latest minor
  release. This repo has already been broken by exactly this (see commit d7b9cc9 "use
  defaultProjectionData.mainMatrix per v5 API"). No `integrity` attributes either, so the CDN
  is fully trusted.
- **Fix:** Pin exact versions (e.g. `maplibre-gl@5.x.y`) in all six locations and add
  `integrity` + `crossorigin="anonymous"` attributes to the `<script>`/`<link>` tags (jsDelivr
  serves SRI hashes; workers' `importScripts` can't do SRI — at least pin exact versions
  there). Document the chosen versions in the READMEs.

### P2.4 Missing worker `error` handlers

- **Where:** `Isosmfar/app.js:392-401` (voronoiWorker: `onmessage` only),
  `Inundator/js/app.js:95-117` (floodWorker: `message` listener only).
- **Problem:** If the worker script fails to load or throws outside the try/catch (e.g. CDN
  failure inside `importScripts` for the Voronoi worker), the app silently does nothing.
- **Fix:** Add `worker.onerror` handlers that log and surface `showMessage('...', 'error')`.

### P2.5 Inconsistent fetch hygiene

- **Where:**
  - `Isosmfar/app.js:1607-1613`: the area lookup inside `generate()` uses a raw `fetch` with no
    `response.ok` check and no retry, unlike `searchArea()` (1259-1280) which has both.
  - `Inundator/js/app.js:217-228`: `searchLocation()` — no `response.ok` check; failures only
    hit the console.
  - `Inundator/js/core/elevation-service.js:176-180`: `getElevationAtPoint()` uses raw `fetch`
    with no `ok` check and no retry, while `fetchDEMData` uses `fetchTileWithRetry`.
- **Fix:** Route all three through the existing retry helpers (`retryWithBackoff` in Isosmfar,
  `fetchTileWithRetry` in Inundator) and check `response.ok` before consuming the body.
  In Isosmfar, also make the `display_name.includes(areaName)` staleness check at 1607
  case-insensitive.

### P2.6 `showMessage` renders interpolated text as HTML

- **Where:** `Isosmfar/app.js:2601-2607`, `Inundator/js/app.js:657-663`.
- **Problem:** `messages.innerHTML = `<div ...>${text}</div>`` — `text` regularly includes
  `error.message`, which can echo remote API response fragments. Low practical risk, but it's
  a needless injection surface and it also breaks on messages containing `<`.
- **Fix:** Build the div with `document.createElement` and set `textContent`.

### P2.7 Isosmfar: `alert()` used for error surfacing

- **Where:** `Isosmfar/app.js:919` (WebGL context lost) and `app.js:1721-1724` (mobile error path).
- **Problem:** Blocking alerts, double-reporting (message + status + alert).
- **Fix:** Drop the alerts; make the status bar / message area sufficiently prominent on mobile
  (e.g. an `error` style with higher contrast and longer `MESSAGE_TIMEOUT_MS` for errors).

### P2.8 Isosmfar: retry helper discards the original error

- **Where:** `Isosmfar/app.js:161` — `throw new Error('Failed after N attempts: ' + lastError.message)`.
- **Fix:** `throw new Error(\`Failed after ${maxRetries + 1} attempts: ${lastError.message}\`, { cause: lastError })`
  so console traces keep the original stack/status.

---

## P3 — UX & accessibility

### P3.1 Isosmfar custom sliders are mouse-only and not accessible

- **Where:** `Isosmfar/app.js:1000-1088` (`mousedown`/`mousemove`/`mouseup` on document),
  markup in `Isosmfar/index.html:135-215`.
- **Problem:** The five custom sliders (distance, transparency, IDW power, heat bandwidth,
  coalesce) cannot be dragged by touch — on the same mobile devices the app has special memory
  handling for — and cannot be operated by keyboard at all. No ARIA roles.
- **Fix:** Switch to Pointer Events: `pointerdown` on the cursor with
  `setPointerCapture(e.pointerId)`, `pointermove`/`pointerup` handlers (this collapses the
  three mouse handlers and adds touch/pen for free). Add `role="slider"`, `tabindex="0"`,
  `aria-valuemin/max/now`, `aria-label` to each cursor, and arrow-key handling
  (←/→ step, Home/End for extremes) that reuses the same value-update code paths.
  Structure the fix as one shared `makeSlider(cursorEl, trackEl, onChange)` helper to replace
  the five near-identical `mousedown` registrations and the `type`-switch in the document
  `mousemove` handler.

### P3.2 Isosmfar mode toggle uses divs, not buttons

- **Where:** `Isosmfar/index.html:78-81` (`.toggle-button` divs), handler `app.js:703-726`.
- **Fix:** Change to `<button type="button">` elements (CSS reset to keep visuals), which
  restores keyboard focus/activation for free. Add `aria-pressed` toggling.

### P3.3 Dropdowns without keyboard navigation

- **Where:** Isosmfar area dropdown (`app.js:1282-1305` — the query dropdown at 1209-1236
  *has* arrow-key support, the area one doesn't), Inundator location dropdown
  (`Inundator/js/app.js:230-253`).
- **Fix:** Factor Isosmfar's existing keydown logic (ArrowUp/Down/Enter/Escape +
  `.selected` class + `scrollIntoView`) into a reusable helper and apply to both dropdowns.

### P3.4 Landing page mis-describes Isosmfar

- **Where:** `/index.html:114-118` — "Isochrone and accessibility mapping … travel time
  polygons and service area analysis".
- **Problem:** Isosmfar computes straight-line distance/density fields, not isochrones or
  travel times. Visitors arrive with wrong expectations.
- **Fix:** Reuse the accurate description from `Isosmfar/index.html:8` ("Visualize distance,
  density and Voronoi fields as heatmaps from OpenStreetMap data").

### P3.5 Inundator has no favicon

- **Where:** `Inundator/index.html` head.
- **Fix:** Add at least a 32 px favicon (and ideally 180/192 px icons) — reuse the Isosmfar
  icon pipeline. Removes the perpetual `/favicon.ico` 404 and gives the tab an identity.

---

## P4 — Code quality

### P4.1 flood-worker.js: ~250 lines of dead code

- **Where:** `Inundator/js/workers/flood-worker.js:899-941` (`partitionByDamSide`),
  `1072-1148` (`identifyWaterBodies`), `1155-1174` (`checkSidesMerged`),
  `1248-1274` (`isApproachingEdge` — superseded by `isApproachingEdgeFromCounters`).
- **Fix:** Delete all four functions (verified: zero call sites). Also delete the commented-out
  incremental-visualization block at 481-493 and its now-unreachable receiver
  `updateIncrementalVisualization` in `Inundator/js/app.js:519-529` plus its dispatch at
  `app.js:109-110` — or re-enable the feature end-to-end; don't keep half of it.

### P4.2 flood-worker.js: `performIncrementalFlood` and `resumeIncrementalFlood` duplicate the entire flood loop

- **Where:** `Inundator/js/workers/flood-worker.js:221-574` vs `580-857` — the
  `while (queue.length > 0 ...)` loop bodies (progress reporting, area check, stagnation
  logic, edge-expansion state capture, neighbour propagation, and final V-shaped-valley
  selection) are ~200 duplicated lines that have already begun to drift.
- **Fix:** Extract a single `runFloodLoop({ demData, damCells, visited, queue, counters,
  maxWaterLevel, barriers, ... })` used by both entry points; keep `perform*` responsible for
  seeding/geometry and `resume*` for state remapping only. Behaviour must be identical —
  a good candidate for adding the first worker unit tests (see P5.1) before refactoring.

### P4.3 Inundator `config.js`: dead sections

- **Where:** `Inundator/js/config.js:44-72` (`flood.*` — including the whole `selection`
  scoring-weights block left over from the removed water-body scorer), `150-157`
  (`performance.*`). Verified unused by the main thread; the worker has its own constants.
- **Fix:** Together with P1.1: keep (and actually wire) `maxIterations`,
  `maxReservoirAreaKm2`, progress/debug intervals; delete `selection.*`, `seedSearchRadius`,
  `minBodySize`, `maxBodySize`, `connectivity` unless re-wired. Update the README
  "Configuration" section (README.md:298-306) accordingly.

### P4.4 Isosmfar: dead code and unwired constants

- **Where / fix (all in `Isosmfar/app.js`):**
  - `CONFIG.WEBGL_CONTEXT_OPTIONS` (23-28): never used — either pass into the MapLibre map
    creation (`initMap`, 889-912) or delete.
  - `CONFIG.DEFAULT_RADIUS_PERCENT` (31): duplicated as literal `0.12` at 1660 — use the constant.
  - `CONFIG.MIN_DISTANCE_KM` (32): duplicated as `0.01` literals at 1657, 1661, 1670 — use it.
  - `CONFIG.SEARCH_DEBOUNCE_MS` (39): duplicated as `300` at 1185 and 1205 — use it.
  - `CONFIG.PALETTE_INTERPOLATION_STEPS` (46): `17` hard-coded at 2391-2403 — use it.
  - `CONFIG.STORAGE_KEYS.LAST_QUERY` (55, written at 694-696): never read — delete, or read it
    to prefill the query input on first visit (pick one; prefilling is the nicer option).
  - `this.computedMaxDistance` (432, 1667): written, never read — delete.
  - `updateProgress()` method (2591-2594): never called — delete (or wire real progress into
    `generate()`; deleting is fine, the status text already covers it).
- Also: the main thread loads d3-delaunay (`Isosmfar/index.html:248`) and checks for it
  (`app.js:2636-2639`) but no longer uses it — Voronoi runs in the worker, which
  `importScripts` its own copy. Remove the script tag and the check.

### P4.5 Isosmfar: `app.js` is one 2700-line file indented by 8 spaces

- **Where:** whole of `Isosmfar/app.js` (a relic of extraction from an inline `<script>`).
- **Fix (incremental, low risk first):**
  1. Re-indent to column 0 (pure whitespace commit, easy to review with `-w`).
  2. Optionally split into ES modules mirroring Inundator's layout (`config.js`, `utils.js`
     — debounce/throttle/retry/storage/urlState/CacheDB —, `gradient-layer.js` for the WebGL
     custom layer, `app.js` for the controller) and load with
     `<script type="module">`. The README already (falsely) claims "ES6 modular design"
     (Isosmfar/README.md:97) — this would make it true. Do this only after P1/P2 items so the
     diffs stay reviewable.

### P4.6 Inundator: global `console.warn` monkey-patch

- **Where:** `Inundator/js/ui/map-manager.js:21-30`.
- **Problem:** Permanently replaces `console.warn` for the entire page to hide one MapLibre
  deprecation message — this can swallow unrelated warnings from any code.
- **Fix:** Delete the patch. If the noise is unbearable, check whether the current pinned
  MapLibre version still emits it (the referenced deprecation may be gone by v5.x) — the
  right fix is upstream/version, not console surgery.

### P4.7 Cross-app duplication (acknowledged trade-off)

- **Where:** mobile hamburger menu (Isosmfar `app.js:2661-2702` vs Inundator `app.js:174-214`),
  message/status/dropdown UI helpers, and large parts of the two stylesheets.
- **Note:** The two apps are intentionally standalone, so duplication is tolerable. If a third
  gizmo is added, extract a `shared/` directory (menu, dropdown, status bar, message area, CSS
  custom properties). Not urgent — record the decision in the root README (P5.4) instead of
  refactoring now.

---

## P5 — Tests, tooling, deployment, docs

### P5.1 No tests — start with the pure functions

- **Problem:** Zero automated tests in a repo with genuinely tricky logic (grid remapping,
  tile math, Overpass filter parsing, union-find coalescing).
- **Fix:** Add `package.json` with `"type": "module"` at repo root (or per-app), use the
  built-in `node:test` runner — no dependencies needed. Highest-value first:
  - **Inundator:** `remapCellToNewGrid` / `remapCellSet` / `remapBarrierToNewGrid` and
    `SimpleQueue` (export them from the worker file — workers tolerate `export` statements
    when also loaded as modules, or move them into an importable
    `js/workers/flood-core.js` that the worker imports); `ElevationService.decodeTerrarium`,
    `lngToTileX`/`latToTileY` round-trips; `Statistics.calculate` with a synthetic DEM;
    `PolygonGenerator.transformRingsToGeo`.
  - **Isosmfar:** `coalescePoints` (voronoi-worker), `processOverpassFilter` (lots of
    input-shape cases: bare `key=value`, `and` lists, comma lists, pre-bracketed, colon keys),
    `extractCurrentTag`, `parseCSV`, `urlState.encode/decode` (needs the P4.5 module split, or
    temporarily test via copy — prefer the split).
  - Wire into CI (see P5.3).
- **Regression guard:** write the P4.2 loop-extraction tests *before* that refactor.

### P5.2 No linting

- **Fix:** Add ESLint (flat config, `eslint:recommended` + browser/worker globals), one config
  at repo root covering both apps. Fix or explicitly disable what it finds. Add
  `npm run lint`.

### P5.3 CI: add a checks workflow

- **Fix:** New `.github/workflows/ci.yml` on pushes and PRs: `npm ci` (or nothing if
  dependency-free), `npm run lint`, `node --test`. Fast, no browser needed.

### P5.4 Add a root README

- **Problem:** The repository has no root `README.md`; the GitHub landing page shows a bare
  file list.
- **Fix:** Short README: one paragraph per gizmo with screenshot thumbnail + live link
  (`https://liotier.github.io/Geogizmos/Inundator/`, `.../Isosmfar/`), link to per-app
  READMEs, license note (Unlicense), and a line about the deploy workflows.

### P5.5 Deploy workflows

- **Where:** `.github/workflows/deploy-preview.yml`, `deploy-production.yml`.
- **Fixes:**
  1. **Stale previews accumulate forever** (`keep_files: true`): add a cleanup workflow on
     `delete` (branch) / PR close that removes `preview/<safe_branch>` from the `gh-pages`
     branch.
  2. **Preview index is misleading:** it is rewritten on every push to list only the current
     branch. Either generate the list from the actual `preview/*` directories on gh-pages, or
     drop the index page entirely (the PR comment already carries the URL).
  3. **Preview links only Isosmfar:** include Inundator (both in the index page and the PR
     comment).
  4. **Screenshot payload:** `rsync`/`cp` currently ship ~11 MB of screenshots into every
     preview and into production. Add `--exclude='*.png' --exclude='*.jpg'` for the
     screenshots (careful: `Isosmfar/icons/*.png` must still deploy — exclude by explicit
     filename or move screenshots to a `docs/` folder excluded wholesale). See also P5.6.
  5. **Action version:** `peaceiris/actions-gh-pages@v3` → `@v4`.

### P5.6 Screenshot weight and filenames

- **Where:** `Inundator/Screenshot_2025-11-20_...png` (7.2 MB!),
  `Isosmfar/Screenshot 2025-09-11 at 17-23-08 ....png` (3.3 MB, spaces in filename),
  `Isosmfar/Isosmfar_screenshot.jpg` (454 KB).
- **Fix:** Recompress both PNGs to web-appropriate sizes (≤ 300 KB JPEG/WebP is plenty for
  og:image at 1200×630). Keep one screenshot per app; give it a space-free name; update the
  `og:image` references (`Inundator/index.html:16`, `Isosmfar/index.html:15`) and the
  READMEs. Note: git history keeps the old blobs; that's fine, just stop the bleeding.

### P5.7 README accuracy

- **Where / fixes:**
  - `Isosmfar/README.md:91` claims "Service Worker implementation for offline functionality"
    and the whole "Offline Usage" section (173-181) claims the app "works completely offline"
    — but Service Worker registration was **removed** (see the explanatory comment at
    `Isosmfar/app.js:2610-2617`). Rewrite: caching is IndexedDB (API results, 7 days) +
    localStorage (preferences); the app needs the network for tiles and any new query. Also
    drop/adjust the "Install as PWA … for offline access" bullet (161) and "Progressive Web
    App architecture with … service worker" (103).
  - `Isosmfar/README.md:97` "ES6 modular design" — false until P4.5 step 2; reword or do the split.
  - `Isosmfar/README.md:85` "Dynamic level-of-detail – processes only visible area at current
    zoom" — nothing in the code does this; delete the bullet.
  - `Inundator/README.md:262-280` — align the 1000 km² claims with the value actually enforced
    after P1.1.
  - `Isosmfar/index.html:26-52` schema.org block: `"image"` points to a GitHub **blob page**
    (HTML, with `%20`-escaped spaces), not an image — point it at the same asset as `og:image`;
    `softwareVersion: "1.4"` is unmaintained — remove it or maintain it.

### P5.8 Performance opportunities (optional, measurable wins)

  - **Inundator edge detection scans the whole grid:**
    `isApproachingEdgeFromCounters` (`flood-worker.js:1212-1246`) is O(width×height) and runs
    every `layerCheckInterval` (5000) iterations — on a 40-tile grid that's a ~100 M-element
    scan repeated dozens of times. Replace with an O(1) incremental check: when flooding a
    neighbour (lines 500-539 / 784-822), test its x/y against the threshold bands and set
    `edges.west/east/north/south` flags directly. Delete the scan.
  - **Polygon grid allocation:** `polygon-generator.js:22` uses `new Array(width*height).fill(0)`
    (boxed doubles, ~8× memory of need at 100 M cells max) — use `Uint8Array`; d3-contours
    accepts array-likes.
  - **Isosmfar boundary test per fragment:** the point-in-polygon loop (shader, up to 4096
    vertices per fragment) dominates fill-rate on large areas. Optional: render the boundary
    polygon once into a mask texture (or stencil buffer) at layer-add time and sample it —
    turns O(vertices) per fragment into O(1). Bigger change; only if profiling justifies it.

---

## Suggested implementation order

1. **P1.1–P1.3** (Inundator numbers users see: config wiring, water level, degenerate dams) —
   these interact, do them together.
2. **P1.4–P1.7** (Isosmfar correctness: area id, latitude scale, icons, URL state).
3. **P1.8–P1.12** (cache fallback, URL leak, polygon holes, progress, feature cap).
4. **P2.x** robustness batch (mostly mechanical).
5. **P5.1/P5.2/P5.3** (tests + lint + CI) — before the larger refactors so they're guarded.
6. **P4.1–P4.4** dead-code removal (trivially safe once tests exist).
7. **P4.2** flood-loop extraction, **P4.5** Isosmfar re-indent/modularization.
8. **P3.x** UX/accessibility, **P5.4–P5.7** docs & deploy.
