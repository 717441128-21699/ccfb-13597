// Node 单元测试:纯逻辑模块(无需浏览器)
// 运行: node tests/unit.mjs
import { encodeVRS, decodeVRS } from '../js/vrs.js';
import { buildSession, pathPoint, PATH_LENGTH, LEVEL } from '../js/trajectory.js';
import { riskFromComponents, gradeOf } from '../js/riskmodel.js';
import { pearson, m4View, m4Perspective, m4Mul } from '../js/util.js';

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗ FAIL:', name); }
}

// 1. vrs 容器往返
{
  const meta = { version: 1, fps: 90, poseFps: 90, codec: 'vp8', duration: 1 };
  const head = new Float32Array(7 * 10).map((_, i) => i * 0.1);
  const chunks = [
    { key: true, ts: 0, dur: 11111, data: new Uint8Array([1, 2, 3, 4]) },
    { key: false, ts: 11111, dur: 11111, data: new Uint8Array([5, 6, 7]) },
  ];
  const blob = encodeVRS(meta, head, chunks);
  const buf = await blob.arrayBuffer();
  const back = decodeVRS(buf);
  check('vrs meta 往返', back.meta.fps === 90 && back.meta.poseCount === 10);
  check('vrs 位姿往返', back.head.length === 70 && Math.abs(back.head[69] - 6.9) < 1e-6);
  check('vrs 码流往返', back.chunks.length === 2 && back.chunks[1].data[2] === 7 && back.chunks[0].key === true);
}

// 2. 轨迹生成:确定性与几何
{
  const a = buildSession({ duration: 30, fps: 30, seed: 5, aggressiveness: 0.8 });
  const b = buildSession({ duration: 30, fps: 30, seed: 5, aggressiveness: 0.8 });
  check('轨迹确定性', a.cam[100] === b.cam[100] && a.events.length === b.events.length);
  check('事件存在', a.events.length >= 2);
  check('真值风险范围', a.trueRisk.every(r => r >= 0 && r <= 100));
  // 相机始终位于走廊内(距中心线 ±2m 内 ⇒ 坐标应在内外墙之间)
  let inCorridor = true;
  for (let k = 0; k < a.n; k += 10) {
    const x = a.cam[k * 7 + 1], z = a.cam[k * 7 + 3];
    const inOuter = Math.abs(x) < LEVEL.outer.hx - 0.1 && Math.abs(z) < LEVEL.outer.hz - 0.1;
    const inInner = Math.abs(x) < LEVEL.inner.hx + 0.1 && Math.abs(z) < LEVEL.inner.hz + 0.1;
    if (!inOuter || inInner) { inCorridor = false; break; }
  }
  check('相机不撞墙', inCorridor);
  // 路径连续性
  let maxStep = 0;
  for (let k = 1; k < a.n; k++) {
    const dx = a.cam[k * 7 + 1] - a.cam[(k - 1) * 7 + 1];
    const dz = a.cam[k * 7 + 3] - a.cam[(k - 1) * 7 + 3];
    maxStep = Math.max(maxStep, Math.hypot(dx, dz));
  }
  check('相机运动连续(无瞬移)', maxStep < 0.5);
}

// 3. 路径参数化
{
  const L = PATH_LENGTH;
  const [x0, z0] = pathPoint(0);
  const [x1, z1] = pathPoint(L); // 应回到起点
  check('路径闭合', Math.hypot(x1 - x0, z1 - z0) < 1e-6);
  let maxJump = 0, prev = pathPoint(0);
  for (let s = 0.1; s < L; s += 0.1) {
    const p = pathPoint(s);
    maxJump = Math.max(maxJump, Math.hypot(p[0] - prev[0], p[1] - prev[1]));
    prev = p;
  }
  check('路径弧长参数化均匀', Math.abs(maxJump - 0.1) < 0.02);
}

// 4. 风险模型单调性
{
  const r0 = riskFromComponents({ rot: 0, periph: 0, loom: 0, vert: 0 });
  const r1 = riskFromComponents({ rot: 0.5, periph: 0.5, loom: 0.1, vert: 0.1 });
  const r2 = riskFromComponents({ rot: 2, periph: 2, loom: 1, vert: 1 });
  check('风险单调递增', r0 < r1 && r1 < r2 && r2 <= 100);
  check('零输入零风险', r0 === 0);
  check('等级划分', gradeOf(10).grade === 'A' && gradeOf(60).grade === 'D');
}

// 5. 视图矩阵:点在相机正前方时 view z 为负
{
  // 相机在 (0,1.6,0) 朝 -z 看
  const v = m4View(0, 0, 0, 0, 1.6, 0);
  const z = v[2] * 0 + v[6] * 0 + v[10] * (-5) + v[14]; // 点 (0,0,-5)
  check('视图矩阵:前方点为负 z', z < 0);
  // 相机平移:点在世界 (0,1.6,-5),相机在 (0,1.6,0) → view z = -5
  check('视图矩阵:距离正确', Math.abs(z + 5) < 1e-6);
  // 投影:正前方点 ndc 居中,w 为正
  const proj = m4Perspective(1.0, 16 / 9, 0.1, 100);
  const m = m4Mul(proj, v);
  const w = m[3] * 0 + m[7] * 0 + m[11] * (-5) + m[15];
  check('投影矩阵:w 为正', w > 0);
}

// 6. Pearson
{
  check('pearson 完全线性=1', Math.abs(pearson([1, 2, 3, 4], [2, 4, 6, 8]) - 1) < 1e-9);
  check('pearson 反相关=-1', Math.abs(pearson([1, 2, 3, 4], [8, 6, 4, 2]) + 1) < 1e-9);
}

console.log(`\n${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
