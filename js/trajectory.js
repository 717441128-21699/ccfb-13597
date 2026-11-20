// 试玩轨迹生成:沿环形走廊的移动 + 头部自然运动 + 各类晕动风险事件
import { mulberry32, clamp, smoothstep, angularRates } from './util.js';
import { riskFromComponents } from './riskmodel.js';

export const LEVEL = {
  name: '环形走廊 A-7',
  outer: { hx: 32, hz: 22 },   // 外墙半尺寸 (m)
  inner: { hx: 28, hz: 18 },   // 内墙半尺寸 → 走廊宽 4m
  wallH: 3,
  eyeH: 1.6,
};

// 中心线:圆角矩形,直段半长 A=24 (x) / B=14 (z),转角半径 R=6,圆心 (±24,±14)
const A = 24, B = 14, R = 6;
const L_STRAIGHT_X = 2 * A, L_STRAIGHT_Z = 2 * B, L_ARC = Math.PI * R / 2;
export const PATH_LENGTH = 2 * L_STRAIGHT_X + 2 * L_STRAIGHT_Z + 4 * L_ARC;

// s (弧长) → [x, z, yaw];yaw 约定:forward = (-sin yaw, 0, -cos yaw)
export function pathPoint(s) {
  s = ((s % PATH_LENGTH) + PATH_LENGTH) % PATH_LENGTH;
  const segs = [L_STRAIGHT_X, L_ARC, L_STRAIGHT_Z, L_ARC, L_STRAIGHT_X, L_ARC, L_STRAIGHT_Z, L_ARC];
  let i = 0;
  while (s > segs[i]) { s -= segs[i]; i = (i + 1) % 8; }
  switch (i) {
    case 0: return [-A + s, -(B + R), -Math.PI / 2];
    case 1: { const th = -Math.PI / 2 + s / R; return [A + R * Math.cos(th), -(B) + R * Math.sin(th) - 0, Math.atan2(Math.sin(th), -Math.cos(th))]; }
    case 2: return [A + R, -B + s, Math.PI];
    case 3: { const th = s / R; return [A + R * Math.cos(th), B + R * Math.sin(th), Math.atan2(Math.sin(th), -Math.cos(th))]; }
    case 4: return [A - s, B + R, Math.PI / 2];
    case 5: { const th = Math.PI / 2 + s / R; return [-A + R * Math.cos(th), B + R * Math.sin(th), Math.atan2(Math.sin(th), -Math.cos(th))]; }
    case 6: return [-(A + R), B - s, 0];
    default: { const th = Math.PI + s / R; return [-A + R * Math.cos(th), -B + R * Math.sin(th), Math.atan2(Math.sin(th), -Math.cos(th))]; }
  }
}

const EVENT_TYPES = ['forcedTurn', 'roll', 'speedBurst', 'starfield', 'bob', 'stopStart'];
export const EVENT_NAMES = {
  forcedTurn: '强制转向', roll: '镜头滚转', speedBurst: '加速冲刺',
  starfield: '星空粒子流', bob: '垂直晃动', stopStart: '急停急启',
};

