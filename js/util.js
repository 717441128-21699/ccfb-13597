// 基础工具:随机数、数学、矩阵
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
export function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
export function unwrapAngle(a, ref) {
  // 把 a 调整到 ref 附近 (±PI)
  while (a - ref > Math.PI) a -= 2 * Math.PI;
  while (a - ref < -Math.PI) a += 2 * Math.PI;
  return a;
}
// 对角序列做 unwrap 后差分,返回角速度序列 (长度 n-1)
export function angularRates(angles, dt) {
  const out = new Float32Array(angles.length - 1);
  for (let i = 1; i < angles.length; i++) {
    const d = unwrapAngle(angles[i], angles[i - 1]) - angles[i - 1];
    out[i - 1] = d / dt;
  }
  return out;
}
export function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return NaN;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return sxy / Math.sqrt(sxx * syy + 1e-12);
}

// ---- mat4 (列主序, WebGL 约定) ----
export function m4Mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}
export function m4RotY(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
}
export function m4RotX(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
}
export function m4RotZ(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}
export function m4Perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  const o = new Float32Array(16);
  o[0] = f / aspect; o[5] = f;
  o[10] = (far + near) / (near - far); o[11] = -1;
  o[14] = 2 * far * near / (near - far);
  return o;
}
// 由 yaw/pitch/roll + 位置构造视图矩阵 (R = Ry*Rx*Rz 的逆变换)
export function m4View(yaw, pitch, roll, px, py, pz) {
  const R = m4Mul(m4Mul(m4RotY(yaw), m4RotX(pitch)), m4RotZ(roll));
  const v = new Float32Array(16);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) v[c * 4 + r] = R[r * 4 + c];
  // 平移 = -Rᵀ·p,即 -(R 的第 i 列)·p
  v[12] = -(R[0] * px + R[1] * py + R[2] * pz);
  v[13] = -(R[4] * px + R[5] * py + R[6] * pz);
  v[14] = -(R[8] * px + R[9] * py + R[10] * pz);
  v[15] = 1;
  return v;
}
export function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
export function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
export function formatTime(sec) {
  const m = Math.floor(sec / 60), s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
