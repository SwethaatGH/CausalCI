import { beforeAll, describe, expect, it } from "vitest";
import { buildDependencyGraph, initPolyglot, polyglotStatus, readPathMapping, workspacePackages } from "../src";

const edge = (g: ReturnType<typeof buildDependencyGraph>["graph"], source: string, target: string) => g.edges.find((e) => e.source === source && e.target === target);

describe("type-aware JS/TS resolution", () => {
  const files = [
    { path: "src/lib/price.ts", content: "export function price(x: number) { return x * 2; }\nexport function double(x: number) { return x + x; }" },
    {
      path: "src/cart.ts",
      content: [
        'import { price, double } from "@/lib/price";',
        'import { Logger } from "@acme/log";',
        "export interface Store { save(n: number): void }",
        "export class Cart {",
        "  constructor(private store: Store, private log: Logger) {}",
        "  total(xs: number[]) {",
        "    const t = xs.map(double).reduce((a, b) => a + price(b), 0);",
        "    this.log.info(t);",
        "    this.store.save(t);",
        "    return t;",
        "  }",
        "}",
        "export function checkout() { return new Cart(new MemoryStore(), new Logger()).total([1]); }",
        "class MemoryStore implements Store { save(n: number) { void n; } }",
      ].join("\n"),
    },
    { path: "packages/log/src/index.ts", content: "export class Logger { info(x: unknown) { return String(x); } }" },
  ];
  const configs = [
    { path: "tsconfig.json", content: '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }' },
    { path: "packages/log/package.json", content: '{ "name": "@acme/log", "main": "dist/index.js" }' },
  ];
  const { graph } = buildDependencyGraph(files, { headSha: null, configs });

  it("resolves tsconfig path aliases", () => {
    expect(readPathMapping(configs).paths).toEqual({ "@/*": ["src/*"] });
    expect(edge(graph, "file:src/cart.ts", "file:src/lib/price.ts")).toBeDefined();
    expect(edge(graph, "fn:src/cart.ts#Cart.total", "fn:src/lib/price.ts#price")).toBeDefined();
  });

  it("resolves workspace packages to their source entry (dist → src)", () => {
    expect(workspacePackages(configs, new Set(files.map((f) => f.path))).get("@acme/log")).toBe("packages/log/src/index.ts");
    expect(edge(graph, "file:src/cart.ts", "file:packages/log/src/index.ts")).toBeDefined();
  });

  it("follows method calls on typed instances", () => {
    const e = edge(graph, "fn:src/cart.ts#Cart.total", "fn:packages/log/src/index.ts#Logger.info");
    expect(e?.evidence.description).toMatch(/calls method/);
  });

  it("links functions passed as callbacks", () => {
    expect(edge(graph, "fn:src/cart.ts#Cart.total", "fn:src/lib/price.ts#double")?.evidence.description).toMatch(/callback/);
  });

  it("links interface calls to their implementations", () => {
    expect(edge(graph, "fn:src/cart.ts#Cart.total", "fn:src/cart.ts#MemoryStore.save")?.evidence.description).toMatch(/dispatch/);
  });

  it("links constructors", () => {
    expect(edge(graph, "fn:src/cart.ts#checkout", "fn:src/cart.ts#Cart")).toBeDefined();
  });

  it("reports what it resolved", () => {
    expect(graph.limitations.join(" ")).toMatch(/Path aliases resolved/);
    expect(graph.limitations.join(" ")).toMatch(/workspace package/);
  });

  it("falls back to syntactic resolution when asked", () => {
    const syntactic = buildDependencyGraph(files, { headSha: null, configs, semantic: false }).graph;
    expect(edge(syntactic, "file:src/cart.ts", "file:src/lib/price.ts")).toBeUndefined();
  });
});

