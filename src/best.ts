export const BEST_KEY = 'pacman.bestScore';

// canon: CAP-9.2
// canon: CAP-9.3
export function nextBest(best: number | null, score: number): number {
  return best === null || score > best ? score : best;
}

// canon: CAP-9.1
// canon: CAP-9.4
export function readBest(storage: Pick<Storage, 'getItem'> | null): number | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(BEST_KEY);
    if (raw === null || !/^\d+$/.test(raw)) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : null;
  } catch {
    return null;
  }
}

// canon: CAP-9.1
// canon: CAP-9.4
export function writeBest(storage: Pick<Storage, 'setItem'> | null, best: number): void {
  if (storage === null) return;
  try {
    storage.setItem(BEST_KEY, String(best));
  } catch {
    // Storage full or blocked: the best stays in memory only.
  }
}

// canon: CAP-9.5
export function bestText(best: number | null): string {
  return best === null ? 'Best: –' : `Best: ${best}`;
}
