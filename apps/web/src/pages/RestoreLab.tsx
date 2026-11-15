import "../lib/monaco";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DiffEditor } from "@monaco-editor/react";
import { AlertTriangle, CheckCircle2, Download, FlaskConical, History, Scissors, ShieldAlert, ShieldCheck, ShieldPlus, Undo2, XCircle } from "lucide-react";
import { toast } from "sonner";
import type { Investigation, PatchSuggestion, VerificationResult } from "@causalci/shared";
import { api, downloadText } from "../lib/api";
import { qk, usePatches, useTimeline } from "../lib/queries";
import { cn, firstLine, languageForPath } from "../lib/utils";
import { Badge, Button, CopyButton, EmptyState, ErrorState, Modal, PageTitle, Panel, PanelHeader, Select, SimulatedBanner, Skeleton } from "../components/ui";
import { VerifyInSandbox } from "../components/testing";
import { InvestigationGate, MiniDiff, useActiveInvestigation } from "../components/investigation";

const STRATEGIES = [
  { id: "minimal" as const, title: "Smallest fix", icon: Scissors, desc: "The smallest change that fixes the bug while keeping what the commit meant to improve.", engine: "Gemma" },
  { id: "revert" as const, title: "Revert the commit", icon: Undo2, desc: "Undo every change the commit made, like git revert. Works without the AI.", engine: "No AI" },
  { id: "preventive" as const, title: "Add tests", icon: ShieldPlus, desc: "Regression tests (and validation) that would have caught this change.", engine: "Gemma" },
];

export default function RestoreLab() {
  return (
    <>
      <PageTitle title="Fix and verify" description="Review proposed fixes for a suspect and check whether they pass. Nothing is ever pushed to your repository." />
      <InvestigationGate>{(inv) => <RestoreView inv={inv} />}</InvestigationGate>
    </>
  );
}

