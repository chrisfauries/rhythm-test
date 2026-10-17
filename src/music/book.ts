import { BOOK } from "./bookData";
import { Line, parseLine } from "./rhythm";

export interface Exercise {
  /** Stable id, e.g. "7.5-C". */
  id: string;
  pageId: string;
  label: string;
  title: string;
  timeSig: string;
  source: string;
  line: Line;
}

export interface Page {
  id: string;
  title: string;
  subtitle?: string;
  exercises: Exercise[];
}

/** Expand the shorthand used in bookData.ts into plain notation. */
export const expandShorthand = (source: string) =>
  source.replace(/\bS\b/g, "16 16 16 16").replace(/\bD\b/g, "8. 16");

export const PAGES: Page[] = BOOK.map((p) => ({
  id: p.id,
  title: p.title,
  subtitle: p.subtitle,
  exercises: p.lines.map(([label, timeSig, raw]) => {
    const source = expandShorthand(raw);
    return {
      id: `${p.id}-${label}`,
      pageId: p.id,
      label,
      title: `${p.title} – ${label}`,
      timeSig,
      source,
      line: parseLine(source, timeSig),
    };
  }),
}));

export const findExercise = (id: string) => {
  for (const page of PAGES) {
    const index = page.exercises.findIndex((e) => e.id === id);
    if (index >= 0) return { page, exercise: page.exercises[index], index };
  }
  return null;
};

/** The exercise after `id`, continuing onto the next page. */
export const nextExercise = (id: string): Exercise | null => {
  const all = PAGES.flatMap((p) => p.exercises);
  const i = all.findIndex((e) => e.id === id);
  return i >= 0 && i + 1 < all.length ? all[i + 1] : null;
};

export const customExercise = (source: string, timeSig: string): Exercise => {
  const expanded = expandShorthand(source);
  return {
    id: "custom",
    pageId: "custom",
    label: "Custom",
    title: "Custom Rhythm",
    timeSig,
    source: expanded,
    line: parseLine(expanded, timeSig),
  };
};
