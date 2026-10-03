import { MercatorCoordinate, type CustomLayerInterface, type CustomRenderMethodInput, type Map as MlMap } from 'maplibre-gl';
import { hexToGl, mixHex } from '../lib/color';
import { EARTH_R } from '../lib/geo';
import type { Engine } from '../lib/sim/engine';
import { mulberry32, hashString } from '../lib/sim/passengers';
import { MeshBuilder, STRIDE, type C4, type V2 } from './mesh';

const RAD = Math.PI / 180;

const VS = `#version 300 es
precision highp float;
uniform mat4 u_matrix;
uniform vec3 u_sun;
uniform float u_night;
uniform vec3 u_glow;
uniform float u_alpha;
in vec3 a_pos;
in vec3 a_normal;
in vec4 a_color;
in float a_e;
out vec4 v_color;
void main() {
  gl_Position = u_matrix * vec4(a_pos, 1.0);
  vec3 c = a_color.rgb;
  float al = a_color.a * u_alpha;
  if (a_e > 1.5) { v_color = vec4(c * al, al); return; }
  float diff = max(dot(normalize(a_normal), normalize(u_sun)), 0.0);
  float amb = mix(0.6, 0.34, u_night);
  float lit = amb + (1.0 - amb) * diff * mix(1.0, 0.5, u_night);
  vec3 col = c * lit * mix(1.0, 0.6, u_night);
  col = mix(col, u_glow, clamp(a_e * u_night, 0.0, 1.0));
  v_color = vec4(col * al, al);
}`;

const FS = `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 o;
void main() { o = v_color; }`;

const C = {
  dark: hexToGl('#2a2f37'),
  glass: hexToGl('#1b2735'),
  roof: hexToGl('#d7dbe0'),
  silver: hexToGl('#cfd4da'),
  white: hexToGl('#f3f4f6'),
  ballast: hexToGl('#6d665e'),
  concreteTrack: hexToGl('#9a9690'),
  sleeper: hexToGl('#4a4540'),
  rail: hexToGl('#c7ccd2'),
  concrete: hexToGl('#b9b5ae'),
  platform: hexToGl('#c9c4bb'),
  edge: hexToGl('#f5c400'),
  canopy: hexToGl('#e9ebee'),
  pillar: hexToGl('#a7a39c'),
  kerb: hexToGl('#d3cfc8'),
  shelterGlass: hexToGl('#9cc7dd', 0.55),
  pier: hexToGl('#8a6a4a'),
  head: hexToGl('#fff8e0'),
  tail: hexToGl('#ff3b3b'),
  amber: hexToGl('#ffb020'),
  doorLight: hexToGl('#ffe9b8'),
  tunnel: hexToGl('#05070d', 0.55),
  zone: hexToGl('#22c55e', 0.35),
  zoneCore: hexToGl('#4ade80', 0.85),
};

const SHIRTS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#34495e', '#ecf0f1', '#e67e22', '#1abc9c', '#95a5a6', '#d35400', '#2c3e50', '#c0392b', '#ff7eb6', '#16a085', '#111827'].map((c) => hexToGl(c));
const SKIN = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#a0522d'].map((c) => hexToGl(c));

class Frame {
  lat0 = 0;
  lon0 = 0;
  kx = 1;
  ky = RAD * EARTH_R;
  set(lat: number, lon: number) {
    this.lat0 = lat;
    this.lon0 = lon;
    this.kx = RAD * EARTH_R * Math.cos(lat * RAD);
  }
  enu(lat: number, lon: number): V2 {
    return [(lon - this.lon0) * this.kx, (lat - this.lat0) * this.ky];
  }
}

interface Person {
  along: number;
  lat: number;
  h: number;
  shirt: C4;
  skin: C4;
  state: 0 | 1 | 2;
  t: number;
  fa: number;
  fl: number;
  ta: number;
  tl: number;
}

interface GpuMesh {
  buf: WebGLBuffer;
  count: number;
  frame: Frame;
}

export class SceneLayer implements CustomLayerInterface {
  readonly id = 'scene';
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;

  engine: Engine | null = null;
  colour = '#3b82f6';
  night = 0;
  sun: [number, number, number] = [0.4, -0.5, 0.75];
  xray = false;
  assists = true;
  driveSide: -1 | 1 = 1;
  /** cab view: the camera sits inside the front car */
  hideVehicle = false;

