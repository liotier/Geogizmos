# Inundator

Interactive reservoir inundation visualization tool. Draw a dam on a map and simulate the resulting reservoir using Digital Elevation Model (DEM) data.

## Features

- **Interactive Dam Drawing**: Click two points on the map to define a dam line
- **Automatic Crest Elevation**: Calculates optimal dam height from terrain data with 95% fill level safety factor
- **Physics-Based Flooding**: Simulates water accumulation following natural topography
- **Dynamic DEM Expansion**: Automatically expands terrain data for massive valley lakes (up to 100km radius)
- **Real-time Visualization**: See the reservoir extent on the map with semi-transparent water overlay
- **Reservoir Statistics**: Surface area, volume, depth metrics, and dam length
- **Multiple Basemaps**: OpenTopoMap (with contour lines), OpenStreetMap, or satellite imagery
- **Export Options**: Save results as PNG images or GeoJSON files
- **Location Search**: Built-in geocoding to find valleys and dam sites worldwide

## Architecture

The application uses a modular ES6 architecture:

```
Inundator/
├── index.html              # Main HTML page
├── css/
│   └── styles.css          # Application styles
└── js/
    ├── config.js           # Configuration parameters
    ├── app.js              # Main application controller
    ├── core/               # Core functionality modules
    │   ├── elevation-service.js    # DEM tile fetching
    │   ├── dam-geometry.js         # Dam line operations
    │   ├── polygon-generator.js    # Flood polygon creation
    │   └── statistics.js           # Metrics calculation
    ├── ui/                 # User interface modules
    │   ├── map-manager.js          # MapLibre GL map handling
    │   └── visualization.js        # Map layer rendering
    └── workers/
        └── flood-worker.js         # Flood algorithm (Web Worker)
```

## Flood Algorithm

The algorithm uses a physics-based approach with priority queue optimization:

1. **Dam Extension**: Extends dam line to valley walls (terrain above crest elevation)
2. **Seed Identification**: Finds valley bottom locations on each side of the dam
3. **Priority Queue Flooding**: Water spreads from lowest elevations first using a min-heap
4. **Water Level Tracking**: Maintains maximum elevation in flow path to prevent uphill flooding
5. **Connected Component Analysis**: Identifies separate water bodies
6. **Upstream Selection**: Multi-factor scoring based on valley floor elevation, average elevation, edge proximity, and confinement
7. **Dynamic Expansion**: Monitors edge proximity and automatically requests larger terrain data when needed

The algorithm correctly handles:
- Complex valley topography
- Multiple depressions behind a dam
- Natural barriers (ridges, hills)
- Massive valley lakes (millions of cells)
- Automatic distinction between upstream reservoir and downstream river

## Configuration

All tunable parameters are in `js/config.js`:

- **DEM Settings**: Initial buffer (10km), maximum buffer (100km), zoom levels, tile limits
- **Flood Algorithm**: Iteration limits (20M), seed search radius, water body scoring weights, edge proximity detection
- **Dam Parameters**: Safety factor (95% fill level), sampling intervals
- **Visualization**: Colors, opacity, simplification tolerance
- **Map Settings**: Default location, basemaps, zoom limits

## Usage

### Basic Workflow

1. **Search Location**: Enter a valley or dam site name in the location search box
2. **Draw Dam**: Click "Draw dam line" and place two points across the valley
3. **Compute**: Click "Compute inundation" to run the flood simulation
4. **Explore**: Use the basemap selector to view with different backgrounds (topographic contours, satellite, etc.)
5. **Export**: Save the result as PNG image or GeoJSON file

The application automatically:
- Calculates optimal crest elevation from terrain along dam line
- Applies 95% fill level safety factor
- Extends dam to valley walls to prevent leakage
- Expands terrain data if lake approaches initial boundary
- Selects upstream reservoir (excluding downstream areas)

### Interaction

- **Pan**: Click and drag the map
- **Zoom**: Mouse wheel or pinch gesture
- **Draw**: Click two points to define dam endpoints
- **Clear**: Remove existing dam to start over
- **Basemap**: Switch between topographic, standard, or satellite views

## Development

### Running Locally

The application uses ES6 modules, which require a web server:

```bash
# Python 3
python -m http.server 8000

# Node.js (http-server)
npx http-server

# PHP
php -S localhost:8000
```

Then open http://localhost:8000/Inundator/

