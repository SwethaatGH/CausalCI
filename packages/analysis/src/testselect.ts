import type { DependencyGraph } from "@causalci/shared";
import { isJsTs, isTestPath } from "./classify";
import { computeBlastRadius, fileNodeId } from "./graph";

export interface TestSelection {
  /** Test files to run. Equals `allTests` when `runAll` is true. */
  selected: string[];
  skipped: string[];
  runAll: boolean;
  reasons: string[];
}

/**
 * Regression test selection: run only the tests that can reach what changed, through the
 * import/call graph. It is deliberately conservative: anything the graph cannot see (a manifest,
 * config, non-JS file, or a changed file missing from the graph) falls back to the full suite,
 * because a skipped test that would have failed is worse than a slow run.
 */
export function selectTests(
  graph: DependencyGraph,
  input: { changedFiles: string[]; modifiedFunctionIds?: string[]; allTests: string[] },
): TestSelection {
  const all = [...new Set(input.allTests)].sort();
  const known = new Set(graph.nodes.map((n) => n.id));
  const reasons: string[] = [];

  const opaque = input.changedFiles.filter((f) => !isTestPath(f) && (!isJsTs(f) || !known.has(fileNodeId(f))));
  if (opaque.length) {
    reasons.push(`Changed files the graph cannot trace (${opaque.slice(0, 5).join(", ")}${opaque.length > 5 ? ", …" : ""}); running the full suite.`);
    return { selected: all, skipped: [], runAll: true, reasons };
  }

  const changedTests = input.changedFiles.filter((f) => isTestPath(f) && all.includes(f));
  const radius = computeBlastRadius(graph, { commitSha: null, changedFiles: input.changedFiles, modifiedFunctionIds: input.modifiedFunctionIds ?? [] });
  const reached = radius.relatedTests.filter((t) => all.includes(t));
  const selected = [...new Set([...changedTests, ...reached])].sort();
  if (changedTests.length) reasons.push(`${changedTests.length} test file(s) changed directly.`);
  reasons.push(`${reached.length} test file(s) depend on the changed code through imports or calls.`);
  return { selected, skipped: all.filter((t) => !selected.includes(t)), runAll: false, reasons };
}
