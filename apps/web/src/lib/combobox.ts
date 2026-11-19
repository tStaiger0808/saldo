/** Lower case without accents, so "arzte" finds "Ärzte" and "STRASSE" finds "Straße". */
export function foldForSearch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replaceAll("ß", "ss");
}

export type SearchIndex<T> = { item: T; folded: string }[];

export function searchIndex<T>(items: readonly T[], label: (item: T) => string): SearchIndex<T> {
  return items.map((item) => ({ item, folded: foldForSearch(label(item)) }));
}

const WORD_START = /[\s\-/.(&,]/;

/** 0: the label starts with the query, 1: a later word does, 2: it occurs inside a word, -1: no match. */
function rank(folded: string, query: string): number {
  let at = folded.indexOf(query);
  if (at < 0) return -1;
  if (at === 0) return 0;
  for (; at >= 0; at = folded.indexOf(query, at + 1)) {
    if (WORD_START.test(folded.charAt(at - 1))) return 1;
  }
  return 2;
}

/**
 * Substring matches of `query`, ignoring case and accents: the label starting with it first, then a word starting with
 * it, then the rest; within a group the given order stays. Returns at most `limit` items and the number of all matches.
 */
export function matchOptions<T>(index: SearchIndex<T>, query: string, limit: number): { items: T[]; total: number } {
  const q = foldForSearch(query.trim());
  if (!q) return { items: index.slice(0, limit).map((entry) => entry.item), total: index.length };
  const groups: T[][] = [[], [], []];
  for (const entry of index) {
    const r = rank(entry.folded, q);
    if (r >= 0) groups[r]?.push(entry.item);
  }
  const all = groups.flat();
  return { items: all.slice(0, limit), total: all.length };
}