describe("Python, Go and Java (tree-sitter)", () => {
  beforeAll(async () => {
    expect(await initPolyglot()).toBe(true);
  });

  it("loads all three grammars", () => {
    expect(polyglotStatus().languages.sort()).toEqual(["go", "java", "python"]);
  });

  it("Python: functions, classes, relative and package imports, self and module calls", () => {
    const { graph } = buildDependencyGraph(
      [
        { path: "shop/__init__.py", content: "" },
        { path: "shop/pricing.py", content: "def clamp(x):\n    return min(x, 60)\n\nclass Discount:\n    def apply(self, total):\n        return total - self.rate(total)\n    def rate(self, total):\n        return clamp(total)\n" },
        { path: "shop/checkout.py", content: "from .pricing import Discount, clamp\nfrom shop import pricing\n\ndef checkout(total):\n    d = Discount()\n    pricing.clamp(total)\n    return d.apply(clamp(total))\n" },
      ],
      { headSha: null },
    );
    expect(graph.level).toBe("function");
    expect(edge(graph, "file:shop/checkout.py", "file:shop/pricing.py")).toBeDefined();
    expect(edge(graph, "fn:shop/pricing.py#Discount.apply", "fn:shop/pricing.py#Discount.rate")).toBeDefined();
    expect(edge(graph, "fn:shop/checkout.py#checkout", "fn:shop/pricing.py#clamp")).toBeDefined();
    expect(edge(graph, "fn:shop/checkout.py#checkout", "fn:shop/pricing.py#Discount")).toBeDefined();
    expect(edge(graph, "fn:shop/checkout.py#checkout", "fn:shop/pricing.py#Discount.apply")?.evidence.description).toMatch(/method name/);
  });

  it("Go: module-relative imports, package calls, same-package calls and receiver methods", () => {
    const { graph } = buildDependencyGraph(
      [
        { path: "internal/price/price.go", content: "package price\n\nfunc Clamp(x int) int { return min(x, 60) }\n\ntype Calc struct{}\n\nfunc (c *Calc) Total(x int) int { return Clamp(x) + helper() }\n" },
        { path: "internal/price/helper.go", content: "package price\n\nfunc helper() int { return 1 }\n" },
        { path: "cmd/app/main.go", content: 'package main\n\nimport (\n  "fmt"\n  "example.com/shop/internal/price"\n)\n\nfunc main() { fmt.Println(price.Clamp(3)) }\n' },
      ],
      { headSha: null, configs: [{ path: "go.mod", content: "module example.com/shop\n\ngo 1.22\n" }] },
    );
    expect(edge(graph, "file:cmd/app/main.go", "file:internal/price/price.go")).toBeDefined();
    expect(edge(graph, "fn:cmd/app/main.go#main", "fn:internal/price/price.go#Clamp")).toBeDefined();
    expect(edge(graph, "fn:internal/price/price.go#Calc.Total", "fn:internal/price/helper.go#helper")).toBeDefined();
  });

  it("Java: imports, static calls, same-class calls and constructors", () => {
    const { graph } = buildDependencyGraph(
      [
        { path: "src/main/java/shop/util/Money.java", content: "package shop.util;\npublic class Money { public static int round(int x) { return x; } }\n" },
        { path: "src/main/java/shop/Cart.java", content: "package shop;\nimport shop.util.Money;\npublic class Cart {\n  public int total(int x) { return Money.round(x) + fee(); }\n  int fee() { return 1; }\n  static Cart make() { return new Cart(); }\n}\n" },
      ],
      { headSha: null },
    );
    expect(edge(graph, "file:src/main/java/shop/Cart.java", "file:src/main/java/shop/util/Money.java")).toBeDefined();
    expect(edge(graph, "fn:src/main/java/shop/Cart.java#Cart.total", "fn:src/main/java/shop/util/Money.java#Money.round")).toBeDefined();
    expect(edge(graph, "fn:src/main/java/shop/Cart.java#Cart.total", "fn:src/main/java/shop/Cart.java#Cart.fee")).toBeDefined();
    expect(edge(graph, "fn:src/main/java/shop/Cart.java#Cart.make", "fn:src/main/java/shop/Cart.java#Cart")).toBeDefined();
  });
});
