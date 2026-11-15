import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Brain, Compass, Crosshair, GitBranch, Play, Radar, Search, Siren, Zap } from "lucide-react";
import { toast } from "sonner";
import type { Branch, InvestigationMode, Repository } from "@causalci/shared";
import { createInvestigationSchema, MODE_LABELS } from "@causalci/shared";
import { api, ApiRequestError } from "../lib/api";
import { qk, useInvestigation, useSettings } from "../lib/queries";
import { useSelection } from "../lib/selection";
import { cn, firstLine, fmtNum, relTime, short } from "../lib/utils";
import { Badge, Button, ErrorState, Field, Input, PageTitle, Panel, PanelHeader, Select, Textarea } from "../components/ui";
import { PipelineProgress, useLaunchDemo } from "../components/investigation";

const MODE_ICON: Record<InvestigationMode, typeof Zap> = { "quick-scan": Zap, "regression-hunt": Crosshair, "single-commit": Search, exploration: Compass, "ai-guided": Brain };

export default function TimePortal() {
  const [params] = useSearchParams();
  const { go } = useSelection();
  const qc = useQueryClient();
  const settings = useSettings();
  const demo = useLaunchDemo();

  const [input, setInput] = useState(params.get("repo") ?? "");
  const [repo, setRepo] = useState<Repository | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branch, setBranch] = useState(params.get("branch") ?? "");
  const [mode, setMode] = useState<InvestigationMode>("quick-scan");
  const [limit, setLimit] = useState(20);
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [goodSha, setGoodSha] = useState("");
  const [badSha, setBadSha] = useState("");
  const [commitSha, setCommitSha] = useState("");
  const [symptoms, setSymptoms] = useState("");
  const [name, setName] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [startedId, setStartedId] = useState<string | null>(null);

  useEffect(() => {
    if (settings.data) {
      setMode(settings.data.defaultMode);
      setLimit(settings.data.defaultCommitLimit);
    }
  }, [settings.data]);

  const importRepo = useMutation({
    mutationFn: (value: string) => api.importRepo(value),
    onSuccess: (r) => {
      setRepo(r.repository);
      setBranches(r.branches);
      setBranch((b) => (b && r.branches.some((x) => x.name === b) ? b : r.repository.defaultBranch));
      toast.success(`Repository added: ${r.repository.fullName}`);
    },
  });

  // Prefill from ?repo= (e.g. header branch selector)
  useEffect(() => {
    const r = params.get("repo");
    if (r) importRepo.mutate(r.startsWith("demo/") ? "demo" : r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commits = useQuery({
    queryKey: ["repo-commits", repo?.id, branch],
    queryFn: () => api.repoCommits(repo!.id, branch, 50),
    enabled: !!repo && !!branch && ["regression-hunt", "single-commit"].includes(mode),
  });

  const create = useMutation({
    mutationFn: async () => {
      const body = {
        repositoryId: repo!.id,
        branch,
        mode,
        name: name || undefined,
        limit,
        since: since ? new Date(since).toISOString() : null,
        until: until ? new Date(`${until}T23:59:59`).toISOString() : null,
        goodSha: mode === "regression-hunt" ? goodSha || null : null,
        badSha: mode === "regression-hunt" ? badSha || null : null,
        commitSha: mode === "single-commit" ? commitSha || null : null,
        symptoms: mode === "ai-guided" || symptoms ? symptoms || null : null,
      };
      const parsed = createInvestigationSchema.safeParse(body);
      if (!parsed.success) {
        const e: Record<string, string> = {};
        for (const i of parsed.error.issues) e[String(i.path[0])] = i.message;
        setErrors(e);
        throw new Error("Please fix the highlighted fields.");
      }
      setErrors({});
      return api.createInvestigation(body);
    },
    onSuccess: (inv) => {
      qc.setQueryData(qk.investigation(inv.id), inv);
      void qc.invalidateQueries({ queryKey: qk.investigations });
      setStartedId(inv.id);
      go("/portal", { inv: inv.id, commit: null, a: null, b: null });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const started = useInvestigation(startedId);
  const commitOptions = useMemo(() => commits.data ?? [], [commits.data]);

  const importError = importRepo.error as ApiRequestError | null;

  return (
    <>
      <PageTitle title="New investigation" description="Choose a GitHub repository and the commits to check, then pick how to look for the problem." />
      <div className="grid gap-4 xl:grid-cols-[1fr_400px]">
        <div className="space-y-4">
          <Panel>
            <PanelHeader title="1 · Repository" subtitle="A public GitHub link, or owner/name" icon={<Radar className="h-4 w-4" />} />
            <form
              className="flex flex-col gap-2 p-4 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault();
                if (input.trim()) importRepo.mutate(input.trim());
              }}
            >
              <Input aria-label="Repository" value={input} onChange={(e) => setInput(e.target.value)} placeholder="https://github.com/owner/repo  or  owner/repo" className="font-mono" />
              <Button type="submit" variant="primary" loading={importRepo.isPending} disabled={!input.trim()}>
                Load repository
              </Button>
            </form>
            {importError && (
              <div className="px-4 pb-4">
                <ErrorState error={importError} />
                {importError.code === "GITHUB_RATE_LIMIT" && <p className="mt-2 text-xs text-ink-2">Tip: add a GITHUB_TOKEN to the backend .env to raise the limit from 60 to 5,000 requests/hour.</p>}
              </div>
            )}
            {repo && (
              <div className="mx-4 mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-line bg-obsidian/40 px-3 py-2.5 text-xs text-ink-2">
                <span className="font-display text-sm font-semibold text-ink">{repo.fullName}</span>
                {repo.isDemo && <Badge tone="warn">SIMULATED</Badge>}
                <span>{repo.primaryLanguage ?? "unknown language"}</span>
                <span>★ {fmtNum(repo.stars)}</span>
                <span>{fmtNum(repo.contributorsCount)} contributors</span>
                <span className="truncate">{repo.description}</span>
              </div>
            )}
          </Panel>

          <Panel className={cn(!repo && "pointer-events-none opacity-50")} aria-disabled={!repo}>
            <PanelHeader title="2 · How to search" subtitle="How should CausalCI look for the problem?" icon={<Siren className="h-4 w-4" />} />
            <div className="grid gap-2 p-4 sm:grid-cols-2 lg:grid-cols-3" role="radiogroup" aria-label="Investigation mode">
              {(Object.keys(MODE_LABELS) as InvestigationMode[]).map((m) => {
                const Icon = MODE_ICON[m];
                return (
                  <button
                    key={m}
                    role="radio"
                    aria-checked={mode === m}
                    onClick={() => setMode(m)}
                    className={cn("rounded-xl border p-3 text-left transition-colors", mode === m ? "border-bio/50 bg-bio/[0.06] glow-bio" : "border-line-2 hover:border-cyan/40")}
                  >
                    <Icon className={cn("h-4 w-4", mode === m ? "text-ink" : "text-ink-3")} />
                    <div className="mt-2 text-sm font-semibold text-ink">{MODE_LABELS[m].title}</div>
                    <div className="mt-0.5 text-xs text-ink-2">{MODE_LABELS[m].description}</div>
                  </button>
                );
              })}
            </div>
          </Panel>

          <Panel className={cn(!repo && "pointer-events-none opacity-50")}>
            <PanelHeader title="3 · Which commits" subtitle="Fewer commits give faster results" icon={<GitBranch className="h-4 w-4" />} />
            <div className="grid gap-4 p-4 md:grid-cols-2">
              <Field label="Branch" htmlFor="branch">
                <Select id="branch" value={branch} onChange={(e) => setBranch(e.target.value)}>
                  {branches.map((b) => (
                    <option key={b.name} value={b.name}>
                      {b.name}
                      {b.name === repo?.defaultBranch ? " (default)" : ""}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Investigation name (optional)" htmlFor="name">
                <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder={repo ? `${MODE_LABELS[mode].title} · ${repo.fullName}` : ""} />
              </Field>
              {mode !== "single-commit" && (
                <Field label={`Commit count limit: ${limit}`} hint={mode === "quick-scan" ? "10 to 20 commits is usually enough." : "Each commit costs one GitHub API request (cached afterwards)."} htmlFor="limit">
                  <input id="limit" type="range" min={5} max={100} step={1} value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="w-full" />
                </Field>
              )}
              {(mode === "quick-scan" || mode === "exploration" || mode === "ai-guided") && (
                <div className="grid grid-cols-2 gap-2">
                  <Field label="From date" htmlFor="since">
                    <Input id="since" type="date" value={since} onChange={(e) => setSince(e.target.value)} />
                  </Field>
                  <Field label="To date" error={errors.until} htmlFor="until">
                    <Input id="until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
                  </Field>
                </div>
              )}
              {mode === "regression-hunt" && (
                <>
                  <CommitPicker label="Known working commit (baseline)" value={goodSha} onChange={setGoodSha} options={commitOptions} loading={commits.isLoading} error={errors.goodSha} tone="healthy" />
                  <CommitPicker label="Known broken commit" value={badSha} onChange={setBadSha} options={commitOptions} loading={commits.isLoading} error={errors.badSha} tone="crit" />
                </>
              )}
              {mode === "single-commit" && <CommitPicker label="Commit to investigate" value={commitSha} onChange={setCommitSha} options={commitOptions} loading={commits.isLoading} error={errors.commitSha} tone="cyan" />}
              {(mode === "ai-guided" || mode === "quick-scan" || mode === "regression-hunt") && (
                <div className="md:col-span-2">
                  <Field label={mode === "ai-guided" ? "Symptoms — bug description or error message" : "Symptoms (optional)"} error={errors.symptoms} hint="Keywords are matched against changed paths and diff lines to prioritize commits. Gemma also receives this text." htmlFor="symptoms">
                    <Textarea id="symptoms" rows={3} value={symptoms} onChange={(e) => setSymptoms(e.target.value)} placeholder="e.g. TypeError: Cannot read properties of undefined (reading 'total') in checkout after upgrading…" />
                  </Field>
                </div>
              )}
            </div>
            <div className="flex items-center justify-between border-t border-line px-4 py-3">
              <p className="text-xs text-ink-3">Analysis runs on the backend. No repository code is executed.</p>
              <Button variant="primary" icon={<Play className="h-4 w-4" />} loading={create.isPending} disabled={!repo || !branch} onClick={() => create.mutate()}>
                Launch investigation
              </Button>
            </div>
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel glow="bio" className="p-5">
            <h3 className="font-display text-[19px] font-semibold tracking-[-0.01em]">Try the demo</h3>
            <p className="mt-1 text-sm text-ink-2">
              A sample checkout service with 11 commits and one bug added on purpose. Runs offline, with no GitHub account or AI needed.
            </p>
            <Button className="mt-4 w-full" variant="primary" icon={<Play className="h-4 w-4" />} loading={demo.isPending} onClick={() => demo.mutate()}>
              Start the demo
            </Button>
            <button className="mt-2 w-full text-center text-[13px] text-ink-3 hover:text-ink hover:underline" onClick={() => { setInput("demo"); importRepo.mutate("demo"); }}>
              or set up the demo yourself
            </button>
          </Panel>
          {started.data && (
            <>
              <PipelineProgress inv={started.data} compact />
              {started.data.status === "completed" && (
                <Button className="w-full" variant="primary" onClick={() => go("/mission", { inv: started.data!.id })}>
                  Go to the overview →
                </Button>
              )}
            </>
          )}
          <Panel className="p-5 text-[13px] leading-relaxed text-ink-2">
            <h4 className="mb-2 text-[13px] font-semibold text-ink">What happens when you start</h4>
            <ol className="list-decimal space-y-1 pl-4">
              <li>CausalCI fetches the commits and their changes. Your GitHub token stays on the server.</li>
              <li>Changed JavaScript and TypeScript files are read to find which functions changed.</li>
              <li>It maps which code depends on which, from real imports and calls.</li>
              <li>Every commit gets a risk score, with the reasons shown.</li>
              <li>The AI only runs when you ask it to.</li>
            </ol>
          </Panel>
        </div>
      </div>
    </>
  );
}

function CommitPicker({ label, value, onChange, options, loading, error, tone }: { label: string; value: string; onChange: (v: string) => void; options: { sha: string; message: string; date: string }[]; loading: boolean; error?: string; tone: "healthy" | "crit" | "cyan" }) {
  const id = label.replace(/\W+/g, "-");
  return (
    <Field label={label} error={error} hint="Pick from recent commits or paste a SHA" htmlFor={id}>
      <div className="flex gap-2">
        <Input id={id} value={value} onChange={(e) => onChange(e.target.value.trim())} placeholder="SHA" className={cn("w-32 font-mono", tone === "healthy" && "text-healthy", tone === "crit" && "text-crit")} />
        <Select aria-label={`${label} from list`} value={options.some((o) => o.sha === value) ? value : ""} onChange={(e) => onChange(e.target.value)} disabled={loading}>
          <option value="">{loading ? "Loading commits…" : "Select a recent commit…"}</option>
          {options.map((c) => (
            <option key={c.sha} value={c.sha}>
              {short(c.sha)} · {firstLine(c.message).slice(0, 60)} · {relTime(c.date)}
            </option>
          ))}
        </Select>
      </div>
    </Field>
  );
}
