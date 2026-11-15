# 2. Sandboxes: Docker with optional gVisor locally, Kubernetes Jobs in production

Status: accepted

## Context

Bisecting means executing arbitrary repository code, including at commits nobody has reviewed. We needed isolation that works on a laptop, in GitHub Actions, and in a cluster that serves many users.

## Decision

- **Docker sandbox** for the CLI, the MCP server and GitHub Actions. Each run gets a fresh git worktree mounted read-only, dependencies in a volume keyed by a content hash of the lockfile (installed once, mounted read-only), `--network=none`, no capabilities, a non-root user, pids, memory and CPU limits, and optional `--runtime=runsc`.
- **Kubernetes Jobs** in production. The worker never runs repository code; it creates one restricted Job per run on a gVisor node pool, with no service-account token and egress restricted by NetworkPolicy.
- **No Docker-in-Docker and no host socket in production.** The compose file mounts the socket for local development only.

## Consequences

- Kubernetes cannot remove the network from one container, so the install step and the test step share the pod's egress policy (DNS plus 443 to public IPs). Documented in the threat model, with Cilium FQDN policies as the fix.
- Content-hash dependency caching makes the second and later runs of a bisect cost only the test time.
