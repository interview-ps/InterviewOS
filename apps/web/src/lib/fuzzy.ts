/**
 * §9.7 command-palette fuzzy scoring — a subsequence match with bonuses for
 * word-boundary hits, consecutive characters, and early match position.
 * Returns a score ≥ 0, or -1 when `query` is not a subsequence of `text`.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return 0;

  let score = 0;
  let pos = 0;
  let streak = 0;
  let firstHit = -1;

  for (const ch of q) {
    const found = t.indexOf(ch, pos);
    if (found === -1) return -1;
    if (firstHit === -1) firstHit = found;
    streak = found === pos ? streak + 1 : 0;
    score += 1 + streak * 2;
    if (found === 0 || /[\s\-_/()]/.test(t[found - 1])) score += 4;
    pos = found + 1;
  }
  score += Math.max(0, 12 - firstHit);
  // A command whose first character matches the query is the most likely
  // intent ("system" → "Start system design …").
  if (firstHit === 0) score += 10;
  return score;
}

export interface Scored<T> {
  item: T;
  score: number;
}

/** Filter + rank `items` whose `text` fuzzy-matches `query`, best first. */
export function fuzzyFilter<T>(
  items: T[],
  query: string,
  text: (item: T) => string,
): T[] {
  const scored: Scored<T>[] = [];
  for (const item of items) {
    const score = fuzzyScore(query, text(item));
    if (score >= 0) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}
