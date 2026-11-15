export const defaults = {
  // shape
  sides: 3,
  angle: 60,
  width: 1 / 3,
  skew: 0,
  alternate: false,
  equal: false,
  // iteration
  depth: 4,
  infinite: false,
  play: false,
  playSpeed: 0.6,
  playTo: 6,
  // stroke
  stroke: true,
  lineWidth: 1.25,
  colorMode: 1 as 0 | 1 | 2,
  colorBy: 0 as 0 | 1,
  color1: '#7dd3fc',
  color2: '#c4b5fd',
  cycles: 1,
  hueSpeed: 0,
  additive: false,
  // fill
  fill: true,
  fillMode: 1 as 0 | 1,
  fill1: '#1e3a5f',
  fill2: '#0b0d12',
  fillAlpha: 0.6,
  // view
  bg: '#0b0d12',
  rotation: 0,
  spin: 0,
  autoZoom: 0,
  follow: true,
  lod: 0.75,
};

export type Settings = typeof defaults;
export type Key = keyof Settings;

/** Keys that change the generated geometry. */
export const GEOM_KEYS: Key[] = ['sides', 'angle', 'width', 'skew', 'alternate', 'equal'];

/** Spike width that makes all four sub-segments equal length for a given angle. */
export function equalWidth(angleDeg: number) {
  const c = Math.cos((Math.abs(angleDeg) * Math.PI) / 180);
  return c / (1 + c);
}

/** Max finite iteration depth (geometry is generated per view, so this is cheap). */
export const DEPTH_MAX = 12;

export const presets: Record<string, Partial<Settings>> = {
  Classic: { sides: 3, angle: 60, width: 1 / 3, skew: 0, alternate: false, equal: false },
  Anti: { sides: 3, angle: -60, width: 1 / 3, skew: 0, alternate: false, equal: false },
  'Koch curve': { sides: 1, angle: 60, width: 1 / 3, skew: 0, alternate: false, equal: false },
  Cesàro: { sides: 4, angle: -85, skew: 0, alternate: false, equal: true },
  Quadric: { sides: 4, angle: 75, width: 0.3, skew: 0, alternate: false, equal: false },
  Thorns: { sides: 5, angle: 80, width: 0.18, skew: 0, alternate: false, equal: false },
  Wave: { sides: 3, angle: 50, width: 0.4, skew: 0, alternate: true, equal: false },
  Swirl: { sides: 6, angle: 55, width: 0.36, skew: 0.6, alternate: false, equal: false },
};

const NUM_KEYS = new Set(Object.entries(defaults).filter(([, v]) => typeof v === 'number').map(([k]) => k));
const BOOL_KEYS = new Set(Object.entries(defaults).filter(([, v]) => typeof v === 'boolean').map(([k]) => k));

/** Encode only values differing from defaults, to keep share links short. */
export function toHash(s: Settings): string {
  const q = new URLSearchParams();
  for (const k of Object.keys(defaults) as Key[]) {
    const v = s[k];
    if (v === defaults[k] || k === 'play') continue;
    q.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : typeof v === 'number' ? String(+v.toFixed(4)) : String(v));
  }
  return q.toString();
}

export function fromHash(hash: string): Partial<Settings> {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  const out: Record<string, unknown> = {};
  for (const [k, v] of q) {
    if (!(k in defaults)) continue;
    if (NUM_KEYS.has(k)) {
      const n = parseFloat(v);
      if (Number.isFinite(n)) out[k] = n;
    } else if (BOOL_KEYS.has(k)) out[k] = v === '1';
    else if (/^#[0-9a-f]{6}$/i.test(v)) out[k] = v;
  }
  return out as Partial<Settings>;
}
