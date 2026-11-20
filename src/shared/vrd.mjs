// .vrd 试玩数据容器（单文件，小端序）
//
//   ASCII 头 "VRD1\n" + JSON 元数据 + "\n"
//   二进制帧记录（每帧 60 字节）：
//     uint32 frameIndex, float32 t,
//     float32[4] quat(x,y,z,w), float32 headYawRate, float32 headPitchRate,
//     float32 worldVx, worldVy, worldVz, float32 camYaw, camPitch,
//     float32 tunnel
//   编码视频块（uint32 长度 + 字节），第一块带 codec description（avcC/vp9 config）
//
// 姿态是 JSON 头里声明的 90Hz 等间隔序列；视频块时间戳通过帧号 / fps 对齐。

const MAGIC = 'VRD1\n';
const RECORD = 4 + 4 * 17; // 72 字节/帧（含位置 xyz）

export class VrdWriter {
  constructor(meta) {
    this.chunks = [];
    this.meta = { ...meta, format: 'vrd', version: 2, recordBytes: RECORD };
    this._frameCount = 0;
  }

  addFrame(f) {
    const buf = new ArrayBuffer(RECORD);
    const dv = new DataView(buf);
    let o = 0;
    dv.setUint32(o, f.i, true); o += 4;
    dv.setFloat32(o, f.t, true); o += 4;
    dv.setFloat32(o, f.quat[0], true); o += 4;
    dv.setFloat32(o, f.quat[1], true); o += 4;
    dv.setFloat32(o, f.quat[2], true); o += 4;
    dv.setFloat32(o, f.quat[3], true); o += 4;
    dv.setFloat32(o, f.headYawRate, true); o += 4;
    dv.setFloat32(o, f.headPitchRate, true); o += 4;
    dv.setFloat32(o, f.worldV[0], true); o += 4;
    dv.setFloat32(o, f.worldV[1], true); o += 4;
    dv.setFloat32(o, f.worldV[2], true); o += 4;
    dv.setFloat32(o, f.camYaw, true); o += 4;
    dv.setFloat32(o, f.camPitch, true); o += 4;
    dv.setFloat32(o, f.tunnel, true); o += 4;
    dv.setFloat32(o, f.pos[0], true); o += 4;
    dv.setFloat32(o, f.pos[1], true); o += 4;
    dv.setFloat32(o, f.pos[2], true);
    this.chunks.push(new Uint8Array(buf));
    this._frameCount++;
  }

  addVideoChunk(data, timestamp, isKey) {
    const head = new ArrayBuffer(12);
    const dv = new DataView(head);
    dv.setUint32(0, data.byteLength, true);
    dv.setUint32(4, Math.round(timestamp), true);
    dv.setUint32(8, isKey ? 1 : 0, true);
    this.chunks.push(new Uint8Array(head), data);
  }

  finalize(codec, extraDescription) {
    this.meta.frameCount = this._frameCount;
    this.meta.codec = codec;
    this.meta.descriptionBytes = extraDescription?.byteLength ?? 0;
    const header = new TextEncoder().encode(MAGIC + JSON.stringify(this.meta) + '\n');
    const parts = [header];
    if (extraDescription) parts.push(extraDescription);
    parts.push(...this.chunks);
    const total = parts.reduce((s, p) => s + p.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.byteLength;
    }
    return out;
  }
}

export function parseVrd(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const nl = u8.indexOf(0x0a, 5);
  if (nl < 0 || new TextDecoder().decode(u8.subarray(0, 5)) !== MAGIC) {
    throw new Error('不是合法的 VRD 文件（魔数不匹配）');
  }
  const meta = JSON.parse(new TextDecoder().decode(u8.subarray(5, nl)));
  let off = nl + 1;
  let description = null;
  if (meta.descriptionBytes > 0) {
    description = u8.slice(off, off + meta.descriptionBytes);
    off += meta.descriptionBytes;
  }
  const frames = new Array(meta.frameCount);
  for (let i = 0; i < meta.frameCount; i++) {
    const dv = new DataView(u8.buffer, u8.byteOffset + off, RECORD);
    let o = 0;
    const idx = dv.getUint32(o, true); o += 4;
    const t = dv.getFloat32(o, true); o += 4;
    const quat = [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true), dv.getFloat32(o + 12, true)];
    o += 16;
    frames[i] = {
      i: idx,
      t,
      quat,
      headYawRate: dv.getFloat32(o, true),
      headPitchRate: dv.getFloat32(o + 4, true),
      worldV: [dv.getFloat32(o + 8, true), dv.getFloat32(o + 12, true), dv.getFloat32(o + 16, true)],
      camYaw: dv.getFloat32(o + 20, true),
      camPitch: dv.getFloat32(o + 24, true),
      tunnel: dv.getFloat32(o + 28, true),
      // v2 起含精确位置；v1 文件这三个字段读出越界值，由 app 侧回退到速度积分
      pos: meta.version >= 2
        ? [dv.getFloat32(o + 32, true), dv.getFloat32(o + 36, true), dv.getFloat32(o + 40, true)]
        : null,
    };
    off += RECORD;
  }
  const video = [];
  while (off + 12 <= u8.length) {
    const dv = new DataView(u8.buffer, u8.byteOffset + off, 12);
    const len = dv.getUint32(0, true);
    const timestamp = dv.getUint32(4, true);
    const isKey = dv.getUint32(8, true) === 1;
    off += 12;
    if (off + len > u8.length) break;
    video.push({ data: u8.slice(off, off + len), timestamp, isKey });
    off += len;
  }
  return { meta, frames, video, description };
}
