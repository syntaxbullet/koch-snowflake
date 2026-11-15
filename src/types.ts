/** Parameters that define the geometry. Changing any of these requires regeneration. */
export interface GeomParams {
  /** Number of sides of the seed polygon. 1 = a single open segment (Koch curve). */
  sides: number;
  /** Integer iteration level to generate. */
  level: number;
  /** Fraction of each segment replaced by the spike (classic: 1/3). */
  width: number;
  /** Base angle of the spike in degrees. Negative = inward. Classic: 60. */
  angle: number;
  /** Apex offset along the spike base, -1..1. 0 = symmetric. */
  skew: number;
  /** Flip spike direction on every other iteration. */
  alternate: boolean;
}

export interface GeomRequest {
  id: number;
  params: GeomParams;
}

export interface GeomResult {
  id: number;
  params: GeomParams;
  /**
   * Interleaved vertex data: [x, y, baseX, baseY] per point.
   * (x, y) is the point at full growth, (baseX, baseY) is where it sits before the
   * newest spikes have grown. The renderer lerps between them for smooth morphing.
   * For closed shapes the first point is repeated at the end.
   */
  data: Float32Array;
  /** Number of points in `data`. */
  points: number;
  closed: boolean;
  perimeter: number;
  area: number;
  /** Average segment length (world units) at each level 0..level, used for LOD. */
  levelLen: number[];
  /** [minX, minY, maxX, maxY] at full growth. */
  bounds: [number, number, number, number];
  ms: number;
}
