# Isosmfar

**Isosmfar** is an interactive web application for exploring **iso-distance fields** based on OpenStreetMap (OSM) data. It lets you visualize how far every location in a chosen area is from features that match a query (e.g. schools, hospitals, bus stops, restaurants, etc.).

The app is fully self-contained in a single file - with the notable exception of being entirely dependent and built on the whole Openstreetmap universe... Isosmfar is nothing without Openstreetmap data and services.

I love Openstreetmap !

# 👉 [Try it now – Isosmfar online](https://liotier.github.io/Geogizmos/Isosmfar/Isosmfar.html)

![screenshot](Screenshot%202025-09-11%20at%2017-23-08%20Isosmfar%20-%20OSM%20Distance%20Fields.png)

## ✨ Key Features

- **No setup required**  
  This is the full product, freely available online.  
  **No installation, no sign-up, no limitations.**  
  Works directly in your browser.

- **Flexible queries**  
  Define features of interest with simple `key=value` filters or full [Overpass QL](https://wiki.openstreetmap.org/wiki/Overpass_API/Overpass_QL) queries.

- **Real-time distance field visualization**  
  See a continuous heatmap of distances to the nearest matching features.  
  Smooth WebGL rendering with instant parameter updates.

- **Smart area selection**  
  Choose any area by name using [Nominatim](https://nominatim.org/) autocompletion.

- **Advanced customization**  
  - Exponential-scale gradient radius control for precise tuning at any scale (10m to 100km+)
  - Six color palettes with 17-step interpolation
  - Transparency control with edge-fading for natural density visualization
  - Multiple basemap layers (Standard, Humanitarian, Carto Light)

- **High-performance rendering**  
  Powered by **WebGL shaders** for buttery-smooth 60fps interaction even with thousands of points.

- **Export your results**  
  Save pixel-perfect visualizations as PNG images for sharing, reporting, or further analysis.

## 🛠️ Technical Excellence

Isosmfar showcases several sophisticated web development techniques:

### WebGL Custom Layer Implementation
- **GPU-accelerated distance computation** using custom vertex and fragment shaders
- **Texture-based data storage** allowing efficient processing of up to 5,000 features
- Features are packed into floating-point textures for parallel GPU processing
- Color palettes stored as 1D textures for smooth gradient interpolation

### Smart UI/UX Design
- **Exponential-scale sliders** providing intuitive control across 4 orders of magnitude (10m to 100km)
- **Adaptive distance defaults** automatically calculated based on area size and feature density
- **17-step color interpolation** creating smooth gradients from 9-color base palettes
- **Edge-fading transparency** multiplying alpha by distance for natural density visualization

### Performance Optimizations
- **Haversine distance calculations** performed directly in shader code
- **Texture sampling** for both feature positions and color palettes
- **Dynamic level-of-detail** – processes only visible area at current zoom
- **Deduplication** of overlapping features to prevent redundant calculations
- **Parallel processing** - fragment shader computes distances to all features in parallel

### Robust Architecture
- **ES6 modular design** with clean separation of concerns
- **Promise-based async operations** for smooth API interactions
- **Debounced search** preventing excessive Nominatim API calls
- **Canvas preservation** for reliable PNG exports with `preserveDrawingBuffer`

## 🔧 Technology Stack

- **JavaScript (ES6+)**
- **WebGL** – hardware-accelerated graphics rendering
- **[MapLibre GL JS](https://maplibre.org/)** – high-performance map display
- **[Turf.js](https://turfjs.org/)** – spatial analysis and area calculations
- **[D3-Delaunay](https://d3js.org/d3-delaunay/voronoi)** - Voronoi diagram
- **[Overpass API](https://overpass-api.de/)** – OSM feature queries
- **[Nominatim](https://nominatim.org/)** – geocoding
- **Custom GLSL Shaders** – GPU-based distance field computation

## 📖 How It Works

1. **Select an area**  
   Nominatim provides intelligent autocompletion with boundary polygon retrieval.

2. **Query OSM features**  
   Overpass API returns features matching your criteria within the selected boundary.

3. **GPU-accelerated processing**  
   Features are packed into textures and sent to the GPU where custom shaders compute a continuous distance field in real-time.

4. **Dynamic visualization**  
   The distance field is rendered as a smooth gradient overlay with adjustable parameters updating at 60fps.

5. **Export results**  
   MapLibre's canvas is captured with proper WebGL context preservation for pixel-perfect PNG exports.

## 🎨 Advanced Features

- **Smart distance scaling**: Exponential scale provides fine control at both local (meters) and regional (kilometers) scales
- **Adaptive defaults**: Initial gradient radius automatically calculated as ~12% of the area's characteristic dimension
- **Palette hot-swapping**: Change color schemes in real-time without recomputing the distance field

## 📦 Deployment

Since Isosmfar is a static single-page application:

- Run locally by opening `Isosmfar.html` in any modern browser
- Host on GitHub Pages, Netlify, or any static hosting service
- Embed in existing applications as an iframe
- Fork and customize for domain-specific use cases

**No server infrastructure required** – just static file hosting and access to public Openstreetmap services.

## 📜 License

This project is distributed under the [Unlicense](https://unlicense.org), placing it in the public domain.  
You are free to use, modify, and distribute this software for any purpose.

## 👤 Author

Created by Jean-Marc Liotier  
[View on GitHub](https://github.com/liotier/Geogizmos/tree/main/Isosmfar)
