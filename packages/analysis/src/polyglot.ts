// Function-level analysis for Python, Go and Java with tree-sitter grammars (WebAssembly; no native
// build). Call `initPolyglot()` once at startup; parsing is synchronous afterwards. Until it has run,
// these languages fall back to file-level analysis, so nothing breaks in environments without it.
import { createRequire } from "node:module";
import type { CodeFunction } from "@causalci/shared";
import type { Node as TSNode, Parser as TSParser } from "web-tree-sitter";

export type PolyLang = "python" | "go" | "java";

export interface PolyImport {
  /** Module / package path as written: "pkg.mod", ".util", "github.com/x/y", "a.b.C", "a.b.*". */
  spec: string;
  line: number;
  /** Local names it binds. `imported: "*"` binds a whole module/package to `local`. */
  names: { local: string; imported: string }[];
}

export interface PolyCall {
  /** Enclosing function id (`path#name`), or null at module level. */
  fromId: string | null;
  /** Called name: `helper`, or the member name for `x.helper()`. */
  name: string;
  /** Text before the dot for member calls (`self`, `pkg`, `Util`, `obj`), else null. */
  receiver: string | null;
  /** Enclosing class for methods, used to resolve `self.x()` / `this.x()` / bare calls in Java. */
  className: string | null;
  line: number;
}

export interface PolyParsed {
  path: string;
  lang: PolyLang;
  /** Go package name or Java package; null for Python. */
  pkg: string | null;
  functions: CodeFunction[];
  imports: PolyImport[];
  calls: PolyCall[];
  parseError: string | null;
}

const state: { parsers: Partial<Record<PolyLang, TSParser>>; ready: boolean; error: string | null } = { parsers: {}, ready: false, error: null };
let initPromise: Promise<boolean> | null = null;

export function polyglotLanguage(path: string): PolyLang | null {
  if (/\.py$/i.test(path)) return "python";
  if (/\.go$/i.test(path)) return "go";
  if (/\.java$/i.test(path)) return "java";
  return null;
}

/** Loads the grammars. Safe to call repeatedly; resolves to false (with `polyglotStatus().error`) if loading fails. */
export function initPolyglot(): Promise<boolean> {
  initPromise ??= (async () => {
    try {
      const { Parser, Language } = await import("web-tree-sitter");
      const require = createRequire(import.meta.url);
      await Parser.init();
      for (const lang of ["python", "go", "java"] as PolyLang[]) {
        const language = await Language.load(require.resolve(`tree-sitter-${lang}/tree-sitter-${lang}.wasm`));
        const p = new Parser();
        p.setLanguage(language);
        state.parsers[lang] = p;
      }
      state.ready = true;
      return true;
    } catch (err) {
      state.error = (err as Error).message;
      return false;
    }
  })();
  return initPromise;
}

export function polyglotStatus() {
  return { ready: state.ready, error: state.error, languages: Object.keys(state.parsers) as PolyLang[] };
}

const lineOf = (n: TSNode) => n.startPosition.row + 1;
const field = (n: TSNode, name: string) => n.childForFieldName(name);
const kids = (n: TSNode) => n.namedChildren.filter((c): c is TSNode => !!c);

export function parsePolyglot(path: string, content: string): PolyParsed | null {
  const lang = polyglotLanguage(path);
  const parser = lang ? state.parsers[lang] : undefined;
  if (!lang || !parser) return null;
  const out: PolyParsed = { path, lang, pkg: null, functions: [], imports: [], calls: [], parseError: null };
  let tree;
  try {
    tree = parser.parse(content);
  } catch (err) {
    out.parseError = `Parse failure: ${(err as Error).message}`;
    return out;
  }
  if (!tree) {
    out.parseError = "Parse failure";
    return out;
  }
  if (tree.rootNode.hasError) out.parseError = "Syntax errors; results may be partial";
  const addFn = (name: string, kind: CodeFunction["kind"], node: TSNode, exported: boolean) => {
    const id = `${path}#${name}`;
    if (!out.functions.some((f) => f.id === id))
      out.functions.push({ id, name, kind, filePath: path, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, exported });
    return id;
  };
  if (lang === "python") parsePython(tree.rootNode, out, addFn);
  else if (lang === "go") parseGo(tree.rootNode, out, addFn);
  else parseJava(tree.rootNode, out, addFn);
  tree.delete();
  return out;
}