  private map: MlMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private prog: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private loc: Record<string, number> = {};
  private uni: Record<string, WebGLUniformLocation | null> = {};
  private stat!: GpuMesh;
  private dyn!: GpuMesh;
  private beam!: GpuMesh;
  private mbStatic = new MeshBuilder(16384);
  private mbDyn = new MeshBuilder(8192);
  private mbBeam = new MeshBuilder(64);
  private staticS = -1e9;
  private staticK = -1;
  private staticKey = '';
  private persons: Person[] = [];
  private crowdKey = '';
  private crowdInit = 1;
  private deliveredSeen = 0;
  private lastT = 0;
  private alightCooldown = 0;

  setRun(engine: Engine | null, colour: string, driveSide: -1 | 1) {
    this.engine = engine;
    this.colour = colour;
    this.driveSide = driveSide;
    this.staticS = -1e9;
    this.staticKey = '';
    this.persons = [];
    this.crowdKey = '';
    this.lastT = 0;
    this.map?.triggerRepaint();
  }

  onAdd(map: MlMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.map = map;
    const g = gl as WebGL2RenderingContext;
    this.gl = g;
    const sh = (type: number, src: string) => {
      const s = g.createShader(type)!;
      g.shaderSource(s, src);
      g.compileShader(s);
      if (!g.getShaderParameter(s, g.COMPILE_STATUS)) console.error(g.getShaderInfoLog(s));
      return s;
    };
    const p = g.createProgram()!;
    g.attachShader(p, sh(g.VERTEX_SHADER, VS));
    g.attachShader(p, sh(g.FRAGMENT_SHADER, FS));
    g.linkProgram(p);
    if (!g.getProgramParameter(p, g.LINK_STATUS)) console.error(g.getProgramInfoLog(p));
    this.prog = p;
    this.vao = g.createVertexArray();
    for (const a of ['a_pos', 'a_normal', 'a_color', 'a_e']) this.loc[a] = g.getAttribLocation(p, a);
    for (const u of ['u_matrix', 'u_sun', 'u_night', 'u_glow', 'u_alpha']) this.uni[u] = g.getUniformLocation(p, u);
    const mk = (): GpuMesh => ({ buf: g.createBuffer()!, count: 0, frame: new Frame() });
    this.stat = mk();
    this.dyn = mk();
    this.beam = mk();
  }

  onRemove() {
    const g = this.gl;
    if (g && this.prog) {
      g.deleteProgram(this.prog);
      if (this.vao) g.deleteVertexArray(this.vao);
      for (const m of [this.stat, this.dyn, this.beam]) g.deleteBuffer(m.buf);
    }
    this.map = null;
    this.gl = null;
  }

  // ---------------------------------------------------------------- geometry
  private P(f: Frame, s: number): V2 {
    const [la, lo] = this.engine!.track.path.pointAt(s);
    return f.enu(la, lo);
  }

  private U(f: Frame, s: number): V2 {
    const a = this.P(f, s - 2);
    const b = this.P(f, s + 2);
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
  }

  /** point at distance s with a lateral offset (positive = right of travel). */
  private at(f: Frame, s: number, lat: number): V2 {
    const p = this.P(f, s);
    if (lat === 0) return p;
    const u = this.U(f, s);
    return [p[0] + u[1] * lat, p[1] - u[0] * lat];
  }

  private quadAlong(mb: MeshBuilder, f: Frame, sa: number, sb: number, l0: number, l1: number, z: number, c: C4, e = 0) {
    mb.flat([this.at(f, sa, l0), this.at(f, sb, l0), this.at(f, sb, l1), this.at(f, sa, l1)], z, c, e);
  }

  private boxAlong(mb: MeshBuilder, f: Frame, sa: number, sb: number, l0: number, l1: number, z0: number, z1: number, c: C4, e = 0) {
    mb.prism([this.at(f, sa, l0), this.at(f, sb, l0), this.at(f, sb, l1), this.at(f, sa, l1)], z0, z1, c, e);
  }

  private roadLateral() {
    const e = this.engine!;
    return e.profile.rail || e.profile.sound === 'ship' ? 0 : this.driveSide * 1.7;
  }

