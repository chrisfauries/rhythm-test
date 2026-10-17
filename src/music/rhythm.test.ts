import { BOOK } from "./bookData";
import { expandShorthand, PAGES } from "./book";
import {
  countLabel,
  expectedClaps,
  expectedCounts,
  parseLine,
  RhythmParseError,
} from "./rhythm";

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
    expect([0, 0.25, 0.5, 0.75, 1, 1 / 3, 2 / 3].map(countLabel)).toEqual([
      "one",
      "e",
      "and",
      "a",
      "two",
      "trip",
      "let",
    ]);
  });

  it("counts held notes but not rests in 'notes' mode", () => {
    const line = parseLine("h qr 8 8", "4/4");
    expect(expectedCounts(line, "notes").map((c) => c.label)).toEqual([
      "one",
      "two",
      "four",
      "and",
    ]);
  });

  it("counts every beat in 'all' mode", () => {
    const line = parseLine("h qr 8 8", "4/4");
    expect(expectedCounts(line, "all").map((c) => c.label)).toEqual([
      "one",
      "two",
      "three",
      "four",
      "and",
    ]);
  });

  it("counts eighth-note beats in 6/8", () => {
    const line = parseLine("q. 8 8 8", "6/8");
    expect(expectedCounts(line, "notes").map((c) => c.label)).toEqual([
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
    ]);
  });
});
