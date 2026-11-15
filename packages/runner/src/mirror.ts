// A local partial clone used as the source of truth for history: full commit list, complete
// (never truncated) diffs, file contents at any commit and the full file tree. Blobs are fetched on
// demand (`--filter=blob:none`), so cloning stays cheap, and nothing here counts against GitHub's
// REST API rate limit.
import { createHash } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Branch, ChangedFile, Commit } from "@causalci/shared";
import { run, runOk } from "./exec";
import { assertRef, git, loadCommit, parseGitPatch } from "./git";

const RECORD = "\x1e";
const FIELD = "\0";
const META = "--format=%H%x00%an%x00%ae%x00%aI%x00%P%x00%B%x1e";

function parseLog(out: string): Commit[] {
  return out
    .split(RECORD)
    .map((r) => r.replace(/^\n/, ""))
    .filter((r) => r.trim())
    .map((rec) => {
      const [sha, name, email, date, parents, ...body] = rec.split(FIELD);
      return {
        sha,
        shortSha: sha.slice(0, 7),
        message: body.join(FIELD).trim(),
        author: { name, email: email || null, login: null, avatarUrl: null },
        date,
        parents: parents.trim() ? parents.trim().split(" ") : [],
        stats: null,
        files: [],
        url: null,
      };
    });
}

export class GitMirror {
  readonly dir: string;
  private lastFetch = 0;
  private pending: Promise<void> | null = null;

  constructor(
    readonly url: string,
    cacheDir: string,
    private readonly opts: { maxAgeMs?: number } = {},
  ) {
    if (!/^(https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+?(\.git)?|file:\/\/\/[^\s]+)$/.test(url)) throw new Error(`Unsupported clone URL: ${url}`);
    this.dir = join(cacheDir, createHash("sha256").update(url).digest("hex").slice(0, 16));
  }

  static async available(): Promise<boolean> {
    const r = await run("git", ["--version"], { timeoutMs: 5000 }).catch(() => null);
    return !!r && r.code === 0;
  }

  /** Clones on first use; afterwards fetches when the copy is older than `maxAgeMs` (concurrent callers share one fetch). */
  async ready(): Promise<void> {
    if (Date.now() - this.lastFetch < (this.opts.maxAgeMs ?? 120_000)) return;
    this.pending ??= (async () => {
      const exists = await access(join(this.dir, "HEAD")).then(
        () => true,
        () => false,
      );
      const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
      if (exists) await runOk("git", ["-C", this.dir, "fetch", "--quiet", "--prune", "--no-tags", "--filter=blob:none", "origin", "+refs/heads/*:refs/remotes/origin/*"], { timeoutMs: 10 * 60_000, env });
      else {
        await mkdir(join(this.dir, ".."), { recursive: true });
        await runOk("git", ["clone", "--quiet", "--bare", "--filter=blob:none", "--no-tags", "--", this.url, this.dir], { timeoutMs: 20 * 60_000, env });
        await runOk("git", ["-C", this.dir, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
        await runOk("git", ["-C", this.dir, "fetch", "--quiet", "--no-tags", "--filter=blob:none", "origin"], { timeoutMs: 10 * 60_000, env });
      }
      this.lastFetch = Date.now();
    })().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** Branch names map to origin/<name>; anything else (SHA, HEAD~3) is used as given. */
  private async ref(ref: string): Promise<string> {
    assertRef(ref);
    const remote = `refs/remotes/origin/${ref}`;
    const r = await run("git", ["-C", this.dir, "rev-parse", "--verify", "--quiet", remote]);
    return r.code === 0 ? remote : ref;
  }

  async branches(): Promise<Branch[]> {
    await this.ready();
    const out = await git(this.dir, ["for-each-ref", "--format=%(refname:strip=3)%00%(objectname)", "refs/remotes/origin/"]);
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split(FIELD))
      .filter(([name]) => name && name !== "HEAD")
      .map(([name, sha]) => ({ name, sha, protected: null }));
  }

  /** Newest first, metadata only (like GitHub's list-commits endpoint). */
  async log(branch: string, o: { limit: number; since?: string | null; until?: string | null }): Promise<Commit[]> {
    await this.ready();
    const args = ["log", META, `--max-count=${Math.max(1, Math.floor(o.limit))}`];
    if (o.since) args.push(`--since=${o.since}`);
    if (o.until) args.push(`--until=${o.until}`);
    args.push(await this.ref(branch), "--");
    return parseLog(await git(this.dir, args));
  }

  async commit(sha: string): Promise<Commit> {
    await this.ready();
    return loadCommit(this.dir, sha);
  }

  /** Commits in base..head, oldest first, capped to the newest `cap`; throws when head is not after base. */
  async between(base: string, head: string, cap: number): Promise<{ commits: Commit[]; total: number }> {
    await this.ready();
    const b = await this.ref(base);
    const h = await this.ref(head);
    const isAncestor = (await run("git", ["-C", this.dir, "merge-base", "--is-ancestor", b, h])).code === 0;
    if (!isAncestor) throw Object.assign(new Error("The 'broken' commit does not come after the 'working' commit."), { code: "INVALID_RANGE" });
    const all = parseLog(await git(this.dir, ["log", META, "--reverse", `${b}..${h}`, "--"]));
    return { commits: all.slice(-cap), total: all.length };
  }

  async diff(base: string, head: string): Promise<ChangedFile[]> {
    await this.ready();
    return parseGitPatch(await git(this.dir, ["diff", "--no-color", "--no-ext-diff", "--find-renames", "-U3", await this.ref(base), await this.ref(head), "--"]));
  }

  /** File content at a commit; null when absent or binary. Throws when larger than `maxBytes`. */
  async file(path: string, ref: string, maxBytes: number): Promise<string | null> {
    await this.ready();
    const spec = `${await this.ref(ref)}:${path}`;
    const size = await run("git", ["-C", this.dir, "cat-file", "-s", spec], { timeoutMs: 60_000 });
    if (size.code !== 0) return null;
    if (Number(size.stdout.trim()) > maxBytes) throw Object.assign(new Error(`${path} exceeds ${maxBytes} bytes`), { code: "FILE_TOO_LARGE" });
    const text = await git(this.dir, ["cat-file", "-p", spec], 120_000);
    return text.includes("\u0000") ? null : text;
  }

  async tree(ref: string): Promise<{ paths: string[]; truncated: boolean }> {
    await this.ready();
    const out = await git(this.dir, ["ls-tree", "-r", "--name-only", "--full-tree", await this.ref(ref)]);
    return { paths: out.split("\n").filter(Boolean), truncated: false };
  }
}