  private buildStatic(center: number) {
    const e = this.engine!;
    const tr = e.track;
    const p = e.profile;
    const mb = this.mbStatic;
    mb.reset();
    const f = this.stat.frame;
    const [la, lo] = tr.path.pointAt(center);
    f.set(la, lo);
    const L = e.length;
    const s0 = Math.max(-L - 60, center - 350);
    const s1 = Math.min(tr.length + 60, center + 900);
    const mode = e.route.mode;
    const isTram = mode === 'tram' || mode === 'light_rail';

    // tunnel cut-away strips
    for (const t of tr.tunnels) {
      const a = Math.max(s0, t.s0);
      const b = Math.min(s1, t.s1);
      for (let s = a; s < b; s += 10) this.quadAlong(mb, f, s, Math.min(b, s + 10), -5, 5, 0.03, C.tunnel);
    }

    if (p.rail && mode !== 'monorail') {
      const step = 8;
      for (let s = s0; s < s1; s += step) {
        const sb = Math.min(s1, s + step);
        const z = (tr.elevationAt(s) + tr.elevationAt(sb)) / 2;
        if (z > 0.6) this.boxAlong(mb, f, s, sb, -2.4, 2.4, z - 1.15, z, C.concrete);
        if (isTram) this.quadAlong(mb, f, s, sb, -1.45, 1.45, z + 0.05, C.concreteTrack);
        else this.quadAlong(mb, f, s, sb, -1.65, 1.65, z + 0.06, C.ballast);
        this.quadAlong(mb, f, s, sb, -0.76, -0.68, z + 0.2, C.rail);
        this.quadAlong(mb, f, s, sb, 0.68, 0.76, z + 0.2, C.rail);
      }
      if (!isTram) {
        const a = Math.max(s0, center - 160);
        const b = Math.min(s1, center + 420);
        for (let s = Math.ceil(a / 0.65) * 0.65; s < b; s += 0.65) {
          const z = tr.elevationAt(s);
          this.quadAlong(mb, f, s - 0.12, s + 0.12, -1.25, 1.25, z + 0.13, C.sleeper);
        }
      }
      for (let s = Math.ceil(s0 / 30) * 30; s < s1; s += 30) {
        const z = tr.elevationAt(s);
        if (z > 2) this.boxAlong(mb, f, s - 0.7, s + 0.7, -0.7, 0.7, 0, z - 1.15, C.pillar);
      }
    } else if (mode === 'monorail') {
      for (let s = s0; s < s1; s += 8) {
        const sb = Math.min(s1, s + 8);
        const z = (tr.elevationAt(s) + tr.elevationAt(sb)) / 2;
        this.boxAlong(mb, f, s, sb, -0.45, 0.45, z - 1.9, z - 0.25, C.concrete);
      }
      for (let s = Math.ceil(s0 / 25) * 25; s < s1; s += 25) {
        const z = tr.elevationAt(s);
        if (z > 2) {
          this.boxAlong(mb, f, s - 0.6, s + 0.6, -0.6, 0.6, 0, z - 1.9, C.pillar);
          this.boxAlong(mb, f, s - 0.6, s + 0.6, -1.2, 1.2, z - 2.4, z - 1.9, C.pillar);
        }
      }
    }

    // stops
    const hw = p.width / 2;
    e.tt.targets.forEach((target, j) => {
      if (target < s0 - 80 || target - L > s1 + 80) return;
      const stop = e.tt.stops[j];
      const side = stop.side;
      if (p.rail) {
        const zt = tr.elevationAt(target - L / 2);
        const elevated = zt > 1;
        const platH = mode === 'monorail' ? -0.15 : isTram ? 0.3 : 1.1;
        const top = zt + platH;
        const inner = side * (hw + 0.2);
        const outer = side * (hw + (isTram ? 2.6 : 4.4));
        const a = target - L - 5;
        const b = target + 5;
        for (let s = a; s < b; s += 6) {
          const sb = Math.min(b, s + 6);
          this.boxAlong(mb, f, s, sb, inner, outer, elevated ? top - 0.7 : 0, top, C.platform);
          this.quadAlong(mb, f, s, sb, inner + side * 0.15, inner + side * 0.55, top + 0.012, C.edge);
          if (!isTram) {
            this.boxAlong(mb, f, s, sb, inner + side * 0.4, outer + side * 0.2, top + 3.4, top + 3.6, C.canopy);
          }
        }
        if (!isTram) {
          for (let s = a + 6; s < b - 3; s += 12) {
            const mid = (inner + outer) / 2;
            this.boxAlong(mb, f, s - 0.15, s + 0.15, mid - 0.15, mid + 0.15, top, top + 3.4, C.pillar);
          }
        } else {
          // tram shelter
          const mid = target - L / 2;
          this.boxAlong(mb, f, mid - 2.5, mid + 2.5, outer - side * 1.3, outer - side * 0.1, top + 2.3, top + 2.45, C.canopy);
          this.boxAlong(mb, f, mid - 2.5, mid + 2.5, outer - side * 0.18, outer - side * 0.1, top, top + 2.3, C.shelterGlass);
        }
        // stop marker board
        const ml = side * (hw + 0.45);
        this.boxAlong(mb, f, target + 1.2, target + 1.32, ml - 0.06, ml + 0.06, top > 0 ? top : zt, (top > 0 ? top : zt) + 2.4, C.pillar);
        this.boxAlong(mb, f, target + 1.18, target + 1.36, ml - 0.35, ml + 0.35, (top > 0 ? top : zt) + 1.9, (top > 0 ? top : zt) + 2.5, hexToGl(this.colour), 2);
      } else if (p.sound === 'ship') {
        const inner = side * (hw + 0.5);
        const outer = side * (hw + 6);
        this.boxAlong(mb, f, target - L - 4, target + 4, inner, outer, 0, 1.4, C.pier);
      } else {
        const lat = this.roadLateral();
        const inner = lat + side * (hw + 0.25);
        const outer = inner + side * 3.2;
        this.boxAlong(mb, f, stop.s - 10, stop.s + 8, inner, outer, 0, 0.16, C.kerb);
        const sh0 = outer - side * 1.5;
        this.boxAlong(mb, f, stop.s - 2, stop.s + 2.5, sh0, outer - side * 0.1, 2.4, 2.55, C.canopy);
        this.boxAlong(mb, f, stop.s - 2, stop.s + 2.5, outer - side * 0.18, outer - side * 0.1, 0.16, 2.4, C.shelterGlass);
        const pl = inner + side * 0.4;
        this.boxAlong(mb, f, stop.s + 4.5, stop.s + 4.62, pl - 0.06, pl + 0.06, 0, 2.7, C.pillar);
        this.boxAlong(mb, f, stop.s + 4.48, stop.s + 4.64, pl - 0.3, pl + 0.3, 2.15, 2.75, hexToGl(this.colour), 2);
      }
    });

    this.upload(this.stat, mb);
  }

