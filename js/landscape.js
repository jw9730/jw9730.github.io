/*
 * A pixel-art view from the open corridor of an old apartment block:
 * a vast, dense city, mountains and the sea near the horizon,
 * and a sky that drifts through the day.
 *
 * Markup:
 *   <canvas id="landscape" width="205" height="100"></canvas>
 *   optional buttons anywhere on the page:
 *     <button data-mh-hour="12.5">noon</button>  skim the clock to 12:30
 *     <button data-mh-rain>rain</button>          start / stop a downpour
 *       (data-mh-rain-on="stop" sets its label while it rains)
 *   an element with data-mh-controls is un-hidden once the scene is running.
 *   data-hour="18.1" on the canvas sets the starting hour (default 17:36).
 *
 * Time flows on its own, slowly around sunset and faster through the rest of
 * the day (a full day takes about three and a half minutes). Drag sideways on
 * the scene to scrub. Roughly every other day a heavy downpour rolls in, never
 * in the evening. The animation pauses off-screen and stays still for people
 * who prefer reduced motion.
 *
 * Console: magicHour.set(h), magicHour.get(), magicHour.storm().
 */
(() => {
  'use strict';

  const canvas = document.getElementById('landscape');
  if (!canvas || !canvas.getContext) return;

  // ------------------------------------------------------------------ setup
  const W = 205, H = 100, N = W * H;
  const HZ = 46;            // horizon row
  const SKY_TOP = 8;        // first sky row below the ceiling slab
  const F = 92;             // focal length in pixels
  const CAM_H = 120;        // eye height above the city, metres
  // The ground (streets, parks, alleys) sits DROP metres below where the
  // original low-rise roofscape was designed. Roof heights stay put, so the
  // skyline looks the same from up here but every building is ~2x taller.
  const DROP = 12;
  const K = F * (CAM_H + DROP); // ground-plane projection
  const CX = 102.5;         // optical centre
  const FACE_AZ = 248;      // compass bearing we are looking toward (WSW)
  const CITY_END = 86;      // first parapet row
  const CITY_FAR = 9000;    // where the city gives way to far land
  const VIS = 6800;         // visibility in metres (dry, clear air)

  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(W, H);
  const out = image.data;

  // ---------------------------------------------------------------- helpers
  const makeRng = (seed) => () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = makeRng(20260928);
  const hash = (n) => {
    n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
    n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const hex = (s) => [
    parseInt(s.slice(1, 3), 16) / 255,
    parseInt(s.slice(3, 5), 16) / 255,
    parseInt(s.slice(5, 7), 16) / 255,
  ];
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const smooth = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const lerp = (a, b, t) => a + (b - a) * t;
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const wrapH = (h) => ((h % 24) + 24) % 24;

  // 1-D value noise for ridgelines
  const noise1 = (seed) => {
    const r = makeRng(seed), p = [];
    for (let i = 0; i < 256; i++) p.push(r());
    return (x) => {
      const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
      return lerp(p[i & 255], p[(i + 1) & 255], u);
    };
  };

  // ------------------------------------------------------------- materials
  const SKY = 0, MTN1 = 1, MTN2 = 2, MTN3 = 3, SEA = 4, GROUND = 5, ROAD = 6,
    ROOF = 7, FACE = 8, SIDE = 9, PARK = 10, CEIL = 11, BEAM = 12, PILLAR = 13,
    CAP = 14, PARAPET = 15;

  const mat = new Uint8Array(N);
  const alb = new Float32Array(N * 3);
  const fog = new Float32Array(N);
  const win = new Uint8Array(N);    // window light threshold, 0 = no window
  const tint = new Uint8Array(N);
  const glow = new Float32Array(N); // street-lamp spill
  const rimW = new Float32Array(N); // how much an edge catches sky/sun light
  const noiz = new Float32Array(N);
  for (let i = 0; i < N; i++) noiz[i] = rng();

  const setAlb = (i, c, k = 1) => {
    alb[i * 3] = c[0] * k; alb[i * 3 + 1] = c[1] * k; alb[i * 3 + 2] = c[2] * k;
  };

  // --------------------------------------------------------------- palettes
  const P = (...a) => a.map(hex);
  const ROOFS_GREEN = P('#5f9470', '#6b9c77', '#548565', '#679a6e');
  const ROOFS_GREY = P('#9e9e98', '#8c8d88', '#aaa79e', '#96948c');
  const ROOFS_RED = P('#b9b6ae', '#aeaba3', '#c3c0b7');
  const ROOFS_BLUE = P('#5a7392', '#63809b');
  const ROOFS_LIGHT = P('#c1bcb0', '#b5b1a6');
  const FACES_BRICK = P('#cfccc4', '#c4c1b9', '#d8d5cd', '#bdbab3');
  const FACES_BEIGE = P('#d6c9b0', '#cbbd9f', '#d9cfba');
  const FACES_GREY = P('#a4a4a0', '#b0aea6');
  const FACES_WHITE = P('#dcdad2', '#e2ded4');
  const FACES_PASTEL = P('#d6d0b8', '#d2d0c8', '#bcc6c2');
  const TREE = P('#3f6a3c', '#4b7a44', '#365c35', '#557f48');
  const ALLEY = P('#57544f', '#5f5b55', '#4f4d4a');
  const ASPHALT = hex('#4b4c51');
  const SLAB_FACE = P('#e2dccd', '#d9d4c8', '#e6e0d0');
  const TINTS = P('#ffcf85', '#eef4ff', '#fff0c8', '#9bb8ff', '#ff9ab8', '#9ae8ff');
  const SODIUM = hex('#ffb257');

  const roofColor = () => {
    const r = rng();
    if (r < 0.05) return pick(ROOFS_GREEN);
    if (r < 0.68) return pick(ROOFS_GREY);
    if (r < 0.78) return pick(ROOFS_RED);
    if (r < 0.84) return pick(ROOFS_BLUE);
    return pick(ROOFS_LIGHT);
  };
  const faceColor = () => {
    const r = rng();
    if (r < 0.36) return pick(FACES_BRICK);
    if (r < 0.62) return pick(FACES_BEIGE);
    if (r < 0.77) return pick(FACES_GREY);
    if (r < 0.92) return pick(FACES_WHITE);
    return pick(FACES_PASTEL);
  };
  const shopTint = () => {
    const r = rng();
    return r < 0.45 ? 0 : r < 0.7 ? 2 : r < 0.85 ? 1 : r < 0.93 ? 4 : 5;
  };
  const windowTint = () => {
    const r = rng();
    return r < 0.42 ? 0 : r < 0.86 ? 1 : r < 0.97 ? 2 : 3;
  };

  // ------------------------------------------------------------ world layout
  // Horizontal avenues (constant depth) and radial boulevards (constant x).
  const HROADS = [
    { z0: 340, z1: 386 },
    { z0: 690, z1: 730 },
    { z0: 1340, z1: 1390 },
  ];
  // Radial boulevards run away from us. How much of one we can see past the
  // blocks beside it shrinks with its distance from our line of sight, so the
  // main one sits fairly close to the centre.
  const VROADS = [
    { x: -125, w: 34 },
    { x: 330, w: 36 },
  ];
  // Old apartment complexes: rows of identical slabs.
  const COMPLEXES = [
    { x0: -900, x1: -420, z0: 470, z1: 660, b: 15 },
    { x0: 700, x1: 1500, z0: 900, z1: 1300, b: 27 },
    { x0: -2600, x1: -1500, z0: 1500, z1: 2300, b: 18 },
  ];
  // Sea on the right: the coastline pulls closer the further right we look.
  const coastZ = (a) => {
    if (a < 0.1) return Infinity;
    const wob = 1 + 0.1 * Math.sin(a * 37) + 0.05 * Math.sin(a * 91);
    return (800 + 9000 * Math.exp(-(a - 0.1) * 3.5)) * wob;
  };

  // ------------------------------------------------------------ mountains
  const mtnH = [new Float32Array(W), new Float32Array(W), new Float32Array(W)];
  {
    const n1 = noise1(11), n2 = noise1(23), n3 = noise1(37);
    for (let x = 0; x < W; x++) {
      const e1 = smooth(134, 92, x) * (0.75 + 0.25 * smooth(0, 50, x));
      mtnH[0][x] = e1 * (3.5 + 8 * Math.pow(n1(x / 19), 1.5) + 2.4 * n1(x / 6 + 40));
      const e2 = smooth(118, 78, x);
      mtnH[1][x] = e2 * (1.8 + 4.2 * Math.pow(n2(x / 13), 1.3) + 1.1 * n2(x / 4.5 + 9));
      const e3 = smooth(108, 60, x);
      mtnH[2][x] = e3 * (0.9 + 1.6 * n3(x / 8));
      // islands out at sea
      const isl = (c, r, hgt) => {
        const d = (x - c) / r;
        return d * d < 1 ? hgt * (1 - d * d) : 0;
      };
      mtnH[0][x] = Math.max(mtnH[0][x], isl(156, 6, 2.6), isl(181, 5, 1.8), isl(196, 3, 1.1));
    }
  }
  // a radio mast on the mid ridge, with a red light
  let mastX = 0, mastTop = 0;
  {
    let best = -1;
    for (let x = 25; x < 70; x++) if (mtnH[1][x] > best) { best = mtnH[1][x]; mastX = x; }
  }

  for (let y = 0; y < HZ; y++) {
    const el = HZ - (y + 0.5);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (el < mtnH[2][x]) mat[i] = MTN3;
      else if (el < mtnH[1][x]) mat[i] = MTN2;
      else if (el < mtnH[0][x]) mat[i] = MTN1;
    }
  }
  {
    const ridgeY = Math.round(HZ - 0.5 - mtnH[1][mastX]);
    for (let k = 1; k <= 3; k++) {
      const y = ridgeY - k + 1;
      if (y >= 0) mat[y * W + mastX] = MTN2;
    }
    mastTop = ridgeY - 3;
  }

  // ------------------------------------------------------------ city ground
  for (let y = HZ; y < CITY_END; y++) {
    const zc = K / (y + 0.5 - HZ);
    const zN = K / (y + 1 - HZ);
    const zF = y === HZ ? Infinity : K / (y - HZ);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const a = (x + 0.5 - CX) / F;
      if (zc > coastZ(a)) { mat[i] = SEA; continue; }
      if (zc > CITY_FAR) { mat[i] = MTN3; continue; }
      fog[i] = 1 - Math.exp(-zc / VIS);
      const xw = a * zc, pw = zc / F;
      let road = false;
      for (const r of HROADS) if (r.z1 > zN && r.z0 < zF) road = true;
      for (const r of VROADS) if (Math.abs(xw - r.x) < r.w / 2 + pw * 0.45) road = true;
      if (road) { mat[i] = ROAD; setAlb(i, ASPHALT, 0.95 + 0.1 * noiz[i]); continue; }
      if (zc < 950 + 500 * noiz[i]) {
        mat[i] = GROUND;
        setAlb(i, rng() < 0.03 ? pick(TREE) : pick(ALLEY));
      } else {
        // far city: a sub-pixel carpet of roofs, walls and windows
        mat[i] = rng() < 0.6 ? ROOF : FACE;
        setAlb(i, mat[i] === ROOF ? roofColor() : faceColor(), 0.9 + 0.2 * noiz[i]);
        if (rng() < 0.34) { win[i] = 1 + Math.floor(rng() * 254); tint[i] = windowTint(); }
      }
    }
  }

  // ------------------------------------------------------------ buildings
  const aviation = []; // red lights on tall roofs
  const put = (x, y, m, c, z, w, ti) => {
    if (x < 0 || x >= W || y < HZ - 30 || y >= CITY_END) return;
    const i = y * W + x;
    if (mat[i] === SEA) return;
    mat[i] = m;
    setAlb(i, c, 0.97 + 0.06 * noiz[i]);
    fog[i] = 1 - Math.exp(-z / VIS);
    win[i] = w || 0;
    tint[i] = ti || 0;
  };

  // less sky reaches the bottom of a deep street, so walls darken toward it
  const canyonAO = (y, top, bottom) => {
    const up = (bottom - 1 - y) / Math.max(1, bottom - top - 1);
    return 0.7 + 0.3 * smooth(0, 0.5, up);
  };
  // street-level shop fronts: most light up early in the evening
  const shopAt = () => (rng() < 0.6 ? 1 + Math.floor(rng() * 90) : 0);

  // Height above the street for ordinary blocks. A slow-varying "district"
  // field makes some neighbourhoods keep more old 2-4 storey houses, so the
  // low roofs come in pockets rather than as random noise.
  const field = (xw, z, cell, seed) => {
    const gx = xw / cell, gz = z / cell;
    const ix = Math.floor(gx), iz = Math.floor(gz);
    const u = smooth(0, 1, gx - ix), v = smooth(0, 1, gz - iz);
    const c = (a, b) => hash(Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ seed);
    return lerp(lerp(c(ix, iz), c(ix + 1, iz), u), lerp(c(ix, iz + 1), c(ix + 1, iz + 1), u), v);
  };
  // Taller blocks gather in a few busier districts and along the cross
  // avenues; old low houses gather in others. Blocks on our side of a radial
  // boulevard stay mid-rise so the boulevard is not walled off from view.
  const nearAvenue = (z) => HROADS.some((r) => z > r.z0 - 50 && z < r.z1 + 50);
  const screensBoulevard = (xw) =>
    VROADS.some((r) => Math.sign(r.x) * (r.x - xw) > 0 && Math.abs(xw - r.x) < r.w / 2 + 40);
  const houseHeight = (xw, z) => {
    const old = field(xw, z, 380, 0), busy = field(xw, z, 520, 0x5bd1e995);
    let pTall = 0.05 + 0.5 * busy * busy * busy + (nearAvenue(z) ? 0.12 : 0);
    if (screensBoulevard(xw)) pTall = 0;
    const pLow = (0.14 + 0.56 * old * old) * (1 - busy * 0.8);
    const r = rng();
    if (r < pLow) return 6 + rng() * 7;                     // old low houses
    if (r < pLow + pTall) return 32 + rng() * 22;           // 11-18 storey blocks
    return 16 + rng() * 12;                                 // the usual 5-9 storeys
  };

  const drawBox = (bx) => {
    const { x0, x1, z0, z1, b } = bx;
    const top = CAM_H - b;
    const yb = HZ + K / z0, yt = HZ + (F * top) / z0, yr = HZ + (F * top) / z1;
    const winAt = (density) => (rng() < density ? 1 + Math.floor(rng() * 254) : 0);
    // roof
    for (let y = Math.round(yr); y < Math.round(yt); y++) {
      const zz = clamp((F * top) / (y + 0.5 - HZ), z0, z1);
      const xa = Math.round(CX + (F * x0) / zz), xb = Math.round(CX + (F * x1) / zz);
      for (let x = xa; x < xb; x++) {
        let c = bx.roof;
        if (bx.tanks && rng() < 0.05) c = rng() < 0.6 ? hex('#4d78a8') : hex('#d8d8d0');
        put(x, y, bx.park ? PARK : ROOF, bx.park ? pick(TREE) : c, zz);
      }
    }
    // side wall facing the centre line
    if (x0 > 0 || x1 < 0) {
      const xe = x0 > 0 ? x0 : x1;
      const sb = CX + (F * xe) / z1, sf = CX + (F * xe) / z0;
      const c0 = Math.round(Math.min(sb, sf)), c1 = Math.round(Math.max(sb, sf));
      for (let x = c0; x < c1; x++) {
        const zz = clamp((F * xe) / (x + 0.5 - CX), z0, z1);
        const t0 = Math.round(HZ + (F * top) / zz), t1 = Math.round(HZ + K / zz);
        const shopRows = Math.max(1, Math.round((F * 4) / zz));
        for (let y = t0; y < t1; y++) {
          if (bx.park) { put(x, y, PARK, pick(TREE), zz); continue; }
          const ao = canyonAO(y, t0, t1);
          if (t1 - y <= shopRows && t1 - t0 > 2) {
            put(x, y, SIDE, bx.face.map((v) => v * ao), zz, shopAt(), shopTint());
          } else {
            put(x, y, SIDE, bx.face.map((v) => v * ao), zz, winAt(bx.wd * 0.5), windowTint());
          }
        }
      }
    }
    // front wall, facing us
    const xa = Math.round(CX + (F * x0) / z0), xb = Math.round(CX + (F * x1) / z0);
    const fy0 = Math.round(yt), fy1 = Math.round(yb);
    const shopRows = Math.max(1, Math.round((F * 4) / z0));
    for (let y = fy0; y < fy1; y++) {
      const ao = canyonAO(y, fy0, fy1);
      const face = bx.face ? bx.face.map((v) => v * ao) : null;
      for (let x = xa; x < xb; x++) {
        if (bx.park) { put(x, y, PARK, pick(TREE), z0); continue; }
        if (y === fy0 && fy1 - fy0 >= 3) { put(x, y, ROOF, bx.face, z0); continue; }
        if (fy1 - y <= shopRows && fy1 - fy0 > 2 && !bx.slab) {
          put(x, y, FACE, face, z0, shopAt(), shopTint());
          continue;
        }
        let w = 0;
        if (bx.slab) w = (x - xa) % 2 === 0 ? winAt(bx.wd) : 0;
        else w = winAt(bx.wd);
        put(x, y, FACE, face, z0, w, bx.office ? (rng() < 0.85 ? 1 : 2) : windowTint());
      }
    }
    if (bx.b > 44 && z0 < 2600) {
      const ax = Math.round(CX + (F * (x0 + x1)) / 2 / z0), ay = Math.round(yr) - 1;
      if (ay >= HZ && ax >= 6 && ax < W) aviation.push({ i: ay * W + ax, ph: rng() * 1.6 });
    }
  };

  {
    const rows = [];
    let z = 232;
    while (z < CITY_FAR) {
      const d = z * (0.065 + rng() * 0.03);
      rows.push([z, z + d]);
      z += d + z * (0.004 + rng() * 0.007);
    }
    for (let ri = rows.length - 1; ri >= 0; ri--) {
      const [z0, z1] = rows[ri];
      if (HROADS.some((r) => z1 > r.z0 - 4 && z0 < r.z1 + 4)) continue;
      const lots = [];
      const xL = (-(CX + 8) * z1) / F, xR = ((W - CX + 8) * z1) / F;
      let x = xL + rng() * 10;
      while (x < xR) {
        const cpx = x / z0; // screen-space slope, for the coast test
        const cx = COMPLEXES.find((c) => x > c.x0 && x < c.x1 && z0 > c.z0 && z0 < c.z1);
        let bx;
        if (cx) {
          if (ri % 2 === 0) {
            bx = { w: 58, gap: 24, d: 13, b: cx.b, slab: true, wd: 0.85,
              face: pick(SLAB_FACE), roof: pick(ROOFS_GREY) };
          } else {
            x += 30; // parking between slabs
            continue;
          }
        } else {
          const r = rng();
          if (r < 0.007 && z0 > 850 && z0 < 3600) {
            const office = rng() < 0.6;
            bx = { w: 22 + rng() * 18, gap: 4, d: Math.min(z1 - z0, 26), b: 45 + rng() * 22,
              wd: 0.7, office, face: office ? hex('#7f93a8') : pick(FACES_GREY), roof: hex('#8d8f92') };
          } else if (r < 0.012) {
            bx = { w: 30 + rng() * 30, gap: 2, d: z1 - z0, b: 4 + rng() * 4 - DROP, park: true };
          } else {
            const w = 9 + rng() * 16;
            bx = { w, gap: rng() < 0.12 ? 1.5 + rng() * 2 : 0, d: z1 - z0,
              b: houseHeight(x + w / 2, z0) - DROP, wd: 0.32, face: faceColor(), roof: roofColor(), tanks: true };
          }
        }
        const x0 = x, x1 = x + bx.w;
        x = x1 + bx.gap;
        if (VROADS.some((r) => x1 > r.x - r.w / 2 - 3 && x0 < r.x + r.w / 2 + 3)) continue;
        if (z0 > coastZ(cpx)) continue;
        Object.assign(bx, { x0, x1, z0, z1: z0 + bx.d });
        lots.push(bx);
        // rooftop room (옥탑방) on some near houses
        if (!bx.park && !bx.slab && bx.b < 16 && z0 < 800 && rng() < 0.22) {
          const ww = bx.w * (0.3 + rng() * 0.2), off = rng() * (bx.w - ww);
          lots.push({ x0: x0 + off, x1: x0 + off + ww, z0: z0 + bx.d * 0.45, z1: z0 + bx.d * 0.9,
            b: bx.b + 2.6, wd: 0.3, face: pick(FACES_WHITE), roof: pick(ROOFS_BLUE.concat(ROOFS_GREY)), child: true });
        }
      }
      // outer lots first so that lots nearer the centre line overlap them
      lots.sort((p, q) => {
        const dp = Math.abs(p.x0 + p.x1), dq = Math.abs(q.x0 + q.x1);
        if (p.child !== q.child) return p.child ? 1 : -1;
        return dq - dp;
      });
      for (const bx of lots) drawBox(bx);
    }
  }

  // ------------------------------------------------------------ street lamps
  const lamps = [];
  {
    const addLamp = (xw, z) => {
      const x = Math.round(CX + (F * xw) / z - 0.5), y = Math.round(HZ + K / z - 0.5);
      if (x < 0 || x >= W || y < HZ) return;
      const s = clamp(420 / z, 0.18, 1);
      const seen = y < CITY_END && mat[y * W + x] === ROAD;
      if (seen) lamps.push({ i: y * W + x, s });
      // light bounces up out of the street even where the street itself is
      // hidden: a faint warm wash on the walls just above it
      const k = seen ? 0.5 : 0.16;
      const rx = seen ? 2 : 1, ry0 = seen ? -2 : -2, ry1 = seen ? 2 : 0;
      for (let dy = ry0; dy <= ry1; dy++) {
        for (let dx = -rx; dx <= rx; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || xx >= W || yy < HZ || yy >= CITY_END) continue;
          const d2 = dx * dx + dy * dy * 2;
          glow[yy * W + xx] += (s * k) / (1 + d2);
        }
      }
    };
    for (const r of HROADS) {
      const zs = [r.z0 + 3, (r.z0 + r.z1) / 2, r.z1 - 3];
      for (const z of zs) {
        const xm = ((W - CX + 4) * z) / F;
        for (let xw = -xm; xw < xm; xw += 30 + rng() * 6) addLamp(xw, z);
      }
    }
    for (const r of VROADS) {
      for (const side of [-1, 1]) {
        for (let z = 240; z < 6000; z += Math.max(36, z * 0.05)) addLamp(r.x + side * (r.w / 2 - 2), z);
      }
      for (let z = 260; z < 6000; z += Math.max(48, z * 0.06)) addLamp(r.x, z);
    }
    for (let i = 0; i < N; i++) glow[i] = Math.min(glow[i], 0.75);
  }

  // cars: horizontal avenues (two directions) and radial boulevards
  const lanes = [];
  for (const r of HROADS) {
    const zc = (r.z0 + r.z1) / 2;
    const xm = ((W - CX + 8) * zc) / F;
    for (const f of [0.15, 0.35, 0.65, 0.85]) {
      lanes.push({ kind: 'h', z: lerp(r.z0, r.z1, f), dir: f < 0.5 ? -1 : 1, xm, cars: [] });
    }
  }
  for (const r of VROADS) {
    for (const f of [-0.35, -0.12, 0.12, 0.35]) {
      // one carriageway comes toward us, the other drives away
      lanes.push({ kind: 'v', x: r.x + f * r.w, dir: f < 0 ? -1 : 1, cars: [] });
    }
  }
  for (const ln of lanes) {
    const n = ln.kind === 'h' ? 9 + Math.floor(rng() * 6) : 26;
    for (let k = 0; k < n; k++) {
      ln.cars.push({
        p: ln.kind === 'h' ? lerp(-ln.xm, ln.xm, rng()) : lerp(240, 7000, rng()),
        v: 9 + rng() * 8,
        c: pick(P('#e8e8e4', '#303236', '#a9adb2', '#8a2b2b', '#2f4a6e')),
      });
    }
  }

  // boats and a harbour light
  const seaRows = [];
  for (let y = HZ; y < CITY_END; y++) {
    let c = 0;
    for (let x = 0; x < W; x++) if (mat[y * W + x] === SEA) c++;
    if (c > 8) seaRows.push(y);
  }
  const boats = [];
  for (let k = 0; k < 3; k++) {
    boats.push({ x: 125 + rng() * 80, y: seaRows[1 + Math.floor(rng() * (seaRows.length - 1))] || HZ + 1,
      v: (rng() < 0.5 ? -1 : 1) * (0.08 + rng() * 0.12) });
  }
  let harbour = -1;
  {
    const y = seaRows[seaRows.length - 2] || HZ + 3;
    for (let x = 110; x < W; x++) {
      if (mat[y * W + x] === SEA) { harbour = y * W + x - 1; break; }
    }
  }

  // ------------------------------------------------------------ foreground
  {
    const CEIL_C = hex('#8f8a82'), BEAM_C = hex('#a19b91'), PILLAR_C = hex('#9a948a'),
      CAP_C = hex('#cbc4b4'), WALL_C = hex('#b5ad9d');
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (x <= 5) {
          mat[i] = PILLAR;
          setAlb(i, PILLAR_C, (x === 5 ? 1.1 : x === 0 ? 0.85 : 1) * (0.96 + 0.06 * noiz[i]));
          rimW[i] = x === 5 && y > SKY_TOP ? 0.35 : 0;
          continue;
        }
        if (y <= 4) {
          mat[i] = CEIL;
          setAlb(i, CEIL_C, (0.82 + y * 0.04) * (0.97 + 0.05 * noiz[i]));
        } else if (y <= 7) {
          mat[i] = BEAM;
          setAlb(i, BEAM_C, (y === 7 ? 0.8 : 1) * (0.96 + 0.06 * noiz[i]));
          rimW[i] = y === 7 ? 0.2 : 0;
        } else if (y >= CITY_END && y <= 88) {
          mat[i] = CAP;
          setAlb(i, CAP_C, (y === 86 ? 1.05 : 1) * (0.95 + 0.08 * noiz[i]));
          rimW[i] = y === 86 ? 1 : 0.35;
        } else if (y > 88) {
          mat[i] = PARAPET;
          const stain = noiz[x] < 0.12 ? 0.95 : 1; // vertical rain streaks
          setAlb(i, WALL_C, (1 - (y - 89) * 0.012) * stain * (0.95 + 0.07 * noiz[i]));
        }
      }
    }
  }

  // ------------------------------------------------------------ sky objects
  const stars = [];
  for (let k = 0; k < 80; k++) {
    const y = Math.floor(SKY_TOP + Math.pow(rng(), 1.4) * (HZ - SKY_TOP - 5));
    stars.push({ x: Math.floor(rng() * W), y, m: 0.25 + 0.75 * Math.pow(rng(), 2.2),
      ph: rng() * 6.28, sp: 1 + rng() * 3 });
  }

  const makeCloud = (cw, ch, y, v, thin) => {
    const s = new Uint8Array(cw * ch);
    if (thin) {
      const n = noise1(Math.floor(rng() * 1e6));
      for (let i = 0; i < cw; i++) {
        const e = Math.sin((Math.PI * (i + 0.5)) / cw);
        const v2 = n(i / 4) * e;
        const j = n(i / 9 + 50) > 0.5 ? 0 : 1;
        if (v2 > 0.28) s[j * cw + i] = 1;
      }
    } else {
      const puffs = [{ cx: cw * (0.35 + 0.3 * rng()), rx: cw * (0.22 + 0.1 * rng()), hh: ch }];
      const n = 2 + Math.floor(cw / 9);
      for (let k = 0; k < n; k++) {
        puffs.push({ cx: cw * (0.1 + 0.8 * rng()), rx: cw * (0.1 + 0.14 * rng()), hh: ch * (0.35 + 0.5 * rng()) });
      }
      for (let i = 0; i < cw; i++) {
        let top = 0;
        for (const p of puffs) {
          const d = (i + 0.5 - p.cx) / p.rx;
          if (d * d < 1) top = Math.max(top, p.hh * Math.sqrt(1 - d * d));
        }
        for (let j = 0; j < ch; j++) {
          const fromBottom = ch - j;
          if (fromBottom <= top) s[j * cw + i] = fromBottom <= top - 0.9 ? 2 : 1;
        }
      }
    }
    return { s, cw, ch, x: rng() * (W + 60) - 30, y, v };
  };
  const clouds = [];
  // a few big puffs, some small ones further off, and high cirrus streaks
  for (let k = 0; k < 4; k++) {
    const y = Math.floor(12 + rng() * 16);
    clouds.push(makeCloud(30 + Math.floor(rng() * 30), 5 + Math.floor(rng() * 4), y, -(0.55 + 0.4 * rng())));
  }
  for (let k = 0; k < 6; k++) {
    const y = Math.floor(26 + rng() * 13);
    clouds.push(makeCloud(10 + Math.floor(rng() * 14), 3 + Math.floor(rng() * 2), y, -(0.2 + 0.2 * rng())));
  }
  for (let k = 0; k < 3; k++) {
    clouds.push(makeCloud(34 + Math.floor(rng() * 30), 2, 9 + Math.floor(rng() * 8), -0.35, true));
  }

  // ------------------------------------------------------------ time of day
  // hour, zenith, mid, horizon, glow, glowI, belt, beltI, roof, face, fg,
  // rim, cloud-lit, cloud-shade, lit-from-below, cloud alpha, far mtn, near mtn, sea
  const KEYS = [
    [0, '#070b1f', '#0d1633', '#1a2346', '#000000', 0, '#000000', 0, [.13, .14, .21], [.10, .11, .17], [.17, .18, .24], 0, '#262a44', '#15192e', .8, .55, '#141b36', '#0c1127', '#0f1631'],
    [4.6, '#0a1230', '#15204a', '#2a3660', '#000000', 0, '#000000', 0, [.14, .15, .23], [.11, .12, .19], [.19, .20, .26], 0, '#2b3252', '#1a2140', .5, .6, '#1c2649', '#121a37', '#18234a'],
    [5.6, '#2a4e8e', '#6f83b4', '#5c6a96', '#000000', 0, '#e6a2ad', .5, [.42, .42, .52], [.55, .46, .52], [.44, .44, .52], .1, '#f2b6be', '#8b83aa', .6, .8, '#6c7599', '#4f587c', '#63729c'],
    [6.6, '#467bc5', '#9ab8db', '#e4d0cc', '#000000', 0, '#f3c1b1', .25, [.9, .88, .86], [1.12, 1.0, .88], [.8, .78, .78], .15, '#fff0e2', '#c9b9cb', .3, .85, '#8f9fc0', '#6e82a6', '#8aa6cb'],
    [9, '#397ad3', '#86b9ec', '#d5e8f4', '#000000', 0, '#000000', 0, [1.16, 1.16, 1.14], [1.06, 1.02, 1.0], [.98, .98, 1.0], .2, '#ffffff', '#c3d0e2', 0, .85, '#8ea3c4', '#6d84a8', '#7ea2cf'],
    [13, '#2775d7', '#7ab6ef', '#d2e6f5', '#fff4d4', .12, '#000000', 0, [1.2, 1.2, 1.17], [.88, .9, .97], [.95, .95, .98], .25, '#ffffff', '#c0cce0', 0, .85, '#8ca2c4', '#6b83a8', '#7aa0cf'],
    [16, '#3675ce', '#8cb5e4', '#e8e6d7', '#ffedb3', .38, '#000000', 0, [1.12, 1.07, .98], [.72, .74, .84], [.84, .84, .86], .4, '#fff9ed', '#bec6d8', 0, .85, '#8c9cb8', '#6b7c9a', '#8fa8c6'],
    [17.3, '#2f65bb', '#869fcf', '#f0c686', '#ffc95f', .67, '#000000', 0, [1.0, .84, .66], [.42, .44, .58], [.60, .56, .58], .8, '#ffe8c2', '#b7a9c2', .4, .9, '#8a88a8', '#65637f', '#d5b88e'],
    [18.0, '#234ea5', '#7e83c4', '#f6944e', '#ffa039', .98, '#000000', 0, [.7, .6, .64], [.3, .31, .46], [.50, .45, .50], 1, '#ffbe8b', '#9980b2', .85, .95, '#6f6890', '#4b4468', '#df9f70'],
    [18.35, '#204598', '#7e77b7', '#f47638', '#ff7527', 1, '#000000', 0, [.56, .45, .5], [.23, .24, .37], [.42, .38, .45], .9, '#ff9f73', '#856ca8', 1, 1, '#5f5884', '#3e395c', '#d8865e'],
    [18.7, '#173981', '#6366ac', '#ec7756', '#ff734a', .76, '#000000', 0, [.45, .38, .42], [.25, .26, .38], [.34, .32, .40], .4, '#f38a91', '#645598', 1, 1, '#4c4a74', '#302e4e', '#b47889'],
    [19.1, '#122c6f', '#34468f', '#a46887', '#d06470', .39, '#000000', 0, [.28, .27, .38], [.18, .20, .32], [.26, .26, .36], .1, '#b67397', '#443e78', 1, .9, '#2d3262', '#1d2140', '#5b5885'],
    [19.8, '#101b47', '#1d295b', '#3a3a69', '#000000', 0, '#000000', 0, [.16, .16, .25], [.12, .13, .21], [.20, .20, .28], 0, '#34324f', '#23233e', .8, .7, '#1b2248', '#121834', '#21274e'],
    [22, '#080d24', '#0f1837', '#1f2649', '#000000', 0, '#000000', 0, [.13, .14, .21], [.10, .11, .17], [.17, .18, .24], 0, '#282b45', '#171a30', .8, .55, '#141b36', '#0c1127', '#0f1631'],
  ].map((k) => k.map((v) => (typeof v === 'string' ? hex(v) : v)));
  KEYS.push([24].concat(KEYS[0].slice(1)));

  const WIN_CURVE = [[0, .45], [2, .28], [4.5, .12], [5.8, .22], [7.3, .08], [8.5, .03], [17.6, .03],
    [18.4, .18], [19.4, .55], [21.5, .62], [23.5, .5], [24, .45]];

  const curve = (tab, h) => {
    for (let k = 0; k < tab.length - 1; k++) {
      if (h <= tab[k + 1][0]) return lerp(tab[k][1], tab[k + 1][1], (h - tab[k][0]) / (tab[k + 1][0] - tab[k][0]));
    }
    return tab[tab.length - 1][1];
  };

  const L = {};
  const lightAt = (h) => {
    let k = 0;
    while (k < KEYS.length - 2 && h > KEYS[k + 1][0]) k++;
    const a = KEYS[k], b = KEYS[k + 1];
    const t = smooth(0, 1, (h - a[0]) / (b[0] - a[0]));
    const m = (idx) => (Array.isArray(a[idx]) ? a[idx].map((v, j) => lerp(v, b[idx][j], t)) : lerp(a[idx], b[idx], t));
    L.zen = m(1); L.mid = m(2); L.hor = m(3); L.glow = m(4); L.glowI = m(5);
    L.belt = m(6); L.beltI = m(7); L.roof = m(8); L.face = m(9); L.fg = m(10);
    L.rim = m(11); L.cHi = m(12); L.cLo = m(13); L.cFlip = m(14); L.cA = m(15);
    L.mFar = m(16); L.mNear = m(17); L.sea = m(18);
    // shade stays close to neutral grey rather than picking up the sky's blue
    const grey = (c, k) => { const y = 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]; return c.map((v) => lerp(v, y, k)); };
    L.face = grey(L.face, 0.75);
    L.side = grey(L.roof.map((v, j) => (v + L.face[j]) * 0.45), 0.5);
    L.ground = grey(L.roof.map((v, j) => lerp(v, L.face[j], 0.6) * 0.95), 0.6);
    L.bounce = grey(L.mid, 0.7);
    L.stars = h < 12 ? 1 - smooth(4.9, 5.9, h) : smooth(19.0, 20.1, h);
    L.day = h < 12 ? smooth(5.4, 7.0, h) : 1 - smooth(18.2, 19.4, h);
    L.win = curve(WIN_CURVE, h);
    L.street = h < 12 ? 1 - smooth(5.8, 6.3, h) : smooth(18.45, 18.85, h);
    L.rimC = L.hor.map((v, j) => lerp(v, L.glow[j], 0.5) * L.rim * 0.55);
    return L;
  };

  const sun = { x: 0, y: 0, el: -90 };
  const sunAt = (h) => {
    const u = (h - 12.3) / 6.05;
    if (u < 0 || u > 1.6) { sun.el = -90; sun.x = 140; sun.y = HZ + 60; return sun; }
    const az = 180 + 90 * u, el = 52 * Math.cos((u * Math.PI) / 2);
    sun.el = el;
    sun.x = CX + F * Math.tan(((az - FACE_AZ) * Math.PI) / 180);
    sun.y = HZ - F * Math.tan((el * Math.PI) / 180);
    return sun;
  };
  // A young crescent (~4 days old) that follows the sun down into the west.
  // Same diurnal motion as the sun (down and to the right when facing west),
  // but lower in the sky and setting ~3h later, a little south of the sun.
  const moon = { x: 0, y: 0, a: 0, lx: 1, ly: 0 };
  const moonAt = (h) => {
    const u = (h - 15.13) / 6.05;
    if (u < 0.45 || u > 1.08) { moon.a = 0; return moon; }
    const az = 156 + 90 * u, el = 34 * Math.cos((u * Math.PI) / 2);
    moon.x = CX + F * Math.tan(((az - FACE_AZ) * Math.PI) / 180);
    moon.y = HZ - F * Math.tan((el * Math.PI) / 180);
    moon.a = 0.3 + 0.7 * (1 - L.day);
    // the lit limb faces the sun, which is already below the horizon
    const dx = sun.x - moon.x, dy = sun.y - moon.y, n = Math.hypot(dx, dy) || 1;
    moon.lx = dx / n; moon.ly = dy / n;
    return moon;
  };

  // ------------------------------------------------------------ rendering
  const col = new Float32Array(N * 3);
  const haze = new Float32Array(W * 3);
  const tmp = [0, 0, 0];

  const skyAt = (x, y, o) => {
    const t = clamp((HZ - y) / (HZ - SKY_TOP), 0, 1);
    let r, g, b;
    if (t < 0.4) {
      const u = Math.pow(t / 0.4, 0.8);
      r = lerp(L.hor[0], L.mid[0], u); g = lerp(L.hor[1], L.mid[1], u); b = lerp(L.hor[2], L.mid[2], u);
    } else {
      const u = Math.pow((t - 0.4) / 0.6, 0.9);
      r = lerp(L.mid[0], L.zen[0], u); g = lerp(L.mid[1], L.zen[1], u); b = lerp(L.mid[2], L.zen[2], u);
    }
    if (L.glowI > 0) {
      const dx = x - sun.x, dy = (y - sun.y) * 1.25;
      const d = Math.sqrt(dx * dx + dy * dy);
      const halo = Math.exp(-d / 13) * 0.55;
      const core = Math.exp(-d / 4.5) * 0.22;
      const band = Math.exp(-Math.abs(dx) / 62) * Math.exp(-(HZ - y) / 7.5) * 0.85;
      const gl = Math.min(0.92, L.glowI * (halo + band));
      r = lerp(r, L.glow[0], gl) + core * L.glowI;
      g = lerp(g, L.glow[1], gl) + core * L.glowI * 0.85;
      b = lerp(b, L.glow[2], gl) + core * L.glowI * 0.6;
    }
    if (L.beltI > 0) {
      const bl = L.beltI * Math.exp(-Math.pow((t - 0.2) / 0.09, 2));
      r = lerp(r, L.belt[0], bl); g = lerp(g, L.belt[1], bl); b = lerp(b, L.belt[2], bl);
    }
    o[0] = r; o[1] = g; o[2] = b;
    return o;
  };

  const blend = (i, c, a) => {
    const j = i * 3;
    col[j] += (c[0] - col[j]) * a;
    col[j + 1] += (c[1] - col[j + 1]) * a;
    col[j + 2] += (c[2] - col[j + 2]) * a;
  };
  const add = (i, c, k) => {
    const j = i * 3;
    col[j] += c[0] * k; col[j + 1] += c[1] * k; col[j + 2] += c[2] * k;
  };
  const isSkyish = (m) => m <= MTN3;
  const WHITE = [1, 1, 1], RED = hex('#ff4a3a'), GREEN = hex('#6dff8a');
  const SUN_HI = hex('#fffbea'), SUN_MID = hex('#ffe7a6'), SUN_LO = hex('#ffc27a');
  const MOON_C = hex('#f3efdc'), BIRD_C = hex('#2a2831');
  const HEAD = hex('#fff1c4'), BOAT_DAY = hex('#e8e2d4'), BOAT_LIGHT = hex('#ffe7a6');
  const POT = hex('#a35f41'), POT_RIM = hex('#bb7250'), SOIL = hex('#4a3a30');
  const LEAF = [hex('#5d9a4a'), hex('#4c8340'), hex('#6fae55')];

  // ------------------------------------------------------------ downpours
  // Roughly every other (simulated) day a violent downpour rolls in: a short
  // drizzle, then the sky goes dark and the rain comes down in sheets. Storms
  // only happen between ~21:30 and ~16:00, never in the evening.
  const STORM_SEED = (Math.random() * 1e9) | 0;
  const stormPlan = (d) => {
    const hs = (k) => hash(Math.imul(d, 0x27d4eb2d) ^ Math.imul(k, 0x165667b1) ^ STORM_SEED);
    if (hs(1) > 0.5) return null;
    const a = d * 24 - 1.0 + hs(2) * 13.3;          // 23:00 (day before) .. 12:18
    const len = 1.8 + hs(3) * 1.3;
    return { a, b: Math.min(a + len, d * 24 + 15.6) };
  };
  // Rain asked for with the button runs on real seconds, so it arrives within
  // a few seconds whatever the time of day (the clock crawls at sunset).
  let forced = null, stormOverride = null, clearT = null, clearUntil = 0;
  const FORCED_LEN = 40;
  const forcedAt = () => {
    if (!forced) return 0;
    const x = T - forced.t0;
    if (x < 0) return 0;
    let v = x < 1.2 ? 0.25 * smooth(0, 1.2, x) : lerp(0.25, 1, smooth(1.2, 3.8, x));
    if (x > FORCED_LEN) v *= 1 - smooth(FORCED_LEN, FORCED_LEN + 6, x);
    return v;
  };
  const envelope = (p, t) => {
    const x = t - p.a, len = p.b - p.a;
    if (x < -1.2 || x > len + 0.6) return 0;
    if (x < 0) return 0.25 * smooth(-1.2, 0, x);               // drizzle, slowly thickening
    if (x < 0.9) return lerp(0.25, 1, smooth(0, 0.9, x));      // the deluge takes hold
    if (x < len) return 1;
    return 1 - smooth(len, len + 0.6, x);                      // easing off
  };
  const stormAt = (t) => {
    if (stormOverride !== null) return stormOverride;
    let v = forcedAt();
    const d = Math.floor(t / 24);
    for (let k = d - 1; k <= d + 1; k++) {
      const p = stormPlan(k);
      if (p) v = Math.max(v, envelope(p, t));
    }
    // asked to stop: the rain eases off over a few seconds and stays away a while
    if (clearT !== null) v = Math.min(v, 1 - smooth(clearT, clearT + 3, T));
    return v;
  };
  // smooth 2-D value noise for the racing storm clouds
  const vnoise = (x, y) => {
    const ix = Math.floor(x), iy = Math.floor(y);
    const u = smooth(0, 1, x - ix), v = smooth(0, 1, y - iy);
    const c = (a, b) => hash(Math.imul(a, 374761393) ^ Math.imul(b, 668265263));
    return lerp(lerp(c(ix, iy), c(ix + 1, iy), u), lerp(c(ix, iy + 1), c(ix + 1, iy + 1), u), v);
  };
  const STORM = {
    day: { zen: hex('#4d5561'), mid: hex('#5d656f'), hor: hex('#727980'), cHi: hex('#858c95'),
      cLo: hex('#3a4049'), sea: hex('#3b444e'), rain: hex('#d3dbe4') },
    night: { zen: hex('#0c1018'), mid: hex('#111621'), hor: hex('#1a1f2a'), cHi: hex('#2a303b'),
      cLo: hex('#0e1219'), sea: hex('#0d121a'), rain: hex('#7d8aa0') },
  };
  const SC = {};
  const mixInto = (dst, key, t) => {
    const a = STORM.day[key], b = STORM.night[key];
    dst[key] = [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  };
  const toward = (c, d, t) => [lerp(c[0], d[0], t), lerp(c[1], d[1], t), lerp(c[2], d[2], t)];
  const FLASH_C = hex('#c9d6ff'), CLOUD_DARK = hex('#23272f');

  // The rain is drawn fresh every frame as long, nearly vertical streaks, so
  // it reads as water shot down too fast to follow rather than falling drops.
  const warpPh = new Float32Array(W);
  for (let x = 0; x < W; x++) warpPh[x] = rng() * 6.283;
  const colCopy = new Float32Array(N * 3);
  const sheets = new Float32Array(W);
  const splashes = [], drips = [];
  let splashAcc = 0, dripAcc = 0, wet = 0, S = 0;
  let dripLevel = 0; // the slab above keeps dripping for a while after the rain
  let bolt = null, flashT = -99, nextBolt = 0;

  // animated state
  let T = 0;                   // real seconds since start
  let hour = 17.6;
  let nextFlock = 6, flock = null;
  let nextPlane = 10, plane = null;
  let nextLeaf = 9, leaf = null;
  const startAttr = parseFloat(canvas.dataset.hour);
  if (!Number.isNaN(startAttr)) hour = wrapH(startAttr);
  let absH = hour; // hours since the start of day 0, never wrapped

  const rate = (h) => {
    // hours advanced per real second: unhurried around sunset
    const d = Math.min(Math.abs(h - 18.2), 24 - Math.abs(h - 18.2));
    return 0.17 - 0.155 * Math.exp(-Math.pow(d / 1.5, 2));
  };

  const render = () => {
    const h = hour;
    lightAt(h); sunAt(h); moonAt(h);
    S = stormAt(absH);
    L.dayVis = L.day;
    if (S > 0) {
      const n = 1 - L.day;
      for (const k of ['zen', 'mid', 'hor', 'cHi', 'cLo', 'sea', 'rain']) mixInto(SC, k, n);
      L.zen = toward(L.zen, SC.zen, S * 0.95); L.mid = toward(L.mid, SC.mid, S * 0.95);
      L.hor = toward(L.hor, SC.hor, S * 0.95); L.sea = toward(L.sea, SC.sea, S);
      L.cHi = toward(L.cHi, SC.cHi, S); L.cLo = toward(L.cLo, SC.cLo, S);
      L.cA = lerp(L.cA, 1, S); L.cFlip = lerp(L.cFlip, 0.2, S);
      L.mFar = toward(L.mFar, SC.hor, S * 0.8); L.mNear = toward(L.mNear, SC.hor, S * 0.7);
      const dim = 1 - 0.5 * S * L.day;
      for (const k of ['roof', 'face', 'side', 'ground']) L[k] = L[k].map((v) => v * dim);
      L.fg = L.fg.map((v) => v * (1 - 0.35 * S));
      L.rimC = L.rimC.map((v) => v * (1 - S));
      L.glowI *= (1 - S) * (1 - S); L.beltI *= 1 - S; L.stars *= 1 - S;
      L.dayVis = L.day * (1 - 0.6 * S);
      // dark as dusk at noon: lights come on across the city
      L.win = lerp(L.win, Math.max(L.win, 0.34), S * L.day);
      L.street = Math.max(L.street, 0.75 * smooth(0.4, 1, S));
      moon.a *= 1 - S;
    }
    const sheet = (x) => 0.7 + 0.3 * Math.sin(x * 0.083 + T * 2.1) * Math.sin(x * 0.029 - T * 0.8);

    // haze colour along the horizon
    for (let x = 0; x < W; x++) {
      skyAt(x + 0.5, HZ - 0.5, tmp);
      haze[x * 3] = tmp[0]; haze[x * 3 + 1] = tmp[1]; haze[x * 3 + 2] = tmp[2];
    }

    // ---- sky, mountains
    for (let y = SKY_TOP; y < HZ; y++) {
      for (let x = 6; x < W; x++) {
        const i = y * W + x, m = mat[i];
        if (m === SKY) {
          skyAt(x + 0.5, y + 0.5, tmp);
          if (S > 0) {
            // low, torn cloud racing overhead
            const n = vnoise(x * 0.055 - T * 0.6, y * 0.17) * 0.65 + vnoise(x * 0.14 - T * 1.3, y * 0.33 + 9) * 0.35;
            const k = S * clamp((n - 0.3) * 2.2, 0, 1) * 0.7 * (1 - 0.3 * (1 - L.day));
            const dk = [CLOUD_DARK[0] * (0.4 + 0.6 * L.day), CLOUD_DARK[1] * (0.4 + 0.6 * L.day), CLOUD_DARK[2] * (0.4 + 0.6 * L.day)];
            tmp[0] = lerp(tmp[0], dk[0], k); tmp[1] = lerp(tmp[1], dk[1], k); tmp[2] = lerp(tmp[2], dk[2], k);
          }
          col[i * 3] = tmp[0]; col[i * 3 + 1] = tmp[1]; col[i * 3 + 2] = tmp[2];
        } else if (m >= MTN1 && m <= MTN3) {
          const base = m === MTN1 ? L.mFar : m === MTN3 ? L.mNear : null;
          const el = HZ - y - 0.5;
          const hk = lerp((m === MTN1 ? 0.2 : m === MTN2 ? 0.1 : 0.04) + 0.1 * Math.exp(-el / 2), 0.93, S);
          for (let c = 0; c < 3; c++) {
            const bc = base ? base[c] : lerp(L.mFar[c], L.mNear[c], 0.55);
            col[i * 3 + c] = lerp(bc, haze[x * 3 + c], hk);
          }
        }
      }
    }

    // stars
    if (L.stars > 0.01) {
      for (const s of stars) {
        const i = s.y * W + s.x;
        if (mat[i] !== SKY) continue;
        const tw = 0.65 + 0.35 * Math.sin(T * s.sp + s.ph);
        const fade = smooth(HZ - 4, HZ - 16, s.y);
        add(i, WHITE, L.stars * s.m * tw * fade * 0.9);
      }
    }
    // crescent moon with faint earthshine; each pixel takes the fraction of
    // it the sliver covers, so the moon glides between pixels instead of hopping
    if (moon.a > 0) {
      const R = 3.4, O = 1.9, SS = 6, NS = SS * SS;
      const cx = Math.floor(moon.x), cy = Math.floor(moon.y);
      for (let dy = -5; dy <= 5; dy++) {
        for (let dx = -5; dx <= 5; dx++) {
          const x = cx + dx, y = cy + dy;
          if (x < 6 || x >= W || y < SKY_TOP || y >= HZ) continue;
          const i = y * W + x;
          if (mat[i] !== SKY) continue;
          let lit = 0, disk = 0;
          for (let sy = 0; sy < SS; sy++) {
            for (let sx = 0; sx < SS; sx++) {
              const px = x + (sx + 0.5) / SS - moon.x, py = y + (sy + 0.5) / SS - moon.y;
              if (px * px + py * py >= R * R) continue;
              disk++;
              const qx = px + moon.lx * O, qy = py + moon.ly * O;
              if (qx * qx + qy * qy > R * R) lit++;
            }
          }
          const cl = lit / NS, cd = disk / NS;
          if (cd > 0) add(i, MOON_C, 0.06 * moon.a * L.stars * (cd - cl));
          if (cl > 0) blend(i, MOON_C, moon.a * Math.min(1, cl * 1.2));
          const d = Math.hypot(x + 0.5 - moon.x, y + 0.5 - moon.y);
          if (cd === 0 && d < R + 2.5) add(i, MOON_C, 0.035 * moon.a * L.stars * (1 - (d - R) / 2.5));
        }
      }
    }
    // sun
    if (sun.el > -3 && S < 0.98) {
      const R = 3.2, sc = [0, 0, 0], sa = 1 - S;
      const k1 = smooth(1.5, 9, sun.el), k0 = smooth(-1, 2, sun.el);
      for (let c = 0; c < 3; c++) sc[c] = lerp(lerp(SUN_LO[c], SUN_MID[c], k0), SUN_HI[c], k1);
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = Math.round(sun.x + dx), y = Math.round(sun.y + dy);
          if (x < 6 || x >= W || y < SKY_TOP || y >= HZ) continue;
          const i = y * W + x;
          if (mat[i] !== SKY) continue;
          const d = Math.hypot(x + 0.5 - sun.x, (y + 0.5 - sun.y) * (sun.el < 1.5 ? 1.25 : 1));
          if (d < R) blend(i, sc, sa);
          else if (d < R + 1) blend(i, sc, 0.35 * sa);
        }
      }
    }
    // clouds
    for (const cl of clouds) {
      const ox = Math.round(cl.x);
      for (let j = 0; j < cl.ch; j++) {
        const y = cl.y + j;
        if (y < SKY_TOP || y >= HZ) continue;
        const v = cl.ch > 1 ? j / (cl.ch - 1) : 0.5;
        const lit = lerp(1 - v, v, L.cFlip);
        for (let i2 = 0; i2 < cl.cw; i2++) {
          const s = cl.s[j * cl.cw + i2];
          if (!s) continue;
          const x = ox + i2;
          if (x < 6 || x >= W) continue;
          const i = y * W + x;
          if (!isSkyish(mat[i])) continue;
          if (mat[i] !== SKY && s < 2) continue;
          for (let c = 0; c < 3; c++) tmp[c] = lerp(L.cLo[c], L.cHi[c], lit);
          if (L.glowI > 0) {
            const dx = x - sun.x, dy = (y - sun.y) * 1.25;
            const g = L.glowI * 0.45 * Math.exp(-Math.sqrt(dx * dx + dy * dy) / 30);
            for (let c = 0; c < 3; c++) tmp[c] += L.glow[c] * g;
          }
          blend(i, tmp, (s === 2 ? 1 : 0.5) * L.cA);
        }
      }
    }

    // ---- city, sea
    const litThr = L.win * 255;
    const bk = lerp(0.55, 0.95, L.day);
    const dayK = 1 - 0.75 * L.dayVis;
    const wetGlow = 1 + 0.8 * wet;
    for (let x = 0; x < W; x++) sheets[x] = sheet(x);
    for (let y = HZ; y < CITY_END; y++) {
      for (let x = 6; x < W; x++) {
        const i = y * W + x, m = mat[i], j = i * 3;
        if (m === SEA) {
          const dy = y + 0.5 - HZ;
          skyAt(x + 0.5, HZ - dy * 1.7 - 0.3, tmp);
          const s = 0.93 + 0.07 * Math.sin(x * 1.7 + T * 1.2 + y * 2.3 + noiz[i] * 6);
          for (let c = 0; c < 3; c++) col[j + c] = lerp((tmp[c] * 0.62 + L.sea[c] * 0.38) * s, haze[x * 3 + c], S * 0.55);
          if (S > 0.3 && hash(i * 13 + Math.floor(T * 8) * 977) > 0.975) add(i, WHITE, 0.12 * S * (0.3 + 0.7 * L.day));
          // glitter under a low sun / the moon
          if (sun.el > -1.5 && sun.el < 12) {
            const gx = Math.abs(x + 0.5 - sun.x);
            if (gx < 6) {
              const lowK = smooth(12, 2, sun.el) * smooth(-1.5, 0.5, sun.el);
              const sp = hash(i * 7 + Math.floor(T * 5) * 131) > 0.5 ? 1 : 0.25;
              add(i, L.glow, Math.exp(-gx / 1.8) * lowK * sp * 0.9);
            }
          }
          if (moon.a > 0 && moon.y > HZ - 14) {
            const gx = Math.abs(x + 0.5 - moon.x);
            if (gx < 4) {
              const sp = hash(i * 5 + Math.floor(T * 4) * 71) > 0.55 ? 1 : 0.2;
              add(i, MOON_C, Math.exp(-gx / 1.5) * sp * 0.35 * L.stars);
            }
          }
          continue;
        }
        if (m === MTN3) {
          for (let c = 0; c < 3; c++) col[j + c] = lerp(L.mNear[c], haze[x * 3 + c], 0.25);
          continue;
        }
        const li = m === ROOF || m === PARK ? L.roof : m === FACE ? L.face : m === SIDE ? L.side : L.ground;
        let r = alb[j] * li[0], g = alb[j + 1] * li[1], b = alb[j + 2] * li[2];
        let f = fog[i], emis = false;
        const w = win[i];
        if (w) {
          if (w <= litThr) {
            const tc = TINTS[tint[i]];
            let k = 0.8 + 0.2 * noiz[i];
            if (tint[i] === 3) k *= 0.55 + 0.45 * hash(i * 31 + Math.floor(T * 6));
            const e = dayK;
            r = lerp(r, tc[0] * k, e); g = lerp(g, tc[1] * k, e); b = lerp(b, tc[2] * k, e);
            f *= 0.45;
            emis = true;
          } else {
            r *= 0.8; g *= 0.82; b *= 0.88;
          }
        }
        if (!emis) {
          // sky bounce: pulls the patchwork of roofs toward one palette
          r = lerp(r, L.bounce[0] * bk, 0.2); g = lerp(g, L.bounce[1] * bk, 0.2); b = lerp(b, L.bounce[2] * bk, 0.2);
        }
        const gl = glow[i] * L.street * wetGlow;
        if (gl > 0) { r += SODIUM[0] * gl * 0.6; g += SODIUM[1] * gl * 0.6; b += SODIUM[2] * gl * 0.6; }
        if (S > 0) f = lerp(f, Math.min(1, 0.28 + f * 1.7), S * sheets[x] * (emis ? 0.6 : 1));
        col[j] = lerp(r, haze[x * 3], f);
        col[j + 1] = lerp(g, haze[x * 3 + 1], f);
        col[j + 2] = lerp(b, haze[x * 3 + 2], f);
      }
    }
    // street lamps
    if (L.street > 0.01) {
      for (const lp of lamps) blend(lp.i, SODIUM, L.street * (0.55 + 0.45 * lp.s));
    }
    // traffic
    const night = 1 - L.day;
    for (const ln of lanes) {
      for (const car of ln.cars) {
        let x, y, z;
        if (ln.kind === 'h') {
          x = CX + (F * car.p) / ln.z; y = HZ + K / ln.z; z = ln.z;
        } else {
          x = CX + (F * ln.x) / car.p; y = HZ + K / car.p; z = car.p;
        }
        const xi = Math.floor(x), yi = Math.floor(y);
        if (xi < 6 || xi >= W || yi < HZ || yi >= CITY_END) continue;
        const i = yi * W + xi;
        if (mat[i] !== ROAD) continue;
        const far = 1 - Math.exp(-z / VIS);
        const head = ln.kind === 'h' ? (ln.dir > 0 ? HEAD : RED) : ln.dir < 0 ? HEAD : RED;
        blend(i, car.c, 0.55 * L.day * (1 - far));
        blend(i, head, night * (0.85 - far * 0.3));
      }
    }
    // boats, harbour light
    for (const bt of boats) {
      const i = bt.y * W + Math.floor(bt.x);
      if (bt.x < 6 || bt.x >= W || mat[i] !== SEA) continue;
      blend(i, BOAT_DAY, 0.45 * L.day);
      blend(i, BOAT_LIGHT, 0.9 * night);
    }
    if (harbour >= 0 && night > 0.3 && (T % 4) < 0.45) blend(harbour, GREEN, night);
    // aviation lights (tall roofs + the mountain mast)
    if (night > 0.05) {
      const blink = (ph) => night * smooth(0, 0.25, 0.5 - Math.abs(((T + ph) % 1.6) - 0.5));
      for (const av of aviation) blend(av.i, RED, blink(av.ph));
      if (mastTop >= 0) blend(mastTop * W + mastX, RED, blink(0.4));
    }

    // birds
    if (flock) {
      for (const bd of flock.birds) {
        const bx = Math.round(flock.x + bd.dx), by = Math.round(flock.y + bd.dy + Math.sin(T * 1.7 + bd.ph) * 0.7);
        const up = Math.floor(T * 5 + bd.ph * 3) % 2 === 0;
        const pts = up ? [[-1, -1], [0, 0], [1, -1]] : [[-1, 0], [0, 0], [1, 0]];
        for (const [dx, dy] of pts) {
          const x = bx + dx, y = by + dy;
          if (x < 6 || x >= W || y < SKY_TOP || y >= CITY_END) continue;
          const i = y * W + x;
          if (mat[i] >= CEIL) continue;
          blend(i, BIRD_C, 0.85);
        }
      }
    }
    // aeroplane
    if (plane) {
      const x = Math.floor(plane.x), y = plane.y;
      if (x >= 6 && x < W) {
        const i = y * W + x;
        if (mat[i] === SKY) {
          add(i, WHITE, 0.12);
          if ((T % 1.3) < 0.14) blend(i, RED, 0.95);
          if (Math.abs((T % 1.3) - 0.6) < 0.05) blend(i, WHITE, 1);
        }
      }
    }

    // ---- the downpour, seen past the parapet
    const fl = flashAt();
    if (S > 0.3) {
      // looking through running water: the view behind wobbles and tears in
      // narrow vertical streams that race downward
      const A = 1.45 * smooth(0.3, 1, S);
      colCopy.set(col);
      for (let y = SKY_TOP; y < CITY_END; y++) {
        for (let x = 6; x < W; x++) {
          const i = y * W + x;
          if (mat[i] >= CEIL) continue;
          const band = Math.max(0, Math.sin(x * 0.21 + warpPh[x] * 0.4 + T * 2.3));
          const dx = A * (0.3 + 0.7 * band) * Math.sin(y * 0.7 - T * 21 + warpPh[x]);
          const dy = A * 0.35 * Math.sin(warpPh[x] * 3 + y * 0.31 - T * 16);
          const sx = Math.round(x + dx), sy = Math.round(y + dy);
          if (sx < 6 || sx >= W || sy < SKY_TOP || sy >= CITY_END) continue;
          const si = sy * W + sx;
          if (mat[si] >= CEIL) continue;
          col[i * 3] = colCopy[si * 3]; col[i * 3 + 1] = colCopy[si * 3 + 1]; col[i * 3 + 2] = colCopy[si * 3 + 2];
        }
      }
      // and it washes out toward a pale grey
      const vk = 0.22 * smooth(0.3, 1, S);
      const wash = toward(SC.hor, SC.rain, 0.35);
      for (let y = SKY_TOP; y < CITY_END; y++) {
        for (let x = 6; x < W; x++) {
          const i = y * W + x;
          if (mat[i] >= CEIL) continue;
          const band = 0.55 + 0.45 * Math.sin((x - y * 0.15) * 0.1 - T * 5.5) * Math.sin(x * 0.023 + T * 0.9);
          blend(i, wash, vk * band);
        }
      }
    }
    if (S > 0.01) {
      const rc = SC.rain, slant = rainSlant(), rnd = Math.random;
      const nShort = Math.floor(230 * Math.min(1, S * 1.3));
      const nLong = Math.floor(90 * smooth(0.25, 1, S));
      const bright = 0.6 + 0.4 * L.day + 0.5 * fl;
      for (let k = 0; k < nShort + nLong; k++) {
        const long = k >= nShort;
        const len = long ? 14 + rnd() * 36 : 3 + rnd() * 7;
        const x0 = 6 - len * slant + rnd() * (W - 6 + len * slant), y0 = SKY_TOP + rnd() * (CITY_END - SKY_TOP + len);
        const a0 = (long ? (rnd() < 0.08 ? 0.6 : 0.16 + rnd() * 0.26) : 0.13) * bright * sheet(x0);
        for (let q = 0; q < len; q++) {
          const x = Math.round(x0 - slant * q), y = Math.round(y0 - q);
          if (x < 6 || x >= W || y < SKY_TOP || y >= CITY_END) continue;
          const i = y * W + x;
          if (mat[i] >= CEIL) continue;
          blend(i, rc, a0 * (0.45 + 0.55 * Math.sin((Math.PI * (q + 0.5)) / len)));
        }
      }
    }
    if (fl > 0) {
      for (let y = SKY_TOP; y < CITY_END; y++) {
        for (let x = 6; x < W; x++) {
          const i = y * W + x;
          if (mat[i] >= CEIL) continue;
          add(i, FLASH_C, fl * (y < HZ ? 0.3 : 0.17));
        }
      }
    }

    if (bolt && T - flashT < 0.32 && (T - flashT < 0.09 || T - flashT > 0.17)) {
      for (const [x, y] of bolt) {
        if (x < 7 || x >= W - 1 || y < SKY_TOP || y >= HZ) continue;
        const i = y * W + x;
        if (mat[i] > MTN3) continue;
        add(i - 1, FLASH_C, 0.22); add(i + 1, FLASH_C, 0.22);
        blend(i, WHITE, 1);
      }
    }
    // ---- foreground
    const wetK = 1 - 0.3 * wet;
    for (let i = 0; i < N; i++) {
      const m = mat[i];
      if (m < CEIL) continue;
      const j = i * 3;
      const rw = rimW[i];
      const wk = m === CAP || m === PARAPET ? wetK : m === PILLAR ? 1 - 0.12 * wet : 1;
      const fk = fl * 0.3;
      col[j] = alb[j] * wk * (L.fg[0] + FLASH_C[0] * fk) + L.rimC[0] * rw;
      col[j + 1] = alb[j + 1] * wk * (L.fg[1] + FLASH_C[1] * fk) + L.rimC[1] * rw;
      col[j + 2] = alb[j + 2] * wk * (L.fg[2] + FLASH_C[2] * fk) + L.rimC[2] * rw;
    }
    // potted green onions on the ledge, swaying in the wind
    {
      const gust = 0.6 + 0.4 * Math.sin(T * 0.37) + 0.25 * Math.sin(T * 0.11 + 1);
      const wind = ((1.2 * Math.sin(T * 1.1) + 0.5 * Math.sin(T * 2.7 + 1.3)) * gust - 1.0 * gust) * (1 + 0.8 * S)
        + S * (2.6 + 0.6 * Math.sin(T * 7.3));
      const fgK = (x, c) => [c[0] * L.fg[0], c[1] * L.fg[1], c[2] * L.fg[2]];
      const px0 = 183;
      const potRows = [[0, 8, POT_RIM], [1, 6, POT], [1, 6, POT], [1, 6, POT], [1, 6, POT], [2, 4, POT]];
      potRows.forEach(([o, w, c], k) => {
        const y = 80 + k;
        for (let x = px0 + o; x < px0 + o + w; x++) {
          const cc = fgK(x, c);
          const e = x === px0 + o ? 0.85 : 1;
          const i = y * W + x;
          col[i * 3] = cc[0] * e; col[i * 3 + 1] = cc[1] * e; col[i * 3 + 2] = cc[2] * e;
        }
      });
      for (let x = px0 + 1; x < px0 + 7; x++) {
        const i = 79 * W + x, cc = fgK(x, SOIL);
        col[i * 3] = cc[0]; col[i * 3 + 1] = cc[1]; col[i * 3 + 2] = cc[2];
      }
      const blades = [[1.5, 14, -0.8, 0], [2.5, 17, -0.2, 1], [3.5, 19, 0.15, 2], [4.5, 16, 0.5, 0], [5.5, 12, 1.0, 1], [3, 11, -0.5, 2]];
      for (const [bx0, hgt, lean, ci] of blades) {
        const sway = wind * (0.8 + 0.2 * Math.sin(bx0 * 3.1 + T * 2.2));
        for (let s = 0; s <= 1.0001; s += 1 / (hgt * 1.6)) {
          const x = Math.round(px0 + bx0 + lean * s * 2.5 + sway * s * s * 2.4);
          const y = Math.round(79 - s * hgt + Math.abs(sway) * s * s * 0.8);
          if (x < 0 || x >= W || y < 0) continue;
          const i = y * W + x, cc = fgK(x, LEAF[ci]);
          col[i * 3] = cc[0]; col[i * 3 + 1] = cc[1]; col[i * 3 + 2] = cc[2];
        }
      }
    }
    // an autumn leaf on the wind
    if (leaf) {
      const x = Math.round(leaf.x), y = Math.round(leaf.y);
      const fr = Math.floor(T * 9 + leaf.ph) % 3;
      const pts = fr === 0 ? [[0, 0], [1, 0]] : fr === 1 ? [[0, 0]] : [[0, 0], [0, 1]];
      for (const [dx, dy] of pts) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || xx >= W || yy < 0 || yy >= H) continue;
        const c = leaf.c;
        tmp[0] = c[0] * L.fg[0]; tmp[1] = c[1] * L.fg[1]; tmp[2] = c[2] * L.fg[2];
        blend(yy * W + xx, tmp, 1);
      }
    }

    // water: drops falling off the slab above, splashes on the ledge
    if (drips.length || splashes.length) {
      const rc = toward(STORM.day.rain, STORM.night.rain, 1 - L.day);
      const ds = dripSlant();
      for (const dr of drips) {
        for (let q = 0; q < 3; q++) {
          const x = Math.round(dr.x - ds * q), y = Math.round(dr.y) - q;
          if (x < 6 || x >= W || y < SKY_TOP || y >= CITY_END) continue;
          const i = y * W + x;
          if (mat[i] >= CEIL) continue;
          blend(i, rc, 0.55 * (1 - q / 3));
        }
      }
      for (const sp of splashes) {
        const age = T - sp.t, fr = age < 0.05 ? 0 : age < 0.1 ? 1 : 2;
        const pts = fr === 0 ? [[0, 0], [0, -1]] : fr === 1 ? [[-1, -1], [1, -1], [0, -2]] : [[-2, -1], [2, -1]];
        for (const [dx, dy] of pts) {
          const x = sp.x + dx, y = CITY_END + dy;
          if (x < 6 || x >= W) continue;
          blend(y * W + x, rc, (fr === 2 ? 0.35 : 0.6) * sp.k);
        }
      }
    }

    // time readout while scrubbing or skimming to a new time
    if (T < showClockUntil || jump) drawClock(h);
    if (rainButtons.length) syncRainButtons();

    // ---- quantise with ordered dithering and blit
    const B4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    const LV = 34;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x, j = i * 3, o = i * 4;
        const d = (B4[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
        out[o] = (Math.floor(clamp(col[j], 0, 1) * LV + d) / LV) * 255;
        out[o + 1] = (Math.floor(clamp(col[j + 1], 0, 1) * LV + d) / LV) * 255;
        out[o + 2] = (Math.floor(clamp(col[j + 2], 0, 1) * LV + d) / LV) * 255;
        out[o + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
  };
  // storm wind blows from the left: rain comes down slanting to the right
  const rainSlant = () => 0.16 + 0.06 * Math.sin(T * 0.7) + 0.03 * Math.sin(T * 2.3);
  // once the storm passes the wind drops, and drops fall nearly straight
  const dripSlant = () => rainSlant() * (0.25 + 0.75 * S);
  const flashAt = () => {
    const t = T - flashT;
    if (t < 0 || t > 1) return 0;
    if (t < 0.07) return 1;
    if (t < 0.15) return 0.2;
    if (t < 0.24) return 0.75;
    return 0.75 * Math.exp(-(t - 0.24) * 9);
  };

  // 3x5 digits for the scrub readout
  const GLYPH = {
    0: '111101101101111', 1: '010110010010111', 2: '111001111100111', 3: '111001111001111',
    4: '101101111001001', 5: '111100111001111', 6: '111100111101111', 7: '111001010010010',
    8: '111101111101111', 9: '111101111001111', ':': '000010000010000',
  };
  let showClockUntil = -1;
  const drawClock = (h) => {
    const hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
    const s = String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
    let x0 = W - 4 - s.length * 4 + 1;
    const y0 = SKY_TOP + 3;
    for (const ch of s) {
      const g = GLYPH[ch];
      for (let k = 0; k < 15; k++) {
        if (g[k] !== '1') continue;
        const x = x0 + (k % 3), y = y0 + Math.floor(k / 3);
        blend((y + 1) * W + x + 1, [0, 0, 0], 0.35);
        blend(y * W + x, WHITE, 0.92);
      }
      x0 += 4;
    }
  };

  // ------------------------------------------------------------ simulation
  const step = (dt) => {
    // rain, drips, splashes, lightning
    wet += (S - wet) * dt * (S > wet ? 0.9 : 0.04);
    if (S > 0.01) {
      splashAcc += dt * 38 * S;
      while (splashAcc > 1) { splashAcc--; splashes.push({ x: 6 + Math.floor(rng() * (W - 6)), t: T, k: 0.6 + 0.4 * rng() }); }
      if (S < 0.8 && nextBolt < T + 6) nextBolt = T + 6 + rng() * 10;
      if (S > 0.8 && T > nextBolt) {
        // a bolt somewhere out over the city
        const pts = [];
        let x = Math.round(20 + rng() * 170);
        const y1 = HZ - 1 - Math.floor(rng() * 6);
        for (let y = SKY_TOP; y <= y1; y++) {
          x += Math.round((rng() - 0.5) * 2.4);
          pts.push([x, y]);
          if (rng() < 0.08) {
            let bx = x;
            for (let yy = y + 1; yy < Math.min(y1, y + 6); yy++) { bx += rng() < 0.5 ? -1 : 1; pts.push([bx, yy]); }
          }
        }
        bolt = pts;
        flashT = T;
        nextBolt = T + 16 + rng() * 26;
      }
    }
    // drips: plenty during the storm, then thinning out over a minute or so
    dripLevel = S > dripLevel ? S : Math.max(0, dripLevel - dt * 0.014);
    // (and they have stopped by the time the evening comes round)
    const eve = hour > 16.2 && hour < 21.7 ? 1 - smooth(16.2, 17, hour) : 1;
    dripAcc += dt * (4 * S + 2.6 * dripLevel * (1 - S)) * eve;
    while (dripAcc > 1) { dripAcc--; drips.push({ x: 7 + rng() * (W - 8), y: SKY_TOP, v: 10 }); }
    for (const dr of drips) { dr.v += 320 * dt; dr.y += dr.v * dt; dr.x += dripSlant() * dr.v * dt; }
    while (drips.length && drips[0].y > CITY_END) {
      const dr = drips.shift();
      splashes.push({ x: Math.round(dr.x), t: T, k: 1 });
    }
    while (splashes.length && T - splashes[0].t > 0.16) splashes.shift();

    for (const cl of clouds) {
      cl.x += cl.v * dt;
      if (cl.x < -cl.cw - 10) cl.x = W + 10 + rng() * 40;
    }
    for (const ln of lanes) {
      for (const car of ln.cars) {
        car.p += ln.dir * car.v * dt;
        if (ln.kind === 'h') {
          if (car.p > ln.xm) car.p = -ln.xm;
          if (car.p < -ln.xm) car.p = ln.xm;
        } else {
          if (car.p > 7000) car.p = 240;
          if (car.p < 240) car.p = 7000;
        }
      }
    }
    for (const bt of boats) {
      bt.x += bt.v * dt;
      if (bt.x > W + 2) bt.x = 118;
      if (bt.x < 118) bt.x = W + 1;
    }
    const h = hour;
    if (!flock && T > nextFlock && h > 6.2 && h < 19.2 && S < 0.05) {
      const n = 4 + Math.floor(rng() * 4), birds = [];
      for (let k = 0; k < n; k++) birds.push({ dx: k * 3 + rng() * 2, dy: Math.abs(k - n / 2) * 1.2 + rng() * 1.5, ph: rng() * 6 });
      flock = { x: W + 4, y: 16 + rng() * 20, vx: -(6 + rng() * 4), birds };
    }
    if (flock) {
      flock.x += flock.vx * dt;
      flock.y += Math.sin(T * 0.6) * dt * 0.8;
      if (flock.x < -30) { flock = null; nextFlock = T + 25 + rng() * 45; }
    }
    if (!plane && T > nextPlane && (h > 19.6 || h < 5.3) && S < 0.05) {
      plane = { x: -2, y: 11 + Math.floor(rng() * 12), vx: 1.8 + rng() };
    }
    if (plane) {
      plane.x += plane.vx * dt;
      if (plane.x > W + 3) { plane = null; nextPlane = T + 20 + rng() * 40; }
    }
    if (!leaf && T > nextLeaf) {
      const gale = S > 0.3;
      leaf = { x: gale ? -2 : W + 2, y: 18 + rng() * 55, vx: (gale ? 1 : -1) * (16 + rng() * 12) * (1 + 1.5 * S), ph: rng() * 6,
        c: pick(P('#d98a3a', '#c0582e', '#e0b040', '#b86a2a')) };
    }
    if (leaf) {
      leaf.x += leaf.vx * dt;
      leaf.y += (Math.sin(T * 2.6 + leaf.ph) * 9 + 2.5) * dt;
      if (leaf.x < -3 || leaf.x > W + 3 || leaf.y > H + 2) { leaf = null; nextLeaf = T + (S > 0.5 ? 2 + rng() * 5 : 18 + rng() * 35); }
    }
  };

  // ------------------------------------------------------------ main loop
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let running = false, visible = true, last = 0, acc = 0, raf = 0, dragging = false, jump = null;
  const FRAME = 1 / 24;

  const loop = (now) => {
    raf = 0;
    if (!running) return;
    const dt = Math.min(0.1, (now - last) / 1000 || 0);
    last = now;
    acc += dt;
    if (acc >= FRAME) {
      const d = acc;
      acc = 0;
      T += d;
      if (jump) {
        const k = smooth(0, 1, (T - jump.t0) / jump.dur);
        absH = lerp(jump.from, jump.to, k);
        hour = wrapH(absH);
        if (k >= 1) jump = null;
      } else if (!dragging) {
        absH += rate(hour) * d * (1 - 0.6 * S);
        hour = wrapH(absH);
      }
      if (clearT !== null && absH > clearUntil) clearT = null;
      if (forced && T - forced.t0 > FORCED_LEN + 6) forced = null;
      step(d);
      render();
    }
    raf = requestAnimationFrame(loop);
  };
  const start = () => {
    if (running || reduced || !visible) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(loop);
  };
  const stop = () => {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  if ('IntersectionObserver' in window) {
    new IntersectionObserver((es) => {
      visible = es[es.length - 1].isIntersecting;
      if (visible) start(); else stop();
    }).observe(canvas);
  }

  // drag sideways to scrub the time of day
  let dragX = 0, dragH = 0;
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true; dragX = e.clientX; dragH = absH;
    showClockUntil = T + 1e9;
    if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
    if (!running) render();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const wpx = canvas.getBoundingClientRect().width || W;
    absH = dragH + ((e.clientX - dragX) / wpx) * 12;
    hour = wrapH(absH);
    if (!running) render();
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    showClockUntil = T + 1.5;
    if (!running) { showClockUntil = -1; render(); }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // ------------------------------------------------------------ buttons
  // <button data-mh-hour="12.5">noon</button> skims the clock to that time;
  // <button data-mh-rain>rain</button> brings a downpour in, or sends it away.
  const goTo = (target) => {
    let delta = wrapH(target - hour);
    if (delta > 12) delta -= 24; // take the shorter way round
    if (Math.abs(delta) < 0.02) return;
    if (!running) { absH += delta; hour = wrapH(absH); render(); return; }
    jump = { from: absH, to: absH + delta, t0: T, dur: 0.5 + Math.abs(delta) / 12 };
  };
  const rainButtons = Array.from(document.querySelectorAll('[data-mh-rain]'));
  const dryLabels = rainButtons.map((b) => b.textContent.trim() || 'rain');
  const raining = () => clearT === null && (S > 0.02 || (forced !== null && T - forced.t0 < FORCED_LEN));
  const toggleRain = () => {
    if (raining()) {
      // when the scene is still (reduced motion), skip straight to the end state
      clearT = running ? T : T - 3;
      clearUntil = absH + 4;
      forced = null;
    } else {
      clearT = null;
      forced = { t0: running ? T : T - 4 };
    }
    if (!running) render();
    syncRainButtons();
  };
  let rainLabel = null;
  const syncRainButtons = () => {
    const on = raining();
    if (on === rainLabel) return;
    rainLabel = on;
    rainButtons.forEach((b, k) => {
      b.textContent = on ? b.getAttribute('data-mh-rain-on') || 'stop' : dryLabels[k];
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  };
  for (const b of document.querySelectorAll('[data-mh-hour]')) {
    const h = parseFloat(b.getAttribute('data-mh-hour'));
    if (!Number.isNaN(h)) b.addEventListener('click', () => goTo(h));
  }
  for (const b of rainButtons) b.addEventListener('click', toggleRain);

  for (const el of document.querySelectorAll('[data-mh-controls]')) el.hidden = false;

  // a small console hook (the _debug helpers are for screenshots and tests)
  window.magicHour = {
    set: (h) => { absH = Math.floor(absH / 24) * 24 + wrapH(h); hour = wrapH(absH); render(); },
    get: () => hour,
    storm: () => { clearT = null; forced = { t0: T }; },
    _debug: {
      tick: (s) => { T += s; step(s); render(); },
      rain: (v) => { stormOverride = v; render(); },
    },
  };

  if (reduced && Number.isNaN(startAttr)) { hour = 18.05; absH = hour; }
  render();
  start();
})();
