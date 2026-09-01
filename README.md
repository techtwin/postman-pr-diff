# Postman PR Diff

`Postman PR Diff` is a JavaScript GitHub Action that posts a compact, sticky pull-request comment and a job summary for semantic request-level changes in [Postman Collection v2.1](https://schema.getpostman.com/json/collection/v2.1.0/collection.json) files.

It compares the GitHub API's merge-base revision with the current PR head. It never checks out the pull request, runs collection scripts, or executes PR-provided code.

## Architecture and security model

The Action is intentionally split by trust boundary:

| Module | Responsibility |
| --- | --- |
| `src/index.js` | Retrieves pull request metadata and collection files through GitHub's API, then publishes the non-blocking report. |
| `src/collection.js` and `src/formats.js` | Parse Collection v2.1 JSON and normalize requests, body modes, and inert script events. |
| `src/diff.js` | Produces deterministic request and collection-script change models. |
| `src/redaction.js` and `src/render-utils.js` | Centralize recursive secret redaction, Markdown-safe formatting, output limits, and bounded text diffs. |
| `src/body-renderer.js` and `src/script-renderer.js` | Render safe format-specific and script details without evaluating content. |
| `src/render.js` | Composes the compact per-collection report and delegates untrusted-content rendering to the bounded helpers. |

The Action does not check out PR code or invoke Postman. XML processing rejects DTDs and entities, disables entity processing, and enforces input-size, depth, and node limits. File and binary bodies are metadata-only. All rendered user-controlled content flows through redaction and size limits before being included in Markdown.

## Setup

Add this workflow to `.github/workflows/postman-pr-diff.yml`:

```yaml
name: Postman PR Diff

on:
  pull_request:
    types: [opened, reopened, synchronize, ready_for_review]

permissions:
  contents: read
  pull-requests: write

jobs:
  diff:
    runs-on: ubuntu-latest
    steps:
      - uses: techtwin/postman-pr-diff@main # Pin an immutable release SHA in production.
        with:
          github-token: ${{ github.token }}
```

`contents: read` retrieves collection contents. `pull-requests: write` is required both to inspect the pull request and to create or update its conversation comment. Although GitHub exposes pull-request conversation comments at an `issues` REST endpoint, granting only `issues: write` does not authorize this operation for a pull request. The report is non-blocking: permission or API failures generate warnings and do not fail the job.

For pull requests from forks, GitHub downgrades the provided token to read-only. The Action still performs safe reads and writes the job summary, but it may be unable to create or update the PR comment. Do **not** replace this with `pull_request_target`; that event would make untrusted PR data available to a write-scoped workflow.

The included workflow first checks out the repository's default branch at a pinned `actions/checkout` revision and then invokes the local Action. It therefore never checks out or executes the PR head. If you use the published Action from another repository, pin its `uses:` reference to an immutable release SHA.

## Configuration

| Input | Default | Purpose |
| --- | --- | --- |
| `github-token` | Required | Usually `${{ github.token }}` with `contents: read` and `pull-requests: write`. |
| `collection-file-suffix` | `.postman_collection.json` | Evaluates changed files whose current or previous name ends with the suffix. |
| `comment-marker` | `postman-pr-diff` | Namespace for the idempotently updated comment. |
| `url-display` | `path-only` | URL visibility in reports: `path-only` (no host or query values), `full` (redacts known sensitive values), or `hidden`. |

## What changes are compared

The Action flattens collection folders into stable request paths and compares each request's method, URL, headers, body, and authentication. Object-key ordering is normalized so formatting-only JSON reordering does not cause a change. It reports added, removed, and modified requests; nested folders are included in the request path.

The sticky comment keeps per-collection counts concise and lists modified requests by their current method, path, and request name. `url-display` defaults to `path-only`: it omits URL hosts and query values, while still identifying changed paths and query parameter names. Use `full` only when the repository's PR visibility makes full endpoint output appropriate; it redacts known sensitive parameter names. Use `hidden` to suppress all URL details. Each modified request has an expandable field-level section for method, URL changes, added/removed/changed headers, authentication type and configuration names, and request body changes.

Raw JSON request bodies are parsed and compared structurally. The report uses readable JSON paths such as `$.vehicle.annualMileage` to show added, removed, and updated properties with safe inline values; object wrapping/moving is compacted where possible, and changed arrays are reported as replacements rather than expanded item-by-item. Object key ordering is ignored.

Each changed JSON body also includes an expandable `View exact body changes (raw JSON diff)` section. It contains a red/green GitHub `diff` block generated from redacted, key-sorted, pretty JSON so simple property additions and removals remain easy to inspect. The raw diff is omitted with an explicit size or line-count notice when it exceeds the safety cap; the concise structural summary remains the primary view. Raw non-JSON body content is intentionally omitted and marked as changed.

## Supported body and script formats

| Postman body mode | Semantic report |
| --- | --- |
| `raw` JSON | Structural JSON paths plus bounded, expandable exact diff. |
| `raw` XML | Element, attribute, and text changes after parsing without DTDs, entities, or network resolution. Malformed, unsafe, deep, or oversized XML emits an omission notice. |
| `raw` HTML, JavaScript, text, and other | Redacted, bounded expandable text diff. |
| `urlencoded` | Enabled fields only, sorted by name. |
| `formdata` | Field changes; file fields show filename metadata only, never file content or source paths. |
| `graphql` | Query diff plus canonical JSON variables comparison. |
| `file` / `binary` | Filename metadata only. |

Collection and request `prerequest` and `test` events are compared deterministically and rendered as collapsed, redacted, capped script diffs. Scripts, entities, templates, and file content are never executed, interpolated, or fetched.

Header values with sensitive names (for example, `Authorization`, `Cookie`, API keys, tokens, passwords, and secrets), sensitive query parameters, and authentication values are redacted. Long or large bodies are omitted rather than expanded, and the whole comment has a size limit.

Request scripts, examples, collection metadata, descriptions, variable values, response examples, and array ordering are intentionally outside the semantic comparison. The Action accepts only Collection v2.1 documents and reports a per-file warning for invalid JSON or an unsupported schema.

## Development

```sh
npm install
npm test
npm run build
```

Commit the generated `dist/` output with source changes: GitHub Actions runs the bundled entry point rather than installing dependencies at execution time.

The Node built-in test suite covers request additions/removals/modifications, body-format dispatch, XML hardening and fallback notices, disabled form fields, file privacy, script diffs, secret redaction, and comment/update behavior.
