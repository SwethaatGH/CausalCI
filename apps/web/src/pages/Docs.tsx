import { BookOpen, Keyboard, Microscope, ShieldCheck } from "lucide-react";
import { TERMS } from "@causalci/shared";
import { DetectionBadge, Kbd, PageTitle, Panel, PanelHeader } from "../components/ui";
import { SIGNAL_LABELS } from "../components/signal-labels";
import { ALL_NAV } from "../components/layout/nav";

export default function Docs() {
  return (
    <>
      <PageTitle title="Help" description="What each part of CausalCI does, and what it doesn’t claim." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Glossary" subtitle="The words CausalCI uses" icon={<BookOpen className="h-4 w-4" />} />
          <table className="w-full text-sm">
            <tbody>
              {Object.values(TERMS).map((t) => (
                <tr key={t.themed} className="border-t border-line"><td className="px-4 py-2 font-medium text-ink">{t.themed}</td><td className="px-4 py-2 text-ink-2">{t.technical}</td></tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel>
          <PanelHeader title="Analysis pipeline" icon={<Microscope className="h-4 w-4" />} />
          <ol className="list-decimal space-y-1.5 p-4 pl-9 text-sm text-ink-2">
            <li><strong className="text-ink">Import</strong> — repository metadata, branches and commits via Octokit (backend only).</li>
            <li><strong className="text-ink">Diff extraction</strong> — per-commit patches; binary and truncated files are skipped and reported.</li>
            <li><strong className="text-ink">Reading the code</strong> — changed JavaScript and TypeScript files are parsed to find which functions each changed line belongs to.</li>
            <li><strong className="text-ink">Dependency analysis</strong> — imports and direct identifier calls at the head commit form the impact map. Python imports are regex-detected (file-level); other languages are shown without edges.</li>
            <li><strong className="text-ink">Risk scoring</strong> — capped, transparent signals summed to 0–100.</li>
            <li><strong className="text-ink">Ranking</strong> — top 5 suspects with evidence and verification steps.</li>
            <li><strong className="text-ink">Gemma investigation</strong> — on demand; bounded context with evidence IDs; output validated with Zod; unknown citations are stripped and flagged.</li>
            <li><strong className="text-ink">Reports</strong> — built only from stored data; exported as Markdown, JSON or print.</li>
          </ol>
        </Panel>
        <Panel className="lg:col-span-2">
          <PanelHeader title="Risk signals" subtitle="Scores are heuristics, never calibrated probabilities" icon={<ShieldCheck className="h-4 w-4" />} />
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-ink-2"><tr><th className="px-4 py-2">Signal</th><th>Detection</th><th>Cap</th><th className="px-4">What it means</th></tr></thead>
            <tbody>
              {Object.entries(SIGNAL_LABELS).map(([k, s]) => (
                <tr key={k} className="border-t border-line align-top"><td className="px-4 py-2 text-ink">{s.label}</td><td className="py-2"><DetectionBadge detection={s.detection} /></td><td className="py-2 font-mono text-ink-2">{s.max}</td><td className="px-4 py-2 text-ink-2">{s.explain}</td></tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel>
          <PanelHeader title="Keyboard shortcuts" icon={<Keyboard className="h-4 w-4" />} />
          <ul className="space-y-1.5 p-4 text-sm text-ink-2">
            <li className="flex justify-between"><span>Command palette & global search</span><Kbd>⌘/Ctrl K</Kbd></li>
            {ALL_NAV.filter((n) => n.key).map((n) => (
              <li key={n.path} className="flex justify-between"><span>{n.label}</span><Kbd>g {n.key}</Kbd></li>
            ))}
            <li className="flex justify-between"><span>Compare two commits on the timeline</span><Kbd>Shift + click</Kbd></li>
            <li className="flex justify-between"><span>Documentation</span><Kbd>?</Kbd></li>
          </ul>
        </Panel>
        <Panel>
          <PanelHeader title="Safety & limitations" icon={<ShieldCheck className="h-4 w-4" />} />
          <ul className="list-disc space-y-1.5 p-4 pl-8 text-sm text-ink-2">
            <li>Imported repository code is never executed. Automated verification exists only for the controlled demo repository (isolated <code>vm</code> context).</li>
            <li>Fixes are never pushed; a proposed fix is marked unverified until it passes the checks.</li>
            <li>When Gemma is unavailable, demo analysis is clearly labeled PRERECORDED — never presented as live inference.</li>
            <li>Dependency edges cover relative JS/TS imports and direct calls; aliases, dynamic dispatch and callbacks are not resolved.</li>
            <li>GitHub may truncate very large diffs and trees; affected files are reported as skipped.</li>
          </ul>
        </Panel>
      </div>
    </>
  );
}
