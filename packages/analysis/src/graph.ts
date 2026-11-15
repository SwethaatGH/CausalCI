import type {
  AffectedNode,
  BlastRadius,
  DependencyEdge,
  DependencyGraph,
  DependencyNode,
  EvidenceReference,
} from "@causalci/shared";
import { parseModule, type ParsedModule } from "./ast";
import { parsePolyglot, polyglotEdges, polyglotLanguage, polyglotStatus, type PolyParsed } from "./polyglot";
import { semanticJsEdges } from "./semantic";
import { isJsTs, isTestPath, languageOf, moduleOf } from "./classify";

export interface SourceFile {
  path: string;
  content: string;
}

export const fileNodeId = (path: string) => `file:${path}`;
export const fnNodeId = (functionId: string) => `fn:${functionId}`;

const JS_EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", "/index.ts", "/index.tsx", "/index.js", "/index.jsx"];

function normalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** Resolves a relative JS/TS import specifier against the set of known files. Non-relative specifiers return null. */
export function resolveJsImport(fromPath: string, specifier: string, known: Set<string>): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = normalize(`${dirname(fromPath)}/${specifier}`);
  const candidates = JS_EXTS.map((e) => base + e);
  // ESM-style "./x.js" that refers to "./x.ts"
  const jsExt = /\.(m|c)?js$/.exec(base);
  if (jsExt) {
    const stem = base.slice(0, -jsExt[0].length);
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`);
  }
  return candidates.find((c) => known.has(c)) ?? null;
}

const PY_FROM = /^\s*from\s+(\.+[\w.]*|[\w.]+)\s+import\s+/;
const PY_IMPORT = /^\s*import\s+([\w.]+)/;

/** Regex-based Python import detection (heuristic; no AST). */
export function pythonImports(path: string, content: string, known: Set<string>): { target: string; line: number; text: string }[] {
  const out: { target: string; line: number; text: string }[] = [];
  const lines = content.split("\n");
  lines.forEach((text, i) => {
    const m = PY_FROM.exec(text) ?? PY_IMPORT.exec(text);
    if (!m) return;
    let mod = m[1];
    let baseDir = "";
    if (mod.startsWith(".")) {
      const dots = /^\.+/.exec(mod)![0].length;
      let dir = dirname(path);
      for (let k = 1; k < dots; k++) dir = dirname(dir);
      baseDir = dir;
      mod = mod.slice(dots);
    }
    const rel = mod.replace(/\./g, "/");
    const prefixes = baseDir ? [baseDir] : ["", "src", "lib", "app"];
    for (const p of prefixes) {
      const stem = normalize(`${p}/${rel}`);
      const hit = [`${stem}.py`, `${stem}/__init__.py`].find((c) => known.has(c));
      if (hit && hit !== path) {
        out.push({ target: hit, line: i + 1, text: text.trim() });
        return;
      }
    }
  });
  return out;
}

export interface BuiltGraph {
  graph: DependencyGraph;
  parsed: Map<string, ParsedModule>;
}

/**
 * Builds a dependency graph from real source contents.
 * - JS/TS: functions from the compiler AST; imports and calls resolved by the TypeScript type checker
 *   (path aliases, workspace packages, method calls, callbacks, interface dispatch), with a
 *   syntactic fallback.
 * - Python, Go, Java: functions, imports and calls from tree-sitter grammars once `initPolyglot()`
 *   has run; otherwise Python falls back to regex-detected file imports.
 * - Other languages: file nodes only — no relationships are invented.
 */
export function buildDependencyGraph(
  files: SourceFile[],
  opts: { headSha: string | null; skipped?: { path: string; reason: string }[]; configs?: SourceFile[]; semantic?: boolean },
): BuiltGraph {
  const known = new Set(files.map((f) => f.path));
  const nodes = new Map<string, DependencyNode>();
  const edges = new Map<string, DependencyEdge>();
  const parsed = new Map<string, ParsedModule>();
  const skipped = [...(opts.skipped ?? [])];
  const limitations: string[] = [];
  let hasOtherLang = false;

  const addEdge = (source: string, target: string, kind: DependencyEdge["kind"], evidence: Omit<EvidenceReference, "id" | "commitSha">) => {
    if (source === target) return;
    const id = `${kind}:${source}->${target}`;
    if (edges.has(id)) return;
    edges.set(id, { id, source, target, kind, evidence: { ...evidence, id: `ev:${id}`, commitSha: opts.headSha } });
  };

  for (const f of files) {
    nodes.set(fileNodeId(f.path), {
      id: fileNodeId(f.path),
      kind: "file",
      label: f.path.split("/").pop() ?? f.path,
      filePath: f.path,
      module: moduleOf(f.path),
      language: languageOf(f.path),
      parentId: null,
      isTest: isTestPath(f.path),
    });
  }

  // Pass 1: parse JS/TS and add function nodes.
  for (const f of files) {
    if (!isJsTs(f.path)) continue;
    const pm = parseModule(f.path, f.content);
    parsed.set(f.path, pm);
    if (pm.parseError && pm.functions.length === 0 && pm.imports.length === 0) {
      skipped.push({ path: f.path, reason: pm.parseError });
      continue;
    }
    for (const fn of pm.functions) {
      const id = fnNodeId(fn.id);
      nodes.set(id, {
        id,
        kind: fn.kind === "class" ? "class" : "function",
        label: fn.name,
        filePath: f.path,
        module: moduleOf(f.path),
        language: languageOf(f.path),
        parentId: fileNodeId(f.path),
        isTest: isTestPath(f.path),
      });
      addEdge(fileNodeId(f.path), id, "contains", {
        kind: "ast",
        filePath: f.path,
        line: fn.startLine,
        snippet: null,
        description: `${fn.kind} ${fn.name} declared at ${f.path}:${fn.startLine}`,
      });
    }
  }

  // Pass 1b: Python, Go and Java functions via tree-sitter.
  const poly = new Map<string, PolyParsed>();
  for (const f of files) {
    if (!polyglotLanguage(f.path) || !f.content) continue;
    const pm = parsePolyglot(f.path, f.content);
    if (!pm) continue;
    poly.set(f.path, pm);
    if (pm.parseError && pm.functions.length === 0) skipped.push({ path: f.path, reason: pm.parseError });
    for (const fn of pm.functions) {
      const id = fnNodeId(fn.id);
      nodes.set(id, { id, kind: fn.kind === "class" ? "class" : "function", label: fn.name, filePath: f.path, module: moduleOf(f.path), language: languageOf(f.path), parentId: fileNodeId(f.path), isTest: isTestPath(f.path) });
      addEdge(fileNodeId(f.path), id, "contains", { kind: "ast", filePath: f.path, line: fn.startLine, snippet: null, description: `${fn.kind} ${fn.name} declared at ${f.path}:${fn.startLine}` });
    }
  }

  // Type-aware JS/TS resolution; falls back to the syntactic resolver below if it cannot run.
  const VIA: Record<string, string> = { import: "imports", call: "calls", "method-call": "calls method", callback: "passes as a callback", dispatch: "may dispatch to (interface or override)", constructor: "constructs" };
  const semantic = opts.semantic === false ? null : semanticJsEdges(files.filter((f) => isJsTs(f.path)), opts.configs ?? []);
  const semanticOk = !!semantic && !semantic.notes.some((n) => n.startsWith("Type-aware resolution failed"));
  if (semantic) limitations.push(...semantic.notes);
  if (semanticOk) {
    for (const e of semantic!.edges) {
      if (!nodes.has(e.source) || !nodes.has(e.target)) continue;
      addEdge(e.source, e.target, e.kind, {
        kind: e.kind === "import" ? "import" : "ast",
        filePath: e.filePath,
        line: e.line,
        snippet: e.snippet,
        description: `${e.source.replace(/^(fn|file):/, "").split("#").pop()} ${VIA[e.via]} ${e.target.replace(/^(fn|file):/, "").split("#").pop()} at ${e.filePath}:${e.line} (type-checked)`,
      });
    }
  }

  // Pass 2: imports and calls.
  for (const f of files) {
    if (isJsTs(f.path)) {
      if (semanticOk) continue;
      const pm = parsed.get(f.path);
      if (!pm) continue;
      const localToTarget = new Map<string, { file: string; imported: string }>();
      for (const imp of pm.imports) {
        const target = resolveJsImport(f.path, imp.specifier, known);
        if (!target) continue;
        addEdge(fileNodeId(f.path), fileNodeId(target), "import", {
          kind: "import",
          filePath: f.path,
          line: imp.line,
          snippet: `${imp.kind} "${imp.specifier}"`,
          description: `${f.path}:${imp.line} imports ${target}`,
        });
        for (const b of imp.bindings) localToTarget.set(b.local, { file: target, imported: b.imported });
      }
      const localFns = new Map(pm.functions.map((fn) => [fn.name, fn.id]));
      for (const call of pm.calls) {
        if (!call.fromId) continue;
        let targetFnId: string | null = null;
        const dot = call.callee.indexOf(".");
        if (dot === -1) {
          const local = localFns.get(call.callee);
          if (local) targetFnId = local;
          else {
            const imp = localToTarget.get(call.callee);
            if (imp && imp.imported !== "*") {
              const targetMod = parsed.get(imp.file);
              const name = imp.imported === "default" ? null : imp.imported;
              const fn = name ? targetMod?.functions.find((x) => x.name === name && x.exported) : undefined;
              if (fn) targetFnId = fn.id;
            }
          }
        } else {
          const ns = localToTarget.get(call.callee.slice(0, dot));
          if (ns?.imported === "*") {
            const fn = parsed.get(ns.file)?.functions.find((x) => x.name === call.callee.slice(dot + 1) && x.exported);
            if (fn) targetFnId = fn.id;
          }
        }
        if (targetFnId && nodes.has(fnNodeId(targetFnId))) {
          addEdge(fnNodeId(call.fromId), fnNodeId(targetFnId), "call", {
            kind: "ast",
            filePath: f.path,
            line: call.line,
            snippet: `${call.callee}(…)`,
            description: `${call.fromId.split("#")[1]} calls ${call.callee} at ${f.path}:${call.line}`,
          });
        }
      }
    } else if (poly.has(f.path)) {
      continue; // edges added below from the tree-sitter resolver
    } else if (/\.py$/i.test(f.path)) {
      for (const imp of pythonImports(f.path, f.content, known)) {
        addEdge(fileNodeId(f.path), fileNodeId(imp.target), "import", {
          kind: "import",
          filePath: f.path,
          line: imp.line,
          snippet: imp.text,
          description: `Heuristic (regex) import detected at ${f.path}:${imp.line}`,
        });
      }
    } else if (!polyglotLanguage(f.path)) {
      hasOtherLang = true;
    }
  }

  for (const e of polyglotEdges(poly, known, opts.configs ?? [])) {
    if (!nodes.has(e.source) || !nodes.has(e.target)) continue;
    addEdge(e.source, e.target, e.kind, {
      kind: e.kind === "import" ? "import" : "ast",
      filePath: e.filePath,
      line: e.line,
      snippet: e.snippet,
      description:
        e.confidence === "name-match"
          ? `${e.snippet} matched by method name only (unique among visible code) at ${e.filePath}:${e.line}`
          : `${e.snippet} at ${e.filePath}:${e.line} (tree-sitter)`,
    });
  }

  const hasJs = files.some((f) => isJsTs(f.path));
  if (hasJs && !semanticOk) limitations.push("JS/TS relationships use syntactic resolution: relative imports and direct calls only.");
  if (hasJs && semanticOk) limitations.push("JS/TS calls are resolved by the TypeScript type checker; calls through `any`, dynamic `obj[name]()` or values from packages outside the repository cannot be followed.");
  const polyMissing = files.some((f) => polyglotLanguage(f.path)) && !polyglotStatus().ready;
  if (polyMissing) limitations.push("Python/Go/Java grammars are not loaded in this process; Python imports fall back to regular expressions and Go/Java files have no edges.");
  if (poly.size) limitations.push("Python, Go and Java calls on untyped instances are linked only when the method name is unique among visible code (labeled name match).");
  if (hasOtherLang) limitations.push("Files in other languages are shown without relationships; no edges are inferred.");

  const hasFunctions = [...nodes.values()].some((n) => n.kind !== "file");
  return {
    graph: {
      headSha: opts.headSha,
      level: hasFunctions ? "function" : "file",
      nodes: [...nodes.values()],
      edges: [...edges.values()],
      analyzedFiles: files.length,
      skippedFiles: skipped,
      limitations,
    },
    parsed,
  };
}

/** Number of distinct files that import each file. */
export function fileFanIn(graph: DependencyGraph): Map<string, number> {
  const counts = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    if (e.kind !== "import") continue;
    const target = e.target.replace(/^file:/, "");
    if (!counts.has(target)) counts.set(target, new Set());
    counts.get(target)!.add(e.source);
  }
  return new Map([...counts].map(([k, v]) => [k, v.size]));
}

/**
 * Reverse-reachability from changed nodes: which nodes depend (transitively) on what changed.
 * This is potential impact, not confirmed breakage.
 */
export function computeBlastRadius(
  graph: DependencyGraph,
  input: { commitSha: string | null; changedFiles: string[]; modifiedFunctionIds: string[] },
  maxDepth = 8,
): BlastRadius {
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const seeds = [
    ...input.changedFiles.map(fileNodeId).filter((id) => nodeIds.has(id)),
    ...input.modifiedFunctionIds.map(fnNodeId).filter((id) => nodeIds.has(id)),
  ];
  const notes: string[] = [];
  const missing = input.changedFiles.filter((f) => !nodeIds.has(fileNodeId(f)));
  if (missing.length) notes.push(`${missing.length} changed file(s) are not part of the analyzed graph (non-source, deleted, or outside limits).`);
  if (seeds.length === 0) {
    return { commitSha: input.commitSha, seeds, modifiedFunctions: [], directDependents: [], affected: [], relatedTests: [], classification: "unknown", notes: [...notes, "No changed nodes in the dependency graph."] };
  }

  const incoming = new Map<string, DependencyEdge[]>();
  for (const e of graph.edges) {
    if (e.kind === "contains") continue;
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    incoming.get(e.target)!.push(e);
  }
  const parentOf = new Map(graph.nodes.map((n) => [n.id, n.parentId]));

  const visited = new Map<string, AffectedNode>();
  const seedSet = new Set(seeds);
  const queue: AffectedNode[] = seeds.map((id) => ({ id, depth: 0, via: "call" as const, pathEdgeIds: [] }));
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur.depth >= maxDepth) continue;
    for (const e of incoming.get(cur.id) ?? []) {
      const via: AffectedNode["via"] = e.kind === "call" && cur.via === "call" ? "call" : "import";
      const next: AffectedNode = { id: e.source, depth: cur.depth + 1, via, pathEdgeIds: [...cur.pathEdgeIds, e.id] };
      const prev = visited.get(e.source);
      if (seedSet.has(e.source)) continue;
      if (prev && (prev.depth <= next.depth || (prev.via === "call" && via === "import"))) continue;
      visited.set(e.source, next);
      queue.push(next);
      // A function reached through a call also puts its containing file in scope.
      const parent = parentOf.get(e.source);
      if (parent && !seedSet.has(parent) && !visited.has(parent)) {
        const p: AffectedNode = { id: parent, depth: next.depth, via, pathEdgeIds: next.pathEdgeIds };
        visited.set(parent, p);
        queue.push(p);
      }
    }
  }

  const affected = [...visited.values()].sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const relatedTests = [...new Set(affected.filter((a) => nodeById.get(a.id)?.isTest).map((a) => nodeById.get(a.id)!.filePath!))];
  const affectedFiles = new Set(affected.map((a) => nodeById.get(a.id)?.filePath).filter(Boolean));
  const classification = affectedFiles.size === 0 ? "contained" : affectedFiles.size <= 3 ? "moderate" : "wide";
  return {
    commitSha: input.commitSha,
    seeds,
    modifiedFunctions: input.modifiedFunctionIds.filter((id) => nodeIds.has(fnNodeId(id))),
    directDependents: affected.filter((a) => a.depth === 1).map((a) => a.id),
    affected,
    relatedTests,
    classification,
    notes,
  };
}