export function buildSession(opts = {}) {
  const { duration = 120, fps = 90, seed = 1, aggressiveness = 0.7 } = opts;
  const rng = mulberry32((seed * 2654435761) >>> 0);
  const n = Math.round(duration * fps);
  const dt = 1 / fps;

  // 事件排期:强度越高,事件越密集
  const events = [];
  let t = 5 + rng() * 4;
  const gapScale = 1.3 - 0.8 * aggressiveness;
  while (t < duration - 7) {
    const type = EVENT_TYPES[Math.floor(rng() * EVENT_TYPES.length)];
    const durMap = {
      forcedTurn: 2 + rng() * 2, roll: 2 + rng() * 1.5, speedBurst: 3 + rng() * 2,
      starfield: 3 + rng() * 3, bob: 3 + rng() * 2, stopStart: 2.5 + rng(),
    };
    const dur = durMap[type];
    const intensity = clamp((0.45 + 0.55 * rng()) * aggressiveness, 0.05, 1);
    events.push({ type, t0: +t.toFixed(2), t1: +(t + dur).toFixed(2), intensity: +intensity.toFixed(3), dir: rng() < 0.5 ? -1 : 1 });
    t += dur + (5 + rng() * 7) * gapScale;
  }

  // 头部自然运动:缓慢漂移 + 瞬时扫视(扫出后回中,避免注视方向漂移)
  const saccades = [];
  let ts = 1 + rng() * 2;
  while (ts < duration) { saccades.push({ t: ts, amp: (rng() - 0.5) * 0.5 }); ts += 1.5 + rng() * 2.5; }
  const headYawAt = (tt) => {
    let y = 0.18 * Math.sin(0.4 * tt + seed) + 0.08 * Math.sin(1.3 * tt + 1.7);
    for (const s of saccades) {
      y += s.amp * (smoothstep(s.t, s.t + 0.45, tt) - smoothstep(s.t + 1.2, s.t + 1.65, tt));
    }
    return y;
  };
  const headPitchAt = (tt) => 0.08 * Math.sin(0.6 * tt + 0.5) + 0.04 * Math.sin(1.9 * tt);
  const env = (tt, e) => smoothstep(e.t0, e.t0 + 0.6, tt) * (1 - smoothstep(e.t1 - 0.6, e.t1, tt));

  // 相机位姿(用于渲染)与头显位姿(IMU 记录,仅物理头部运动)
  const cam = new Float32Array(n * 7);   // t, px, py, pz, yaw, pitch, roll
  const head = new Float32Array(n * 7);
  const starAlpha = new Float32Array(n);
  const baseSpeed = 1.2 + 0.9 * aggressiveness; // 强度也影响基础移动速度
  let s = 0, yawExtra = 0;
  for (let k = 0; k < n; k++) {
    const tt = k * dt;
    let speed = baseSpeed * (1 + 0.12 * Math.sin(0.23 * tt));
    let yawRateEx = 0, roll = 0, bobY = 0, star = 0;
    for (const e of events) {
      const en = env(tt, e);
      if (en <= 0) continue;
      switch (e.type) {
        case 'forcedTurn': yawRateEx += e.dir * (40 + 70 * e.intensity) * Math.PI / 180 * en; break;
        case 'roll': roll += e.dir * (15 + 45 * e.intensity) * Math.PI / 180 * en; break;
        case 'speedBurst': speed *= 1 + 2.2 * e.intensity * en; break;
        case 'starfield': star = Math.max(star, en * e.intensity); break;
        case 'bob': bobY += (0.04 + 0.16 * e.intensity) * Math.sin(2 * Math.PI * 2.2 * (tt - e.t0)) * en; break;
        case 'stopStart': speed *= clamp(1 - en * e.intensity, 0.05, 1); break;
      }
    }
    yawExtra += yawRateEx * dt;
    s += speed * dt;
    const [px, pz, pyaw] = pathPoint(s);
    const hy = headYawAt(tt), hp = headPitchAt(tt);
    cam.set([tt, px, LEVEL.eyeH + bobY, pz, pyaw + yawExtra + hy, hp, roll], k * 7);
    head.set([tt, 0.002 * Math.sin(3.1 * tt), LEVEL.eyeH + 0.01 * Math.sin(1.1 * tt), 0.002 * Math.cos(2.7 * tt), hy, hp, 0], k * 7);
    starAlpha[k] = star;
  }

  // 真值风险(从相机运动学直接计算,与分析仪共用风险公式)
  const camYaw = new Float32Array(n), camPitch = new Float32Array(n), camRoll = new Float32Array(n), camY = new Float32Array(n);
  const headYaw = new Float32Array(n), headPitch = new Float32Array(n);
  const speedArr = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    camYaw[k] = cam[k * 7 + 4]; camPitch[k] = cam[k * 7 + 5]; camRoll[k] = cam[k * 7 + 6]; camY[k] = cam[k * 7 + 2];
    headYaw[k] = head[k * 7 + 4]; headPitch[k] = head[k * 7 + 5];
    if (k > 0) {
      const dx = cam[k * 7 + 1] - cam[(k - 1) * 7 + 1], dz = cam[k * 7 + 3] - cam[(k - 1) * 7 + 3];
      speedArr[k] = Math.hypot(dx, dz) / dt;
    }
  }
  speedArr[0] = speedArr[1];
  const camYawR = angularRates(camYaw, dt), camPitchR = angularRates(camPitch, dt), camRollR = angularRates(camRoll, dt);
  const headYawR = angularRates(headYaw, dt), headPitchR = angularRates(headPitch, dt);
  const camVy = angularRates(camY, dt);
  const accel = angularRates(speedArr, dt);

  const nSec = Math.ceil(duration);
  const trueRisk = new Float32Array(nSec);
  const counts = new Float32Array(nSec);
  const trueComp = Array.from({ length: nSec }, () => ({ rot: 0, periph: 0, loom: 0, vert: 0 }));
  for (let k = 0; k < n - 1; k++) {
    const c = {
      rot: Math.hypot(camYawR[k] - headYawR[k], camPitchR[k] - headPitchR[k]) + 2 * Math.abs(camRollR[k]),
      periph: speedArr[k] / 2.2 + starAlpha[k] * 1.1,
      loom: Math.abs(accel[k]) / 6,
      vert: Math.abs(camVy[k]) / 2,
    };
    const r = riskFromComponents(c);
    const sec = Math.min(nSec - 1, Math.floor(k * dt));
    trueRisk[sec] += r; counts[sec]++;
    const tc = trueComp[sec];
    tc.rot += c.rot; tc.periph += c.periph; tc.loom += c.loom; tc.vert += c.vert;
  }
  for (let i = 0; i < nSec; i++) {
    trueRisk[i] /= Math.max(1, counts[i]);
    const tc = trueComp[i], m = Math.max(1, counts[i]);
    tc.rot /= m; tc.periph /= m; tc.loom /= m; tc.vert /= m;
  }

  const camPosPerSec = [];
  for (let sec = 0; sec < nSec; sec++) {
    const k = Math.min(n - 1, Math.round(sec * fps));
    camPosPerSec.push([+cam[k * 7 + 1].toFixed(3), +cam[k * 7 + 2].toFixed(3), +cam[k * 7 + 3].toFixed(3)]);
  }

  return { fps, duration, n, cam, head, starAlpha, events, trueRisk: Array.from(trueRisk, v => +v.toFixed(2)), trueComp: trueComp.map(c => ({ rot: +c.rot.toFixed(3), periph: +c.periph.toFixed(3), loom: +c.loom.toFixed(3), vert: +c.vert.toFixed(3) })), camPosPerSec, level: LEVEL };
}
