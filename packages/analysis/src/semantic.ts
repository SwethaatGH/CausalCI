// Type-checked JS/TS relationships. A TypeScript program is built over the repository's files in
// memory (no node_modules, no lib files), and the checker resolves what syntax alone cannot:
// tsconfig path aliases and baseUrl, workspace packages, `obj.method()` on class instances,
// functions passed as callbacks, and calls through interfaces or abstract methods.
import ts from "typescript";
import { isJsTs } from "./classify";

export interface SemanticEdge {
  /** `file:<path>` or `fn:<path>#<name>` ids, matching the dependency graph. */
  source: string;
  target: string;
  kind: "import" | "call";
  /** How the relationship was established; shown as evidence. */
  via: "import" | "call" | "method-call" | "callback" | "dispatch" | "constructor";
  filePath: string;
  line: number;
  snippet: string;
}

export interface SemanticResult {
  edges: SemanticEdge[];
  /** Notes about what the resolver could and could not do (shown with the graph). */
  notes: string[];
}

interface ConfigFile {
  path: string;
  content: string;
}

const dirname = (p: string) => (p.lastIndexOf("/") === -1 ? "" : p.slice(0, p.lastIndexOf("/")));
const join = (...parts: string[]) => {
  const out: string[] = [];
  for (const seg of parts.join("/").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
};

/** Reads compilerOptions.baseUrl / paths from the nearest root tsconfig/jsconfig, following one level of `extends`. */
export function readPathMapping(configs: ConfigFile[]): { baseUrl?: string; paths?: Record<string, string[]> } {
  const byPath = new Map(configs.map((c) => [c.path, c.content]));
  const load = (path: string, depth = 0): ts.CompilerOptions | null => {
    const text = byPath.get(path);
    if (!text || depth > 3) return null;
    const parsed = ts.parseConfigFileTextToJson(path, text);
    if (parsed.error || !parsed.config) return null;
    const own = (parsed.config.compilerOptions ?? {}) as { baseUrl?: string; paths?: Record<string, string[]> };
    let inherited: { baseUrl?: string; paths?: Record<string, string[]> } = {};
    const ext = parsed.config.extends;
    if (typeof ext === "string" && ext.startsWith(".")) {
      const target = join(dirname(path), ext.endsWith(".json") ? ext : `${ext}.json`);
      inherited = (load(target, depth + 1) as typeof inherited) ?? {};
    }
    const dir = dirname(path);
    const baseUrl = own.baseUrl !== undefined ? join(dir, own.baseUrl) : inherited.baseUrl;
    return { baseUrl, paths: own.paths ?? inherited.paths } as ts.CompilerOptions;
  };
  for (const root of ["tsconfig.json", "jsconfig.json", "tsconfig.base.json"]) {
    const opts = load(root);
    if (opts && (opts.baseUrl !== undefined || opts.paths)) return { baseUrl: opts.baseUrl as string | undefined, paths: opts.paths as Record<string, string[]> | undefined };
  }
  return {};
}

/** Maps workspace package names (from package.json files in the repository) to their entry file. */
export function workspacePackages(configs: ConfigFile[], known: Set<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of configs) {
    if (!c.path.endsWith("package.json") || c.path === "package.json") continue;
    let pkg: { name?: string; main?: string; module?: string; types?: string; source?: string; exports?: unknown };
    try {
      pkg = JSON.parse(c.content);
    } catch {
      continue;
    }
    if (!pkg.name) continue;
    const dir = dirname(c.path);
    const exp = pkg.exports as Record<string, unknown> | string | undefined;
    const dot = typeof exp === "string" ? exp : exp && typeof exp === "object" ? (exp["."] as Record<string, string> | string | undefined) : undefined;
    const dotPath = typeof dot === "string" ? dot : dot && typeof dot === "object" ? (dot.types ?? dot.import ?? dot.default) : undefined;
    const candidates = [pkg.source, pkg.types, dotPath, pkg.module, pkg.main, "src/index.ts", "src/index.tsx", "src/index.js", "index.ts", "index.js"]
      .filter((x): x is string => typeof x === "string")
      .flatMap((p) => {
        const full = join(dir, p);
        // Built output often points at dist/*.js; prefer the source file it was compiled from.
        const src = full.replace(/\/dist\//, "/src/").replace(/\.d\.ts$|\.m?js$/, ".ts");
        return [full, src, src.replace(/\.ts$/, ".tsx")];
      });
    const hit = candidates.find((p) => known.has(p));
    if (hit) out.set(pkg.name, hit);
  }
  return out;
}

function extensionOf(p: string): ts.Extension {
  if (p.endsWith(".d.ts")) return ts.Extension.Dts;
  if (p.endsWith(".tsx")) return ts.Extension.Tsx;
  if (p.endsWith(".ts") || p.endsWith(".mts") || p.endsWith(".cts")) return ts.Extension.Ts;
  if (p.endsWith(".jsx")) return ts.Extension.Jsx;
  return ts.Extension.Js;
}

/** The graph id of the function, method, arrow or class that a declaration (or position inside one) belongs to. */
function ownerId(node: ts.Node, sf: ts.SourceFile): string | null {
  let n: ts.Node | undefined = node;
  while (n && n !== sf) {
    if (ts.isFunctionDeclaration(n) && n.name) return `${sf.fileName}#${n.name.text}`;
    if ((ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n)) && ts.isClassLike(n.parent) && n.parent.name) {
      const name = ts.isConstructorDeclaration(n) ? "constructor" : n.name && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) ? n.name.text : null;
      if (name) return `${sf.fileName}#${n.parent.name.text}.${name}`;
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)))
      return `${sf.fileName}#${n.name.text}`;
    if (ts.isClassDeclaration(n) && n.name) return `${sf.fileName}#${n.name.text}`;
    n = n.parent;
  }
  return null;
}

