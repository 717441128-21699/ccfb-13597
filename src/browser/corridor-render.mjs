// 程序化走廊渲染器：Canvas 2D 绘制与 scene.mjs 解析模型同几何的走廊。
// 棋盘格纹理提供高对比特征，让 WebGL2 LK 光流能在真实编码画面上工作；
// 隧道视野遮罩按场景 tunnel 强度绘制径向暗角。
import { VIDEO_W, VIDEO_H } from '../shared/scene.mjs';

const TILE = 1.0; // 棋盘格 1m

export function createCorridorRenderer(canvas) {
  canvas.width = VIDEO_W;
  canvas.height = VIDEO_H;
  const ctx = canvas.getContext('2d', { willReadFrequently: false });

  // 走廊几何（与 scene.mjs CORRIDOR 一致）
  const A = 2;
  const H = 3;
  const SEG = 45;

  function shade(q, base) {
    // 棋盘格 + 距离衰减
    const tile = Math.floor(q[0] / TILE) + Math.floor(q[1] / TILE) + Math.floor(q[2] / TILE);
    const checker = tile % 2 === 0;
    const d = Math.hypot(q[0], q[1], q[2]);
    const fog = Math.max(0.25, 1 - d / 40);
    const v = (checker ? base : base * 0.45) * fog;
    return `rgb(${v | 0},${(v * 0.85) | 0},${(v * 0.7) | 0})`;
  }

  // 画一个四边形（世界坐标 4 点），用中心深度做简单画家排序
  function quad(model, state, pts, baseColor) {
    const projected = pts.map((p) => model.project(state, p));
    if (projected.some((p) => p === null)) return;
    const avgDepth = projected.reduce((s, p) => s + p.depth, 0) / 4;
    ctx.fillStyle = shade(pts[0], baseColor);
    ctx.beginPath();
    ctx.moveTo(projected[0].u, projected[0].v);
    for (let i = 1; i < 4; i++) ctx.lineTo(projected[i].u, projected[i].v);
    ctx.closePath();
    ctx.fill();
    return avgDepth;
  }

  return {
    render(model, state) {
      ctx.fillStyle = '#0a0c10';
      ctx.fillRect(0, 0, VIDEO_W, VIDEO_H);

      const [cx, cy, cz] = state.pos;
      // 只绘制相机附近 ±2 个重复段的瓦片（每米一格棋盘）
      const z0 = Math.floor(cz) - 6;
      const z1 = Math.floor(cz) + 30;
      const drawList = [];

      for (let z = z0; z < z1; z++) {
        const zm = ((z % SEG) + SEG) % SEG;
        const za = z;
        const zb = z + 1;
        // 左右墙 x=±A
        for (const x of [-A, A]) {
          for (let y = 0; y < H; y++) {
            drawList.push({
              pts: [
                [x, y, za], [x, y + 1, za], [x, y + 1, zb], [x, y, zb],
              ],
              base: 200,
            });
          }
        }
        // 地板 y=0、天花板 y=H
        for (let x = -A; x < A; x++) {
          drawList.push({
            pts: [
              [x, 0, za], [x + 1, 0, za], [x + 1, 0, zb], [x, 0, zb],
            ],
            base: 170,
          });
          drawList.push({
            pts: [
              [x, H, za], [x + 1, H, za], [x + 1, H, zb], [x, H, zb],
            ],
            base: 150,
          });
        }
        // 重复段端墙（每 45m 一面，棋盘与走廊连续故视觉无缝）
        if (zm === 0 || zm === SEG - 1) {
          const zw = zm === 0 ? z : z + 1;
          for (let x = -A; x < A; x++) {
            for (let y = 0; y < H; y++) {
              drawList.push({
                pts: [
                  [x, y, zw], [x + 1, y, zw], [x + 1, y + 1, zw], [x, y + 1, zw],
                ],
                base: 180,
              });
            }
          }
        }
      }

      // 画家算法：远的先画。用首点估算深度
      const withDepth = drawList
        .map((q) => {
          const p0 = model.project(state, q.pts[0]);
          return { q, depth: p0 ? p0.depth : -1 };
        })
        .filter((x) => x.depth > 0)
        .sort((a, b) => b.depth - a.depth);
      for (const { q } of withDepth) quad(model, state, q.pts, q.base);

      // 中央准星（HUD，固定不动，不参与场景光流）
      ctx.strokeStyle = 'rgba(180,220,255,0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(VIDEO_W / 2 - 5, VIDEO_H / 2);
      ctx.lineTo(VIDEO_W / 2 + 5, VIDEO_H / 2);
      ctx.moveTo(VIDEO_W / 2, VIDEO_H / 2 - 5);
      ctx.lineTo(VIDEO_W / 2, VIDEO_H / 2 + 5);
      ctx.stroke();

      // 隧道视野遮罩：径向渐变暗角
      if (state.tunnel > 0.01) {
        const radius = 0.62 - 0.25 * state.tunnel; // 遮罩越强开口越小
        const inner = Math.hypot(VIDEO_W, VIDEO_H) * 0.5 * radius;
        const outer = Math.hypot(VIDEO_W, VIDEO_H) * 0.52;
        const g = ctx.createRadialGradient(
          VIDEO_W / 2, VIDEO_H / 2, inner,
          VIDEO_W / 2, VIDEO_H / 2, outer,
        );
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(1, `rgba(0,0,0,${0.92 * state.tunnel})`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, VIDEO_W, VIDEO_H);
      }
    },
  };
}
