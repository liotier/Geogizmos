# Isosmfar

**Isosmfar** is an interactive web application for exploring **iso-distance fields** based on OpenStreetMap (OSM) data. It lets you visualize how far every location in a chosen area is from features that match a query (e.g. schools, hospitals, bus stops, restaurants, etc.).

👉 [Try it now – Isosmfar online](https://liotier.github.io/Geogizmos/Isosmfar/Isosmfar.html)

![screenshot](Screenshot%202025-09-11%20at%2017-23-08%20Isosmfar%20-%20OSM%20Distance%20Fields.png)

---

## ✨ Key Features

- **No setup required**  
  This is the full product, freely available online.  
  **No installation, no sign-up, no limitations.**  
  Works directly in your browser.

- **Flexible queries**  
  Define the features of interest either with simple `key=value` filters or with full [Overpass QL](https://wiki.openstreetmap.org/wiki/Overpass_API/Overpass_QL) queries.

- **Distance field visualization**  
  See a continuous map of the distance to the nearest matching feature.  
  Tune the radius, colors, and transparency to highlight patterns.

- **Area selection**  
  Choose any area by name using [Nominatim](https://nominatim.org/) autocompletion.

- **Customizable display**  
  - Adjustable gradient radius  
  - Multiple color palettes  
  - Transparency control  
  - Different basemap layers

- **Smooth rendering**  
  Powered by **WebGL** for responsive and fluid interaction.

- **Export your results**  
  Save your visualization as a PNG image for sharing, reporting, or further analysis.

---

## 🚀 Benefits

- **100% client-side** – all computation and rendering happen in your browser.  
- **Portable single-page app** – can be hosted anywhere as a single HTML file (plus assets).  
- **Free and open** – powered by free data and open-source libraries.  

---

## 🛠️ Technology

Isosmfar is a lightweight **single-page application (SPA)** built with standard web technologies:

- **JavaScript (ES6)** – application logic and rendering
- **HTML5 & CSS3** – user interface
- **WebGL** – fast graphics rendering for smooth UX
- **[Leaflet](https://leafletjs.com/)** – interactive mapping library
- **[Turf.js](https://turfjs.org/)** – spatial analysis and distance computations
- **[Chromajs](https://gka.github.io/chroma.js/)** – color palette generation
- **[Overpass API](https://overpass-api.de/)** – for querying OSM features and retrieving boundaries
- **[Nominatim](https://nominatim.org/)** – for name autocompletion
- **[OpenStreetMap tiles](https://www.openstreetmap.org/)** – for basemap backgrounds

No build system, no external dependencies beyond the included libraries. The app is fully self-contained.

---

## 📖 How It Works

1. **Select an area**  
   Start typing the name of a city, region, or country. Nominatim provides autocompletion.  

2. **Retrieve boundary and features**  
   Overpass API supplies the geographic boundary of the selected area, and returns the features matching your query.  

3. **Define your query**  
   - Simple filter: `amenity=school`, `highway=bus_stop`, etc.  
   - Or full Overpass QL for advanced use.

4. **Generate the distance field**  
   - A raster grid is computed where each pixel stores the Euclidean distance to the nearest feature.  
   - The distances are rendered as a smooth WebGL-driven color gradient overlayed on the basemap.

5. **Adjust parameters**  
   - Gradient radius controls the visualization scale.  
   - Choose among multiple palettes and adjust transparency.  

6. **Export your result**  
   Click *Export PNG* to save the current map view with the distance overlay.

---

## 🙏 Acknowledgments

This project would not exist without the amazing open data and open-source ecosystem:

- **[OpenStreetMap](https://www.openstreetmap.org/)** – the free and editable map of the world  
- **[Overpass API](https://overpass-api.de/)** – powerful querying of OSM data and boundaries  
- **[Nominatim](https://nominatim.org/)** – open geocoding and search autocompletion  
- **[Leaflet](https://leafletjs.com/)** – intuitive interactive maps  
- **[Turf.js](https://turfjs.org/)** – modular geospatial analysis in JavaScript  
- **[Chroma.js](https://gka.github.io/chroma.js/)** – color scales for data visualization  

A big thank you to the contributors and communities behind these tools and datasets.

---

## 📦 Deployment

Since Isosmfar is just a static HTML/JS app, you can:

- Run it locally by opening the HTML file in a browser  
- Host it on GitHub Pages, GitLab Pages, or any static hosting service  

**No server-side components are required beyond access to OSM services.**

---

## 📜 License

This project is distributed under the [Unlicense](https://unlicense.org), placing it in the public domain.  

---

## 👤 Authors

Created by **Jean-Marc Liotier**  
Distributed on GitHub: [Geogizmos / Isosmfar](https://github.com/liotier/Geogizmos/tree/main/Isosmfar)