type AddFn = (name: string, kind: CodeFunction["kind"], node: TSNode, exported: boolean) => string;

function parsePython(root: TSNode, out: PolyParsed, addFn: AddFn) {
  const visit = (node: TSNode, cls: string | null, fn: string | null) => {
    switch (node.type) {
      case "import_statement":
        for (const c of kids(node)) {
          if (c.type === "dotted_name") out.imports.push({ spec: c.text, line: lineOf(node), names: [{ local: c.text.split(".")[0], imported: "*" }] });
          if (c.type === "aliased_import") {
            const name = field(c, "name")?.text ?? "";
            out.imports.push({ spec: name, line: lineOf(node), names: [{ local: field(c, "alias")?.text ?? name, imported: "*" }] });
          }
        }
        return;
      case "import_from_statement": {
        const mod = field(node, "module_name")?.text ?? "";
        const names: PolyImport["names"] = [];
        for (const c of kids(node)) {
          if (c === field(node, "module_name")) continue;
          if (c.type === "dotted_name") names.push({ local: c.text, imported: c.text });
          if (c.type === "aliased_import") names.push({ local: field(c, "alias")?.text ?? "", imported: field(c, "name")?.text ?? "" });
          if (c.type === "wildcard_import") names.push({ local: "*", imported: "*all" });
        }
        out.imports.push({ spec: mod, line: lineOf(node), names });
        return;
      }
      case "class_definition": {
        const name = field(node, "name")?.text;
        if (!name) break;
        addFn(name, "class", node, !name.startsWith("_"));
        const body = field(node, "body");
        if (body) for (const c of kids(body)) visit(c, name, fn);
        return;
      }
      case "function_definition": {
        const name = field(node, "name")?.text;
        if (!name) break;
        // Nested helpers belong to their enclosing function; only module functions and methods get nodes.
        if (fn) break;
        const id = cls ? addFn(`${cls}.${name}`, "method", node, !name.startsWith("_") || name === "__init__") : addFn(name, "function", node, !name.startsWith("_"));
        const body = field(node, "body");
        if (body) for (const c of kids(body)) visit(c, cls, id);
        return;
      }
      case "call": {
        const f = field(node, "function");
        if (f?.type === "identifier") out.calls.push({ fromId: fn, name: f.text, receiver: null, className: cls, line: lineOf(node) });
        else if (f?.type === "attribute") {
          const obj = field(f, "object");
          out.calls.push({ fromId: fn, name: field(f, "attribute")?.text ?? "", receiver: obj?.type === "identifier" ? obj.text : null, className: cls, line: lineOf(node) });
        }
        break;
      }
    }
    for (const c of kids(node)) visit(c, cls, fn);
  };
  visit(root, null, null);
}

function goReceiverType(node: TSNode): string | null {
  const recv = field(node, "receiver");
  const decl = recv ? kids(recv)[0] : null;
  const t = decl ? field(decl, "type") : null;
  if (!t) return null;
  return t.text.replace(/^\*/, "").replace(/\[.*\]$/, "");
}

