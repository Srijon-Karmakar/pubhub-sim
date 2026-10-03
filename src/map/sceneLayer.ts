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
uniform vec3 u_view;
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
  vec3 n = normalize(a_normal);
  vec3 L = normalize(u_sun);
  vec3 V = normalize(u_view);
  float diff = max(dot(n, L), 0.0);
  float sky = 0.62 + 0.38 * n.z;
  float amb = mix(0.6, 0.34, u_night) * sky;
  float lit = amb + (1.0 - amb) * diff * mix(1.0, 0.5, u_night);
  vec3 col = c * lit * mix(1.0, 0.6, u_night);
  float glassy = step(0.5, a_e);
  float spec = pow(max(dot(n, normalize(L + V)), 0.0), mix(22.0, 70.0, glassy)) * mix(0.14, 0.8, glassy) * (1.0 - 0.75 * u_night);
  float fres = pow(1.0 - max(dot(n, V), 0.0), 3.0);
  col = mix(col, mix(vec3(0.6, 0.72, 0.86), vec3(0.08, 0.1, 0.16), u_night), fres * glassy * 0.5);
  col += vec3(spec);
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
    for (const u of ['u_matrix', 'u_sun', 'u_night', 'u_glow', 'u_alpha', 'u_view']) this.uni[u] = g.getUniformLocation(p, u);
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
      if (mode === 'train' || isTram) {
        const wireZ = isTram ? 5.6 : 5.4;
        const mastL = -this.driveSide * (isTram ? 2.6 : 3.1);
        const wire = hexToGl('#2c3036');
        const mastC = hexToGl('#7c838b');
        for (let s = s0; s < s1; s += 10) {
          const sb = Math.min(s1, s + 10);
          if (tr.inTunnel(s)) continue;
          const z = (tr.elevationAt(s) + tr.elevationAt(sb)) / 2;
          this.boxAlong(mb, f, s, sb, -0.025, 0.025, z + wireZ, z + wireZ + 0.04, wire);
          if (!isTram) this.boxAlong(mb, f, s, sb, -0.02, 0.02, z + wireZ + 0.9, z + wireZ + 0.94, wire);
        }
        for (let s = Math.ceil(s0 / 55) * 55; s < s1; s += 55) {
          if (tr.inTunnel(s)) continue;
          const z = tr.elevationAt(s);
          this.boxAlong(mb, f, s - 0.14, s + 0.14, mastL - 0.14, mastL + 0.14, z, z + wireZ + 1.2, mastC);
          this.boxAlong(mb, f, s - 0.05, s + 0.05, Math.min(mastL, 0), Math.max(mastL, 0), z + wireZ + 0.85, z + wireZ + 0.95, mastC);
        }
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
    const roofTint = hexToGl(mixHex('#c4cad1', this.colour, 0.08));
    const roofCrown = hexToGl('#e3e6ea');
    const roofKit = hexToGl('#8f969f');
    const liveryDark = hexToGl(mixHex(this.colour, '#000000', 0.35));
    const lat = this.roadLateral();
    const hw = p.width / 2;
    const h = p.height / 3.6;
    const mode = e.route.mode;
    const isTram = mode === 'tram' || mode === 'light_rail';
    const isBus = mode === 'bus' || mode === 'trolleybus';
    const ship = mode === 'ferry';

    const carStride = p.carLength + p.carGap;
    const k = e.k;
    const stop = e.tt.stops[k];
    const target = e.tt.targets[k];
    const doorOpen = e.doors === 'closed' ? 0 : e.doors === 'opening' ? Math.min(1, e.doorT / 2.2) : e.doors === 'closing' ? Math.max(0, 1 - e.doorT / 3) : 1;
    const doorSlots: { along: number; lat: number }[] = [];
    const side = stop?.side ?? this.driveSide;

    // palette
    const silver = hexToGl('#e6e9ed');
    const pillar = isBus ? hexToGl('#f4f5f7') : silver;
    const doorCol = hexToGl(mixHex(this.colour, '#000000', 0.25));
    const under = hexToGl('#1f2328');
    const wheel = hexToGl('#2b2f35');
    const bogie = hexToGl('#3a3f46');
    const steel = hexToGl('#aeb4bb');
    const glassC = hexToGl('#16212c');
    const gangway = hexToGl('#23272d');

    // a slab of the car between sA and sB (front end sB), with optional tapered noses
    const slab = (sA: number, sB: number, wf: number, noseF: number, noseR: number, z0: number, z1: number, col: C4, em = 0) => {
      mb.prism(this.carPoly(this.at(f, sB, lat), this.at(f, sA, lat), hw * wf, noseF, noseR), z0, z1, col, em);
    };
    // a thin panel standing proud of the car sides (windows, doors)
    const sides = (sA: number, sB: number, z0: number, z1: number, col: C4, em: number, out = 0.022, only?: number) => {
      for (const sgn of only ? [only] : [-1, 1]) {
        const l0 = lat + sgn * (hw - 0.01);
        const l1 = lat + sgn * (hw + out);
        this.boxAlong(mb, f, sA, sB, Math.min(l0, l1), Math.max(l0, l1), z0, z1, col, em);
      }
    };
    // stair-stepped slanted bar (pantograph arms, trolley poles)
    const slant = (a0: number, z0: number, a1: number, z1: number, lt: number, th: number, col: C4) => {
      const n = 5;
      for (let j = 0; j < n; j++) {
        const sa = a0 + ((a1 - a0) * j) / n;
        const sb = a0 + ((a1 - a0) * (j + 1)) / n;
        this.boxAlong(mb, f, Math.min(sa, sb) - th, Math.max(sa, sb) + th, lt - th, lt + th, z0 + ((z1 - z0) * j) / n, z0 + ((z1 - z0) * (j + 1)) / n + th, col);
      }
    };

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
        mb.prism(this.carPoly(F, R, hw, nose, 2, 0.05), 0, 1.4, hexToGl('#1e2a38'));
        mb.prism(this.carPoly(F, R, hw, nose, 2, 0.05), 1.4, 2.25, C.white);
        mb.prism(this.carPoly(F, R, hw, nose, 2, 0.05), 2.25, 2.55, livery);
        const cF = this.at(f, sf - nose - 1, lat);
        const cR = this.at(f, sr + 4, lat);
        mb.prism(this.carPoly(cF, cR, hw * 0.8, 2, 1), 2.55, 2.9, C.white);
        mb.prism(this.carPoly(cF, cR, hw * 0.78, 2, 1), 2.9, 4.2, glassC, 1);
        mb.prism(this.carPoly(cF, cR, hw * 0.82, 2, 1), 4.2, 4.55, C.white);
        const uF = this.at(f, sf - nose - 3, lat);
        const uR = this.at(f, sr + 9, lat);
        mb.prism(this.carPoly(uF, uR, hw * 0.62, 1.5, 1), 4.55, 5.6, glassC, 1);
        mb.prism(this.carPoly(uF, uR, hw * 0.66, 1.5, 1), 5.6, 5.9, C.white);
        const bF = this.at(f, sf - nose - 2.5, lat);
        const bR = this.at(f, sf - nose - 7, lat);
        mb.prism(this.carPoly(bF, bR, hw * 0.5, 1.2, 0), 5.9, 6.9, glassC, 1);
        mb.prism(this.carPoly(bF, bR, hw * 0.54, 1.2, 0), 6.9, 7.15, C.white);
        this.boxAlong(mb, f, sf - nose - 4.9, sf - nose - 4.6, lat - 0.15, lat + 0.15, 7.15, 9.2, steel);
        this.boxAlong(mb, f, sr + 4.5, sr + 7, lat - 0.9, lat + 0.9, 5.9, 7.8, livery);
        this.boxAlong(mb, f, sr + 4.5, sr + 7, lat - 0.9, lat + 0.9, 7.8, 8.1, under);
        for (const sgn of [-1, 1]) this.boxAlong(mb, f, sr + 3, sf - nose - 1, lat + sgn * (hw * 0.8 - 0.03), lat + sgn * (hw * 0.8 + 0.03), 5.55, 5.62, steel);
        continue;
      }

      const front = i === 0;
      const rear = i === p.cars - 1;
      const nose = mode === 'train' ? 2.4 : mode === 'monorail' ? 2.2 : isBus ? 0 : 1.3;
      const nF = front ? nose : 0;
      const nR = rear ? nose : 0;

      if (isBus) {
        // ---------- bus / trolleybus ----------
        const zB = base + 0.32;
        const zW0 = base + 1.12;
        const zW1 = base + 2.5;
        const zR = base + 2.9;
        slab(sr, sf, 1, 0, 0, zB, zW0, livery);
        slab(sr, sf, 0.995, 0, 0, zW0, zW1, pillar);
        slab(sr, sf, 1, 0, 0, zW1, zR, C.white);
        slab(sr + 0.15, sf - 0.15, 0.96, 0, 0, zR, zR + 0.16, C.roof);
        const doors = [...(front ? [sf - 1.15] : []), (sf + sr) / 2 + (front ? -0.6 : 0)];
        const cuts = [sr + 0.6, ...doors.flatMap((dc) => [dc - 0.75, dc + 0.75]), sf - (front ? 0.4 : 0.6)].sort((x, y) => x - y);
        for (let c = 0; c + 1 < cuts.length; c += 2) {
          for (let w = cuts[c]; w < cuts[c + 1] - 0.4; w += 1.9) sides(w + 0.08, Math.min(cuts[c + 1], w + 1.9) - 0.08, zW0 + 0.08, zW1 - 0.08, glassC, 1);
        }
        for (const dc of doors) {
          sides(dc - 0.62, dc + 0.62, zB + 0.05, zW1 - 0.02, glassC, 1, 0.03, side);
          doorSlots.push({ along: dc, lat: lat + side * (hw + 0.45) });
          if (doorOpen > 0.02) {
            const wd = 0.6 * doorOpen;
            this.boxAlong(mb, f, dc - wd, dc + wd, lat + side * (hw - 0.02), lat + side * (hw + 0.05), zB, zW1, C.doorLight, 2);
          }
        }
        for (const ax of front ? [sf - 2.5, sr + 3] : [sr + 2.6]) {
          for (const sgn of [-1, 1]) {
            this.boxAlong(mb, f, ax - 0.5, ax + 0.5, lat + sgn * (hw - 0.3), lat + sgn * (hw + 0.03), base, base + 0.98, wheel);
            this.boxAlong(mb, f, ax - 0.2, ax + 0.2, lat + sgn * (hw + 0.03), lat + sgn * (hw + 0.06), base + 0.29, base + 0.69, steel);
          }
        }
        this.boxAlong(mb, f, (sf + sr) / 2 - 1.5, (sf + sr) / 2 + 1.3, lat - hw * 0.62, lat + hw * 0.62, zR + 0.16, zR + 0.46, C.roof);
        if (front) {
          this.boxAlong(mb, f, sf - 0.08, sf + 0.02, lat - hw * 0.94, lat + hw * 0.94, base + 0.95, zW1 + 0.15, glassC, 1);
          this.boxAlong(mb, f, sf - 0.05, sf + 0.04, lat - hw * 0.7, lat + hw * 0.7, zW1 + 0.17, zR - 0.06, C.amber, 2);
          for (const sgn of [-1, 1]) {
            this.boxAlong(mb, f, sf - 0.35, sf - 0.15, lat + sgn * (hw + 0.08), lat + sgn * (hw + 0.38), base + 2.0, base + 2.42, under);
            this.boxAlong(mb, f, sf - 0.02, sf + 0.05, lat + sgn * hw * 0.55, lat + sgn * hw * 0.85, base + 0.55, base + 0.75, C.head, 2);
          }
        }
        if (rear) {
          this.boxAlong(mb, f, sr - 0.04, sr + 0.05, lat - hw * 0.7, lat + hw * 0.7, zW0 + 0.35, zW1 - 0.1, glassC, 1);
          for (const sgn of [-1, 1]) this.boxAlong(mb, f, sr - 0.05, sr + 0.02, lat + sgn * hw * 0.62, lat + sgn * hw * 0.9, base + 0.6, base + 1.0, C.tail, 2);
        }
        if (mode === 'trolleybus' && front) {
          for (const sgn of [-1, 1]) slant(sr + 4, zR + 0.4, sr - 3.5, zR + 2.6, lat + sgn * 0.3, 0.035, under);
        }
        if (i > 0) this.boxAlong(mb, f, sf, sf + p.carGap, lat - hw * 0.85, lat + hw * 0.85, zB, zW1, gangway);
        continue;
      }

      // ---------- rail vehicles ----------
      const mono = mode === 'monorail';
      const zFloor = base + (isTram ? 0.36 : mono ? 1.1 : 0.95) * h;
      const zW0 = base + (isTram ? 1.18 : mono ? 1.9 : 1.75) * h;
      const zW1 = base + (isTram ? 2.5 : mono ? 2.85 : 2.75) * h;
      const zTop = base + (isTram ? 3.0 : mono ? 3.45 : 3.32) * h;
      const zSkirt = base + (isTram ? 0.12 : mono ? 0.0 : 0.32) * h;
      const lower = mono ? liveryDark : livery;
      const upper = isTram ? livery : silver;

      // underframe & running gear
      slab(sr + 0.4, sf - 0.4, isTram || mono ? 0.98 : 0.86, nF * 0.8, nR * 0.8, zSkirt, zFloor, isTram || mono ? lower : under);
      if (!isTram && !mono) {
        for (const bc of [sr + 2.7, sf - 2.7]) {
          this.boxAlong(mb, f, bc - 1.35, bc + 1.35, lat - hw * 0.82, lat + hw * 0.82, base + 0.12 * h, base + 0.62 * h, bogie);
          for (const ax of [bc - 0.85, bc + 0.85]) {
            for (const sgn of [-1, 1]) this.boxAlong(mb, f, ax - 0.42, ax + 0.42, lat + sgn * (hw * 0.62), lat + sgn * (hw * 0.86), base, base + 0.84 * h, wheel);
            this.boxAlong(mb, f, ax - 0.06, ax + 0.06, lat - hw * 0.62, lat + hw * 0.62, base + 0.38 * h, base + 0.46 * h, steel);
          }
        }
      }
      // body: lower livery, window band, cab glass, cant rail, two-tier roof
      slab(sr, sf, 1, nF, nR, zFloor, zW0, lower);
      const cabLen = front || rear ? Math.min(2.2, p.carLength * 0.18) : 0;
      slab(rear ? sr + cabLen : sr, front ? sf - cabLen : sf, 0.995, 0, 0, zW0, zW1, upper);
      if (front) slab(sf - cabLen, sf, 0.99, nF * 0.72, 0, zW0, zW1, glassC, 1);
      if (rear) slab(sr, sr + cabLen, 0.99, 0, nR * 0.72, zW0, zW1, glassC, 1);
      slab(sr, sf, 1, nF * 0.55, nR * 0.55, zW1, zTop, upper);
      slab(sr + 0.2, sf - 0.2, 0.96, nF * 0.35, nR * 0.35, zTop, zTop + 0.14 * h, roofTint);
      slab(sr + 0.6, sf - 0.6, 0.74, nF * 0.2, nR * 0.2, zTop + 0.14 * h, zTop + 0.26 * h, roofCrown);
      // roof vents along the crown
      for (let vs = sr + 1.4; vs < sf - 1.4; vs += 2.6) if (Math.abs(vs - (sf + sr) / 2) > 2.4) this.boxAlong(mb, f, vs - 0.35, vs + 0.35, lat - 0.32, lat + 0.32, zTop + 0.26 * h, zTop + 0.34 * h, roofKit);
      sides(sr + (rear ? nR : 0.1), sf - (front ? nF : 0.1), zW0 - 0.07, zW0 - 0.01, doorCol, 0, 0.026);

      // doors, and window panes between them
      const nd = p.doorsPerCar;
      const doorW = isTram ? 1.3 : 1.4;
      const centres: number[] = [];
      for (let d = 0; d < nd; d++) centres.push(sf - (p.carLength * (d + 0.5)) / nd);
      const winStart = sr + (rear ? cabLen + 0.3 : 0.5);
      const winEnd = sf - (front ? cabLen + 0.3 : 0.5);
      const cuts = [winStart, ...centres.flatMap((dc) => [dc - doorW / 2 - 0.25, dc + doorW / 2 + 0.25]).sort((x, y) => x - y), winEnd];
      for (let c = 0; c + 1 < cuts.length; c += 2) {
        const s0 = Math.max(winStart, cuts[c]);
        const s1 = Math.min(winEnd, cuts[c + 1]);
        if (s1 - s0 < 0.6) continue;
        const panes = Math.max(1, Math.round((s1 - s0) / 1.8));
        const pw = (s1 - s0) / panes;
        for (let w = 0; w < panes; w++) sides(s0 + w * pw + 0.07, s0 + (w + 1) * pw - 0.07, zW0 + 0.07, zW1 - 0.06, glassC, 1);
      }
      for (const dc of centres) {
        sides(dc - doorW / 2, dc + doorW / 2, zFloor + 0.02, zW1 + 0.02, doorCol, 0, 0.028);
        sides(dc - doorW / 2 + 0.12, dc + doorW / 2 - 0.12, zW0 - 0.1, zW1 - 0.1, glassC, 1, 0.04);
        doorSlots.push({ along: dc, lat: lat + side * (hw + 0.45) });
        if (doorOpen > 0.02) {
          const wd = (doorW / 2) * doorOpen;
          this.boxAlong(mb, f, dc - wd, dc + wd, lat + side * (hw - 0.02), lat + side * (hw + 0.05), zFloor, zW1, C.doorLight, 2);
        }
      }

      // roof equipment and pantograph
      if (p.carLength > 9) {
        const mid = (sf + sr) / 2;
        this.boxAlong(mb, f, mid - 2, mid + 2, lat - hw * 0.5, lat + hw * 0.5, zTop + 0.26 * h, zTop + 0.5 * h, roofKit);
      }
      const panto = (mode === 'train' && (i === 1 || p.cars === 1)) || (isTram && i === Math.floor(p.cars / 2));
      if (panto) {
        const mid = (sf + sr) / 2 + (p.carLength > 9 ? 3.2 : 0);
        const zp = zTop + 0.26 * h;
        this.boxAlong(mb, f, mid - 0.7, mid + 0.7, lat - 0.6, lat + 0.6, zp, zp + 0.18, under);
        for (const sgn of [-1, 1]) {
          slant(mid - 0.6, zp + 0.18, mid + 0.4, zp + 1.0, lat + sgn * 0.45, 0.035, steel);
          slant(mid + 0.4, zp + 1.0, mid - 0.2, zp + 1.7, lat + sgn * 0.35, 0.03, steel);
        }
        this.boxAlong(mb, f, mid - 0.32, mid - 0.08, lat - 0.85, lat + 0.85, zp + 1.7, zp + 1.78, steel);
      }

      // cab: headlights, destination display, tail lights
      if (front) {
        const u = this.U(f, sf);
        const l: V2 = [-u[1], u[0]];
        for (const sgn of [-1, 1]) {
          const c: V2 = [F[0] - u[0] * 0.25 + l[0] * hw * 0.48 * sgn, F[1] - u[1] * 0.25 + l[1] * hw * 0.48 * sgn];
          mb.segBox([c[0] + u[0] * 0.12, c[1] + u[1] * 0.12], [c[0] - u[0] * 0.12, c[1] - u[1] * 0.12], 0.22, zFloor - 0.15, zFloor + 0.12, C.head, 2);
        }
        this.boxAlong(mb, f, sf - nF * 0.62 - 0.12, sf - nF * 0.5, lat - hw * 0.45, lat + hw * 0.45, zW1 - 0.32, zW1 - 0.06, C.amber, 2);
      }
      if (rear) {
        const u = this.U(f, sr);
        const l: V2 = [-u[1], u[0]];
        for (const sgn of [-1, 1]) {
          const c: V2 = [R[0] + u[0] * 0.25 + l[0] * hw * 0.5 * sgn, R[1] + u[1] * 0.25 + l[1] * hw * 0.5 * sgn];
          mb.segBox([c[0] + u[0] * 0.1, c[1] + u[1] * 0.1], [c[0] - u[0] * 0.1, c[1] - u[1] * 0.1], 0.16, zFloor - 0.1, zFloor + 0.12, C.tail, 2);
        }
      }
      // gangway bellows to the car in front
      if (i > 0) this.boxAlong(mb, f, sf, sf + p.carGap, lat - hw * 0.72, lat + hw * 0.72, zFloor - 0.05, zW1 + 0.15, gangway);
    }

    // ---- signals / traffic lights ----
    const red = hexToGl('#ff2a2a');
    const green = hexToGl('#2dff6a');
    const amberL = hexToGl('#ffae1a');
    const off = hexToGl('#2a2d31');
    for (const g of e.signals) {
      const dd = g.s - e.s;
      if (dd < -80 || dd > 1300) continue;
      const zb = tr.elevationAt(g.s);
      const isRed = g.state === 'red';
      if (p.rail) {
        const lt = this.driveSide * (hw + 1.4);
        this.boxAlong(mb, f, g.s - 0.1, g.s + 0.1, lt - 0.1, lt + 0.1, zb, zb + 4.4, hexToGl('#5b6168'));
        this.boxAlong(mb, f, g.s - 0.12, g.s + 0.12, lt - 0.32, lt + 0.32, zb + 3.2, zb + 4.6, under);
        this.boxAlong(mb, f, g.s - 0.16, g.s - 0.12, lt - 0.2, lt + 0.2, zb + 4.12, zb + 4.42, isRed ? red : off, isRed ? 2 : 0);
        this.boxAlong(mb, f, g.s - 0.16, g.s - 0.12, lt - 0.2, lt + 0.2, zb + 3.42, zb + 3.72, isRed ? off : green, isRed ? 0 : 2);
        if (isRed) this.quadAlong(mb, f, g.s - 6, g.s, lt - 1.2, lt + 1.2, zb + 0.08, hexToGl('#ff2a2a', 0.18), 2);
      } else {
        const lt = lat + this.driveSide * (hw + 2.3);
        this.boxAlong(mb, f, g.s - 0.09, g.s + 0.09, lt - 0.09, lt + 0.09, zb, zb + 4.8, hexToGl('#3d4248'));
        this.boxAlong(mb, f, g.s - 0.16, g.s + 0.16, lt - 0.24, lt + 0.24, zb + 3.3, zb + 4.75, under);
        const lamps: [number, C4, boolean][] = [
          [4.38, red, isRed],
          [3.98, amberL, false],
          [3.58, green, !isRed],
        ];
        for (const [z, col, on] of lamps) this.boxAlong(mb, f, g.s - 0.2, g.s - 0.16, lt - 0.15, lt + 0.15, zb + z, zb + z + 0.3, on ? col : off, on ? 2 : 0);
        this.quadAlong(mb, f, g.s - 0.5, g.s, lat - 1.9, lat + 1.9, 0.05, hexToGl('#f4f4f4', 0.9), 2);
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
    if (this.map) {
      const b = (this.map.getBearing() * Math.PI) / 180;
      const pt = (this.map.getPitch() * Math.PI) / 180;
      g.uniform3fv(this.uni.u_view, [-Math.sin(b) * Math.sin(pt), -Math.cos(b) * Math.sin(pt), Math.cos(pt)]);
    }
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
      g.uniform1f(this.uni.u_alpha, 0.72);
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
