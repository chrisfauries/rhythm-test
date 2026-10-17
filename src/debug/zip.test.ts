/**
 * @jest-environment node
 */
import { crc32, zipBytes } from "./zip";

const bytes = (s: string) => new TextEncoder().encode(s);

test("crc32 matches the standard check value", () => {
  expect(crc32(bytes("123456789")).toString(16)).toBe("cbf43926");
});

test("zip has a local header per file and a central directory", () => {
  const buf = zipBytes([
    { name: "a.txt", data: bytes("hello") },
    { name: "b.json", data: bytes("{}") },
  ]);
  const view = new DataView(buf.buffer);
  expect(view.getUint32(0, true)).toBe(0x04034b50);
  const end = buf.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  expect(view.getUint16(end + 10, true)).toBe(2);
  const dirOffset = view.getUint32(end + 16, true);
  expect(view.getUint32(dirOffset, true)).toBe(0x02014b50);
  expect(new TextDecoder().decode(buf.subarray(30, 35))).toBe("a.txt");
  expect(new TextDecoder().decode(buf.subarray(35, 40))).toBe("hello");
});
