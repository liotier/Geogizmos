import js from '@eslint/js';

// Hand-listed globals (kept small and explicit rather than pulling in the
// `globals` package, to keep devDependencies to just eslint + @turf/turf).
const browserGlobals = {
    window: 'readonly',
    document: 'readonly',
    navigator: 'readonly',
    console: 'readonly',
    fetch: 'readonly',
    URL: 'readonly',
    URLSearchParams: 'readonly',
    localStorage: 'readonly',
    indexedDB: 'readonly',
    IDBRequest: 'readonly',
    Image: 'readonly',
    Worker: 'readonly',
    performance: 'readonly',
    requestAnimationFrame: 'readonly',
    setTimeout: 'readonly',
    clearTimeout: 'readonly',
    globalThis: 'readonly',
    alert: 'readonly',
    Blob: 'readonly',
    CustomEvent: 'readonly',
    WebGL2RenderingContext: 'readonly',
    WebGLRenderingContext: 'readonly'
};

const workerGlobals = {
    self: 'readonly',
    console: 'readonly',
    performance: 'readonly',
    setTimeout: 'readonly',
    clearTimeout: 'readonly',
    globalThis: 'readonly'
};

const nodeGlobals = {
    process: 'readonly',
    console: 'readonly',
    globalThis: 'readonly',
    URLSearchParams: 'readonly'
};

const baseRules = {
    ...js.configs.recommended.rules,
    'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
    'no-console': 'off'
};

export default [
    {
        ignores: ['node_modules/**', '**/icons/**']
    },
    // Inundator: ES modules, browser environment
    {
        files: ['Inundator/js/**/*.js'],
        ignores: ['Inundator/js/workers/**'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: browserGlobals
        },
        rules: baseRules
    },
    // Inundator: Web Worker (classic script, not a module)
    {
        files: ['Inundator/js/workers/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: workerGlobals
        },
        rules: baseRules
    },
    // Isosmfar: classic (non-module) browser script, loads MapLibre/Turf from CDN
    {
        files: ['Isosmfar/app.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: {
                ...browserGlobals,
                maplibregl: 'readonly',
                turf: 'readonly'
            }
        },
        rules: baseRules
    },
    // Isosmfar: Voronoi Web Worker
    {
        files: ['Isosmfar/voronoi-worker.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: {
                ...workerGlobals,
                importScripts: 'readonly',
                turf: 'readonly',
                d3: 'readonly'
            }
        },
        rules: baseRules
    },
    // Tests (both apps) and this config file: Node + ESM
    {
        files: ['**/test/**/*.js', 'eslint.config.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: nodeGlobals
        },
        rules: baseRules
    }
];
