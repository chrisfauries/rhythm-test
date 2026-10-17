// Minimal .zip reader (stored or deflated entries) for capture/debug zips.
const fs = require("fs");
const zlib = require("zlib");

exports.readZip = (file) => {
  const buf = fs.readFileSync(file);
  // End of central directory: last 22+ bytes, signature 0x06054b50.
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error(`${file}: not a zip`);
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + size);
    files[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
};

/** Mono float samples from a 16-bit or float WAV buffer. */
exports.wavSamples = (b) => {
  let off = 12;
  let fmt = null;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === "fmt ") fmt = { ch: b.readUInt16LE(off + 10), sr: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22), fmt: b.readUInt16LE(off + 8) };
    if (id === "data") {
      const bytes = fmt.bits / 8;
      const n = Math.floor(size / bytes / fmt.ch);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const q = off + 8 + i * fmt.ch * bytes;
        out[i] = fmt.fmt === 3 ? b.readFloatLE(q) : b.readInt16LE(q) / 32768;
      }
      return { sr: fmt.sr, data: out };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
};
