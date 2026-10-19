import { BOOK } from "./bookData";
import { expandShorthand, PAGES } from "./book";
import { countLabel, expectedClaps, expectedCounts, parseLine, RhythmParseError } from "./rhythm";

describe("book transcription", () => {
  for (const page of BOOK) {
    for (const [label, ts, src] of page.lines) {
      it(`${page.title} ${label} adds up`, () => {
        expect(() => parseLine(expandShorthand(src), ts)).not.toThrow();
      });
    }
  }

  it("has unique exercise ids", () => {
    const ids = PAGES.flatMap((p) => p.exercises.map((e) => e.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("parseLine", () => {
  it("rejects measures with the wrong length", () => {
    expect(() => parseLine("q q q", "4/4")).toThrow(RhythmParseError);
  });

  it("supports measure rests in any meter", () => {
    expect(parseLine("mr | q q q", "3/4").measures).toHaveLength(2);
  });

  it("reads beam groups, including triplets and rests inside a beam", () => {
    const line = parseLine("[ 8 8 8 8 ] 8 8 [ 3( 8 8 8 ) ] | [ 8 8r 8 ] 8 h", "4/4");
    expect(line.explicitBeams).toBe(true);
    const beams = line.measures.map((m) => m.map((n) => n.beam ?? null));
    expect(beams).toEqual([
      [0, 0, 0, 0, null, null, 1, 1, 1],
      [2, 2, 2, null, null],
    ]);
  });

  it("beams automatically when a line has no brackets", () => {
    expect(parseLine("8 8 8 8 h", "4/4").explicitBeams).toBeUndefined();
  });

  it("rejects beams that can't be drawn", () => {
    expect(() => parseLine("[ 8 ] 8 h.", "4/4")).toThrow(RhythmParseError);
    expect(() => parseLine("[ q 8 8 ] h", "4/4")).toThrow(RhythmParseError);
    expect(() => parseLine("[ 8 8 | 8 8 ] h", "4/4")).toThrow(RhythmParseError);
  });

  it("matches the book's beaming (four beamed 8ths stay one group)", () => {
    const line = PAGES.find((p) => p.id === "2")!.exercises[0].line;
    const m2 = line.measures[1].map((n) => n.beam);
    expect(new Set(m2.slice(0, 4)).size).toBe(1);
    expect(m2[0]).not.toBe(m2[4]);
  });

  it("supports triplets", () => {
    const line = parseLine("3( 8 8 8 ) q h", "4/4");
    expect(expectedClaps(line).map((c) => c.pos)).toEqual([0, 1 / 3, 2 / 3, 1, 2]);
  });

  it("merges tied notes, including across barlines", () => {
    const line = parseLine("h. q~ | q h q", "4/4");
    const claps = expectedClaps(line);
    expect(claps.map((c) => [c.pos, c.len])).toEqual([
      [0, 3],
      [3, 2],
      [5, 2],
      [7, 1],
    ]);
  });

  it("rejects a tie onto a rest", () => {
    expect(() => parseLine("h~ hr", "4/4")).toThrow(RhythmParseError);
  });
});

describe("counts", () => {
  it("labels subdivisions", () => {
    expect([0, 0.25, 0.5, 0.75, 1, 1 / 3, 2 / 3].map(countLabel)).toEqual(["one", "e", "and", "a", "two", "la", "li"]);
  });

  it("counts held notes but not rests in 'notes' mode", () => {
    const line = parseLine("h qr 8 8", "4/4");
    expect(expectedCounts(line, "notes").map((c) => c.label)).toEqual(["one", "two", "four", "and"]);
  });

  it("counts every beat and every rest in 'all' mode", () => {
    // The "&" of the eighth rest, and both beats of the half rest.
    const line = parseLine("8 8r q | hr", "2/4");
    expect(expectedCounts(line, "all").map((c) => c.label)).toEqual(["one", "and", "two", "one", "two"]);
  });

  it("counts every beat in 'all' mode", () => {
    const line = parseLine("h qr 8 8", "4/4");
    expect(expectedCounts(line, "all").map((c) => c.label)).toEqual(["one", "two", "three", "four", "and"]);
  });

  it("counts eighths in 6/8, but a dotted quarter is one beat: just its first number", () => {
    const line = parseLine("q. 8 8 8", "6/8");
    expect(expectedCounts(line, "notes").map((c) => c.label)).toEqual(["one", "four", "five", "six"]);
    // A dotted half is two beats: "1 (2 3) 4". A dotted-quarter rest is counted on its beat only.
    const held = parseLine("h. | q.r 8 8 8", "6/8");
    expect(expectedCounts(held, "notes").map((c) => c.label)).toEqual(["one", "four", "four", "five", "six"]);
    expect(expectedCounts(held, "all").map((c) => c.label)).toEqual(["one", "four", "one", "four", "five", "six"]);
  });
});
