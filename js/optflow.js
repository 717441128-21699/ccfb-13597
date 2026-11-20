// WebGL2 稠密光流:亮度金字塔(单层低分辨率) + Horn-Schunck 迭代 + GPU 统计归约
// 每帧输出 16 个统计量(打包在 4×1 RGBA 中),批量读回避免 GPU 同步停顿
import { getGL, program, texture, fbo, fsTriangle, FS_VERT } from './glutil.js';

const LUMA_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uTex;
in vec2 vUV; out vec4 o;
void main(){
  vec3 c = texture(uTex, vUV).rgb;
  o = vec4(vec3(dot(c, vec3(0.299, 0.587, 0.114))), 1.0);
}`;

const GRAD_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uPrev, uCurr;
uniform vec2 uTexel;
in vec2 vUV; out vec4 o;
void main(){
  float l = texture(uCurr, vUV - vec2(uTexel.x, 0.)).r;
  float r = texture(uCurr, vUV + vec2(uTexel.x, 0.)).r;
  float d = texture(uCurr, vUV - vec2(0., uTexel.y)).r;
  float u = texture(uCurr, vUV + vec2(0., uTexel.y)).r;
  float it = texture(uCurr, vUV).r - texture(uPrev, vUV).r;
  o = vec4(0.5*(r-l), 0.5*(u-d), it, 0.);
}`;

const HS_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uGrad, uFlow;
uniform vec2 uTexel;
uniform float uLambda;
in vec2 vUV; out vec4 o;
void main(){
  vec2 avg = 0.25 * (
    texture(uFlow, vUV + vec2(uTexel.x, 0.)).rg + texture(uFlow, vUV - vec2(uTexel.x, 0.)).rg +
    texture(uFlow, vUV + vec2(0., uTexel.y)).rg + texture(uFlow, vUV - vec2(0., uTexel.y)).rg);
  vec3 g = texture(uGrad, vUV).rgb;
  float denom = uLambda + g.x*g.x + g.y*g.y;
  vec2 fl = avg - g.xy * (dot(g.xy, avg) + g.z) / denom;
  fl = clamp(fl, vec2(-30.), vec2(30.));
  o = vec4(fl, 0., 1.);
}`;

// 统计归约:输出 4 行 × 4 通道 = 16 个统计量,单位已换算为弧度/帧
// row0: meanU, meanV, meanRotN, meanR2
// row1: meanSpeed, meanLoom, Σspeed·periphW, ΣperiphW   (periphW 侧向加权,对准平移流最强的两侧)
// row2: Σspeed·centerW, ΣcenterW, Σu·centerW, Σv·centerW
// row3: ΣrotN·centerW, Σr2·centerW, 0, 0               (中心区滚转估计,抗近景不对称)
const STATS_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uFlow;
uniform vec2 uFlowSize;
uniform vec2 uScaleRad;
out vec4 o;
void main(){
  float row = floor(gl_FragCoord.y);
  vec4 acc = vec4(0.);
  const int SX = 48, SY = 27;
  for (int j = 0; j < SY; j++) {
    for (int i = 0; i < SX; i++) {
      vec2 uv = (vec2(float(i), float(j)) + 0.5) / vec2(float(SX), float(SY));
      vec2 fpx = texture(uFlow, uv).rg;
      vec2 f = fpx * (2.0 / uFlowSize) * uScaleRad;   // 弧度
      vec2 p = uv * 2.0 - 1.0;                         // 归一化视场坐标
      float r2 = dot(p, p);
      float speed = length(f);
      float periph = smoothstep(0.35, 0.85, r2) * (p.x * p.x);
      float center = 1.0 - smoothstep(0.35, 0.85, r2);
      float rotN = p.x * f.y - p.y * f.x;
      float loom = p.x * f.x + p.y * f.y;
      if (row < 0.5)      acc += vec4(f.x, f.y, rotN, r2);
      else if (row < 1.5) acc += vec4(speed, loom, speed * periph, periph);
      else if (row < 2.5) acc += vec4(speed * center, center, f.x * center, f.y * center);
      else                acc += vec4(rotN * center, r2 * center, 0.0, 0.0);
    }
  }
  o = acc / float(SX * SY);
}`;

const BATCH = 128;

