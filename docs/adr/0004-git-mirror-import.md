# 4. Read history from a local partial clone, not the REST API

Status: accepted

## Context

Importing through GitHub's REST API hit three walls: 60 requests per hour without a token (one investigation can need hundreds), patches omitted for large diffs, and recursive trees truncated for large repositories. Each made results incomplete in ways users could not see.

## Decision

By default (`IMPORT_MODE=auto`), history is read from a bare partial clone (`git clone --bare --filter=blob:none`) kept under `CACHE_DIR`: `git log` for commits, `git show` / `git diff` for complete patches, `git cat-file` for file contents (blobs are fetched on demand) and `git ls-tree -r` for the full tree. Repository metadata still comes from the API, as a conditional request with the stored ETag; GitHub answers an unchanged resource with 304, which does not count against the rate limit.

When git is unavailable or the clone fails, the API path remains, and it now repairs what it used to skip: truncated patches are rebuilt from the raw file contents before and after the commit (raw downloads don't use REST quota), and a truncated tree is walked one level at a time.

## Consequences

- No rate limit for history, and no truncation, so every changed file is analyzed.
- A first import of a large repository costs a clone (history only, no file contents); later imports only fetch.
- The cache directory grows with the number of repositories imported; it is safe to delete.
