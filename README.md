# Koch Snowflake

An interactive, GPU-accelerated Koch snowflake explorer with **true infinite zoom**. Zero runtime dependencies. It builds to a few static files you can host anywhere.

Live: https://syntaxbullet.github.io/koch-snowflake/

## Features

- **Infinite zoom.** Turn on *Infinite depth* and keep zooming with no limit. It has been tested past 10⁷⁰×, where it shows level 150+ of the fractal at full precision. *Fly in ∞* turns on auto-zoom, which steers along the curve as it goes.
- **Smooth iteration morphing.** With a finite depth, the depth value is continuous, so new spikes grow out of the previous level.
- **Generalised Koch rule.** You can change the seed polygon (1–12 sides, where 1 is the Koch curve), the spike angle (negative angles point inward, giving the anti-snowflake), the spike width, an "equal segments" Cesàro mode, the apex skew, and alternating direction per level.
- **Styling.** Solid, gradient or rainbow strokes, coloured by position along the path or by segment direction. Direction colouring looks the same at every zoom level. Also: any line width, animated colour flow, an additive glow mode, and a solid or radial even-odd fill.
- **Touch and mouse.** Drag to pan and scroll to zoom around the cursor. On touch screens, pinch to zoom, use two fingers to pan, twist to rotate, and double-tap to fit. Rotation only engages after a deliberate twist of more than 12°, so zooming never rotates by accident. On desktop, Shift-drag rotates and a trackpad pinch zooms.
- **Export.** Save a PNG or a vector SVG of the current view, or copy a shareable link. All settings live in the URL hash.
- **Presets:** Classic, Anti, Koch curve, Cesàro, Quadric, Thorns, Wave, Swirl.

### Keyboard

| Key | Action |
| --- | --- |
| `Space` | Animate depth (ping-pong) |
| `↑` / `↓` or `]` / `[` | Next / previous iteration |
| `I` | Toggle infinite depth |
| `F` or double-click | Fit view |
| `H` | Hide UI |
| `P` | Save PNG |
| `+` / `-` | Zoom |

## How it works

### Infinite zoom without running out of precision

Plain floating-point numbers run out of precision at around 10⁷× zoom. So the camera isn't stored as a position in space. It's stored as an **address in the subdivision tree**: the seed side, then which of the four children at each level (`[side, d₁, d₂, …]`). Alongside the address is a mapping from that segment to the screen, `screen(z) = A·z + B`, using complex numbers.

The camera is kept *normalised*: it always points at a segment roughly the size of the screen near the view centre.

- **Zooming in** moves the camera down to a child segment.
- **Zooming out** moves it up to the parent.
- **Panning** along the curve steps to the next or previous segment at the same level, using exact ratios between neighbouring segments.

The numbers involved stay screen-sized no matter how deep you go, so zoom has no limit (`src/fractal.ts`).

### Only the visible part is built

Each time the view changes, the builder goes up from the camera to a segment that covers the screen and collects its neighbours along the curve. It then subdivides, skipping anything off-screen and stopping once segments are about a pixel long (*Detail cutoff*). A typical view has 10–30 K segments and builds in 1–8 ms, whatever the zoom or depth.

### Rendering

| Piece | Technique |
| --- | --- |
| Strokes | Segments live in a float texture. The shader reads each one by vertex index (`gl_VertexID`) and expands it into a quad, so there are no vertex buffers. The fragment shader computes the distance to the segment, which gives anti-aliased lines of any width with round joins. |
| Fill | **Even-odd stencil fill without slivers.** Whether a point is inside the level-n curve can be worked out as: the seed polygon XOR every spike triangle of every level. So the builder emits small local triangles, and the stencil buffer does the XOR. When zoomed deep, the levels above the visible part become a single polygon closed off far away on the curve's interior side. |
| Morphing | The newest level's spike tips are blended between flat and fully grown, which gives smooth fractional depth. |
| Precision | Anything far off-screen is clipped in 64-bit maths before being converted to 32-bit floats for the GPU. |
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
