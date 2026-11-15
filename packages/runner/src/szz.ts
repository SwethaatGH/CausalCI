// SZZ (Śliwerski, Zimmermann, Zeller 2005): find bug-introducing commits from bug-fix commits.
// For each fix, the lines it deletes or modifies are blamed on the fix's parent; the commits that
// last touched those lines are the candidate bug introducers. Reverts are used as a second,
// higher-precision label source: "This reverts commit X" names X directly.
import { isDocsPath, isSourcePath, isTestPath, parsePatch, removedOldLines } from "@causalci/analysis";
import { git, loadCommit } from "./git";

export interface RegressionLabel {
  fixSha: string;
  introducingSha: string;
  method: "revert" | "szz";
  /** For SZZ: share of blamed lines attributed to this commit (1 for reverts). */
  support: number;
  fixTitle: string;
}

const FIX_RE = /\b(fix(e[sd])?|bug(fix)?|regression|broke|breaks|crash(es|ed)?|hotfix)\b/i;
const NOT_FIX_RE = /\b(typo|lint|format(ting)?|docs?|readme|changelog|prefix|suffix)\b/i;
const REVERT_RE = /This reverts commit ([0-9a-f]{7,40})/i;
const COMMENT_ONLY = /^\s*(\/\/|\/\*|\*|#|$)/;

export async function mineReverts(repo: string, opts: { ref?: string; maxCount?: number } = {}): Promise<RegressionLabel[]> {
  const out = await git(repo, ["log", "--first-parent", `--max-count=${opts.maxCount ?? 5000}`, "--format=%H%x00%s%x00%b%x1e", opts.ref ?? "HEAD"]);
  const labels: RegressionLabel[] = [];
  for (const rec of out.split("\x1e")) {
    const [sha, subject, body] = rec.trim().split("\0");
    if (!sha || !/^revert/i.test(subject ?? "")) continue;
    const m = REVERT_RE.exec(body ?? "");
    if (!m) continue;
    const introducing = (await git(repo, ["rev-parse", "--verify", `${m[1]}^{commit}`]).catch(() => "")).trim();
    if (introducing) labels.push({ fixSha: sha, introducingSha: introducing, method: "revert", support: 1, fixTitle: subject });
  }
  return labels;
}

/** Groups sorted line numbers into contiguous [start, end] ranges for `git blame -L`. */
export function toRanges(lines: number[]): [number, number][] {
  const s = [...new Set(lines)].filter((n) => n > 0).sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (const n of s) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out;
}

/** Parses `git blame --porcelain` output into the commit SHA for each blamed line. */
export function parseBlamePorcelain(text: string): string[] {
  const shas: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]{40}) \d+ \d+( \d+)?$/.exec(line);
    if (m) shas.push(m[1]);
  }
  return shas;
}

export async function szzForFix(repo: string, fixSha: string): Promise<RegressionLabel[]> {
  const fix = await loadCommit(repo, fixSha);
  if (!fix.parents.length) return [];
  const parent = fix.parents[0];
  const votes = new Map<string, number>();
  let total = 0;
  for (const f of fix.files) {
    if (f.status === "added" || !f.patch || isTestPath(f.path) || isDocsPath(f.path) || !isSourcePath(f.path)) continue;
    const hunks = parsePatch(f.patch);
    // Basic SZZ refinement: ignore deleted lines that are blank or comments.
    const removed = new Set(hunks.flatMap((h) => h.lines.filter((l) => l.type === "del" && !COMMENT_ONLY.test(l.content)).map((l) => l.oldLine!)));
    const lines = removedOldLines(hunks).filter((n) => removed.has(n));
    const ranges = toRanges(lines).slice(0, 50);
    if (!ranges.length) continue;
    const args = ["blame", "--porcelain", "-w", ...ranges.flatMap(([a, b]) => ["-L", `${a},${b}`]), parent, "--", f.previousPath ?? f.path];
    const blamed = parseBlamePorcelain(await git(repo, args).catch(() => ""));
    for (const sha of blamed) {
      votes.set(sha, (votes.get(sha) ?? 0) + 1);
      total++;
    }
  }
  if (!total) return [];
  const title = fix.message.split("\n")[0];
  return [...votes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([sha, n]) => ({ fixSha: fix.sha, introducingSha: sha, method: "szz" as const, support: n / total, fixTitle: title }));
}

export async function mineSzz(repo: string, opts: { ref?: string; maxFixes?: number; scanCount?: number } = {}): Promise<RegressionLabel[]> {
  const out = await git(repo, ["log", "--first-parent", "--no-merges", `--max-count=${opts.scanCount ?? 3000}`, "--format=%H%x00%s", opts.ref ?? "HEAD"]);
  const fixes = out
    .split("\n")
    .map((l) => l.split("\0"))
    .filter(([sha, s]) => sha && s && FIX_RE.test(s) && !NOT_FIX_RE.test(s) && !/^revert/i.test(s))
    .slice(0, opts.maxFixes ?? 150);
  const labels: RegressionLabel[] = [];
  for (const [sha] of fixes) {
    const found = await szzForFix(repo, sha);
    // Keep only the dominant introducer per fix, and only when it holds a majority of blamed lines.
    if (found[0] && found[0].support >= 0.5) labels.push(found[0]);
  }
  return labels;
}

export async function mineLabels(repo: string, opts: { ref?: string; maxFixes?: number } = {}): Promise<RegressionLabel[]> {
  const [reverts, szz] = await Promise.all([mineReverts(repo, opts), mineSzz(repo, opts)]);
  const seen = new Set<string>();
  return [...reverts, ...szz].filter((l) => {
    const k = `${l.fixSha}:${l.introducingSha}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