### Deployment

The application automatically deploys to GitHub Pages when changes are pushed to the `main` branch. See `.github/workflows/deploy-inundator.yml` for the deployment configuration.

### Debugging

Open browser console (F12) to see detailed algorithm output:
- DEM fetch progress and dimensions
- Crest elevation calculation
- Seed cell identification
- Flooding progress (iterations, queue size, cells flooded)
- DEM expansion requests
- Water body detection and scoring
- Final statistics

### Adding Features

The modular architecture makes it easy to extend:

- **New DEM Sources**: Modify `ElevationService` class in `core/elevation-service.js`
- **Algorithm Improvements**: Enhance `flood-worker.js` (runs in separate thread)
- **Visualization Styles**: Extend `Visualization` class in `ui/visualization.js`
- **Additional Statistics**: Add calculations to `Statistics` class in `core/statistics.js`
- **UI Components**: Update `app.js` for new controls

## Performance

- **Web Workers**: Computation runs in background thread (UI remains responsive)
- **Min-Heap Priority Queue**: O(log n) performance for flood propagation
- **Progressive Loading**: DEM tiles fetched only as needed
- **Dynamic Expansion**: Starts with small area, expands on demand
- **Optimized Progress Updates**: Only every 100K iterations to minimize overhead

Typical computation times:
- Small reservoir (~1 km²): < 1 second
- Medium reservoir (~10 km²): 2-5 seconds
- Large reservoir (~100 km²): 10-30 seconds
- Massive valley lake (>500 km²): 30-120 seconds with multiple expansions

## Dependencies

- **MapLibre GL JS**: Map rendering (v3.6.2)
- **Turf.js**: Geospatial operations (v6)
- **D3 Arrays & Contours**: Marching squares algorithm for polygon generation (v3-4)

All dependencies are loaded from CDN.

## Data Sources

- **Base Maps**:
  - OpenTopoMap (topographic with contour lines)
  - OpenStreetMap (standard map)
  - Esri World Imagery (satellite)
- **Elevation Data**: AWS Terrain Tiles in Terrarium format (~30m resolution)
- **Geocoding**: Nominatim (OpenStreetMap)

## Capabilities

- **Maximum Lake Size**: Up to 2 million cells (~600+ km² at zoom 13)
- **DEM Coverage**: 10km initial radius, expands to 100km if needed
- **Iteration Limit**: 20 million iterations for complex flooding
- **Tile Capacity**: Up to 40×40 tiles (1,600 tiles) per computation
- **Grid Size**: Up to 100 million cells (10,000×10,000 at maximum)

## Known Limitations

- **DEM Resolution**: ~30m (depends on zoom level and latitude)
- **Simplified Hydraulics**: Static water level, no flow dynamics or wave action
- **No Temporal Variation**: Single snapshot, not time-series
- **Edge Cases**: Very narrow gorges or highly complex multi-basin topography may require parameter tuning
- **Tile Server Load**: Very large expansions (>80km) may take time to fetch all tiles

## Future Enhancements

### Potential Features

1. **Multiple Dams**: Support cascading reservoirs in a watershed
2. **Elevation Profile**: Cross-section view showing reservoir depth
3. **3D Visualization**: Terrain rendering with water surface
4. **Scenario Comparison**: Overlay multiple dam heights or locations
5. **Sedimentation Modeling**: Estimate capacity loss over time
6. **Flood Risk Analysis**: Downstream inundation from dam failure scenarios
7. **Optimization Tool**: Suggest optimal dam placement for storage or power generation

### Technical Improvements

1. **TypeScript**: Add type safety and better IDE support
2. **Unit Tests**: Automated testing for core modules
3. **Custom DEM Sources**: Support user-uploaded elevation data
4. **Offline Support**: Service worker for offline operation
5. **WebAssembly**: Port critical algorithms for better performance

## Support

For issues or questions:

1. Check the configuration parameters in `js/config.js`
2. Open browser console (F12) to see detailed debug output
3. Review worker messages for algorithm insights
4. File an issue on GitHub with:
   - Location name and coordinates
   - Dam line coordinates
   - Console output (especially worker messages)
   - Screenshot if applicable
   - Expected vs actual behavior

## License

This is an open-source educational/research tool. See the main repository LICENSE file.

## Credits

Developed as an experimental tool for reservoir simulation and hydrological analysis.
