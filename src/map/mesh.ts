export type V2 = [number, number];
export type C4 = [number, number, number, number];

/** Interleaved: pos(3) normal(3) color(4) emissive(1) */
export const STRIDE = 11;

export class MeshBuilder {
  data: Float32Array;
  n = 0;

  constructor(capacity = 4096) {
    this.data = new Float32Array(capacity * STRIDE);
  }

  reset() {
    this.n = 0;
  }

  private ensure(extra: number) {
    const need = (this.n + extra) * STRIDE;
    if (need <= this.data.length) return;
    let cap = this.data.length;
    while (cap < need) cap *= 2;
    const next = new Float32Array(cap);
    next.set(this.data.subarray(0, this.n * STRIDE));
    this.data = next;
  }

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: C4, e: number) {
    const o = this.n * STRIDE;
    const d = this.data;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = z;
    d[o + 3] = nx;
    d[o + 4] = ny;
    d[o + 5] = nz;
    d[o + 6] = c[0];
    d[o + 7] = c[1];
    d[o + 8] = c[2];
    d[o + 9] = c[3];
    d[o + 10] = e;
    this.n++;
  }

  /** Extruded convex polygon (counter-clockwise in ENU). */
  prism(poly: V2[], z0: number, z1: number, c: C4, e = 0, top: C4 | null = null, sides = true) {
    const m = poly.length;
    let area = 0;
    for (let i = 0; i < m; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % m];
      area += a[0] * b[1] - b[0] * a[1];
    }
    if (area < 0) poly = poly.slice().reverse();
    this.ensure(m * 6 + (m - 2) * 3);
    if (sides) {
      for (let i = 0; i < m; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % m];
        let nx = b[1] - a[1];
        let ny = -(b[0] - a[0]);
        const L = Math.hypot(nx, ny) || 1;
        nx /= L;
        ny /= L;
        this.vert(a[0], a[1], z0, nx, ny, 0, c, e);
        this.vert(b[0], b[1], z0, nx, ny, 0, c, e);
        this.vert(b[0], b[1], z1, nx, ny, 0, c, e);
        this.vert(a[0], a[1], z0, nx, ny, 0, c, e);
        this.vert(b[0], b[1], z1, nx, ny, 0, c, e);
        this.vert(a[0], a[1], z1, nx, ny, 0, c, e);
      }
    }
    const tc = top ?? c;
    for (let i = 1; i < m - 1; i++) {
      this.vert(poly[0][0], poly[0][1], z1, 0, 0, 1, tc, e);
      this.vert(poly[i][0], poly[i][1], z1, 0, 0, 1, tc, e);
      this.vert(poly[i + 1][0], poly[i + 1][1], z1, 0, 0, 1, tc, e);
    }
  }

  /** Flat horizontal quad (counter-clockwise), with optional per-corner alpha. */
  flat(p: V2[], z: number, c: C4, e = 0, alphas?: [number, number, number, number]) {
    this.ensure(6);
    const col = (i: number): C4 => (alphas ? [c[0], c[1], c[2], alphas[i]] : c);
    const idx = [0, 1, 2, 0, 2, 3];
    for (const i of idx) this.vert(p[i][0], p[i][1], z, 0, 0, 1, col(i), e);
  }

  /** Oriented box between two centre points (front f, rear r). */
  segBox(f: V2, r: V2, hw: number, z0: number, z1: number, c: C4, e = 0, top: C4 | null = null) {
    let ux = f[0] - r[0];
    let uy = f[1] - r[1];
    const L = Math.hypot(ux, uy) || 1;
    ux /= L;
    uy /= L;
    const lx = -uy * hw;
    const ly = ux * hw;
    this.prism(
      [
        [r[0] - lx, r[1] - ly],
        [f[0] - lx, f[1] - ly],
        [f[0] + lx, f[1] + ly],
        [r[0] + lx, r[1] + ly],
      ],
      z0,
      z1,
      c,
      e,
      top,
    );
  }
}