export class OpticalFlow {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 8; this.canvas.height = 8;
    const gl = this.gl = getGL(this.canvas);
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('缺少 EXT_color_buffer_float 扩展,无法计算光流');
    }
    this.FW = 96; this.FH = 54;
    this.progLuma = program(gl, FS_VERT, LUMA_FRAG);
    this.progGrad = program(gl, FS_VERT, GRAD_FRAG);
    this.progHS = program(gl, FS_VERT, HS_FRAG);
    this.progStats = program(gl, FS_VERT, STATS_FRAG);
    this.vao = fsTriangle(gl);

    // 视频帧上传纹理:不用 texStorage2D(不可变存储与 texImage2D 冲突)
    this.vidTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.vidTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const opts16f = { internal: gl.RGBA16F };
    this.luma = [texture(gl, this.FW, this.FH, { internal: gl.R16F }), texture(gl, this.FW, this.FH, { internal: gl.R16F })];
    this.grad = texture(gl, this.FW, this.FH, opts16f);
    this.flow = [texture(gl, this.FW, this.FH, { internal: gl.RG16F }), texture(gl, this.FW, this.FH, { internal: gl.RG16F })];
    this.atlas = texture(gl, BATCH, 4, { internal: gl.RGBA16F, filter: gl.NEAREST });

    this.fboLuma = [fbo(gl, this.luma[0]), fbo(gl, this.luma[1])];
    this.fboGrad = fbo(gl, this.grad);
    this.fboFlow = [fbo(gl, this.flow[0]), fbo(gl, this.flow[1])];
    this.fboAtlas = fbo(gl, this.atlas);

    // 清零
    for (const f of [this.fboLuma[0], this.fboLuma[1], this.fboFlow[0], this.fboFlow[1]]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.cur = 0;      // luma ping-pong
    this.col = 0;      // atlas 当前列
    this.frameIdx = 0; // 已处理帧数
    this.onBatch = null;
    this.fovX = 100 * Math.PI / 180;
  }

  setFov(fovXDeg, aspect) {
    this.fovX = fovXDeg * Math.PI / 180;
    this.fovY = 2 * Math.atan(Math.tan(this.fovX / 2) / aspect);
  }

  _draw(prog, target, w, h, setup) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog);
    setup && setup();
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  _bindTex(unit, tex) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  pushFrame(videoFrame) {
    const gl = this.gl;
    // 上传解码帧
    gl.bindTexture(gl.TEXTURE_2D, this.vidTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoFrame);

    const prev = this.cur, curr = 1 - this.cur;
    // 1) 亮度
    this._draw(this.progLuma, this.fboLuma[curr], this.FW, this.FH, () => {
      this._bindTex(0, this.vidTex);
      gl.uniform1i(gl.getUniformLocation(this.progLuma, 'uTex'), 0);
    });
    // 2) 梯度
    this._draw(this.progGrad, this.fboGrad, this.FW, this.FH, () => {
      this._bindTex(0, this.luma[prev]);
      this._bindTex(1, this.luma[curr]);
      gl.uniform1i(gl.getUniformLocation(this.progGrad, 'uPrev'), 0);
      gl.uniform1i(gl.getUniformLocation(this.progGrad, 'uCurr'), 1);
      gl.uniform2f(gl.getUniformLocation(this.progGrad, 'uTexel'), 1 / this.FW, 1 / this.FH);
    });
    // 3) Horn-Schunck 迭代(每帧从零场开始;不带 warping 的暖启动会发散)
    for (const f of this.fboFlow) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    let a = 0, b = 1;
    const ITER = 16;
    for (let it = 0; it < ITER; it++) {
      this._draw(this.progHS, this.fboFlow[b], this.FW, this.FH, () => {
        this._bindTex(0, this.grad);
        this._bindTex(1, this.flow[a]);
        gl.uniform1i(gl.getUniformLocation(this.progHS, 'uGrad'), 0);
        gl.uniform1i(gl.getUniformLocation(this.progHS, 'uFlow'), 1);
        gl.uniform2f(gl.getUniformLocation(this.progHS, 'uTexel'), 1 / this.FW, 1 / this.FH);
        gl.uniform1f(gl.getUniformLocation(this.progHS, 'uLambda'), 0.0001);
      });
      [a, b] = [b, a];
    }
    // 4) 统计 → atlas 一列
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboAtlas);
    gl.viewport(this.col, 0, 1, 4);
    gl.useProgram(this.progStats);
    this._bindTex(0, this.flow[a]);
    gl.uniform1i(gl.getUniformLocation(this.progStats, 'uFlow'), 0);
    gl.uniform2f(gl.getUniformLocation(this.progStats, 'uFlowSize'), this.FW, this.FH);
    gl.uniform2f(gl.getUniformLocation(this.progStats, 'uScaleRad'), this.fovX / 2, this.fovY / 2);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.cur = curr;
    this.col++;
    this.frameIdx++;
    if (this.col >= BATCH) this.flush();
  }

  flush() {
    if (this.col === 0) return;
    const gl = this.gl;
    const raw = new Float32Array(this.col * 4 * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboAtlas);
    gl.readPixels(0, 0, this.col, 4, gl.RGBA, gl.FLOAT, raw);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // readPixels 布局为 [行][列][通道],转置为 [帧][16]
    const out = new Float32Array(this.col * 16);
    for (let i = 0; i < this.col; i++) {
      for (let j = 0; j < 4; j++) {
        for (let c = 0; c < 4; c++) {
          out[i * 16 + j * 4 + c] = raw[(j * this.col + i) * 4 + c];
        }
      }
    }
    const start = this.frameIdx - this.col;
    const count = this.col;
    this.col = 0;
    if (this.onBatch) this.onBatch(out, start, count);
  }
}
