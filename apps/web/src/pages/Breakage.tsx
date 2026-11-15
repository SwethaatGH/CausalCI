import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, CheckCircle2, FlaskConical, GitCompare, Info, ListChecks, Network, ShieldCheck, Siren, TestTube2, XCircle } from "lucide-react";
import { toast } from "sonner";
import type { Investigation } from "@causalci/shared";
import { FINDING_STATUS_LABELS } from "@causalci/shared";
import { api } from "../lib/api";
import { qk, useAIAnalyses, useTimeline } from "../lib/queries";
import { useUI } from "../lib/store";
import { cn, firstLine, fmtDate, short } from "../lib/utils";
import { Badge, Button, DetectionBadge, EmptyState, FindingBadge, PageTitle, Panel, PanelHeader, ScoreBadge, ScoreRing, Sha, SimulatedBanner, Skeleton } from "../components/ui";
import { EvidenceList, InvestigationGate, SignalList, useActiveInvestigation } from "../components/investigation";
import { SIGNAL_LABELS } from "../components/signal-labels";
import { AnalysisCard } from "./Gemma";
import { ConfirmWithTests } from "../components/testing";

export default function Breakage() {
  return (
    <>
      <PageTitle title="Suspects" description="The commits most likely to have caused the problem, highest risk first, each with the evidence behind its score. Scores are estimates, not probabilities." />
      <InvestigationGate>{(inv) => <BreakageView inv={inv} />}</InvestigationGate>
    </>
  );
}

