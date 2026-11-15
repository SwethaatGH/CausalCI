import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCENARIOS,
  bayesianBisect,
  binaryBisect,
  buildDependencyGraph,
  detectChangePoint,
  informationGain,
  kAryBisect,
  linearScan,
  mulberry32,
  priorFromScores,
  probePoints,
  rankUnder,
  trainRanker,
  runScenario,
  selectTests,
  suspectRangeFromSignal,
  updatePosterior,
  type Oracle,
} from "../src";

const deterministic = (culprit: number): Oracle => async (i) => (i >= culprit ? "fail" : "pass");

describe("deterministic bisection", () => {
  it.each([1, 2, 7, 64, 100])("binary and k-ary find every culprit in %i candidates", async (n) => {
    for (let c = 0; c < n; c++) {
      expect((await binaryBisect(n, deterministic(c))).culprit).toBe(c);
      expect((await kAryBisect(n, 3, deterministic(c))).culprit).toBe(c);
      expect((await linearScan(n, deterministic(c))).culprit).toBe(c);
    }
  });

  it("binary uses at most ⌈log₂ n⌉ runs", async () => {
    for (let c = 0; c < 64; c++) expect((await binaryBisect(64, deterministic(c))).runs).toBeLessThanOrEqual(6);
  });

  it("k-ary needs fewer rounds than binary", async () => {
    const n = 512;
    let binRounds = 0;
    let kRounds = 0;
    for (let c = 0; c < n; c += 7) {
      binRounds += (await binaryBisect(n, deterministic(c))).rounds;
      kRounds += (await kAryBisect(n, 7, deterministic(c))).rounds;
    }
    // log₂(512) = 9 vs log₈(512) = 3
    expect(kRounds).toBeLessThan(binRounds / 2);
  });

  it("probe points are distinct and inside the open interval", () => {
    expect(probePoints(0, 10, 3)).toEqual([2, 5, 7]);
    expect(probePoints(4, 6, 5)).toEqual([4, 5]);
    expect(probePoints(3, 3, 2)).toEqual([]);
  });
});

