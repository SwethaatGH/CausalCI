import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FlaskConical, Info, Play, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import type { Investigation, PatchSuggestion } from "@causalci/shared";
import { api, type TestJob } from "../lib/api";
import { qk, useJobsConfig, useTestJob } from "../lib/queries";
import { cn } from "../lib/utils";
import { Badge, Button, Field, Input, Select, Sha, StatusDot } from "./ui";

const STRATEGIES = [
  { id: "bayesian", label: "Smart search (handles flaky tests)" },
  { id: "binary", label: "Binary search (git bisect)" },
  { id: "k-ary", label: "Parallel search (4 at a time)" },
] as const;

/** A sensible default test command for the repository's main language. */
function defaultTestCommand(language: string | null | undefined): string {
  if (language === "Python") return "python -m pytest -q";
  if (language === "Go") return "go test ./...";
  if (language === "Java") return "mvn -q test";
  return "npm test";
}

function Unavailable({ reason }: { reason: string | null }) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl bg-panel-2 p-3 text-[13px] text-ink-2">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" />
      <span>{reason ?? "Test runs are not available on this server."}</span>
    </div>
  );
}

function JobStatus({ job }: { job: TestJob }) {
  if (job.state === "queued" || job.state === "running")
    return (
      <div className="flex items-center gap-2 text-[13px] text-ink-2" aria-live="polite">
        <StatusDot tone="warn" pulse />
        {job.state === "queued" ? "Waiting for a sandbox…" : "Running your tests in sandboxes…"}
      </div>
    );
  if (job.state === "failed")
    return (
      <p role="alert" className="text-[13px] text-crit">
        The test run couldn’t finish: {job.error}
      </p>
    );
  return null;
}

/** Suspects page: run the repository's tests across the range to find the commit that actually breaks them. */
export function ConfirmWithTests({ inv, language }: { inv: Investigation; language?: string | null }) {
  const cfg = useJobsConfig();
  const qc = useQueryClient();
  const [testCommand, setTestCommand] = useState(() => defaultTestCommand(language));
  const [strategy, setStrategy] = useState<(typeof STRATEGIES)[number]["id"]>("bayesian");
  const job = useTestJob(inv.testJobId, inv.id);
  const start = useMutation({
    mutationFn: () => api.confirmWithTests(inv.id, { testCommand, strategy, parallel: strategy === "k-ary" ? 4 : 1 }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.investigation(inv.id) });
      toast.success("Test run started", { description: "Your tests are running in isolated sandboxes." });
    },
    onError: (e) => toast.error("Couldn’t start the test run", { description: (e as Error).message }),
  });

  if (cfg.data && !cfg.data.enabled) return <Unavailable reason={cfg.data.reason} />;
  const running = job.data && (job.data.state === "queued" || job.data.state === "running");
  const result = job.data?.state === "succeeded" && job.data.result?.kind === "bisect" ? job.data.result : null;

  return (
    <div className="space-y-4">
      <p className="text-[13px] leading-relaxed text-ink-2">
        Runs your repository’s own tests at commits in this range, each in a fresh sandbox with no network, to find the first commit where they fail. Scores are estimates; this is proof.
      </p>
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <Field label="Test command" htmlFor="test-cmd">
          <Input id="test-cmd" value={testCommand} onChange={(e) => setTestCommand(e.target.value)} className="font-mono" spellCheck={false} />
        </Field>
        <Field label="Search" htmlFor="test-strategy">
          <Select id="test-strategy" value={strategy} onChange={(e) => setStrategy(e.target.value as typeof strategy)}>
            {STRATEGIES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Button variant="primary" icon={<Play className="h-4 w-4" />} loading={start.isPending || !!running} disabled={!testCommand.trim() || !!running} onClick={() => start.mutate()}>
        Confirm with tests
      </Button>
      {job.data && <JobStatus job={job.data} />}
      {result && (
        <div className="space-y-3 rounded-xl border border-line p-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="crit">First bad commit</Badge>
            <Sha sha={result.culprit.sha} />
            <span className="text-[14px] font-medium text-ink">{result.culprit.title}</span>
          </div>
          <p className="text-[13px] text-ink-2">
            Found in <strong className="text-ink">{result.runs}</strong> test run(s), <strong className="text-ink">{Math.round(result.confidence * 100)}%</strong> confidence.{" "}
            {result.heuristicRank === 1 ? "It was already the top suspect." : `The ranking had it at #${result.heuristicRank}.`}
          </p>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {result.testRuns.map((r, i) => (
              <li key={`${r.sha}-${i}`} className="flex items-center gap-2 px-2.5 py-1.5 text-[12px]">
                <Sha sha={r.sha} />
                <span className={cn("font-medium", r.verdict === "pass" ? "text-healthy" : "text-crit")}>{r.verdict === "pass" ? "passed" : r.timedOut ? "failed (timed out)" : "failed"}</span>
                <span className="tabular ml-auto text-ink-3">{(r.durationMs / 1000).toFixed(1)}s</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Fix and verify: apply a proposed fix at the newest commit and run the repository's tests in a sandbox. */
export function VerifyInSandbox({ inv, patch, language }: { inv: Investigation; patch: PatchSuggestion; language?: string | null }) {
  const cfg = useJobsConfig();
  const [testCommand, setTestCommand] = useState(() => defaultTestCommand(language));
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useTestJob(jobId, inv.id);
  const start = useMutation({
    mutationFn: () => api.verifyInSandbox(inv.id, patch.id, { testCommand }),
    onSuccess: (j) => setJobId(j.id),
    onError: (e) => toast.error("Couldn’t start the check", { description: (e as Error).message }),
  });
  if (cfg.data && !cfg.data.enabled) return <Unavailable reason={cfg.data.reason} />;
  const running = job.data && (job.data.state === "queued" || job.data.state === "running");
  const result = job.data?.state === "succeeded" && job.data.result?.kind === "verify" ? job.data.result : null;
  return (
    <div className="space-y-3 rounded-xl border border-line p-3.5">
      <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
        <FlaskConical className="h-4 w-4 text-ink-3" /> Check this fix against your tests
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[220px] flex-1">
          <Field label="Test command" htmlFor={`verify-cmd-${patch.id}`}>
            <Input id={`verify-cmd-${patch.id}`} value={testCommand} onChange={(e) => setTestCommand(e.target.value)} className="font-mono" spellCheck={false} />
          </Field>
        </div>
        <Button variant="primary" icon={<ShieldCheck className="h-4 w-4" />} loading={start.isPending || !!running} disabled={!patch.patchValid || !!running} onClick={() => start.mutate()}>
          Run the checks
        </Button>
      </div>
      {job.data && <JobStatus job={job.data} />}
      {result && (
        <div className="space-y-2">
          <Badge tone={result.verdict === "pass" ? "healthy" : "crit"}>{result.verdict === "pass" ? "Tests pass with this fix" : "Tests still fail with this fix"}</Badge>
          <pre className="max-h-48 overflow-auto rounded-lg bg-panel-2 p-2.5 font-mono text-[11px] text-ink-2">{result.logTail.trim() || "(no output)"}</pre>
        </div>
      )}
    </div>
  );
}
