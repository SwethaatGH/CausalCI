# Running and deploying

## The pieces

```text
            ┌──────────────┐  POST /api/bisect-jobs   ┌────────────┐  BLMOVE   ┌──────────────┐
 browser ──▶│ API + web    │─────────────────────────▶│   Redis    │──────────▶│  worker × N  │
 / CI       │ (Fastify)    │◀──── GET job status ─────│ job queue  │           │ (KEDA-scaled)│
            └──────┬───────┘                          └────────────┘           └──────┬───────┘
                   │ /metrics                                                          │ one Job per test run
                   ▼                                                                   ▼
            ┌──────────────┐                                              ┌──────────────────────┐
            │ Prometheus → │◀──────────────── /metrics ───────────────────│ sandbox pod (gVisor) │
            │   Grafana    │                                              │ no token, egress 443 │
            └──────────────┘                                              └──────────────────────┘
```

## Local: one command

```bash
docker compose up --build
```

- App: http://localhost:8787
- Grafana: http://localhost:3000 (the CausalCI dashboard is provisioned)
- Prometheus: http://localhost:9090

The compose worker starts sandbox containers on your Docker daemon. Set `SANDBOX_RUNTIME=runsc` if gVisor is installed.

Queue a job:

```bash
curl -X POST localhost:8787/api/bisect-jobs -H 'content-type: application/json' -d '{
  "repoUrl": "https://github.com/SwethaatGH/CausalCI", "good": "<last green sha>", "bad": "<red sha>",
  "testCommand": "npm test", "strategy": "bayesian", "parallel": 2 }'
curl localhost:8787/api/bisect-jobs/<id>
```

## Running tests from the web app

With `BISECT_JOBS_ENABLED=true` and Docker running (or a worker with `REDIS_URL`), the web app can run a repository's own tests:

- **Suspects → Confirm with tests**: pick the test command (a default is suggested from the main language) and a search: smart (flaky-aware), binary or parallel. The tests run in sandboxes across the investigation's range; the first failing commit becomes *confirmed by tests* and moves to the top.
- **Fix and verify → Run the checks**: the proposed fix is applied to the newest commit and the tests run there; a passing run marks the fix verified.

When test runs aren't available, both places say why (`GET /api/bisect-jobs/config`).

## CLI

```bash
npm run causalci -- bisect --good v1.2.0 --bad HEAD --test "npm test"         # Docker sandbox, Bayesian search
npm run causalci -- bisect --good v1.2.0 --bad HEAD --test "npm test" --strategy k-ary --parallel 4
npm run causalci -- rank --good v1.2.0 --bad HEAD                               # no code runs
npm run causalci -- select-tests --sha HEAD                                     # affected tests only
npm run causalci -- signal --series errors.json --deploys deploys.json          # metric shift → deploy → range
npm run causalci -- eval --repo ../ky --repo ../axios --repo ../express         # see EVALUATION.md
npm run bench
```

## GitHub Actions

- `.github/workflows/ci.yml` typechecks, lints, tests, builds, runs the bisection benchmark into the job summary, builds both images, lints and schema-validates the Helm chart, and validates the Terraform.
- `.github/workflows/find-culprit.yml` runs when CI fails on `main`. It finds the last green commit, bisects in Docker sandboxes on the runner, and comments the result on the culprit commit. Set the repository variable `CAUSALCI_TEST_COMMAND` to change the test command, and `CAUSALCI_OPEN_REVERT_PR=true` to also open a draft revert PR.
- `.github/workflows/release.yml` builds, pushes and signs (cosign, keyless) both images to GHCR when a `v*` tag is pushed, with SBOM and provenance.

## Kubernetes (GKE) with Terraform

```bash
cd deploy/terraform
cp terraform.tfvars.example terraform.tfvars    # project, image owner, jobs token
terraform init && terraform apply
$(terraform output -raw get_credentials)
kubectl -n causalci get pods
```

This creates:
- a GKE cluster with a **system** node pool (API, workers, Redis, KEDA) and an autoscaling **sandbox** node pool running GKE Sandbox (gVisor);
- KEDA;
- the chart, with workers scaling from 0 to 10 on the Redis queue length.

Without Terraform, on any cluster with KEDA installed:

```bash
helm install causalci deploy/helm/causalci -n causalci --create-namespace \
  --set image.api=ghcr.io/swethaatgh/causalci-api --set image.worker=ghcr.io/swethaatgh/causalci-worker --set image.tag=v0.1.0
```

Set `sandbox.runtimeClassName=""` on clusters without gVisor, and `keda.enabled=false` to run a fixed `worker.replicas`.

## GitOps

`deploy/argocd/application.yaml` points Argo CD at the chart on `main` with automated sync, prune and self-heal. Change `repoURL` to your repository.

## MCP server (for coding agents)

```bash
claude mcp add causalci -- npx tsx /path/to/repo/apps/mcp/src/index.ts
```

Tools:
- `rank_suspects`: rank a commit range. Runs no code.
- `select_tests`: list the tests that can reach a commit's changes.
- `find_culprit`: bisect in a Docker sandbox.

## Configuration

| Variable | Used by | Purpose |
|---|---|---|
| `IMPORT_MODE` | API | `auto` (default): read history from a local partial clone when git is available; `git`: always (fail if cloning fails); `api`: GitHub REST API only |
| `CACHE_DIR` | API, worker | Repository mirrors and clone cache (default `./.causalci-cache`) |
| `REDIS_URL` | API, worker | Job queue; in-memory when unset (single process, and the API then runs the worker itself) |
| `BISECT_JOBS_ENABLED` | API | Allow creating sandboxed jobs (default off; forced off by `PUBLIC_DEMO`) |
| `JOBS_TOKEN` | API | Bearer token required to create jobs |
| `INLINE_WORKER` | API | Run the worker loop inside the API (single node with Docker) |
| `SANDBOX` | worker | `docker` or `kubernetes` |
| `SANDBOX_RUNTIME` | worker | Docker runtime or Kubernetes RuntimeClass, e.g. `runsc` or `gvisor` |
| `SANDBOX_IMAGE`, `RUN_TIMEOUT_MS`, `CACHE_DIR`, `STALE_JOB_MS`, `METRICS_PORT` | worker | Sandbox image, per-run limit, clone cache, crash recovery, metrics port |
