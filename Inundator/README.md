# Inundator

Interactive reservoir inundation visualization tool. Draw a dam on a map and simulate the resulting reservoir using Digital Elevation Model (DEM) data.

## Features

- **Interactive Dam Drawing**: Click two points on the map to define a dam line
- **Automatic Crest Elevation**: Calculates dam crest elevation from terrain data
- **Physics-Based Flooding**: Improved algorithm that properly simulates water accumulation
- **Real-time Visualization**: See the reservoir extent on the map
- **Statistics**: Surface area, volume, depth metrics
- **Export**: Save results as PNG images or GeoJSON files

## Architecture

The application has been refactored into a modular architecture for better maintainability:

```
Inundator/
├── index.html              # Main HTML page
├── index-legacy.html       # Original monolithic version (backup)
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

### Previous Issues

The original algorithm had several problems:
- Treated water as a simple elevation threshold rather than a flowing surface
- Created artificial barriers that blocked actual reservoirs
- Used fragile heuristics to select the "upstream" water body
- Could flood areas on the wrong side of the dam

### New Physics-Based Algorithm

The refactored algorithm uses a priority queue approach:

1. **Barrier Creation**: Dam line is thickened and marked as an impassable barrier
2. **Seed Identification**: Finds cells adjacent to the dam that are below crest elevation
3. **Priority Queue Flooding**: Water spreads to neighbors in order of elevation (lowest first)
4. **Water Level Tracking**: Maintains the highest elevation in the flow path to each cell
5. **Connected Components**: Identifies separate water bodies
6. **Upstream Selection**: Scores water bodies based on elevation, size, and proximity to dam

Key improvement: Water level at any point is determined by the highest point in the flow path from the dam, not just local elevation. This prevents water from "flowing uphill" and correctly confines water to topographic depressions.

## Configuration

All tunable parameters are in `js/config.js`:

- **DEM Settings**: Buffer size, zoom levels, tile limits
- **Flood Algorithm**: Iteration limits, seed search radius, water body scoring weights
- **Dam Parameters**: Safety margins, sampling intervals
- **Visualization**: Colors, opacity, simplification tolerance
- **Map Settings**: Default location, basemaps

## Usage

### Basic Workflow

1. **Search Location**: Enter a valley or dam site name
2. **Draw Dam**: Click "Draw dam line" and click two points on the map
3. **Adjust Parameters**: Modify safety margin or manually override crest elevation
4. **Compute**: Click "Compute inundation" to run the flood simulation
5. **Export**: Save the result as PNG or GeoJSON

### Parameters

- **Safety Margin**: Distance below the highest terrain point along the dam line (default: 5m)
- **Crest Elevation**: Can be manually overridden to test different water levels
- **Water Level**: Percentage of crest elevation (useful for filling/draining scenarios)
- **Depth Gradient**: Toggle visualization style

## Development

### Running Locally

The application uses ES6 modules, which require a web server (not just opening index.html in a browser):

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

### Testing the Algorithm

To compare the old and new algorithms, you can toggle the `usePhysicsAlgorithm` setting in `js/config.js`:

```javascript
flood: {
    usePhysicsAlgorithm: true  // Set to false for legacy algorithm
}
```

### Adding New Features

The modular architecture makes it easy to add features:

- **New DEM Sources**: Modify `ElevationService` class
- **Alternative Algorithms**: Add methods to `flood-worker.js`
- **Visualization Styles**: Extend `Visualization` class
- **Additional Statistics**: Add calculations to `Statistics` class

## Future Enhancements

### Near-term Improvements

1. **Progressive Loading**: Handle very large areas by tiling the computation
2. **Multiple Dams**: Support cascading reservoirs
3. **Elevation Profile**: Show cross-section of the reservoir
4. **3D Visualization**: Use terrain-rgb for 3D rendering
5. **Comparison Mode**: Overlay multiple scenarios

### Advanced Features

1. **Sedimentation Modeling**: Estimate sediment accumulation over time
2. **Seasonal Variation**: Model water level changes
3. **Flood Risk**: Downstream inundation from dam failure
4. **Optimization**: Suggest optimal dam placement for maximum storage
5. **Cost Estimation**: Estimate construction costs based on dam height and volume

### Technical Improvements

1. **TypeScript**: Add type safety
2. **Unit Tests**: Test individual modules
3. **Performance Profiling**: Optimize for large areas
4. **Custom DEM Sources**: Support user-uploaded elevation data
5. **Offline Support**: Service worker for offline operation

## Dependencies

- **MapLibre GL JS**: Map rendering (v3.6.2)
- **Turf.js**: Geospatial operations (v6)
- **D3 Contours**: Marching squares algorithm for polygon generation (v4)

All dependencies are loaded from CDN. For production, consider bundling for better performance and reliability.

## Data Sources

- **Base Maps**: OpenTopoMap, OpenStreetMap, Esri Satellite
- **Elevation Data**: AWS Terrain Tiles (Terrarium format)
- **Geocoding**: Nominatim (OpenStreetMap)

## License

This is an open-source educational/research tool. See the main repository LICENSE file.

## Credits

Developed as an experimental tool for reservoir simulation. Refactored and improved by Claude Code.

## Known Limitations

- Maximum area ~400 km² (configurable in config.js)
- DEM resolution ~30m (depends on zoom level)
- Simplified hydraulics (no flow dynamics)
- Assumes static water level (no temporal variation)
- Edge cases in complex terrain (narrow gorges, multiple basins)

## Support

For issues or questions:
1. Check the configuration parameters in `js/config.js`
2. Open browser console (F12) to see debug output
3. Review worker messages for algorithm insights
4. File an issue on GitHub with:
   - Location coordinates
   - Dam line coordinates
   - Console output
   - Expected vs actual behavior
