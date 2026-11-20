// .vrs 会话容器:'VRS1' + u32头长 + JSON头 + 头显位姿(Float32) + 视频码流
// 头显位姿每帧 7 个 float: t, px, py, pz, yaw, pitch, roll
import { bytesToB64, b64ToBytes } from './util.js';

export function encodeVRS(meta, headPosesF32, chunks) {
  const headBytes = new Uint8Array(headPosesF32.buffer, headPosesF32.byteOffset, headPosesF32.byteLength);
  meta.poseCount = headPosesF32.length / 7;
  meta.poseBytes = headBytes.byteLength;
  meta.chunks = chunks.map(c => ({ key: c.key, ts: c.ts, dur: c.dur, size: c.data.byteLength }));
  const headerBytes = new TextEncoder().encode(JSON.stringify(meta));
  const videoBytes = chunks.reduce((a, c) => a + c.data.byteLength, 0);
  const out = new Uint8Array(8 + headerBytes.byteLength + headBytes.byteLength + videoBytes);
  const dv = new DataView(out.buffer);
  out.set([0x56, 0x52, 0x53, 0x31], 0); // 'VRS1'
  dv.setUint32(4, headerBytes.byteLength, true);
  out.set(headerBytes, 8);
  let off = 8 + headerBytes.byteLength;
  out.set(headBytes, off); off += headBytes.byteLength;
  for (const c of chunks) { out.set(c.data, off); off += c.data.byteLength; }
  return new Blob([out], { type: 'application/octet-stream' });
}

export function decodeVRS(buf) {
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== 0x56 || dv.getUint8(1) !== 0x52) throw new Error('不是有效的 .vrs 文件');
  const headerLen = dv.getUint32(4, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, headerLen)));
  let off = 8 + headerLen;
  const head = new Float32Array(buf.slice(off, off + meta.poseBytes));
  off += meta.poseBytes;
  const chunks = meta.chunks.map(cm => {
    const data = new Uint8Array(buf, off, cm.size);
    off += cm.size;
    return { key: cm.key, ts: cm.ts, dur: cm.dur, data };
  });
  return { meta, head, chunks };
}

export { bytesToB64, b64ToBytes };
