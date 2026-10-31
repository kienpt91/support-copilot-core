export interface FusedItem {
  id: string;
  score: number;
  /** 1-based rank in each input list, or null when the list did not contain the id. */
  ranks: (number | null)[];
}

/**
 * Reciprocal Rank Fusion (Cormack et al. 2009): score(id) = sum over lists of 1 / (k + rank).
 * Only ranks matter, so the incompatible score scales of BM25 and cosine do not need normalising.
 * Ties break by the best rank, then by first appearance.
 */
export function reciprocalRankFusion(lists: readonly (readonly string[])[], k = 60): FusedItem[] {
  const acc = new Map<string, FusedItem & { first: number; best: number }>();
  let seen = 0;
  lists.forEach((list, li) => {
    list.forEach((id, i) => {
      const rank = i + 1;
      let item = acc.get(id);
      if (!item) {
        item = { id, score: 0, ranks: lists.map(() => null), first: seen++, best: rank };
        acc.set(id, item);
      }
      item.ranks[li] = rank;
      item.score += 1 / (k + rank);
      item.best = Math.min(item.best, rank);
    });
  });
  return [...acc.values()]
    .sort((a, b) => b.score - a.score || a.best - b.best || a.first - b.first)
    .map(({ id, score, ranks }) => ({ id, score, ranks }));
}