function parseGo(root: TSNode, out: PolyParsed, addFn: AddFn) {
  const exported = (n: string) => /^[A-Z]/.test(n);
  const visit = (node: TSNode, fn: string | null, cls: string | null) => {
    switch (node.type) {
      case "package_clause":
        out.pkg = kids(node)[0]?.text ?? null;
        return;
      case "import_spec": {
        const path = field(node, "path")?.text.replace(/^"|"$/g, "") ?? "";
        const alias = field(node, "name")?.text;
        const local = alias && alias !== "_" ? alias : path.split("/").pop()!.replace(/^go-|\.v\d+$/g, "");
        out.imports.push({ spec: path, line: lineOf(node), names: [{ local, imported: "*" }] });
        return;
      }
      case "function_declaration": {
        const name = field(node, "name")?.text;
        if (!name) break;
        const id = addFn(name, "function", node, exported(name));
        const body = field(node, "body");
        if (body) visit(body, id, null);
        return;
      }
      case "method_declaration": {
        const name = field(node, "name")?.text;
        const recv = goReceiverType(node);
        if (!name) break;
        const id = addFn(recv ? `${recv}.${name}` : name, "method", node, exported(name));
        const body = field(node, "body");
        if (body) visit(body, id, recv);
        return;
      }
      case "type_spec": {
        const name = field(node, "name")?.text;
        const t = field(node, "type");
        if (name && t && (t.type === "struct_type" || t.type === "interface_type")) addFn(name, "class", node, exported(name));
        break;
      }
      case "call_expression": {
        const f = field(node, "function");
        if (f?.type === "identifier") out.calls.push({ fromId: fn, name: f.text, receiver: null, className: cls, line: lineOf(node) });
        else if (f?.type === "selector_expression") {
          const operand = field(f, "operand");
          out.calls.push({ fromId: fn, name: field(f, "field")?.text ?? "", receiver: operand?.type === "identifier" ? operand.text : null, className: cls, line: lineOf(node) });
        }
        break;
      }
    }
    for (const c of kids(node)) visit(c, fn, cls);
  };
  visit(root, null, null);
}

function parseJava(root: TSNode, out: PolyParsed, addFn: AddFn) {
  const isPublic = (n: TSNode) => kids(n).some((c) => c.type === "modifiers" && /\bpublic\b/.test(c.text));
  const visit = (node: TSNode, cls: string | null, fn: string | null) => {
    switch (node.type) {
      case "package_declaration":
        out.pkg = kids(node).find((c) => c.type === "scoped_identifier" || c.type === "identifier")?.text ?? null;
        return;
      case "import_declaration": {
        const text = node.text.replace(/^import\s+(static\s+)?/, "").replace(/;\s*$/, "").trim();
        const last = text.split(".").pop()!;
        out.imports.push({ spec: text, line: lineOf(node), names: last === "*" ? [{ local: "*", imported: "*all" }] : [{ local: last, imported: last }] });
        return;
      }
      case "class_declaration":
      case "interface_declaration":
      case "enum_declaration":
      case "record_declaration": {
        const name = field(node, "name")?.text;
        if (!name) break;
        addFn(name, "class", node, isPublic(node));
        const body = field(node, "body");
        if (body) for (const c of kids(body)) visit(c, name, fn);
        return;
      }
      case "method_declaration":
      case "constructor_declaration": {
        const name = node.type === "constructor_declaration" ? "constructor" : field(node, "name")?.text;
        if (!name || !cls) break;
        const id = addFn(`${cls}.${name}`, "method", node, isPublic(node));
        const body = field(node, "body");
        if (body) for (const c of kids(body)) visit(c, cls, id);
        return;
      }
      case "method_invocation": {
        const obj = field(node, "object");
        out.calls.push({ fromId: fn, name: field(node, "name")?.text ?? "", receiver: obj ? (obj.type === "identifier" || obj.type === "this" ? obj.text : null) : null, className: cls, line: lineOf(node) });
        break;
      }
      case "object_creation_expression": {
        const t = field(node, "type")?.text.replace(/<.*>$/, "");
        if (t) out.calls.push({ fromId: fn, name: "constructor", receiver: t, className: cls, line: lineOf(node) });
        break;
      }
    }
    for (const c of kids(node)) visit(c, cls, fn);
  };
  visit(root, null, null);
}

// ─── Cross-file resolution ─────────────────────────────────────────────

export interface PolyEdge {
  source: string;
  target: string;
  kind: "import" | "call";
  /** How the target was identified: exact resolution, or a unique method-name match (heuristic). */
  confidence: "resolved" | "name-match";
  filePath: string;
  line: number;
  snippet: string;
}

const dirOf = (p: string) => (p.lastIndexOf("/") === -1 ? "" : p.slice(0, p.lastIndexOf("/")));

