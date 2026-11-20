// WebGL2 GPU 金字塔 Lucas-Kanade 光流
//
// 管线（全部在 GPU，仅 16×9 统计网格读回 CPU）：
//   视频帧 → 灰度纹理 → 两层高斯金字塔
//   粗层 LK 迭代（亮度恒定 + 邻域空间一致性，单纹理 Gauss-Seidel 迭代）
//   上采样到细层再迭代 → 输出全分辨率速度场（像素/秒）
//   降采样到 16×9 格点速度，与 scene.mjs 的解析网格同构
//
// 这是产品侧“从画面算光流”的唯一实现；Node 校验用解析光流替代视频解码链路。

import { VIDEO_W, VIDEO_H, GRID_COLS, GRID_ROWS, FOCAL } from '../shared/scene.mjs';

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main(){
  vUv = aPos * 0.5 + 0.5;
  vUv.y = 1.0 - vUv.y;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const GRAY_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uImg;
out vec4 outColor;
void main(){
  vec3 c = texture(uImg, vUv).rgb;
  float g = dot(c, vec3(0.299, 0.587, 0.114));
  outColor = vec4(g, g, g, 1.0);
}`;

const PYRAMID_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uTexel;
out vec4 outColor;
void main(){
  // 3×3 高斯（权重 1-2-1 / 4-8-4 归一化）
  float s = 0.0;
  float wsum = 0.0;
  for (int y=-1;y<=1;y++) for (int x=-1;x<=1;x++){
    float w = (x==0?2.0:1.0) * (y==0?2.0:1.0);
    s += texture(uSrc, vUv + vec2(float(x),float(y))*uTexel).r * w;
    wsum += w;
  }
  float g = s / wsum;
  outColor = vec4(g,g,g,1.0);
}`;

// LK 迭代：读上一轮位移场 d（像素/帧），最小化 Σ (Ix·dx + Iy·dy + It)²
// 邻域 3×3 求和，Gauss-Seidel 单纹理更新。
// 输出位移（像素/帧），CPU 侧除以 dt 得像素/秒，与解析光流同量纲。
const LK_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uCur;   // 当前帧灰度
uniform sampler2D uPrev;  // 上一帧灰度
uniform sampler2D uFlow;  // 上一轮位移 (dx,dy) 像素/帧（本层坐标）
uniform vec2 uTexel;
out vec4 outColor;

void main(){
  vec2 guess = texture(uFlow, vUv).xy;
  float sumIx2=0.0, sumIy2=0.0, sumIxIy=0.0, sumIxIt=0.0, sumIyIt=0.0;
  for (int dy=-1;dy<=1;dy++) for (int dx=-1;dx<=1;dx++){
    vec2 off = vec2(float(dx),float(dy)) * uTexel;
    vec2 p = vUv + off;
    float Ic = texture(uCur, p).r;
    // 用上一轮位移把上一帧 warp 到当前坐标（位移是像素/帧 → 纹理坐标）
    vec2 warpUv = clamp(p - guess * uTexel, vec2(0.0), vec2(1.0));
    float Ip = texture(uPrev, warpUv).r;
    float Ix = (texture(uCur, p + vec2(uTexel.x,0.0)).r - texture(uCur, p - vec2(uTexel.x,0.0)).r) * 0.5;
    float Iy = (texture(uCur, p + vec2(0.0,uTexel.y)).r - texture(uCur, p - vec2(0.0,uTexel.y)).r) * 0.5;
    float It = Ic - Ip;
    sumIx2 += Ix*Ix; sumIy2 += Iy*Iy; sumIxIy += Ix*Iy;
    sumIxIt += Ix*It; sumIyIt += Iy*It;
  }
  float det = sumIx2 * sumIy2 - sumIxIy * sumIxIy;
  vec2 delta = vec2(0.0);
  if (abs(det) > 1e-8){
    delta.x = (-sumIy2 * sumIxIt + sumIxIy * sumIyIt) / det;
    delta.y = ( sumIxIy * sumIxIt - sumIx2 * sumIyIt) / det;
  }
  // 限幅：单层位移不超过 8 像素/帧，超出交给金字塔粗层
  delta = clamp(delta, vec2(-8.0), vec2(8.0));
  outColor = vec4(guess + delta, 0.0, 1.0);
}`;

const UPSAMPLE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uFlow;
uniform float uScale; // 层间分辨率比例（≈2）
out vec4 outColor;
void main(){
  vec2 f = texture(uFlow, vUv).xy * uScale;
  outColor = vec4(f, 0.0, 1.0);
}`;

// 全分辨率速度场降采样到 16×9 网格（块平均）
const GRID_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uFlow;
uniform vec2 uBlock; // 每格块尺寸（纹素）
uniform vec2 uTexel;
out vec4 outColor;
void main(){
  // vUv 即当前格点中心（纹素坐标），在其周围 ±半个块内对称平均
  vec2 sum = vec2(0.0);
  for (int y=0;y<${Math.round(VIDEO_H / GRID_ROWS)};y++){
    for (int x=0;x<${Math.round(VIDEO_W / GRID_COLS)};x++){
      vec2 offset = (vec2(float(x),float(y)) - uBlock*0.5 + 0.5) * uTexel;
      vec2 p = vUv + offset;
      sum += texture(uFlow, clamp(p, vec2(0.0), vec2(1.0))).xy;
    }
  }
  float n = uBlock.x * uBlock.y;
  outColor = vec4(sum / n, 0.0, 1.0);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('着色器编译失败: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

function program(gl, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('程序链接失败: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

function makeTarget(gl, w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.GL_COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return { tex, fbo, w, h };
}

export function glFlowSupported() {
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2');
    if (!gl || !gl.getExtension('EXT_color_buffer_float')) return false;
    // 关键校验：浮点 FBO 必须真正可渲染。部分无 GPU 环境（远程桌面/精简 VM 的
    // SwiftShader 桩）能返回 context 但 FBO 恒为 FRAMEBUFFER_UNSUPPORTED。
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 4, 4, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.GL_COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    const err = gl.getError();
    return ok && err === gl.NO_ERROR;
  } catch {
    return false;
  }
}

export function createFlowGL(canvas) {
  const gl = canvas.getContext('webgl2', {
    preserveDrawingBuffer: false,
    antialias: false,
    powerPreference: 'high-performance',
  });
  if (!gl) throw new Error('当前浏览器不支持 WebGL2');
  if (!gl.getExtension('EXT_color_buffer_float')) {
    throw new Error('不支持 EXT_color_buffer_float，无法做浮点光流');
  }

  const progs = {
    gray: program(gl, GRAY_FS),
    pyramid: program(gl, PYRAMID_FS),
    lk: program(gl, LK_FS),
    upsample: program(gl, UPSAMPLE_FS),
    grid: program(gl, GRID_FS),
  };

  // 全屏三角形
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  for (const p of Object.values(progs)) {
    const loc = gl.getAttribLocation(p, 'aPos');
    if (loc >= 0) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }
  }

  const W = VIDEO_W;
  const H = VIDEO_H;
  const W2 = W / 2;
  const H2 = H / 2;

  // 浮点目标（速度场需要浮点精度）。
  // RGBA32F 是 WebGL2 规范中 color-renderable 的浮点格式，驱动支持最广；
  // 个别后端（部分 SwiftShader）的 RGBA16F FBO 不完整，故优先 32F。
  function makeFloatTarget(w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.GL_COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`浮点 FBO 不完整（status=${status}），该 GPU/驱动无法运行 GPU 光流`);
    }
    return { tex, fbo, w, h };
  }

  // 灰度（双缓冲：当前/上一帧，两层金字塔）
  let grayCur0 = makeTarget(gl, W, H);
  let grayPrev0 = makeTarget(gl, W, H);
  let grayCur1 = makeTarget(gl, W2, H2);
  let grayPrev1 = makeTarget(gl, W2, H2);
  // 速度场（粗层、细层各双缓冲做乒乓）
  const flowCoarseA = makeFloatTarget(gl, W2, H2);
  const flowCoarseB = makeFloatTarget(gl, W2, H2);
  const flowFineA = makeFloatTarget(gl, W, H);
  const flowFineB = makeFloatTarget(gl, W, H);
  const gridTarget = makeFloatTarget(gl, GRID_COLS, GRID_ROWS);

  // 视频输入纹理
  const videoTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, videoTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  function bind(prog, uniforms) {
    gl.useProgram(prog);
    for (const [name, val] of Object.entries(uniforms)) {
      const loc = gl.getUniformLocation(prog, name);
      if (loc === null) continue;
      if (val.sampler !== undefined) {
        gl.activeTexture(gl.TEXTURE0 + val.sampler);
        gl.bindTexture(gl.TEXTURE_2D, val.tex);
        gl.uniform1i(loc, val.sampler);
      } else if (Array.isArray(val)) gl.uniform2f(loc, val[0], val[1]);
      else gl.uniform1f(loc, val);
    }
  }

  function drawTo(target) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.w, target.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  let hasPrev = false;
  const gridPixels = new Float32Array(GRID_COLS * GRID_ROWS * 4);

  function uploadVideo(frame) {
    gl.bindTexture(gl.TEXTURE_2D, videoTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
  }

  // 处理一帧（VideoFrame / canvas / ImageBitmap），返回 16×9 格点速度（px/s）
  function process(frame) {
    uploadVideo(frame);

    // 1. 灰度
    bind(progs.gray, { uImg: { sampler: 0, tex: videoTex } });
    drawTo(grayCur0);
    bind(progs.pyramid, {
      uSrc: { sampler: 0, tex: grayCur0.tex },
      uTexel: [1 / W2, 1 / H2],
    });
    drawTo(grayCur1);

    if (!hasPrev) {
      // 首帧没有上一帧，速度为 0
      gl.bindFramebuffer(gl.FRAMEBUFFER, flowFineA.fbo);
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    } else {
      // 2. 粗层 LK（3 次迭代，乒乓）
      const zeroTarget = (t) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
        gl.viewport(0, 0, t.w, t.h);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      };
      zeroTarget(flowCoarseA);
      let src = flowCoarseA;
      let dst = flowCoarseB;
      for (let it = 0; it < 3; it++) {
        bind(progs.lk, {
          uCur: { sampler: 0, tex: grayCur1.tex },
          uPrev: { sampler: 1, tex: grayPrev1.tex },
          uFlow: { sampler: 2, tex: src.tex },
          uTexel: [1 / W2, 1 / H2],
        });
        drawTo(dst);
        [src, dst] = [dst, src];
      }
      // 3. 上采样到细层
      bind(progs.upsample, {
        uFlow: { sampler: 0, tex: src.tex },
        uScale: W / W2,
      });
      drawTo(flowFineA);
      // 4. 细层 LK（2 次迭代）
      let fsrc = flowFineA;
      let fdst = flowFineB;
      for (let it = 0; it < 2; it++) {
        bind(progs.lk, {
          uCur: { sampler: 0, tex: grayCur0.tex },
          uPrev: { sampler: 1, tex: grayPrev0.tex },
          uFlow: { sampler: 2, tex: fsrc.tex },
          uTexel: [1 / W, 1 / H],
        });
        drawTo(fdst);
        [fsrc, fdst] = [fdst, fsrc];
      }
      // 5. 降采样到 16×9
      const blockX = W / GRID_COLS;
      const blockY = H / GRID_ROWS;
      bind(progs.grid, {
        uFlow: { sampler: 0, tex: fsrc.tex },
        uBlock: [blockX, blockY],
        uTexel: [1 / W, 1 / H],
      });
      drawTo(gridTarget);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.readPixels(0, 0, GRID_COLS, GRID_ROWS, gl.RGBA, gl.FLOAT, gridPixels);
    }

    // 轮换当前/上一帧
    [grayCur0, grayPrev0] = [grayPrev0, grayCur0];
    [grayCur1, grayPrev1] = [grayPrev1, grayCur1];
    hasPrev = true;

    // 输出语义说明：LK 着色器累积的是帧间位移（像素/帧）。
    // readPixels 原点在左下，而 scene.mjs 网格行序自上而下（v 向下），
    // 故按行翻转；垂直速度同时取反，使 +fy 与解析光流一样表示画面向下运动。
    const fx = new Float32Array(GRID_COLS * GRID_ROWS);
    const fy = new Float32Array(GRID_COLS * GRID_ROWS);
    const invDt = 90; // 像素/帧 → 像素/秒
    for (let row = 0; row < GRID_ROWS; row++) {
      const srcRow = GRID_ROWS - 1 - row;
      for (let col = 0; col < GRID_COLS; col++) {
        const srcIdx = (srcRow * GRID_COLS + col) * 4;
        const dstIdx = row * GRID_COLS + col;
        fx[dstIdx] = gridPixels[srcIdx] * invDt;
        fy[dstIdx] = -gridPixels[srcIdx + 1] * invDt;
      }
    }
    return { fx, fy };
  }

  return { gl, process, W, H, focal: FOCAL };
}