  private carPoly(F: V2, R: V2, hw: number, noseF: number, noseR: number, k = 0.62): V2[] {
    let ux = F[0] - R[0];
    let uy = F[1] - R[1];
    const L = Math.hypot(ux, uy) || 1;
    ux /= L;
    uy /= L;
    const lx = -uy;
    const ly = ux;
    const pt = (base: V2, along: number, side: number): V2 => [base[0] + ux * along + lx * side, base[1] + uy * along + ly * side];
    const out: V2[] = [];
    if (noseR > 0) out.push(pt(R, 0, -hw * k), pt(R, noseR, -hw));
    else out.push(pt(R, 0, -hw));
    if (noseF > 0) out.push(pt(F, -noseF, -hw), pt(F, 0, -hw * k), pt(F, 0, hw * k), pt(F, -noseF, hw));
    else out.push(pt(F, 0, -hw), pt(F, 0, hw));
    if (noseR > 0) out.push(pt(R, noseR, hw), pt(R, 0, hw * k));
    else out.push(pt(R, 0, hw));
    return out;
  }

  private buildDynamic(dt: number) {
    const e = this.engine!;
    const p = e.profile;
    const tr = e.track;
    const mb = this.mbDyn;
    mb.reset();
    const f = this.dyn.frame;
    const [la, lo] = tr.path.pointAt(e.s);
    f.set(la, lo);
    const livery = hexToGl(this.colour);
    const roofTint = hexToGl(mixHex('#d7dbe0', this.colour, 0.16));
    const roofKit = hexToGl('#8f969f');
    const liveryDark = hexToGl(mixHex(this.colour, '#000000', 0.35));
    const lat = this.roadLateral();
    const hw = p.width / 2;
    const h = p.height / 3.6;
    const mode = e.route.mode;
    const isTram = mode === 'tram' || mode === 'light_rail';
    const isBus = mode === 'bus' || mode === 'trolleybus';
    const ship = mode === 'ferry';

    type Layer = [number, number, C4, number, number];
    let layers: Layer[];
    if (isBus) {
      layers = [
        [0.32, 1.12, livery, 0, 1],
        [1.12, 2.5, C.glass, 1, 0.995],
        [2.5, 2.95, C.white, 0, 1],
        [2.95, 3.15, C.roof, 0, 0.8],
      ];
    } else if (isTram) {
      layers = [
        [0.28, 0.85, C.dark, 0, 0.92],
        [0.85, 1.2, livery, 0, 1],
        [1.2, 2.5, C.glass, 1, 0.995],
        [2.5, 3.0, livery, 0, 1],
        [3.0, 3.4, C.roof, 0, 0.9],
      ];
    } else if (mode === 'train') {
      layers = [
        [0.3, 1.0, C.dark, 0, 0.9],
        [1.0, 1.6, livery, 0, 1],
        [1.6, 2.1, C.silver, 0, 1],
        [2.1, 2.9, C.glass, 1, 0.995],
        [2.9, 3.6, roofTint, 0, 0.92],
      ];
    } else if (mode === 'monorail') {
      layers = [
        [0.0, 1.15, liveryDark, 0, 1],
        [1.15, 1.9, C.white, 0, 1],
        [1.9, 2.9, C.glass, 1, 0.995],
        [2.9, 3.6, C.white, 0, 0.94],
      ];
    } else if (ship) {
      layers = [];
    } else {
      layers = [
        [0.25, 0.95, C.dark, 0, 0.9],
        [0.95, 2.05, livery, 0, 1],
        [2.05, 2.85, C.glass, 1, 0.995],
        [2.85, 3.45, roofTint, 0, 0.93],
      ];
    }

    const carStride = p.carLength + p.carGap;
    const k = e.k;
    const stop = e.tt.stops[k];
    const target = e.tt.targets[k];
    const doorOpen = e.doors === 'closed' ? 0 : e.doors === 'opening' ? Math.min(1, e.doorT / 2.2) : e.doors === 'closing' ? Math.max(0, 1 - e.doorT / 3) : 1;
    const doorSlots: { along: number; lat: number }[] = [];
    const side = stop?.side ?? this.driveSide;

    for (let i = 0; i < p.cars; i++) {
      if (this.hideVehicle && i < 2) continue;
      const sf = e.s - i * carStride;
      const sr = sf - p.carLength;
      const F = this.at(f, sf, lat);
      const R = this.at(f, sr, lat);
      let base = tr.elevationAt((sf + sr) / 2);
      if (mode === 'monorail') base -= 1.25;
      if (ship) {
        const nose = p.carLength * 0.28;
        const hull = this.carPoly(F, R, hw, nose, 2, 0.05);
        mb.prism(hull, 0, 2.2, C.white);
        mb.prism(this.carPoly(F, R, hw * 1.0, nose, 2, 0.05), 2.2, 2.55, livery);
        const cF = this.at(f, sf - nose - 1, lat);
        const cR = this.at(f, sr + 4, lat);
        mb.prism(this.carPoly(cF, cR, hw * 0.78, 2, 1), 2.55, 4.5, C.glass, 1);
        mb.prism(this.carPoly(cF, cR, hw * 0.8, 2, 1), 4.5, 4.85, C.white);
        const bF = this.at(f, sf - nose - 2, lat);
        const bR = this.at(f, sf - nose - 9, lat);
        mb.prism(this.carPoly(bF, bR, hw * 0.55, 1.5, 0), 4.85, 6.2, C.glass, 1);
        mb.prism(this.carPoly(bF, bR, hw * 0.58, 1.5, 0), 6.2, 6.5, C.white);
        const funnel = this.at(f, sr + 6, lat);
        mb.segBox([funnel[0] + 0.01, funnel[1]], funnel, 0.9, 4.85, 7.2, livery);
        continue;
      }
      const front = i === 0;
      const rear = i === p.cars - 1;
      const noseF = front && !isBus ? (mode === 'train' ? 2.2 : 1.2) : 0;
      const noseR = rear && !isBus ? (mode === 'train' ? 2.2 : 1.2) : 0;
      for (const [z0, z1, col, em, wf] of layers) {
        mb.prism(this.carPoly(F, R, hw * wf, noseF, noseR), base + z0 * h, base + z1 * h, col, em);
      }
      if (layers.length && !isBus && p.carLength > 9) {
        // roof-mounted equipment (A/C units, pantograph wells)
        const top = base + layers[layers.length - 1][1] * h;
        const mid = (sf + sr) / 2;
        this.boxAlong(mb, f, mid - 2.2, mid + 2.2, lat - hw * 0.55, lat + hw * 0.55, top, top + 0.32, roofKit);
        if (p.carLength > 14) {
          this.boxAlong(mb, f, sr + 2.2, sr + 4.4, lat - hw * 0.4, lat + hw * 0.4, top, top + 0.22, roofKit);
          this.boxAlong(mb, f, sf - 4.4, sf - 2.2, lat - hw * 0.4, lat + hw * 0.4, top, top + 0.22, roofKit);
        }
      }
      if (front) {
        const u = this.U(f, sf);
        const l: V2 = [-u[1], u[0]];
        for (const sgn of [-1, 1]) {
          const c: V2 = [F[0] - u[0] * 0.05 + l[0] * hw * 0.5 * sgn, F[1] - u[1] * 0.05 + l[1] * hw * 0.5 * sgn];
          mb.segBox([c[0] + u[0] * 0.08, c[1] + u[1] * 0.08], [c[0] - u[0] * 0.1, c[1] - u[1] * 0.1], 0.16, base + 0.75 * h, base + 1.05 * h, C.head, 2);
        }
        if (isBus) {
          mb.segBox([F[0] + u[0] * 0.04, F[1] + u[1] * 0.04], [F[0] - u[0] * 0.1, F[1] - u[1] * 0.1], hw * 0.75, base + 2.55, base + 2.85, C.amber, 2);
        }
      }
      if (rear) {
        const u = this.U(f, sr);
        const l: V2 = [-u[1], u[0]];
        for (const sgn of [-1, 1]) {
          const c: V2 = [R[0] + l[0] * hw * 0.55 * sgn, R[1] + l[1] * hw * 0.55 * sgn];
          mb.segBox([c[0] + u[0] * 0.08, c[1] + u[1] * 0.08], [c[0] - u[0] * 0.08, c[1] - u[1] * 0.08], 0.13, base + 0.8 * h, base + 1.05 * h, C.tail, 2);
        }
      }
      // doors
      for (let d = 0; d < p.doorsPerCar; d++) {
        const along = sf - (p.carLength * (d + 0.5)) / p.doorsPerCar;
        doorSlots.push({ along, lat: lat + side * (hw + 0.45) });
        if (doorOpen > 0.02) {
          const w = 0.68 * doorOpen;
          const l0 = lat + side * (hw - 0.02);
          const l1 = lat + side * (hw + 0.035);
          this.boxAlong(mb, f, along - w, along + w, l0, l1, base + (isBus || isTram ? 0.35 : 0.95) * h, base + 2.75 * h, C.doorLight, 2);
        }
      }
    }

    // ---- stop zone guide ----
    if (this.assists && stop && !e.served && target - e.s < p.approach + 20) {
      const z = tr.elevationAt(target) + (p.rail ? 0.24 : 0.04);
      const t1 = p.tol[1];
      const zl = lat - 1.7;
      const zr = lat + 1.7;
      this.quadAlong(mb, f, target - p.tol[3], target + p.tol[3], zl, zr, z, C.zone, 2);
      this.quadAlong(mb, f, target - t1, target + t1, zl, zr, z + 0.01, C.zoneCore, 2);
    }

    // ---- crowd ----
    if (stop) this.updateCrowd(dt, doorSlots);
    for (const per of this.persons) {
      const along = per.state === 0 ? per.along : per.fa + (per.ta - per.fa) * Math.min(1, per.t);
      const latp = per.state === 0 ? per.lat : per.fl + (per.tl - per.fl) * Math.min(1, per.t);
      if (Math.abs(along - e.s) > 700) continue;
      const base = this.personBase(along);
      const c = this.at(f, along, latp);
      const u = this.U(f, along);
      const shrink = per.state === 2 && per.t > 2 ? Math.max(0, 1 - (per.t - 2)) : 1;
      if (shrink <= 0.02) continue;
      const hh = per.h * shrink;
      mb.segBox([c[0] + u[0] * 0.24, c[1] + u[1] * 0.24], [c[0] - u[0] * 0.24, c[1] - u[1] * 0.24], 0.14, base, base + hh - 0.3, per.shirt);
      mb.segBox([c[0] + u[0] * 0.11, c[1] + u[1] * 0.11], [c[0] - u[0] * 0.11, c[1] - u[1] * 0.11], 0.11, base + hh - 0.3, base + hh, per.skin);
    }
    this.upload(this.dyn, mb);

    // ---- headlight beam ----
    const bm = this.mbBeam;
    bm.reset();
    this.beam.frame.set(la, lo);
    if (this.night > 0.25 && !ship) {
      const z = tr.elevationAt(e.s) + (p.rail ? 0.3 : 0.06);
      const a = this.night * 0.32;
      const n0 = this.at(f, e.s + 0.3, lat - 1.1);
      const n1 = this.at(f, e.s + 0.3, lat + 1.1);
      const f1 = this.at(f, e.s + 48, lat + 4.5);
      const f0 = this.at(f, e.s + 48, lat - 4.5);
      bm.flat([n0, n1, f1, f0], z, [1, 0.93, 0.76, 1], 2, [a, a, 0, 0]);
    }
    this.upload(this.beam, bm);
  }

