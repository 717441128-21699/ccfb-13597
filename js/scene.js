// 合成 VR 场景渲染器:环形走廊 + 程序化网格纹理 + 星空粒子事件
import { getGL, program } from './glutil.js';
import { m4Perspective, m4View } from './util.js';

const GEO_VERT = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in float aMat;
uniform mat4 uProj, uView;
out vec3 vWorld; out vec3 vNormal; out float vMat;
void main(){
  vWorld = aPos; vNormal = aNormal; vMat = aMat;
  gl_Position = uProj * uView * vec4(aPos, 1.0);
}`;

const GEO_FRAG = `#version 300 es
precision highp float;
in vec3 vWorld; in vec3 vNormal; in float vMat;
uniform vec3 uCamPos;
out vec4 frag;
vec3 baseColor(float m){
  if(m < 0.5) return vec3(0.32, 0.33, 0.38);
  if(m < 1.5) return vec3(0.22, 0.23, 0.30);
  if(m < 2.5) return vec3(0.55, 0.58, 0.62);
  if(m < 3.5) return vec3(0.42, 0.50, 0.58);
  return vec3(0.75, 0.45, 0.20);
}
void main(){
  vec3 n = normalize(vNormal);
  vec2 guv = abs(n.y) > 0.5 ? vWorld.xz : (abs(n.x) > 0.5 ? vWorld.zy : vWorld.xy);
  vec2 cell = fract(guv * 0.5);
  float checker = mod(floor(guv.x * 0.5) + floor(guv.y * 0.5), 2.0);
  vec2 e = abs(cell - 0.5);
  float line = smoothstep(0.42, 0.5, max(e.x, e.y));
  vec3 base = baseColor(vMat) * (0.75 + 0.5 * checker);
  base += line * 0.35;
  if (vMat > 1.5 && vMat < 3.5) base *= 0.8 + 0.4 * step(0.5, fract(vWorld.y * 0.8));
  vec3 L = normalize(vec3(0.4, 0.8, 0.3));
  float diff = 0.82 + 0.38 * max(dot(n, L), 0.0);   // 高环境光:各朝向亮度均匀,保证光流信号稳定
  vec3 col = base * diff;
  float d = distance(vWorld, uCamPos);
  float fog = 1.0 - exp(-d * 0.03);
  col = mix(col, vec3(0.05, 0.06, 0.10), fog);
  frag = vec4(col, 1.0);
}`;

const PTS_VERT = `#version 300 es
layout(location=0) in vec3 aPos;
uniform mat4 uProj, uView;
void main(){
  vec4 p = uProj * uView * vec4(aPos, 1.0);
  gl_Position = p;
  gl_PointSize = clamp(200.0 / max(p.w, 0.1), 1.0, 8.0);
}`;

const PTS_FRAG = `#version 300 es
precision highp float;
uniform float uAlpha;
out vec4 o;
void main(){
  vec2 d = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.1, length(d)) * uAlpha;
  o = vec4(1.0, 0.95, 0.8, 1.0) * a;
}`;

function pushQuad(arr, p0, p1, h, normal, mat) {
  // p0,p1: 墙底两个端点 [x,z];从 y=0 到 y=h
  const [x0, z0] = p0, [x1, z1] = p1;
  const [nx, nz] = normal;
  const quad = [
    [x0, 0, z0], [x1, 0, z1], [x1, h, z1],
    [x0, 0, z0], [x1, h, z1], [x0, h, z0],
  ];
  for (const q of quad) arr.push(q[0], q[1], q[2], nx, 0, nz, mat);
}

function pushBox(arr, cx, cy, cz, sx, sy, sz, mat) {
  const x0 = cx - sx / 2, x1 = cx + sx / 2;
  const y0 = cy - sy / 2, y1 = cy + sy / 2;
  const z0 = cz - sz / 2, z1 = cz + sz / 2;
  const faces = [
    [[1, 0, 0], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]],
    [[-1, 0, 0], [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]]],
    [[0, 1, 0], [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]]],
    [[0, -1, 0], [[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]]],
    [[0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]],
    [[0, 0, -1], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]]],
  ];
  for (const [n, q] of faces) {
    const idx = [0, 1, 2, 0, 2, 3];
    for (const i of idx) {
      arr.push(q[i][0], q[i][1], q[i][2], n[0], n[1], n[2], mat);
    }
  }
}

export class SceneRenderer {
  constructor(canvas, level, pathPointFn, pathLength) {
    this.canvas = canvas;
    this.level = level;
    const gl = this.gl = getGL(canvas);
    this.geoProg = program(gl, GEO_VERT, GEO_FRAG);
    this.ptsProg = program(gl, PTS_VERT, PTS_FRAG);

    // 静态几何
    const v = [];
    const { outer, wallH } = level;
    pushBox(v, 0, -0.05, 0, outer.hx * 2 + 1, 0.1, outer.hz * 2 + 1, 0);          // 地板
    pushBox(v, 0, wallH + 0.05, 0, outer.hx * 2 + 1, 0.1, outer.hz * 2 + 1, 1);  // 天花板
    // 沿中心线的飘带墙(内/外),转角处与路径同心圆弧,保证全程 2m 净距
    const HALF_W = 2; // 走廊半宽
    const STEP = 0.4;
    const M = Math.ceil(pathLength / STEP);
    let prev = null;
    for (let i = 0; i <= M; i++) {
      const [cx, cz, yaw] = pathPointFn((i / M) * pathLength);
      // forward = (-sin, -cos);right = (-fz, fx) = (cos, -sin)
      const rx = Math.cos(yaw), rz = -Math.sin(yaw);
      const inner = [cx + rx * HALF_W, cz + rz * HALF_W];   // 内侧(右手边)
      const outerP = [cx - rx * HALF_W, cz - rz * HALF_W];
      if (prev) {
        // 内墙(面向路径,法线朝 -right)
        pushQuad(v, prev.inner, inner, wallH, [-rx, -rz], 3);
        // 外墙(法线朝 +right)
        pushQuad(v, outerP, prev.outer, wallH, [rx, rz], 2);
      }
      prev = { inner, outer: outerP };
    }
    this.geoCount = v.length / 7;
    this.geoVAO = gl.createVertexArray();
    gl.bindVertexArray(this.geoVAO);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 28, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 28, 24);
    gl.bindVertexArray(null);

    // 星空粒子:沿走廊中心线随机分布
    const N = 5000, pts = new Float32Array(N * 3);
    let rngState = 12345;
    const rnd = () => { rngState = (rngState * 1103515245 + 12345) & 0x7fffffff; return rngState / 0x7fffffff; };
    for (let i = 0; i < N; i++) {
      const s = rnd() * pathLength;
      const [cx, cz] = pathPointFn(s);
      pts[i * 3] = cx + (rnd() - 0.5) * 3.6;
      pts[i * 3 + 1] = 0.2 + rnd() * (wallH - 0.4);
      pts[i * 3 + 2] = cz + (rnd() - 0.5) * 3.6;
    }
    this.ptsCount = N;
    this.ptsVAO = gl.createVertexArray();
    gl.bindVertexArray(this.ptsVAO);
    const pb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, pb);
    gl.bufferData(gl.ARRAY_BUFFER, pts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.fovX = 100 * Math.PI / 180;
    gl.enable(gl.DEPTH_TEST);
  }

  // camPose: [t, px, py, pz, yaw, pitch, roll];starAlpha: 0..1
  render(camPose, starAlpha) {
    const gl = this.gl, c = this.canvas;
    if (c.width !== c.clientWidth && c.clientWidth) { /* 尺寸由外部设置 */ }
    gl.viewport(0, 0, c.width, c.height);
    gl.clearColor(0.03, 0.04, 0.08, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const aspect = c.width / c.height;
    const fovY = 2 * Math.atan(Math.tan(this.fovX / 2) / aspect);
    const proj = m4Perspective(fovY, aspect, 0.05, 120);
    const view = m4View(camPose[4], camPose[5], camPose[6], camPose[1], camPose[2], camPose[3]);

    gl.useProgram(this.geoProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.geoProg, 'uProj'), false, proj);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.geoProg, 'uView'), false, view);
    gl.uniform3f(gl.getUniformLocation(this.geoProg, 'uCamPos'), camPose[1], camPose[2], camPose[3]);
    gl.bindVertexArray(this.geoVAO);
    gl.drawArrays(gl.TRIANGLES, 0, this.geoCount);

    if (starAlpha > 0.01) {
      gl.useProgram(this.ptsProg);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.ptsProg, 'uProj'), false, proj);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.ptsProg, 'uView'), false, view);
      gl.uniform1f(gl.getUniformLocation(this.ptsProg, 'uAlpha'), starAlpha);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.depthMask(false);
      gl.bindVertexArray(this.ptsVAO);
      gl.drawArrays(gl.POINTS, 0, this.ptsCount);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
    gl.bindVertexArray(null);
  }
}