function BreakageView({ inv }: { inv: Investigation }) {
  const { commitSha, selectCommit, go } = useActiveInvestigation();
  const tl = useTimeline(inv);
  const ai = useAIAnalyses(inv.id);
  const qc = useQueryClient();
  const level = useUI((s) => s.level);

  const dismissed = new Set(inv.dismissedSuspects ?? []);
  const visible = inv.findings.filter((f) => !dismissed.has(f.commitSha));
  const repo = useQuery({ queryKey: ["repo", inv.repositoryId], queryFn: () => api.repository(inv.repositoryId) });
  const setDismissed = useMutation({
    mutationFn: (list: string[]) => api.updateInvestigation(inv.id, { dismissedSuspects: list }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.investigation(inv.id) }),
    onError: (e) => toast.error("Couldn’t update suspects", { description: (e as Error).message }),
  });
  const focus = visible.find((f) => commitSha && f.commitSha.startsWith(commitSha)) ?? visible[0] ?? inv.findings[0];
  const commit = focus ? tl.data?.commits.find((c) => c.sha === focus.commitSha) : undefined;
  const assessment = focus ? tl.data?.assessments.find((a) => a.commitSha === focus.commitSha) : undefined;
  const diagnosis = useMemo(() => (ai.data ?? []).find((a) => a.commitSha === focus?.commitSha && (a.task === "root-cause" || a.task === "commit-investigation")), [ai.data, focus]);

  const runAI = useMutation({
    mutationFn: (task: "root-cause" | "tests") => api.aiAnalyze({ investigationId: inv.id, task, commitSha: focus!.commitSha, level }),
    onSuccess: (a) => {
      void qc.invalidateQueries({ queryKey: qk.ai(inv.id) });
      toast.success(a.task === "tests" ? "Tests written" : "Explanation ready", { description: a.source === "prerecorded-demo" ? "Prerecorded demo answer (AI not connected)" : `From ${a.model}` });
      if (a.task === "tests") go("/gemma", { commit: a.commitSha });
    },
    onError: (e) => toast.error("Gemma analysis failed", { description: (e as Error).message }),
  });

  if (tl.isLoading) return <Skeleton className="h-96" />;
  if (inv.findings.length === 0)
    return <Panel><EmptyState icon={<Siren className="h-5 w-5" />} title={inv.mode === "exploration" ? "Browsing only" : "No suspects"} description={inv.mode === "exploration" ? "This investigation browses history without assuming anything broke. Start a new one with “Recent commits” or “Between good and bad” to rank suspects." : "None of the checked commits looks risky."} /></Panel>;

  const bisect = tl.data?.bisect;
  const parent = commit?.parents[0] ?? null;

  return (
    <div className="space-y-4">
      {inv.isDemo && <SimulatedBanner />}
      <div className="grid gap-4 xl:grid-cols-[1.45fr_1fr]">
        {/* Selected suspect */}
        <Panel glow={focus?.status === "test-confirmed" ? "crit" : undefined}>
          <PanelHeader title={focus?.rank === 1 ? "Most likely cause" : `Suspect #${focus?.rank}`} subtitle={<span>Status: <strong>{focus && FINDING_STATUS_LABELS[focus.status]}</strong></span>} icon={<Siren className="h-4 w-4 text-crit" />} />
          {focus && commit && (
            <div className="space-y-5 p-5">
              <div className="flex flex-wrap items-start gap-5">
                <ScoreRing score={focus.score} size={92} label="Heuristic risk score" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Sha sha={commit.sha} />
                    <FindingBadge status={focus.status} />
                    {assessment && <Badge tone="neutral">{assessment.level} risk band</Badge>}
                  </div>
                  <h2 className="mt-2 font-display text-xl font-semibold leading-snug">{firstLine(commit.message)}</h2>
                  <p className="mt-1 text-xs text-ink-2">{commit.author.name} · {fmtDate(commit.date)}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {focus.relevantFiles.map((f) => (
                      <Badge key={f} tone="cyan" className="font-mono">{f}</Badge>
                    ))}
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" icon={<GitCompare className="h-3.5 w-3.5" />} disabled={!parent} onClick={() => go("/divergence", { a: parent, b: commit.sha, commit: commit.sha })}>Open diff</Button>
                <Button size="sm" variant="outline" icon={<GitCompare className="h-3.5 w-3.5" />} disabled={!inv.knownGoodSha} title={inv.knownGoodSha ? "" : "Start a “Between good and bad” investigation to enable this"} onClick={() => go("/divergence", { a: inv.knownGoodSha, b: commit.sha, commit: commit.sha })}>Compare with last good</Button>
                <Button size="sm" variant="outline" icon={<Network className="h-3.5 w-3.5" />} onClick={() => go("/infection", { commit: commit.sha })}>View impact</Button>
                <Button size="sm" variant="outline" icon={<TestTube2 className="h-3.5 w-3.5" />} loading={runAI.isPending && runAI.variables === "tests"} onClick={() => runAI.mutate("tests")}>Generate tests</Button>
                <Button size="sm" variant="outline" icon={<FlaskConical className="h-3.5 w-3.5" />} onClick={() => go("/restore", { commit: commit.sha })}>Fix and verify</Button>
              </div>

              <section>
                <h3 className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-ink-2">Why it was flagged</h3>
                {assessment && <SignalList assessment={assessment} />}
              </section>

              <section>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-[13px] font-semibold text-ink-2">AI explanation</h3>
                  <Button size="sm" variant={diagnosis ? "ghost" : "primary"} icon={<Brain className="h-3.5 w-3.5" />} loading={runAI.isPending && runAI.variables === "root-cause"} onClick={() => runAI.mutate("root-cause")}>
                    {diagnosis ? "Ask again" : "Ask AI"}
                  </Button>
                </div>
                {diagnosis ? <AnalysisCard analysis={diagnosis} compact /> : <p className="rounded-lg border border-dashed border-line-2 p-3 text-sm text-ink-3">No diagnosis yet. Gemma receives the risk signals, evidence IDs, diff excerpts and dependents for this commit.</p>}
              </section>

              <section>
                <h3 className="mb-2 text-[13px] font-semibold text-ink-2">Evidence</h3>
                <EvidenceList evidence={focus.evidence} onOpen={(e) => e.filePath && parent && go("/divergence", { a: parent, b: commit.sha, commit: commit.sha })} />
              </section>

              <section>
                <h3 className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-ink-2"><ListChecks className="h-3.5 w-3.5" /> How to confirm it</h3>
                <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-2">
                  {focus.verificationSteps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
              </section>
            </div>
          )}
        </Panel>

        <div className="space-y-4">
          {/* Leaderboard */}
          <Panel>
            <PanelHeader title="All suspects" subtitle="Top 5, highest risk first" icon={<Siren className="h-4 w-4" />} />
            <ol className="divide-y divide-line">
              {visible.map((f) => {
                const c = tl.data?.commits.find((x) => x.sha === f.commitSha);
                const active = f.commitSha === focus?.commitSha;
                return (
                  <li key={f.id} className={cn("px-4 py-3", active && "bg-cyan/[0.05]")}>
                    <button className="flex w-full items-start gap-3 text-left" onClick={() => selectCommit(f.commitSha)} aria-current={active}>
                      <span className={cn("mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full font-mono text-xs", f.rank === 1 ? "bg-crit/20 text-crit" : "bg-panel-2 text-ink-2")}>{f.rank}</span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-ink">{f.title}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <Sha sha={f.commitSha} />
                          <FindingBadge status={f.status} />
                        </div>
                      </div>
                      <ScoreBadge score={f.score} />
                    </button>
                    <div className="mt-2 flex flex-wrap gap-1 pl-9">
                      <Button size="sm" variant="ghost" onClick={() => selectCommit(f.commitSha)}>Evidence</Button>
                      <Button size="sm" variant="ghost" disabled={!c?.parents[0]} onClick={() => go("/divergence", { a: c?.parents[0] ?? null, b: f.commitSha, commit: f.commitSha })}>Diff</Button>
                      <Button size="sm" variant="ghost" onClick={() => go("/infection", { commit: f.commitSha })}>Impact</Button>
                      <Button size="sm" variant="ghost" onClick={() => go("/gemma", { commit: f.commitSha })}>Ask AI</Button>
                      <Button size="sm" variant="ghost" className="ml-auto" title="Hide this suspect. You can bring it back later." onClick={() => setDismissed.mutate([...dismissed, f.commitSha])}>
                        Not the cause
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ol>
            {dismissed.size > 0 && (
              <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-[13px] text-ink-3">
                <span>{dismissed.size} marked as not the cause</span>
                <Button size="sm" variant="ghost" onClick={() => setDismissed.mutate([])}>Restore</Button>
              </div>
            )}
          </Panel>

          {/* Verification */}
          <Panel>
            <PanelHeader title="Test results" subtitle={inv.isDemo ? "The demo’s built-in checks" : "Your tests, run in isolated sandboxes"} icon={<ShieldCheck className="h-4 w-4" />} />
            <div className="space-y-4 p-4">
              {!inv.isDemo && <ConfirmWithTests inv={inv} language={repo.data?.primaryLanguage} />}
              {bisect ? (
                <div className="space-y-3">
                  <p className="text-sm text-ink-2">
                    Bisected in <strong className="text-ink">{bisect.steps.length}</strong> steps.{" "}
                    {bisect.firstBadSha ? (
                      <>First failing commit: <Sha sha={bisect.firstBadSha} />; last passing: <Sha sha={bisect.lastGoodSha} />.</>
                    ) : (
                      "No failing commit in range."
                    )}
                  </p>
                  <ul className="space-y-2">
                    {bisect.verification.filter((v) => v.results.length).map((v) => (
                      <li key={v.id} className="rounded-lg border border-line bg-obsidian/40 p-2.5">
                        <div className="flex items-center gap-2 text-xs">
                          <Sha sha={v.commitSha} />
                          <span className="text-ink-2">{v.summary}</span>
                        </div>
                        <ul className="mt-1.5 space-y-0.5">
                          {v.results.map((r) => (
                            <li key={r.testName} className="flex items-start gap-1.5 text-xs">
                              {r.passed ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-healthy" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-crit" />}
                              <span className={r.passed ? "text-ink-2" : "text-ink"}>{r.testName}{r.message && <span className="text-crit"> — {r.message}</span>}</span>
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="space-y-2 text-sm text-ink-2">
                  <p className="flex items-start gap-2"><Info className="mt-0.5 h-4 w-4 shrink-0 text-cyan" /> Automated test execution is not available for imported repositories. Findings remain <strong>unverified hypotheses</strong> until you run the suggested steps locally.</p>
                  <p className="text-xs text-ink-3">Running untrusted code requires an isolated, resource-limited container with explicit authorization — see Known Limitations in the docs.</p>
                </div>
              )}
              <div className="mt-4 grid grid-cols-2 gap-1.5 text-[11px]">
                {Object.entries(FINDING_STATUS_LABELS).map(([k, v]) => (
                  <span key={k} className="flex items-center gap-1.5 text-ink-2">
                    <FindingBadge status={k as keyof typeof FINDING_STATUS_LABELS} />
                    <span className="sr-only">{v}</span>
                  </span>
                ))}
              </div>
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="How the score is built" subtitle="Each signal has a cap; the total is clamped to 100" icon={<Info className="h-4 w-4" />} />
            <table className="w-full text-xs">
              <tbody>
                {Object.entries(SIGNAL_LABELS).map(([k, s]) => (
                  <tr key={k} className="border-t border-line" title={s.explain}>
                    <td className="px-4 py-1.5 text-ink">{s.label}</td>
                    <td className="py-1.5"><DetectionBadge detection={s.detection} /></td>
                    <td className="px-4 py-1.5 text-right font-mono text-ink-2">≤ {s.max}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
      </div>
      <p className="text-center text-xs text-ink-3">Focus: {short(focus?.commitSha)} · Shift focus by selecting a suspect.</p>
    </div>
  );
}
