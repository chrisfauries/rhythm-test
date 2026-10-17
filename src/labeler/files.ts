// Reading capture zips and WAVs in the browser (for the labeler).

const inflateRaw = async (data: Uint8Array) => {
  // TypeScript 4.9's DOM types predate DecompressionStream (Chrome has it).
  const DS = (globalThis as any).DecompressionStream;
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DS("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

/** Files in a .zip (stored or deflated entries), by name. */
export const readZip = async (file: Blob): Promise<Map<string, Uint8Array>> => {
  const buf = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(buf.buffer);
  let end = buf.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error("Not a zip file");
  const count = view.getUint16(end + 10, true);
  let p = view.getUint32(end + 16, true);
  const out = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = buf.subarray(start, start + size);
    out.set(name, method === 0 ? raw : await inflateRaw(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
};

/** Mono samples of a 16-bit PCM or float WAV. */
export const parseWav = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  let off = 12;
  let fmt = { ch: 1, sr: 48000, bits: 16, format: 1 };
  while (off + 8 <= bytes.length) {
    const id = tag(off);
    const size = view.getUint32(off + 4, true);
    if (id === "fmt ") {
      fmt = {
        format: view.getUint16(off + 8, true),
        ch: view.getUint16(off + 10, true),
        sr: view.getUint32(off + 12, true),
        bits: view.getUint16(off + 22, true),
      };
    }
    if (id === "data") {
      const step = (fmt.bits / 8) * fmt.ch;
      const n = Math.floor(size / step);
      const data = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const q = off + 8 + i * step;
        data[i] = fmt.format === 3 ? view.getFloat32(q, true) : view.getInt16(q, true) / 32768;
      }
      return { sampleRate: fmt.sr, data };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error("WAV has no data");
};

export const json = (bytes: Uint8Array | undefined) => (bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null);