/** The function-level id a symbol's declaration maps to, or null when it is not a function, method or class in the repository. */
function declId(decl: ts.Declaration, files: Set<string>): string | null {
  const sf = decl.getSourceFile();
  if (!files.has(sf.fileName)) return null;
  if (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl) || ts.isClassDeclaration(decl) || ts.isConstructorDeclaration(decl) || ts.isGetAccessor(decl))
    return ownerId(decl, sf);
  if (ts.isVariableDeclaration(decl) && decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) return ownerId(decl, sf);
  if (ts.isMethodSignature(decl) || ts.isPropertySignature(decl)) return null; // interface member: resolved through dispatch
  return null;
}

export function semanticJsEdges(files: { path: string; content: string }[], configs: ConfigFile[] = [], opts: { maxFiles?: number } = {}): SemanticResult {
  const notes: string[] = [];
  const sources = files.filter((f) => isJsTs(f.path)).slice(0, opts.maxFiles ?? 600);
  if (!sources.length) return { edges: [], notes };
  const contents = new Map(sources.map((f) => [f.path, f.content]));
  const known = new Set(contents.keys());
  const mapping = readPathMapping(configs);
  const workspaces = workspacePackages(configs, known);
  if (mapping.paths) notes.push(`Path aliases resolved from tsconfig (${Object.keys(mapping.paths).length} pattern(s)).`);
  if (workspaces.size) notes.push(`${workspaces.size} workspace package(s) resolved to their source entry.`);

  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    noLib: true,
    noEmit: true,
    skipLibCheck: true,
    noResolve: false,
    types: [],
    jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    resolveJsonModule: false,
    baseUrl: mapping.baseUrl,
    paths: mapping.paths,
  };
  const sfCache = new Map<string, ts.SourceFile>();
  const host: ts.CompilerHost = {
    getSourceFile: (name, lang) => {
      const text = contents.get(name);
      if (text === undefined) return undefined;
      let sf = sfCache.get(name);
      if (!sf) {
        sf = ts.createSourceFile(name, text, lang, true);
        sfCache.set(name, sf);
      }
      return sf;
    },
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => "",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (f) => contents.has(f),
    readFile: (f) => contents.get(f),
    directoryExists: (d) => [...known].some((k) => k.startsWith(`${d}/`)),
    getDirectories: () => [],
    resolveModuleNameLiterals: (literals, containing, _ref, compilerOptions) =>
      literals.map((lit) => {
        const name = lit.text;
        const r = ts.resolveModuleName(name, containing, compilerOptions, host);
        if (r.resolvedModule && known.has(r.resolvedModule.resolvedFileName)) return r;
        // Workspace packages (`@scope/pkg` and `@scope/pkg/sub`): no node_modules here, so map them directly.
        const root = name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0];
        const entry = workspaces.get(root);
        if (entry) {
          const sub = name.slice(root.length);
          const target = sub ? [".ts", ".tsx", ".js", "/index.ts", "/index.js"].map((e) => join(dirname(entry), sub) + e).find((p) => known.has(p)) : entry;
          if (target) return { resolvedModule: { resolvedFileName: target, extension: extensionOf(target), isExternalLibraryImport: false } };
        }
        return { resolvedModule: undefined };
      }),
  };

  let program: ts.Program;
  try {
    program = ts.createProgram({ rootNames: [...known], options, host });
  } catch (err) {
    return { edges: [], notes: [`Type-aware resolution failed (${(err as Error).message}); syntactic resolution was used.`] };
  }
  const checker = program.getTypeChecker();
  const edges = new Map<string, SemanticEdge>();
  const add = (e: SemanticEdge) => {
    if (e.source === e.target) return;
    const key = `${e.kind}:${e.source}->${e.target}`;
    if (!edges.has(key)) edges.set(key, e);
  };

  // Interface / abstract member → concrete implementations, for dispatch through a supertype.
  const implementations = new Map<ts.Symbol, string[]>();
  for (const sf of program.getSourceFiles()) {
    if (!known.has(sf.fileName)) continue;
    const visitClasses = (node: ts.Node) => {
      if (ts.isClassDeclaration(node) && node.name && node.heritageClauses) {
        for (const clause of node.heritageClauses)
          for (const t of clause.types) {
            const superSym = checker.getSymbolAtLocation(t.expression);
            const resolved = superSym && superSym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(superSym) : superSym;
            if (!resolved) continue;
            for (const member of node.members) {
              if (!member.name || !(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))) continue;
              const superMember = resolved.members?.get(member.name.text as ts.__String);
              if (!superMember) continue;
              const id = ownerId(member, sf);
              if (!id) continue;
              implementations.set(superMember, [...(implementations.get(superMember) ?? []), id]);
            }
          }
      }
      ts.forEachChild(node, visitClasses);
    };
    visitClasses(sf);
  }

  const resolve = (expr: ts.Node): ts.Symbol | undefined => {
    let sym = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expr) ? expr.name : expr);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    return sym;
  };
  /** Direct declarations, plus overrides and implementations reachable by dynamic dispatch. */
  const targetsOf = (sym: ts.Symbol): { ids: string[]; dispatched: string[] } => {
    const ids = (sym.declarations ?? []).map((d) => declId(d, known)).filter((x): x is string => !!x);
    const roots = [sym, ...checker.getRootSymbols(sym)];
    const dispatched = [...new Set(roots.flatMap((r) => implementations.get(r) ?? []))].filter((id) => !ids.includes(id));
    return { ids, dispatched };
  };

  for (const sf of program.getSourceFiles()) {
    if (!known.has(sf.fileName)) continue;
    const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const fileId = `file:${sf.fileName}`;
    const walk = (node: ts.Node) => {
      // Imports and re-exports: the checker knows which file a specifier resolved to.
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const mod = checker.getSymbolAtLocation(node.moduleSpecifier);
        const target = mod?.valueDeclaration && ts.isSourceFile(mod.valueDeclaration) ? mod.valueDeclaration.fileName : null;
        if (target && known.has(target))
          add({ source: fileId, target: `file:${target}`, kind: "import", via: "import", filePath: sf.fileName, line: line(node), snippet: `import "${node.moduleSpecifier.text}"` });
      }
      if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.expression) {
        const from = ownerId(node, sf);
        if (from) {
          const sym = resolve(node.expression);
          if (sym) {
            const { ids, dispatched } = targetsOf(sym);
            const isMethod = ts.isPropertyAccessExpression(node.expression);
            const snippet = `${node.expression.getText(sf).slice(0, 80)}(…)`;
            for (const id of ids)
              add({ source: `fn:${from}`, target: `fn:${id}`, kind: "call", via: ts.isNewExpression(node) ? "constructor" : isMethod ? "method-call" : "call", filePath: sf.fileName, line: line(node), snippet });
            for (const id of dispatched) add({ source: `fn:${from}`, target: `fn:${id}`, kind: "call", via: "dispatch", filePath: sf.fileName, line: line(node), snippet });
          }
          // Functions passed by reference (callbacks, handlers): `arr.map(fn)`, `on("x", handler)`.
          for (const arg of node.arguments ?? []) {
            if (!(ts.isIdentifier(arg) || ts.isPropertyAccessExpression(arg))) continue;
            const s = resolve(arg);
            if (!s) continue;
            for (const id of targetsOf(s).ids)
              add({ source: `fn:${from}`, target: `fn:${id}`, kind: "call", via: "callback", filePath: sf.fileName, line: line(arg), snippet: `${arg.getText(sf).slice(0, 60)} passed as a callback` });
          }
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(sf);
  }
  return { edges: [...edges.values()], notes };
}
