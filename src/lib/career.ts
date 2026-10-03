const xpForLevel = (n: number) => (n <= 1 ? 0 : Math.round(600 * Math.pow(n - 1, 1.55)));

const TITLES: [number, string][] = [
  [17, 'Legend'],
  [12, 'Master driver'],
  [8, 'Senior driver'],
  [5, 'Driver'],
  [3, 'Junior driver'],
  [1, 'Trainee'],
];

export interface Level {
  level: number;
  title: string;
  /** 0..1 towards the next level */
  progress: number;
  toNext: number;
}

export function levelFor(xp: number): Level {
  let level = 1;
  while (xpForLevel(level + 1) <= xp) level++;
  const cur = xpForLevel(level);
  const next = xpForLevel(level + 1);
  return {
    level,
    title: TITLES.find(([min]) => level >= min)![1],
    progress: (xp - cur) / Math.max(1, next - cur),
    toNext: next - xp,
  };
}
