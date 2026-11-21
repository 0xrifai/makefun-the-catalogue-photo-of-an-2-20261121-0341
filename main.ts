// Chrono-Toaster 3000 — catalogue photograph of an impossible gadget.
// A polished chrome toaster that toasts TIME: two slices of toast pop up
// from its slots as clock faces (yesterday / tomorrow), with a single
// hourglass accessory. Pure Node 22+ stdlib, no network, no dependencies.
// Deterministic: fixed seeds, no Date/random — two runs are byte-identical.
//
// Run:  node main.ts        (writes /output/entry.png, 1024x1024 PNG)

import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const W = 1024;
const H = 1024;
const OUT = "/output/entry.png";

const buf = new Float32Array(W * H * 3);

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const sstep = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
// Deterministic integer hash -> [0,1). Used for brushed-metal streaks only.
const hash1 = (n: number): number => {
  let h = Math.imul(n | 0, 2654435761) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 1274126177) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};

type RGB = [number, number, number];
type SDF = (x: number, y: number) => number;
type ColorFn = (x: number, y: number) => RGB;

function blend(x: number, y: number, r: number, g: number, b: number, a: number): void {
  if (a <= 0 || x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  const ia = 1 - a;
  buf[i] = buf[i] * ia + r * a;
  buf[i + 1] = buf[i + 1] * ia + g * a;
  buf[i + 2] = buf[i + 2] * ia + b * a;
}

function fillRect(x0: number, y0: number, w: number, h: number, c: RGB, a = 1): void {
  const xa = Math.max(0, Math.floor(x0));
  const xb = Math.min(W, Math.ceil(x0 + w));
  const ya = Math.max(0, Math.floor(y0));
  const yb = Math.min(H, Math.ceil(y0 + h));
  for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) blend(x, y, c[0], c[1], c[2], a);
}

// ---- signed distance functions ----
function sdRoundBox(x: number, y: number, cx: number, cy: number, hw: number, hh: number, r: number): number {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}
function sdCircle(x: number, y: number, cx: number, cy: number, r: number): number {
  return Math.hypot(x - cx, y - cy) - r;
}
function sdEllipse(x: number, y: number, cx: number, cy: number, rx: number, ry: number): number {
  const q = Math.hypot((x - cx) / rx, (y - cy) / ry);
  return (q - 1) * Math.min(rx, ry);
}
function sdSeg(x: number, y: number, ax: number, ay: number, bx: number, by: number, r: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((x - ax) * dx + (y - ay) * dy) / l2;
  t = clamp(t, 0, 1);
  return Math.hypot(x - (ax + dx * t), y - (ay + dy * t)) - r;
}
function smin(a: number, b: number, k: number): number {
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return lerp(b, a, h) - k * h * (1 - h);
}

// Fill a shape (1px anti-aliased edge) inside a bounding box.
function drawSDF(x0: number, y0: number, x1: number, y1: number, sdf: SDF, col: ColorFn, alpha = 1): void {
  const xa = Math.max(0, Math.floor(x0));
  const xb = Math.min(W, Math.ceil(x1));
  const ya = Math.max(0, Math.floor(y0));
  const yb = Math.min(H, Math.ceil(y1));
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      const d = sdf(x + 0.5, y + 0.5);
      if (d >= 1) continue;
      const cov = clamp(0.5 - d, 0, 1) * alpha;
      if (cov <= 0) continue;
      const c = col(x, y);
      blend(x, y, c[0], c[1], c[2], cov);
    }
  }
}

// Stroke centred on the zero contour of an SDF.
function drawStroke(x0: number, y0: number, x1: number, y1: number, sdf: SDF, halfW: number, c: RGB, alpha = 1): void {
  const xa = Math.max(0, Math.floor(x0));
  const xb = Math.min(W, Math.ceil(x1));
  const ya = Math.max(0, Math.floor(y0));
  const yb = Math.min(H, Math.ceil(y1));
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      const ad = Math.abs(sdf(x + 0.5, y + 0.5));
      if (ad > halfW + 1) continue;
      const cov = clamp(halfW + 0.5 - ad, 0, 1) * alpha;
      if (cov <= 0) continue;
      blend(x, y, c[0], c[1], c[2], cov);
    }
  }
}

function distToSegPx(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((x - ax) * dx + (y - ay) * dy) / l2;
  t = clamp(t, 0, 1);
  return Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
}