function RestoreView({ inv }: { inv: Investigation }) {
  const { commitSha, selectCommit } = useActiveInvestigation();
  const tl = useTimeline(inv);
  const patches = usePatches(inv.id);
  const qc = useQueryClient();
  const target = (commitSha && tl.data?.commits.find((c) => c.sha.startsWith(commitSha))?.sha) ?? inv.findings[0]?.commitSha ?? tl.data?.commits[0]?.sha;
  const commit = tl.data?.commits.find((c) => c.sha === target);
  const [active, setActive] = useState<string | null>(null);
  const [rollback, setRollback] = useState(false);
  const [verification, setVerification] = useState<Record<string, VerificationResult>>({});

  const gen = useMutation({
    mutationFn: (strategy: PatchSuggestion["strategy"]) => api.aiFix({ investigationId: inv.id, commitSha: target!, strategy }),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: qk.patches(inv.id) });
      setActive(p.id);
      toast.success("Fix proposed", { description: p.patchValid ? "The patch applies cleanly. Not verified yet." : `The patch is invalid: ${p.patchError}` });
    },
    onError: (e) => toast.error("Couldn’t propose a fix", { description: (e as Error).message }),
  });
  const verify = useMutation({
    mutationFn: (id: string) => api.verifyPatch(inv.id, id),
    onSuccess: (r) => {
      setVerification((v) => ({ ...v, [r.patch.id]: r.result }));
      void qc.invalidateQueries({ queryKey: qk.patches(inv.id) });
      if (r.patch.verified) toast.success("Fix verified", { description: r.result.summary });
      else toast.warning("Verification failed", { description: r.result.summary });
    },
    onError: (e) => toast.error("Verification unavailable", { description: (e as Error).message }),
  });

  const forCommit = patches.data ?? [];
  const current = forCommit.find((p) => p.id === active) ?? forCommit[0];

  if (tl.isLoading) return <Skeleton className="h-96" />;
  return (
    <div className="space-y-4">
      {inv.isDemo && <SimulatedBanner />}
      <div className="flex items-start gap-2 rounded-lg border border-cyan/25 bg-cyan/[0.05] px-3 py-2 text-xs text-ink-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-cyan" />
        <span>These are proposals. CausalCI never pushes commits or changes your repository. A fix is marked <strong className="text-warn">unverified</strong> until it passes the checks{inv.isDemo ? " (you can run them on the demo)" : "; imported repository code is never executed"}.</span>
      </div>

      <Panel className="flex flex-wrap items-center gap-3 p-3">
        <span className="text-xs text-ink-2">Commit</span>
        <Select aria-label="Commit to treat" value={target ?? ""} onChange={(e) => selectCommit(e.target.value)} className="w-96 font-mono text-xs">
          {(tl.data?.commits ?? []).map((c) => {
            const f = inv.findings.find((x) => x.commitSha === c.sha);
            return <option key={c.sha} value={c.sha}>{c.shortSha}{f ? ` [suspect #${f.rank}]` : ""} · {firstLine(c.message).slice(0, 50)}</option>;
          })}
        </Select>
        <Button size="sm" variant="ghost" icon={<History className="h-3.5 w-3.5" />} onClick={() => setRollback(true)}>How to roll back</Button>
      </Panel>

      <div className="grid gap-3 md:grid-cols-3">
        {STRATEGIES.map((s) => (
          <Panel key={s.id} className="flex flex-col p-4">
            <div className="flex items-center gap-2">
              <s.icon className="h-4 w-4 text-ink" />
              <h3 className="font-display font-semibold">{s.title}</h3>
              <Badge tone={s.engine === "Gemma" ? "cyan" : "neutral"} className="ml-auto">{s.engine}</Badge>
            </div>
            <p className="mt-2 flex-1 text-sm text-ink-2">{s.desc}</p>
            <Button className="mt-3" variant={s.id === "minimal" ? "primary" : "secondary"} loading={gen.isPending && gen.variables === s.id} disabled={!target || (s.id === "revert" && !commit?.parents[0])} onClick={() => gen.mutate(s.id)}>
              {s.id === "preventive" ? "Generate regression test" : "Generate patch"}
            </Button>
          </Panel>
        ))}
      </div>
      {gen.isError && <ErrorState error={gen.error} />}

      {forCommit.length === 0 ? (
        <Panel><EmptyState icon={<FlaskConical className="h-5 w-5" />} title="No fixes yet" description="Propose one above. Reverting the commit works without the AI." /></Panel>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[360px_1fr]">
          <Panel>
            <PanelHeader title="Proposed fixes" subtitle={`${forCommit.length} so far`} />
            <ul className="divide-y divide-line">
              {forCommit.map((p) => (
                <li key={p.id}>
                  <button onClick={() => setActive(p.id)} className={cn("w-full px-4 py-3 text-left hover:bg-panel-2", current?.id === p.id && "bg-cyan/[0.06]")}>
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{p.title}</span>
                      {p.verified ? <Badge tone="healthy"><ShieldCheck className="h-3 w-3" />Verified</Badge> : <Badge tone="warn">Unverified</Badge>}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Badge tone="neutral">{p.strategy}</Badge>
                      {!p.patchValid && <Badge tone="crit">invalid patch</Badge>}
                      {p.targetFiles.slice(0, 2).map((f) => <Badge key={f} tone="cyan" className="font-mono">{f}</Badge>)}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </Panel>
          {current && <PatchDetail inv={inv} patch={current} onVerify={() => verify.mutate(current.id)} verifying={verify.isPending} result={verification[current.id]} />}
        </div>
      )}

      <Modal open={rollback} onClose={() => setRollback(false)} title="How to roll back" wide>
        <div className="space-y-3 text-sm text-ink-2">
          <p>Commands to run <strong>locally</strong> after reviewing — CausalCI does not execute them.</p>
          <pre className="overflow-x-auto rounded-lg border border-line bg-obsidian p-3 font-mono text-xs text-ink">{`# Create a branch for the recovery
git checkout -b recovery/${commit?.shortSha ?? "commit"}

# Option A — revert the suspected commit (creates a new commit)
git revert ${commit?.sha ?? "<sha>"}

# Option B — apply a CausalCI patch file
git apply --check fix.patch && git apply fix.patch

# Confirm with tests before merging
npm test`}</pre>
          <ul className="list-disc space-y-1 pl-5">
            <li>Check later commits that touch the same files ({commit?.files.map((f) => f.path).slice(0, 4).join(", ")}) for conflicts.</li>
            <li>Prefer a minimal patch when the commit also contains intended improvements.</li>
            <li>Never force-push shared branches; open a pull request for review.</li>
          </ul>
        </div>
      </Modal>
    </div>
  );
}

function PatchDetail({ inv, patch, onVerify, verifying, result }: { inv: Investigation; patch: PatchSuggestion; onVerify: () => void; verifying: boolean; result?: VerificationResult }) {
  const singleFile = patch.original !== null && patch.proposed !== null && patch.targetFiles.length === 1;
  return (
    <Panel className="min-w-0">
      <PanelHeader
        title={patch.title}
        subtitle={<span>{patch.strategy} · {patch.patchValid ? "well-formed unified diff" : <span className="text-crit">invalid: {patch.patchError}</span>}</span>}
        icon={<FlaskConical className="h-4 w-4" />}
        actions={
          <>
            <CopyButton text={patch.patch} label="Copy patch" />
            <Button size="sm" variant="ghost" icon={<Download className="h-3.5 w-3.5" />} onClick={() => downloadText(`causalci-${patch.strategy}-${patch.id.slice(6, 14)}.patch`, patch.patch, "text/x-diff")}>.patch</Button>
            {inv.isDemo && <Button size="sm" variant="primary" icon={<ShieldCheck className="h-3.5 w-3.5" />} loading={verifying} disabled={!patch.patchValid} onClick={onVerify}>Run the checks</Button>}
          </>
        }
      />
      <div className="space-y-4 p-4 text-sm">
        {patch.verified ? (
          <p className="flex items-center gap-1.5 text-xs text-healthy"><CheckCircle2 className="h-3.5 w-3.5" /> Verified: the tests pass with this fix applied.</p>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-warn"><AlertTriangle className="h-3.5 w-3.5" /> Unverified: this fix hasn’t been shown to work yet.</p>
        )}
        {!inv.isDemo && <VerifyInSandbox inv={inv} patch={patch} />}
        <p className="text-ink">{patch.description}</p>
        <div className="grid gap-3 md:grid-cols-2">
          <Info title="Rationale">{patch.rationale}</Info>
          <Info title="Expected behavioral change">{patch.expectedBehavior}</Info>
          <Info title="Potential risks">{patch.risks.length ? <ul className="list-disc pl-4">{patch.risks.map((r) => <li key={r}>{r}</li>)}</ul> : "None stated"}</Info>
          <Info title="Verification requirements">{patch.verification.length ? <ul className="list-disc pl-4">{patch.verification.map((r) => <li key={r}>{r}</li>)}</ul> : "—"}</Info>
        </div>
        <div className="text-xs text-ink-2">Target files: {patch.targetFiles.map((f) => <code key={f} className="mr-1.5 font-mono text-ink">{f}</code>)}</div>
        {result && (
          <div className={cn("rounded-lg border p-3", result.results.every((r) => r.passed) ? "border-healthy/40 bg-healthy/[0.06]" : "border-crit/40 bg-crit/[0.06]")}>
            <div className="mb-1 text-sm font-medium text-ink">{result.summary}</div>
            <ul className="space-y-0.5 text-xs">
              {result.results.map((r) => (
                <li key={r.testName} className="flex items-start gap-1.5">{r.passed ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 text-healthy" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 text-crit" />}<span>{r.testName}{r.message && <span className="text-crit"> — {r.message}</span>}</span></li>
              ))}
            </ul>
          </div>
        )}
        <div className="overflow-hidden rounded-lg border border-line">
          <div className="flex items-center justify-between border-b border-line bg-panel-2 px-3 py-1.5 text-[12px]">
            <span className="text-ink-2">Original</span>
            <span className="text-ink">Proposed</span>
          </div>
          {singleFile ? (
            <div className="h-[460px]">
              <DiffEditor theme="causalci" language={languageForPath(patch.targetFiles[0])} original={patch.original ?? ""} modified={patch.proposed ?? ""} options={{ readOnly: true, minimap: { enabled: false }, fontFamily: "\"SF Mono\", ui-monospace, Menlo, Monaco, monospace", fontSize: 12.5, scrollBeyondLastLine: false, automaticLayout: true }} />
            </div>
          ) : (
            <div className="max-h-[460px] overflow-auto bg-obsidian/60"><MiniDiff patch={patch.patch} maxLines={2000} /></div>
          )}
        </div>
        <p className="text-xs text-ink-3">Fix <code className="font-mono">{patch.id}</code>. Review it, then apply with <code className="font-mono">git apply</code>.</p>
      </div>
    </Panel>
  );
}

function Info({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-obsidian/40 p-3">
      <div className="mb-1 text-[12px] font-semibold text-ink-3">{title}</div>
      <div className="text-ink-2">{children}</div>
    </div>
  );
}
