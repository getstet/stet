// Starting values a screen may open with in place of its empty ones, keyed by
// the screen's path. Normal use sets none.
let seeds: Record<string, unknown> = {};

export function setScreenSeeds(next: Record<string, unknown>) {
  seeds = next;
}

export function screenSeed<T>(screen: string): T | undefined {
  return seeds[screen] as T | undefined;
}
