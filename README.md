# Koch Snowflake

An interactive, GPU-accelerated Koch snowflake explorer. Zero runtime dependencies. It builds to a few static files you can host anywhere.

## Features

- **Smooth iteration morphing.** Depth is continuous, so new spikes grow out of the previous level. The morph runs entirely on the GPU, which makes scrubbing free.
- **Generalised Koch rule.** You can change the seed polygon (1–12 sides, where 1 is the Koch curve), the spike angle (negative angles point inward, giving the anti-snowflake), the spike width, an "equal segments" Cesàro mode, the apex skew, and alternating direction per level.
- **Up to ~4.2 M vertices.** That's depth 10 for the classic snowflake.
- **Styling.** Solid, gradient or rainbow strokes with any line width, animated colour flow, an additive glow mode, and a solid or radial even-odd fill.
- **View controls.** Drag to pan, scroll or pinch to zoom around the cursor, plus rotation and auto-spin.
- **Export.** Save a PNG of the current view or an SVG of the whole shape, or copy a shareable link. All settings live in the URL hash.
- **Presets:** Classic, Anti, Koch curve, Cesàro, Quadric, Thorns, Wave, Swirl.

### Keyboard

| Key | Action |
| --- | --- |
| `Space` | Animate depth (ping-pong) |
| `↑` / `↓` or `]` / `[` | Next / previous iteration |
| `F` or double-click | Fit view |
| `H` | Hide UI |
| `P` | Save PNG |
| `+` / `-` | Zoom |

## How it's fast

Depth 10 has 3.1 M segments. A full-screen frame of it renders in **~0.6 ms**. The fill costs 1.5 ms even when all 3.1 M segments are forced through.

| Piece | Technique |
| --- | --- |
| Geometry | Built iteratively in a **Web Worker** using Float64 maths, then output as Float32 and *transferred* back with no copy. Requests are coalesced, so dragging a slider never queues stale work. |
| Vertex pulling | All points live in one RGBA32F texture holding `[x, y, baseX, baseY]` for each point. The shaders derive everything from `gl_VertexID`, so there are no vertex or index buffers. |
| Level of detail | Level-k vertices sit at stride 4^(L−k) in the final data. Any coarser iteration can therefore be drawn from the same texture, and the renderer stops at the level where segments drop below ~1 px on screen. Zooming in reveals deeper levels automatically. You can tune this with the *Detail cutoff* setting. |
| Morphing | Each vertex stores its final position and its "base" position, the spot it occupies before the newest spike grows. The shader lerps between them, so fractional depth costs no CPU work. |
| Strokes | Each segment becomes a quad, and the fragment shader computes the distance to the segment. This gives anti-aliased lines of any width with round joins. |
| Fill | **Even-odd stencil fill without slivers.** The parity of the level-n curve equals the seed polygon XOR every spike triangle of every level. The renderer stencil-inverts those small, local triangles (indices are computed in the shader) instead of a triangle fan of millions of slivers, which is about 200× faster. One full-screen pass then shades the result. |
| Frame loop | Draws only when something changed or is animating. |

## Develop

```bash
npm install
```

```bash
npm run dev
```

## Build & deploy

```bash
npm run build
```

This produces `dist/`, which is plain static files. `base: './'` is set, so the build works at any URL path. Deploy options:

- **Netlify / Cloudflare Pages / Vercel:** set the build command to `npm run build` and the output directory to `dist`.
- **GitHub Pages:** already set up in `.github/workflows/deploy.yml`. Push to a GitHub repo, open **Settings → Pages**, and set **Source** to **GitHub Actions**. After that, every push to `main` builds and deploys to `https://<user>.github.io/<repo>/`.
- **Anything else:** upload the contents of `dist/` to any static host or bucket.

The app needs WebGL2, which every current desktop and mobile browser supports.
