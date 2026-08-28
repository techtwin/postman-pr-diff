# Postman PR Diff

`Postman PR Diff` is a JavaScript GitHub Action that posts a compact, sticky pull-request comment and a job summary for semantic request-level changes in [Postman Collection v2.1](https://schema.getpostman.com/json/collection/v2.1.0/collection.json) files.

It compares the GitHub API's merge-base revision with the current PR head. It never checks out the pull request, runs collection scripts, or executes PR-provided code.

## Setup

Add this workflow to `.github/workflows/postman-pr-diff.yml`:

```yaml
name: Postman PR Diff

on:
  pull_request:
    types: [opened, reopened, synchronize, ready_for_review]

permissions:
  contents: read
  pull-requests: read
  issues: write

jobs:
  diff:
    runs-on: ubuntu-latest
    steps:
      - uses: techtwin/postman-pr-diff@main # Pin an immutable release SHA in production.
        with:
          github-token: ${{ github.token }}
```

`contents: read` retrieves collection contents, `pull-requests: read` lists changed files and resolves the merge base, and `issues: write` creates or updates the sticky PR comment. The report is non-blocking: permission or API failures generate warnings and do not fail the job.

For pull requests from forks, GitHub downgrades the provided token to read-only. The Action still performs safe reads and writes the job summary, but it may be unable to create or update the PR comment. Do **not** replace this with `pull_request_target`; that event would make untrusted PR data available to a write-scoped workflow.

The included workflow first checks out the repository's default branch at a pinned `actions/checkout` revision and then invokes the local Action. It therefore never checks out or executes the PR head. If you use the published Action from another repository, pin its `uses:` reference to an immutable release SHA.

## Configuration

| Input | Default | Purpose |
| --- | --- | --- |
| `github-token` | Required | Usually `${{ github.token }}`. |
| `collection-file-suffix` | `.postman_collection.json` | Evaluates changed files whose current or previous name ends with the suffix. |
| `comment-marker` | `postman-pr-diff` | Namespace for the idempotently updated comment. |

## What changes are compared

The Action flattens collection folders into stable request paths and compares each request's method, URL, headers, body, and authentication. Object-key ordering is normalized so formatting-only JSON reordering does not cause a change. It reports added, removed, and modified requests; nested folders are included in the request path.

Request scripts, examples, collection metadata, descriptions, variable values, response examples, and array ordering are intentionally outside the semantic comparison. The Action accepts only Collection v2.1 documents and reports a per-file warning for invalid JSON or an unsupported schema.

## Development

```sh
npm install
npm test
npm run build
```

Commit the generated `dist/` output with source changes: GitHub Actions runs the bundled entry point rather than installing dependencies at execution time.