function pointInPoly(x: number, y: number, pts: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0];
    const yi = pts[i][1];
    const xj = pts[j][0];
    const yj = pts[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function fillPoly(pts: number[][], col: ColorFn, alpha = 1): void {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]);
    y1 = Math.max(y1, p[1]);
  }
  const xa = Math.max(0, Math.floor(x0) - 1);
  const xb = Math.min(W, Math.ceil(x1) + 1);
  const ya = Math.max(0, Math.floor(y0) - 1);
  const yb = Math.min(H, Math.ceil(y1) + 1);
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let dEdge = Infinity;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        dEdge = Math.min(dEdge, distToSegPx(px, py, pts[j][0], pts[j][1], pts[i][0], pts[i][1]));
      }
      const inside = pointInPoly(px, py, pts);
      const cov = inside ? clamp(0.5 + dEdge, 0, 1) : clamp(0.5 - dEdge, 0, 1);
      if (cov <= 0) continue;
      const c = col(x, y);
      blend(x, y, c[0], c[1], c[2], cov * alpha);
    }
  }
}

// ---- tiny 5x7 bitmap font (only glyphs this picture needs) ----
const FONT: Record<string, string[]> = {
  "0": [".###.", "#..##", "#.#.#", "##..#", "#...#", "#...#", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  C: [".####", "#....", "#....", "#....", "#....", "#....", ".####"],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
};

function drawText(s: string, cx: number, top: number, scale: number, c: RGB, alpha = 1): void {
  const w = s.length * 6 * scale - scale;
  let x = Math.round(cx - w / 2);
  for (const ch of s) {
    const g = FONT[ch];
    if (g) {
      for (let r = 0; r < 7; r++) {
        for (let cc = 0; cc < 5; cc++) {
          if (g[r][cc] === "#") fillRect(x + cc * scale, top + r * scale, scale, scale, c, alpha);
        }
      }
    }
    x += 6 * scale;
  }
}

// ---- scene helpers ----
function softShadow(cx: number, cy: number, rx: number, ry: number, alpha: number): void {
  const xa = Math.max(0, Math.floor(cx - rx));
  const xb = Math.min(W, Math.ceil(cx + rx));
  const ya = Math.max(0, Math.floor(cy - ry));
  const yb = Math.min(H, Math.ceil(cy + ry));
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      const q = ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2;
      if (q >= 1) continue;
      blend(x, y, 38, 40, 44, alpha * Math.pow(1 - q, 1.8));
    }
  }
}

// Clock-hand endpoint: theta is clockwise from 12 o'clock, in radians.
function handEnd(cx: number, cy: number, len: number, theta: number): [number, number] {
  return [cx + len * Math.sin(theta), cy - len * Math.cos(theta)];
}

function drawClock(cx: number, cy: number, r: number, hourTheta: number, minuteTheta: number, dateLabel: string): void {
  // Dark rim, then ivory face with a gentle radial falloff.
  drawSDF(cx - r - 4, cy - r - 4, cx + r + 4, cy + r + 4,
    (x, y) => sdCircle(x, y, cx, cy, r + 2.5), () => [46, 40, 32]);
  drawSDF(cx - r, cy - r, cx + r, cy + r, (x, y) => sdCircle(x, y, cx, cy, r), (x, y) => {
    const t = Math.hypot(x - cx, y - cy) / r;
    return [lerp(255, 233, t * t), lerp(253, 226, t * t), lerp(244, 208, t * t)];
  });
  // Hour ticks.
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const long = i % 3 === 0;
    const r1 = long ? r - 17 : r - 11;
    const r2 = r - 5;
    const ax = cx + r1 * Math.sin(a);
    const ay = cy - r1 * Math.cos(a);
    const bx = cx + r2 * Math.sin(a);
    const by = cy - r2 * Math.cos(a);
    drawSDF(Math.min(ax, bx) - 4, Math.min(ay, by) - 4, Math.max(ax, bx) + 4, Math.max(ay, by) + 4,
      (x, y) => sdSeg(x, y, ax, ay, bx, by, long ? 3 : 2.2), () => [46, 42, 36]);
  }
  // Hands.
  const [hx, hy] = handEnd(cx, cy, r * 0.52, hourTheta);
  const [mx, my] = handEnd(cx, cy, r * 0.74, minuteTheta);
  drawSDF(cx - r, cy - r, cx + r, cy + r,
    (x, y) => sdSeg(x, y, cx, cy, hx, hy, 4.5), () => [34, 32, 28]);
  drawSDF(cx - r, cy - r, cx + r, cy + r,
    (x, y) => sdSeg(x, y, cx, cy, mx, my, 3.2), () => [34, 32, 28]);
  drawSDF(cx - 6, cy - 6, cx + 6, cy + 6, (x, y) => sdCircle(x, y, cx, cy, 5), () => [34, 32, 28]);
  // Date window at 6 o'clock: the day the toast delivers.
  drawSDF(cx - 23, cy + 36, cx + 23, cy + 64, (x, y) => sdRoundBox(x, y, cx, cy + 50, 22, 13, 5), () => [58, 50, 40]);
  drawSDF(cx - 21, cy + 38, cx + 21, cy + 62, (x, y) => sdRoundBox(x, y, cx, cy + 50, 20, 11, 4), () => [255, 255, 255]);
  drawText(dateLabel, cx, cy + 43, 2, [40, 36, 30]);
}

