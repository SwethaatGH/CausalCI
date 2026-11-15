// Connects a production signal (error rate, latency) to the deploy that most likely caused it.

export interface SeriesPoint {
  /** Unix time in seconds. */
  t: number;
  v: number;
}

export interface ChangePoint {
  /** Index of the first point after the shift. */
  index: number;
  t: number;
  meanBefore: number;
  meanAfter: number;
  /** Welch t-statistic of the shift; larger is stronger evidence. */
  tStat: number;
}

export interface Deploy {
  sha: string;
  /** Unix time in seconds. */
  t: number;
}

/**
 * Finds the single most likely upward mean shift by scanning every split and maximizing the
 * Welch t-statistic between the two segments (O(n) with prefix sums). Returns null when no split
 * clears `minT`, so a noisy but flat series never produces a suspect.
 */
export function detectChangePoint(series: SeriesPoint[], opts: { minSegment?: number; minT?: number } = {}): ChangePoint | null {
  const minSeg = Math.max(2, opts.minSegment ?? 3);
  const minT = opts.minT ?? 4;
  const pts = [...series].sort((a, b) => a.t - b.t);
  const n = pts.length;
  if (n < minSeg * 2) return null;
  const s1 = [0];
  const s2 = [0];
  for (const p of pts) {
    s1.push(s1[s1.length - 1] + p.v);
    s2.push(s2[s2.length - 1] + p.v * p.v);
  }
  let best: ChangePoint | null = null;
  for (let k = minSeg; k <= n - minSeg; k++) {
    const nA = k;
    const nB = n - k;
    const mA = s1[k] / nA;
    const mB = (s1[n] - s1[k]) / nB;
    const vA = Math.max(0, (s2[k] - nA * mA * mA) / Math.max(1, nA - 1));
    const vB = Math.max(0, (s2[n] - s2[k] - nB * mB * mB) / Math.max(1, nB - 1));
    const se = Math.sqrt(vA / nA + vB / nB) || 1e-9;
    const t = (mB - mA) / se;
    if (t > (best?.tStat ?? -Infinity)) best = { index: k, t: pts[k].t, meanBefore: mA, meanAfter: mB, tStat: t };
  }
  return best && best.tStat >= minT ? best : null;
}

export interface SuspectRange {
  changePoint: ChangePoint;
  /** Deploy live when the shift began: the bad end of the bisect range. */
  suspectDeploy: Deploy;
  /** Deploy before it: the good end of the bisect range, or null if none is known. */
  lastGoodDeploy: Deploy | null;
  /** Seconds between the deploy and the start of the shift. */
  lagSeconds: number;
}

/**
 * The deploy that was live when the metric shifted is the prime suspect; the one before it is the
 * last known-good release. Their SHAs bound the commit range to bisect.
 */
export function suspectRangeFromSignal(series: SeriesPoint[], deploys: Deploy[], opts?: { minSegment?: number; minT?: number; maxLagSeconds?: number }): SuspectRange | null {
  const cp = detectChangePoint(series, opts);
  if (!cp) return null;
  const sorted = [...deploys].sort((a, b) => a.t - b.t);
  const live = sorted.filter((d) => d.t <= cp.t);
  const suspect = live[live.length - 1];
  if (!suspect) return null;
  const lag = cp.t - suspect.t;
  if (opts?.maxLagSeconds !== undefined && lag > opts.maxLagSeconds) return null;
  return { changePoint: cp, suspectDeploy: suspect, lastGoodDeploy: live[live.length - 2] ?? null, lagSeconds: lag };
}
