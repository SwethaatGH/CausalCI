// Local git adapter: produces the same Commit shape the GitHub importer does, from a clone on disk.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChangedFile, Commit, FileStatus } from "@causalci/shared";
import { isJsTs } from "@causalci/analysis";
import { runOk } from "./exec";

const SHA_RE = /^[0-9a-f]{4,40}$/i;
const REF_RE = /^[\w./~^-]{1,200}$/;

/** Guards user-supplied refs: they reach git as arguments, and must never look like options. */
export function assertRef(ref: string, what = "ref"): string {
  if (!REF_RE.test(ref) || ref.startsWith("-")) throw new Error(`Invalid ${what}: ${JSON.stringify(ref)}`);
  return ref;
}

export const git = (repo: string, args: string[], timeoutMs = 120_000) => runOk("git", ["-C", repo, ...args], { timeoutMs, maxBytes: 64 * 1024 * 1024 });

export async function resolveSha(repo: string, ref: string): Promise<string> {
  return (await git(repo, ["rev-parse", "--verify", `${assertRef(ref)}^{commit}`])).trim();
}

/**
 * Commits strictly after `good`, up to and including `bad`, oldest first, following first parents
 * (the history the branch actually experienced, which is what CI tested).
 */
export async function commitRange(repo: string, good: string, bad: string): Promise<string[]> {
  const g = await resolveSha(repo, good);
  const b = await resolveSha(repo, bad);
  const out = await git(repo, ["rev-list", "--first-parent", "--reverse", `${g}..${b}`]);
  return out.split("\n").filter((s) => SHA_RE.test(s));
}

/** The last `count` first-parent commits ending at `ref`, oldest first. */
export async function recentCommits(repo: string, ref: string, count: number): Promise<string[]> {
  const out = await git(repo, ["rev-list", "--first-parent", `--max-count=${Math.max(1, Math.floor(count))}`, assertRef(ref)]);
  return out.split("\n").filter((s) => SHA_RE.test(s)).reverse();
}

function statusOf(block: string): FileStatus {
  if (/^new file mode/m.test(block)) return "added";
  if (/^deleted file mode/m.test(block)) return "removed";
  if (/^rename from/m.test(block)) return "renamed";
  return "modified";
}

/** Splits `git show --patch` output into per-file ChangedFile records. Exported for tests. */
export function parseGitPatch(patchText: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const blocks = patchText.split(/^diff --git /m).slice(1);
  for (const raw of blocks) {
    const header = raw.split("\n", 1)[0];
    const m = /^a\/(.+?) b\/(.+)$/.exec(header);
    if (!m) continue;
    const [, from, to] = m;
    const status = statusOf(raw);
    const binary = /^Binary files /m.test(raw) || /^GIT binary patch/m.test(raw);
    const hunkStart = raw.search(/^@@ /m);
    const patch = !binary && hunkStart >= 0 ? raw.slice(hunkStart).replace(/\n$/, "") : null;
    let additions = 0;
    let deletions = 0;
    if (patch)
      for (const line of patch.split("\n")) {
        if (line.startsWith("+")) additions++;
        else if (line.startsWith("-")) deletions++;
      }
    files.push({ path: status === "removed" ? from : to, previousPath: from !== to ? from : null, status, additions, deletions, patch, binary, truncated: false });
  }
  return files;
}

export async function loadCommit(repo: string, sha: string): Promise<Commit> {
  const s = assertRef(sha, "sha");
  const meta = await git(repo, ["show", "-s", "--format=%H%x00%an%x00%ae%x00%aI%x00%P%x00%B", s]);
  const [full, name, email, date, parents, ...body] = meta.split("\0");
  const patchText = await git(repo, ["show", "--format=", "--patch", "--no-color", "--no-ext-diff", "--find-renames", "-U3", s]);
  const files = parseGitPatch(patchText);
  const additions = files.reduce((a, f) => a + f.additions, 0);
  const deletions = files.reduce((a, f) => a + f.deletions, 0);
  return {
    sha: full.trim(),
    shortSha: full.trim().slice(0, 7),
    message: body.join("\0").trim(),
    author: { name, email: email || null, login: null, avatarUrl: null },
    date,
    parents: parents.trim() ? parents.trim().split(" ") : [],
    stats: { additions, deletions, total: additions + deletions },
    files,
    url: null,
  };
}

/** JS/TS source files at a commit, for the dependency graph and AST analysis. */
export async function loadSourceFiles(repo: string, sha: string, opts: { maxFiles?: number; maxBytes?: number } = {}): Promise<{ path: string; content: string }[]> {
  const maxFiles = opts.maxFiles ?? 400;
  const maxBytes = opts.maxBytes ?? 300_000;
  const listing = await git(repo, ["ls-tree", "-r", "-l", assertRef(sha, "sha")]);
  const paths = listing
    .split("\n")
    .map((l) => /^\d+ blob [0-9a-f]+\s+(\d+|-)\t(.+)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m && m[1] !== "-" && Number(m[1]) <= maxBytes && isJsTs(m[2]) && !m[2].includes("node_modules/"))
    .map((m) => m[2])
    .slice(0, maxFiles);
  const out: { path: string; content: string }[] = [];
  for (const p of paths) out.push({ path: p, content: await git(repo, ["show", `${sha}:${p}`]) });
  return out;
}

/** Shallow-safe clone of a remote into a fresh temporary directory. */
export async function cloneTemp(url: string): Promise<string> {
  if (!/^(https:\/\/|git@|file:\/\/|\/)/.test(url)) throw new Error("Repository URL must be https://, git@, file:// or an absolute path");
  const dir = await mkdtemp(join(tmpdir(), "causalci-repo-"));
  await runOk("git", ["clone", "--quiet", "--no-tags", "--", url, dir], { timeoutMs: 10 * 60_000 });
  return dir;
}

// `git worktree add/remove` take a repository-wide lock, so parallel runs serialize just that step.
let worktreeLock: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = worktreeLock.then(fn, fn);
  worktreeLock = next.catch(() => undefined);
  return next;
}

/** A detached worktree at `sha`, removed by the returned cleanup function. */
export async function checkoutWorktree(repo: string, sha: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "causalci-wt-"));
  await serialized(() => git(repo, ["worktree", "add", "--detach", "--force", dir, assertRef(sha, "sha")]));
  return {
    dir,
    cleanup: async () => {
      await serialized(() => git(repo, ["worktree", "remove", "--force", dir])).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    },
  };
}