// One slice of toast whose face IS a clock.
function drawToast(cx: number, domeTopY: number, clockCy: number, hourTheta: number, minuteTheta: number, dateLabel: string): void {
  const domeCy = domeTopY + 88;
  const bottom = 505;
  const sdf = (x: number, y: number): number => {
    const dC = sdCircle(x, y, cx, domeCy, 88);
    const dR = sdRoundBox(x, y, cx, (domeCy + bottom) / 2, 88, (bottom - domeCy) / 2, 16);
    return smin(dC, dR, 14);
  };
  const sdfInner = (x: number, y: number): number => {
    const dC = sdCircle(x, y, cx, domeCy, 72);
    const dR = sdRoundBox(x, y, cx, (domeCy + bottom - 16) / 2, 72, (bottom - 16 - domeCy) / 2, 12);
    return smin(dC, dR, 12);
  };
  // Dark crust edge, then golden crust, then pale crumb.
  drawSDF(cx - 94, domeTopY - 6, cx + 94, bottom + 6,
    (x, y) => sdf(x, y) - 3, () => [122, 78, 24]);
  drawSDF(cx - 91, domeTopY - 3, cx + 91, bottom + 3, sdf, (x, y) => {
    const t = clamp((y - domeTopY) / (bottom - domeTopY), 0, 1);
    return [lerp(224, 168, t), lerp(158, 110, t), lerp(74, 38, t)];
  });
  drawSDF(cx - 75, domeTopY + 13, cx + 75, bottom - 13, sdfInner, (x, y) => {
    const t = clamp((y - domeTopY) / (bottom - domeTopY), 0, 1);
    return [lerp(251, 236, t), lerp(236, 210, t), lerp(198, 160, t)];
  });
  drawClock(cx, clockCy, 66, hourTheta, minuteTheta, dateLabel);
}

function drawHourglass(): void {
  const cx = 845;
  // Frame: wood caps + posts.
  const wood: ColorFn = (x, y) => {
    const t = clamp((y - 588) / 222, 0, 1);
    return [lerp(96, 66, t), lerp(70, 46, t), lerp(44, 28, t)];
  };
  drawSDF(788, 586, 902, 612, (x, y) => sdRoundBox(x, y, cx, 599, 56, 11, 5), wood);
  drawSDF(788, 788, 902, 812, (x, y) => sdRoundBox(x, y, cx, 800, 56, 11, 5), wood);
  fillRect(796, 610, 9, 178, [74, 52, 32]);
  fillRect(886, 610, 9, 178, [74, 52, 32]);
  fillRect(796, 610, 2, 178, [120, 90, 58], 0.7);
  fillRect(886, 610, 2, 178, [120, 90, 58], 0.7);
  // Glass bulbs (two ellipses, gentle waist).
  const glass: SDF = (x, y) => Math.min(
    sdEllipse(x, y, cx, 664, 38, 58),
    sdEllipse(x, y, cx, 738, 38, 58),
  );
  drawSDF(cx - 40, 604, cx + 40, 798, glass, () => [228, 238, 246], 0.5);
  drawStroke(cx - 42, 602, cx + 42, 800, glass, 2, [140, 155, 168], 0.95);
  // Sand: draining cone on top, settled pile below, thin falling stream.
  const sand: RGB = [217, 164, 65];
  fillPoly([[816, 640], [874, 640], [845, 700]], () => sand);
  fillPoly([[845, 714], [818, 776], [872, 776]], () => sand);
  drawSDF(841, 698, 849, 716, (x, y) => sdSeg(x, y, 845, 700, 845, 714, 1.6), () => sand, 0.9);
  // Glass highlight streak.
  fillPoly([[826, 634], [838, 634], [824, 696], [816, 696]], () => [255, 255, 255], 0.22);
}