describe("bayesian bisection", () => {
  it("matches binary search on a deterministic suite", async () => {
    for (let c = 0; c < 32; c++) {
      const r = await bayesianBisect(32, deterministic(c), { falseFailRate: 0.001, missRate: 0.001 });
      expect(r.culprit).toBe(c);
      expect(r.confidence).toBeGreaterThanOrEqual(0.95);
    }
  });

  it("information gain is highest near the posterior median", () => {
    const g = informationGain(new Array(9).fill(1 / 9), 0.05, 0.1);
    const argmax = g.indexOf(Math.max(...g));
    expect(argmax).toBeGreaterThanOrEqual(3);
    expect(argmax).toBeLessThanOrEqual(4);
  });

  it("posterior stays normalized and moves mass toward the evidence", () => {
    const p0 = new Array(4).fill(0.25);
    const p1 = updatePosterior(p0, 1, "fail", 0.05, 0.1);
    expect(p1.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(p1[0] + p1[1]).toBeGreaterThan(0.9);
  });

  it("a strong prior on the right commit saves runs; a wrong one only costs runs", async () => {
    const n = 64;
    const culprit = 41;
    const right = priorFromScores(Array.from({ length: n }, (_, i) => (i === culprit ? 100 : 0)), 3);
    const wrong = priorFromScores(Array.from({ length: n }, (_, i) => (i === 3 ? 100 : 0)), 3);
    const uniform = await bayesianBisect(n, deterministic(culprit), { falseFailRate: 0.01, missRate: 0.01 });
    const good = await bayesianBisect(n, deterministic(culprit), { prior: right, falseFailRate: 0.01, missRate: 0.01 });
    const bad = await bayesianBisect(n, deterministic(culprit), { prior: wrong, falseFailRate: 0.01, missRate: 0.01 });
    expect(good.culprit).toBe(culprit);
    expect(bad.culprit).toBe(culprit);
    expect(good.runs).toBeLessThan(uniform.runs);
  });

  it("is more accurate than git-style bisect on a flaky suite (seeded simulation)", async () => {
    const r = await runScenario(DEFAULT_SCENARIOS[1], 300, 7);
    const binary = r.stats.find((s) => s.strategy.startsWith("binary"))!;
    const bayes = r.stats.find((s) => s.strategy === "bayesian")!;
    expect(bayes.accuracy).toBeGreaterThan(binary.accuracy + 0.15);
  });

  it("rejects invalid input", async () => {
    await expect(bayesianBisect(4, deterministic(1), { prior: [1, 2] })).rejects.toThrow(RangeError);
    await expect(binaryBisect(0, deterministic(0))).rejects.toThrow(RangeError);
  });

  it("seeded PRNG is reproducible", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe("regression test selection", () => {
  const graph = buildDependencyGraph(
    [
      { path: "src/price.ts", content: "export function price(x: number) { return x * 2; }" },
      { path: "src/cart.ts", content: "import { price } from './price';\nexport function total(xs: number[]) { return xs.map(price).reduce((a, b) => a + b, 0); }" },
      { path: "src/user.ts", content: "export function name() { return 'a'; }" },
      { path: "test/cart.test.ts", content: "import { total } from '../src/cart';\ntotal([1]);" },
      { path: "test/user.test.ts", content: "import { name } from '../src/user';\nname();" },
    ],
    { headSha: null },
  ).graph;
  const allTests = ["test/cart.test.ts", "test/user.test.ts"];

  it("selects only tests that transitively depend on the change", () => {
    const s = selectTests(graph, { changedFiles: ["src/price.ts"], allTests });
    expect(s.runAll).toBe(false);
    expect(s.selected).toEqual(["test/cart.test.ts"]);
    expect(s.skipped).toEqual(["test/user.test.ts"]);
  });

  it("falls back to the full suite for changes the graph cannot trace", () => {
    const s = selectTests(graph, { changedFiles: ["package.json", "src/price.ts"], allTests });
    expect(s.runAll).toBe(true);
    expect(s.selected).toEqual(allTests);
  });
});

describe("production signal correlation", () => {
  const base = 1_700_000_000;
  const series = Array.from({ length: 40 }, (_, i) => ({ t: base + i * 60, v: (i < 25 ? 0.4 : 3.1) + ((i * 7) % 5) * 0.05 }));
  const deploys = [
    { sha: "aaa111", t: base - 3600 },
    { sha: "bbb222", t: base + 10 * 60 },
    { sha: "ccc333", t: base + 24 * 60 + 30 },
  ];

  it("finds the error-rate shift", () => {
    const cp = detectChangePoint(series)!;
    expect(cp.index).toBe(25);
    expect(cp.meanAfter).toBeGreaterThan(cp.meanBefore * 4);
  });

  it("does not invent a shift in a flat noisy series", () => {
    const flat = Array.from({ length: 40 }, (_, i) => ({ t: base + i * 60, v: 1 + ((i * 13) % 7) * 0.03 }));
    expect(detectChangePoint(flat)).toBeNull();
  });

  it("maps the shift to the deploy that was live and the one before it", () => {
    const r = suspectRangeFromSignal(series, deploys)!;
    expect(r.suspectDeploy.sha).toBe("ccc333");
    expect(r.lastGoodDeploy?.sha).toBe("bbb222");
    expect(r.lagSeconds).toBe(30);
  });
});

describe("learned ranker", () => {
  it("learns which feature marks the culprit and ranks it first on unseen groups", () => {
    const rnd = mulberry32(3);
    const group = () => {
      const positive = Math.floor(rnd() * 10);
      const features = Array.from({ length: 10 }, (_, i) => [1, rnd(), i === positive ? 0.9 + rnd() * 0.1 : rnd() * 0.5]);
      return { features, positive };
    };
    const model = trainRanker(Array.from({ length: 60 }, group));
    expect(model.weights[2]).toBeGreaterThan(Math.abs(model.weights[1]));
    const held = Array.from({ length: 30 }, group);
    expect(held.filter((g) => rankUnder(model, g) === 1).length).toBeGreaterThanOrEqual(27);
  });
});