  private personBase(along: number): number {
    const e = this.engine!;
    const p = e.profile;
    const z = e.track.elevationAt(along);
    const mode = e.route.mode;
    if (!p.rail) return p.sound === 'ship' ? 1.4 : 0.16;
    if (mode === 'monorail') return z - 0.15;
    if (mode === 'tram' || mode === 'light_rail') return z + 0.3;
    return z + 1.1;
  }

  private updateCrowd(dt: number, doors: { along: number; lat: number }[]) {
    const e = this.engine!;
    const p = e.profile;
    const k = e.k;
    const stop = e.tt.stops[k];
    const target = e.tt.targets[k];
    const key = `${e.route.id}:${k}`;
    const hw = p.width / 2;
    const side = stop.side;
    const mode = e.route.mode;
    const isTram = mode === 'tram' || mode === 'light_rail';
    const lat = this.roadLateral();
    let inner: number;
    let outer: number;
    let a0: number;
    let a1: number;
    if (p.rail) {
      inner = side * (hw + 1.0);
      outer = side * (hw + (isTram ? 2.4 : 4.1));
      a0 = target - e.length + 1.5;
      a1 = target - 1;
    } else if (p.sound === 'ship') {
      inner = side * (hw + 1.2);
      outer = side * (hw + 5.5);
      a0 = target - e.length;
      a1 = target;
    } else {
      inner = lat + side * (hw + 0.8);
      outer = lat + side * (hw + 3.1);
      a0 = stop.s - 7;
      a1 = stop.s + 5;
    }
    if (key !== this.crowdKey) {
      this.crowdKey = key;
      this.persons = this.persons.filter((q) => q.state === 2);
      const rnd = mulberry32(hashString(key));
      const waiting = e.waiting[k] ?? 0;
      this.crowdInit = Math.max(1, waiting);
      const n = Math.min(p.rail ? 70 : 18, waiting);
      for (let i = 0; i < n; i++) {
        this.persons.push({
          along: a0 + rnd() * (a1 - a0),
          lat: inner + (outer - inner) * rnd(),
          h: 1.55 + rnd() * 0.35,
          shirt: SHIRTS[Math.floor(rnd() * SHIRTS.length)],
          skin: SKIN[Math.floor(rnd() * SKIN.length)],
          state: 0,
          t: 0,
          fa: 0,
          fl: 0,
          ta: 0,
          tl: 0,
        });
      }
      this.deliveredSeen = e.paxDelivered;
    }
    const waitingVisible = this.persons.filter((q) => q.state === 0);
    const n0 = Math.min(p.rail ? 70 : 18, this.crowdInit);
    const desired = Math.round((n0 * (e.waiting[k] ?? 0)) / this.crowdInit);
    let excess = waitingVisible.length - desired;
    while (excess > 0 && doors.length) {
      // the person closest to any door boards first
      let best: Person | null = null;
      let bd = Infinity;
      let door = doors[0];
      for (const q of waitingVisible) {
        if (q.state !== 0) continue;
        for (const d of doors) {
          const dist = Math.abs(d.along - q.along) + Math.abs(d.lat - q.lat) * 0.5;
          if (dist < bd) {
            bd = dist;
            best = q;
            door = d;
          }
        }
      }
      if (!best) break;
      best.state = 1;
      best.t = 0;
      best.fa = best.along;
      best.fl = best.lat;
      best.ta = door.along;
      best.tl = door.lat - side * 0.6;
      excess--;
    }
    this.alightCooldown -= dt;
    const newly = e.paxDelivered - this.deliveredSeen;
    if (newly > 0 && this.alightCooldown <= 0 && doors.length) {
      const rnd = Math.random;
      const d = doors[Math.floor(rnd() * doors.length)];
      this.deliveredSeen += Math.max(1, Math.ceil(newly / 3));
      this.alightCooldown = 0.12;
      const alighting = this.persons.filter((q) => q.state === 2).length;
      if (alighting < 45) {
        const toLat = inner + (outer - inner) * (0.3 + rnd() * 0.6);
        this.persons.push({
          along: d.along,
          lat: d.lat,
          h: 1.55 + rnd() * 0.35,
          shirt: SHIRTS[Math.floor(rnd() * SHIRTS.length)],
          skin: SKIN[Math.floor(rnd() * SKIN.length)],
          state: 2,
          t: 0,
          fa: d.along,
          fl: d.lat - side * 0.6,
          ta: d.along + (rnd() - 0.5) * 10,
          tl: toLat,
        });
      }
    } else if (newly <= 0) this.deliveredSeen = e.paxDelivered;

    for (const q of this.persons) {
      if (q.state === 1) q.t += dt / 1.0;
      else if (q.state === 2) q.t += dt / 2.4;
    }
    this.persons = this.persons.filter((q) => !(q.state === 1 && q.t >= 1) && !(q.state === 2 && q.t >= 3));
  }