// ---- scene ----
function render(): void {
  // 1. Studio backdrop: light-grey seamless gradient + soft key light.
  for (let y = 0; y < H; y++) {
    const t = y / (H - 1);
    let r: number, g: number, b: number;
    if (t < 0.78) {
      const u = t / 0.78;
      r = lerp(238, 223, u); g = lerp(240, 226, u); b = lerp(242, 229, u);
    } else {
      const u = (t - 0.78) / 0.22;
      r = lerp(223, 207, u); g = lerp(226, 211, u); b = lerp(229, 215, u);
    }
    for (let x = 0; x < W; x++) {
      const dx = x - 512;
      const dy = y - 380;
      const q = Math.sqrt(dx * dx + dy * dy) / 640;
      const lift = Math.max(0, 1 - q) * 10;
      const i = (y * W + x) * 3;
      buf[i] = r + lift;
      buf[i + 1] = g + lift;
      buf[i + 2] = b + lift;
    }
  }

  // 2. Contact shadows on the studio floor (floor line ~y=800).
  softShadow(480, 814, 330, 30, 0.32);
  softShadow(845, 812, 72, 14, 0.28);

  // 3. Power cord, lying on the floor from the toaster's right side.
  for (let i = 0; i <= 48; i++) {
    const t = i / 48;
    const mt = 1 - t;
    const x = mt * mt * 700 + 2 * mt * t * 800 + t * t * 884;
    const y = mt * mt * 800 + 2 * mt * t * 838 + t * t * 856;
    drawSDF(x - 5, y - 5, x + 5, y + 5, (px, py) => sdCircle(px, py, x, y, 4), () => [58, 60, 66]);
  }
  drawSDF(878, 846, 912, 870, (x, y) => sdRoundBox(x, y, 895, 858, 16, 8, 4), () => [52, 54, 60]);

  // 4. The single accessory: hourglass.
  drawHourglass();

  // 5. Toaster top surface + slots (toast is drawn over the slots next).
  fillPoly([[238, 424], [722, 424], [742, 476], [218, 476]], (x, y) => {
    const t = clamp((y - 424) / 52, 0, 1);
    return [lerp(230, 205, t), lerp(233, 208, t), lerp(236, 212, t)];
  });
  drawSDF(294, 436, 486, 458, (x, y) => sdRoundBox(x, y, 390, 447, 94, 9, 9), () => [35, 38, 42]);
  drawSDF(544, 436, 736, 458, (x, y) => sdRoundBox(x, y, 640, 447, 94, 9, 9), () => [35, 38, 42]);
  // Soft contact shadow where each slice meets the deck.
  softShadow(390, 470, 105, 9, 0.18);
  softShadow(640, 470, 105, 9, 0.18);

  // 6. The toast: yesterday (10:08, 20 Nov) and tomorrow (2:35, 22 Nov).
  drawToast(390, 164, 318, ((10 + 8 / 60) / 12) * Math.PI * 2, (8 / 60) * Math.PI * 2, "20");
  drawToast(640, 144, 298, ((2 + 35 / 60) / 12) * Math.PI * 2, (35 / 60) * Math.PI * 2, "22");

  // 7. Chrome toaster body (covers the toast below y=476).
  const chrome: ColorFn = (x, y) => {
    const t = (y - 476) / (800 - 476);
    let r: number, g: number, b: number;
    if (t < 0.25) {
      const u = t / 0.25;
      r = lerp(244, 219, u); g = lerp(246, 222, u); b = lerp(247, 226, u);
    } else if (t < 0.6) {
      const u = (t - 0.25) / 0.35;
      r = lerp(219, 180, u); g = lerp(222, 184, u); b = lerp(226, 191, u);
    } else {
      const u = (t - 0.6) / 0.4;
      r = lerp(180, 135, u); g = lerp(184, 140, u); b = lerp(191, 148, u);
    }
    const ex = Math.abs(x - 480) / 260;
    const shade = 1 - 0.1 * ex * ex;
    r *= shade; g *= shade; b *= shade;
    const band = (cx: number, w: number): number => Math.exp(-((x - cx) * (x - cx)) / (2 * w * w));
    const hl = (band(300, 46) + band(625, 40)) * 26;
    r += hl; g += hl; b += hl;
    const st = (hash1(y) * 2 - 1) * 3;
    r += st; g += st; b += st;
    return [clamp(r, 0, 255), clamp(g, 0, 255), clamp(b, 0, 255)];
  };
  drawSDF(218, 474, 742, 802, (x, y) => sdRoundBox(x, y, 480, 638, 260, 162, 24), chrome);
  // Top edge highlight + bottom shade.
  fillRect(232, 476, 496, 2, [255, 255, 255], 0.45);
  fillRect(240, 796, 480, 3, [70, 74, 80], 0.35);

  // 8. Front details: engraved nameplate, browning dial, side lever.
  drawSDF(328, 638, 632, 696, (x, y) => sdRoundBox(x, y, 480, 667, 150, 27, 8), () => [38, 41, 46]);
  drawStroke(330, 640, 630, 694, (x, y) => sdRoundBox(x, y, 480, 667, 148, 25, 7), 1.2, [201, 162, 39], 0.9);
  drawText("CHRONO-TOASTER 3000", 480, 660, 2, [230, 198, 92]);
  for (const [sx, sy] of [[340, 650], [620, 650], [340, 684], [620, 684]] as const) {
    drawSDF(sx - 4, sy - 4, sx + 4, sy + 4, (x, y) => sdCircle(x, y, sx, sy, 2.5), () => [201, 162, 39]);
  }
  // Browning dial.
  drawSDF(266, 690, 318, 742, (x, y) => sdCircle(x, y, 292, 716, 24), () => [44, 47, 52]);
  drawSDF(270, 694, 314, 738, (x, y) => sdCircle(x, y, 292, 716, 20), (x, y) => {
    const t = clamp((y - 696) / 40, 0, 1);
    return [lerp(228, 170, t), lerp(230, 174, t), lerp(233, 180, t)];
  });
  const [dx2, dy2] = handEnd(292, 716, 15, -2.2);
  drawSDF(272, 696, 312, 736, (x, y) => sdSeg(x, y, 292, 716, dx2, dy2, 2.5), () => [40, 42, 46]);
  drawSDF(288, 712, 296, 720, (x, y) => sdCircle(x, y, 292, 716, 3.5), () => [40, 42, 46]);
  // Side lever (right edge).
  drawSDF(734, 596, 766, 616, (x, y) => sdRoundBox(x, y, 750, 606, 15, 7, 7), () => [31, 33, 36]);
  drawSDF(758, 592, 786, 620, (x, y) => sdCircle(x, y, 772, 606, 12), () => [34, 36, 40]);
  drawSDF(764, 596, 776, 608, (x, y) => sdCircle(x, y, 769, 602, 4), () => [200, 204, 210], 0.5);

  // 9. Gentle vignette.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const q = ((x - 512) / 720) ** 2 + ((y - 470) / 720) ** 2;
      if (q <= 0.55) continue;
      const f = 1 - 0.06 * sstep(0.55, 1.15, q);
      const i = (y * W + x) * 3;
      buf[i] *= f;
      buf[i + 1] *= f;
      buf[i + 2] *= f;
    }
  }
}

// ---- minimal deterministic PNG encoder (RGB, no filter) ----
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
  return out;
}

function encodePNG(): Buffer {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const si = (y * W + x) * 3;
      const di = y * (W * 3 + 1) + 1 + x * 3;
      raw[di] = clamp(Math.round(buf[si]), 0, 255);
      raw[di + 1] = clamp(Math.round(buf[si + 1]), 0, 255);
      raw[di + 2] = clamp(Math.round(buf[si + 2]), 0, 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

render();
const png = encodePNG();
mkdirSync("/output", { recursive: true });
writeFileSync(OUT, png);
console.log(`wrote ${OUT} (${W}x${H}, ${png.length} bytes)`);