/** Resolves a Python module path (absolute or relative) to a file in the repository. */
export function resolvePythonModule(fromPath: string, spec: string, known: Set<string>): string | null {
  let mod = spec;
  let bases: string[];
  if (mod.startsWith(".")) {
    const dots = /^\.+/.exec(mod)![0].length;
    let dir = dirOf(fromPath);
    for (let k = 1; k < dots; k++) dir = dirOf(dir);
    bases = [dir];
    mod = mod.slice(dots);
  } else bases = ["", "src", "lib", "app"];
  const rel = mod.replace(/\./g, "/");
  for (const b of bases) {
    const stem = [b, rel].filter(Boolean).join("/");
    const hit = stem ? [`${stem}.py`, `${stem}/__init__.py`].find((c) => known.has(c)) : known.has(`${b}/__init__.py`) ? `${b}/__init__.py` : null;
    if (hit) return hit;
  }
  return null;
}

/** Edges between polyglot files. `configs` supplies go.mod for Go module paths. */
export function polyglotEdges(parsed: Map<string, PolyParsed>, known: Set<string>, configs: { path: string; content: string }[] = []): PolyEdge[] {
  const edges = new Map<string, PolyEdge>();
  const add = (e: PolyEdge) => {
    if (e.source === e.target) return;
    const k = `${e.kind}:${e.source}->${e.target}`;
    if (!edges.has(k)) edges.set(k, e);
  };
  const fnIn = (file: string, name: string) => parsed.get(file)?.functions.find((f) => f.name === name);
  const goModule = /^module\s+(\S+)/m.exec(configs.find((c) => c.path === "go.mod")?.content ?? "")?.[1] ?? null;
  const filesInDir = (dir: string, ext: string) => [...parsed.keys()].filter((p) => dirOf(p) === dir && p.endsWith(ext));

  for (const pm of parsed.values()) {
    const file = `file:${pm.path}`;
    /** local name → target file (and symbol, or "*" for a whole module) */
    const bindings = new Map<string, { files: string[]; imported: string }>();
    const fileImport = (target: string, line: number, spec: string) =>
      add({ source: file, target: `file:${target}`, kind: "import", confidence: "resolved", filePath: pm.path, line, snippet: spec });

    if (pm.lang === "python") {
      for (const imp of pm.imports) {
        const target = resolvePythonModule(pm.path, imp.spec, known);
        for (const n of imp.names) {
          // `from pkg import name`: name may be a submodule file or a symbol defined in pkg.
          const sub = n.imported !== "*" && n.imported !== "*all" ? resolvePythonModule(pm.path, `${imp.spec}${imp.spec.endsWith(".") ? "" : "."}${n.imported}`, known) : null;
          if (sub) {
            fileImport(sub, imp.line, `from ${imp.spec} import ${n.imported}`);
            bindings.set(n.local, { files: [sub], imported: "*" });
          } else if (target) bindings.set(n.local, { files: [target], imported: n.imported });
        }
        if (target) fileImport(target, imp.line, `import ${imp.spec}`);
      }
    } else if (pm.lang === "go") {
      for (const imp of pm.imports) {
        if (!goModule || !(imp.spec === goModule || imp.spec.startsWith(`${goModule}/`))) continue; // stdlib / external
        const dir = imp.spec.slice(goModule.length).replace(/^\//, "");
        const targets = filesInDir(dir, ".go");
        for (const t of targets) fileImport(t, imp.line, `import "${imp.spec}"`);
        for (const n of imp.names) bindings.set(n.local, { files: targets, imported: "*" });
      }
    } else {
      for (const imp of pm.imports) {
        const parts = imp.spec.split(".");
        const wildcard = parts[parts.length - 1] === "*";
        const dirParts = wildcard ? parts.slice(0, -1) : parts.slice(0, -1);
        const suffix = wildcard ? `${dirParts.join("/")}/` : `${parts.join("/")}.java`;
        const targets = [...known].filter((p) => (wildcard ? dirOf(p).endsWith(dirParts.join("/")) && p.endsWith(".java") : p.endsWith(suffix)));
        for (const t of targets) {
          fileImport(t, imp.line, `import ${imp.spec}`);
          const cls = t.split("/").pop()!.replace(/\.java$/, "");
          bindings.set(cls, { files: [t], imported: cls });
        }
      }
      // Classes in the same package are visible without imports.
      for (const t of filesInDir(dirOf(pm.path), ".java")) {
        const cls = t.split("/").pop()!.replace(/\.java$/, "");
        if (!bindings.has(cls)) bindings.set(cls, { files: [t], imported: cls });
      }
    }

    const samePackage = pm.lang === "go" ? filesInDir(dirOf(pm.path), ".go") : [pm.path];
    const visibleFiles = [...new Set([...samePackage, ...[...bindings.values()].flatMap((b) => b.files)])];

    for (const call of pm.calls) {
      if (!call.fromId) continue;
      const src = `fn:${call.fromId}`;
      const targets: { id: string; confidence: PolyEdge["confidence"] }[] = [];
      const find = (files: string[], name: string) => files.map((f) => fnIn(f, name)).filter((f): f is CodeFunction => !!f);
      if (call.receiver === null) {
        // Bare call: same-file / same-package function, a method on the enclosing class (Java), or an imported name.
        const local = find(samePackage, call.name).concat(call.className ? find([pm.path], `${call.className}.${call.name}`) : []);
        const b = bindings.get(call.name);
        const imported = b && b.imported !== "*" ? find(b.files, b.imported) : [];
        for (const f of [...local, ...imported]) targets.push({ id: f.id, confidence: "resolved" });
      } else if (["self", "cls", "this"].includes(call.receiver) && call.className) {
        for (const f of find([pm.path], `${call.className}.${call.name}`)) targets.push({ id: f.id, confidence: "resolved" });
      } else {
        const b = bindings.get(call.receiver);
        if (b && b.imported === "*") {
          // module.func() / pkg.Func()
          for (const f of find(b.files, call.name)) targets.push({ id: f.id, confidence: "resolved" });
        } else if (b || find(samePackage, call.receiver).some((f) => f.kind === "class")) {
          // ClassName.method() / new ClassName()
          const cls = b?.imported ?? call.receiver;
          const files = b?.files ?? samePackage;
          for (const f of find(files, call.name === "constructor" ? cls : `${cls}.${call.name}`)) targets.push({ id: f.id, confidence: "resolved" });
          if (call.name !== "constructor") for (const f of find(files, cls)) if (!targets.length) targets.push({ id: f.id, confidence: "resolved" });
        } else {
          // obj.method() on an instance: without types, link only when the method name is unique among visible code.
          const matches = visibleFiles.flatMap((f) => parsed.get(f)?.functions.filter((fn) => fn.kind === "method" && fn.name.endsWith(`.${call.name}`)) ?? []);
          if (matches.length === 1) targets.push({ id: matches[0].id, confidence: "name-match" });
        }
      }
      for (const t of targets)
        add({ source: src, target: `fn:${t.id}`, kind: "call", confidence: t.confidence, filePath: pm.path, line: call.line, snippet: `${call.receiver ? `${call.receiver}.` : ""}${call.name}(…)` });
    }
  }
  return [...edges.values()];
}

/** Functions declared in a file, for any language CausalCI parses (JS/TS, Python, Go, Java); null if unsupported. */
export function functionsOf(path: string, content: string, parseJs: (p: string, c: string) => { functions: CodeFunction[]; parseError: string | null }): { functions: CodeFunction[]; parseError: string | null } | null {
  if (/\.(m|c)?[jt]sx?$/i.test(path)) return parseJs(path, content);
  const pm = parsePolyglot(path, content);
  return pm ? { functions: pm.functions, parseError: pm.parseError } : null;
}

/** Repository files the resolvers read for configuration (aliases, workspaces, Go module path). */
export function isGraphConfigPath(path: string): boolean {
  return /(^|\/)(tsconfig[^/]*\.json|jsconfig\.json|package\.json|go\.mod)$/.test(path) && !path.includes("node_modules/");
}