  private upload(m: GpuMesh, mb: MeshBuilder) {
    const g = this.gl!;
    g.bindBuffer(g.ARRAY_BUFFER, m.buf);
    g.bufferData(g.ARRAY_BUFFER, mb.data.subarray(0, mb.n * STRIDE), g.DYNAMIC_DRAW);
    m.count = mb.n;
  }

  // ---------------------------------------------------------------- render
  render(gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput) {
    const e = this.engine;
    if (!e || !this.prog) return;
    const g = gl as WebGL2RenderingContext;
    const now = performance.now() / 1000;
    const dt = this.lastT ? Math.min(0.1, now - this.lastT) : 0.016;
    this.lastT = now;

    const key = `${e.route.id}:${e.k}:${e.served}`;
    if (Math.abs(e.s - this.staticS) > 60 || key !== this.staticKey || e.k !== this.staticK) {
      this.staticS = e.s;
      this.staticKey = key;
      this.staticK = e.k;
      this.buildStatic(e.s + 150);
    }
    this.buildDynamic(dt);

    const main = args.defaultProjectionData.mainMatrix as unknown as ArrayLike<number>;
    g.bindVertexArray(this.vao);
    g.useProgram(this.prog);
    g.uniform3fv(this.uni.u_sun, this.sun);
    g.uniform1f(this.uni.u_night, this.night);
    g.uniform3fv(this.uni.u_glow, [1.0, 0.85, 0.55]);
    g.uniform1f(this.uni.u_alpha, 1);
    g.enable(g.DEPTH_TEST);
    g.depthFunc(g.LEQUAL);
    g.depthMask(true);
    g.enable(g.BLEND);
    g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
    g.disable(g.CULL_FACE);
    if (this.xray) g.clear(g.DEPTH_BUFFER_BIT);

    this.draw(g, this.stat, main);
    this.draw(g, this.dyn, main);
    // ghost pass: wherever buildings (e.g. OSM station halls) hide the vehicle,
    // it shows through as a translucent silhouette; visible parts are unchanged
    if (!this.xray && this.dyn.count) {
      g.clear(g.DEPTH_BUFFER_BIT);
      g.uniform1f(this.uni.u_alpha, 0.45);
      this.draw(g, this.dyn, main);
      g.uniform1f(this.uni.u_alpha, 1);
    }
    if (this.beam.count) {
      g.depthMask(false);
      g.blendFunc(g.ONE, g.ONE);
      this.draw(g, this.beam, main);
      g.depthMask(true);
    }
    g.bindVertexArray(null);
  }

