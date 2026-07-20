# Geogizmos

Interactive, dependency-free geographic tools. Each app is a static site with
no build step and no backend — open `index.html` (or visit the live link)
and it just runs, pulling map tiles, elevation, and OpenStreetMap data from
public services.

## [Inundator](Inundator/)

Draw a dam across a valley and watch the reservoir it would create, computed
from real elevation data.

**[Try it live](https://liotier.github.io/Geogizmos/Inundator/)**

[![Inundator screenshot](Inundator/Screenshot_2025-11-20_Inundator_Interactive_Reservoir_Inundation_Simulator.png)](https://liotier.github.io/Geogizmos/Inundator/)

[Read more →](Inundator/README.md)

## [Isosmfar](Isosmfar/)

Visualize distance, density, IDW, and heat-diffusion fields as GPU-rendered
heatmaps from OpenStreetMap data — how far are you from the nearest
hospital, school, or transit stop?

**[Try it live](https://liotier.github.io/Geogizmos/Isosmfar/)**

[![Isosmfar screenshot](Isosmfar/Isosmfar_screenshot.jpg)](https://liotier.github.io/Geogizmos/Isosmfar/)

[Read more →](Isosmfar/README.md)

## Development

Both apps are plain HTML/CSS/JS with dependencies pinned and loaded from a
CDN — no install or build needed to run them; serve the repo root with any
static file server (e.g. `python3 -m http.server`) and open the app's
`index.html`.

Tests and linting *are* set up (Node's built-in test runner + ESLint), for
contributors who want to verify changes to the JS:

```bash
npm install
npm test
npm run lint
```

## Deployment

Two GitHub Actions workflows publish to GitHub Pages:

- **`deploy-production.yml`** — pushes to `main` deploy both apps to the
  site root.
- **`deploy-preview.yml`** — pushes to any `claude/**` branch deploy a
  preview under `preview/<branch>/`, with a PR comment linking to it.
  `cleanup-preview.yml` removes a branch's preview when the branch is deleted.

## License

[Unlicense](LICENSE) — public domain.

## Author

[Jean-Marc Liotier](https://github.com/liotier)