  private draw(g: WebGL2RenderingContext, m: GpuMesh, main: ArrayLike<number>) {
    if (!m.count) return;
    const mc = MercatorCoordinate.fromLngLat([m.frame.lon0, m.frame.lat0], 0);
    const s = mc.meterInMercatorCoordinateUnits();
    const M = [s, 0, 0, 0, 0, -s, 0, 0, 0, 0, s, 0, mc.x, mc.y, mc.z, 1];
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        let v = 0;
        for (let k = 0; k < 4; k++) v += main[k * 4 + r] * M[c * 4 + k];
        out[c * 4 + r] = v;
      }
    }
    g.uniformMatrix4fv(this.uni.u_matrix, false, out);
    g.bindBuffer(g.ARRAY_BUFFER, m.buf);
    const B = 4;
    const L = this.loc;
    g.enableVertexAttribArray(L.a_pos);
    g.vertexAttribPointer(L.a_pos, 3, g.FLOAT, false, STRIDE * B, 0);
    g.enableVertexAttribArray(L.a_normal);
    g.vertexAttribPointer(L.a_normal, 3, g.FLOAT, false, STRIDE * B, 3 * B);
    g.enableVertexAttribArray(L.a_color);
    g.vertexAttribPointer(L.a_color, 4, g.FLOAT, false, STRIDE * B, 6 * B);
    g.enableVertexAttribArray(L.a_e);
    g.vertexAttribPointer(L.a_e, 1, g.FLOAT, false, STRIDE * B, 10 * B);
    g.drawArrays(g.TRIANGLES, 0, m.count);
  }
}
