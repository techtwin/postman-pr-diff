'use strict';

const core = require('@actions/core');
const github = require('@actions/github');
const { parseCollection } = require('./collection');
const { compareCollections, countChanges } = require('./diff');
const { renderReport } = require('./render');

function isMatchingCollection(file, suffix) {
  return [file.filename, file.previous_filename].some(
    (name) => typeof name === 'string' && name.endsWith(suffix),
  );
}

async function readFileAtRef(octokit, repository, path, ref) {
  try {
    const response = await octokit.rest.repos.getContent({
      ...repository,
      path,
      ref,
    });
    if (Array.isArray(response.data) || response.data.type !== 'file') {
      throw new Error('path does not refer to a file');
    }
    return Buffer.from(response.data.content, response.data.encoding).toString('utf8');
  } catch (error) {
    if (error.status === 404) {
      return null;
    }
    throw error;
  }
}

async function compareFile(octokit, baseRepository, headRepository, file, mergeBase, head) {
  const basePath = file.previous_filename || file.filename;
  try {
    const [baseContent, headContent] = await Promise.all([
      readFileAtRef(octokit, baseRepository, basePath, mergeBase),
      readFileAtRef(octokit, headRepository, file.filename, head),
    ]);

    if (baseContent === null && headContent === null) {
      throw new Error('file was unavailable at both compared revisions');
    }

    const base = baseContent === null
      ? { requests: new Map() }
      : parseCollection(baseContent, basePath);
    const current = headContent === null
      ? { requests: new Map() }
      : parseCollection(headContent, file.filename);

    return { path: file.filename, changes: compareCollections(base, current) };
  } catch (error) {
    return { path: file.filename, error: error.message };
  }
}

async function publishComment(octokit, repository, issueNumber, marker, body) {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    ...repository,
    issue_number: issueNumber,
    per_page: 100,
  });
  const existing = comments.find(
    (comment) =>
      comment.user?.login === 'github-actions[bot]' &&
      comment.body?.includes(`<!-- ${marker} -->`),
  );

  if (existing) {
    await octokit.rest.issues.updateComment({
      ...repository,
      comment_id: existing.id,
      body,
    });
  } else {
    await octokit.rest.issues.createComment({
      ...repository,
      issue_number: issueNumber,
      body,
    });
  }
}

function summaryText(results) {
  const totals = results.reduce(
    (sum, result) => {
      if (!result.changes) {
        sum.errors += 1;
        return sum;
      }
      sum.added += result.changes.added.length;
      sum.removed += result.changes.removed.length;
      sum.modified += result.changes.modified.length;
      return sum;
    },
    { added: 0, removed: 0, modified: 0, errors: 0 },
  );
  const changed = totals.added + totals.removed + totals.modified;
  return `Compared ${results.length} collection file${results.length === 1 ? '' : 's'}: ${changed} request change${changed === 1 ? '' : 's'} (${totals.added} added, ${totals.removed} removed, ${totals.modified} modified)${totals.errors ? `; ${totals.errors} file error${totals.errors === 1 ? '' : 's'}` : ''}.`;
}

async function run() {
  const pullRequest = github.context.payload.pull_request;
  if (!pullRequest) {
    core.notice('This action only evaluates pull_request events.');
    return;
  }

  const token = core.getInput('github-token', { required: true });
  const suffix = core.getInput('collection-file-suffix') || '.postman_collection.json';
  const markerName = core.getInput('comment-marker') || 'postman-pr-diff';
  const marker = `${markerName}:${github.context.repo.owner}/${github.context.repo.repo}:${pullRequest.number}`;
  const octokit = github.getOctokit(token);
  const repository = github.context.repo;

  // Resolve the merge base through GitHub's API; no PR checkout or PR code execution occurs.
  const currentPull = await octokit.rest.pulls.get({
    ...repository,
    pull_number: pullRequest.number,
  });
  const mergeBaseComparison = await octokit.rest.repos.compareCommits({
    ...repository,
    base: currentPull.data.base.sha,
    head: currentPull.data.head.label || currentPull.data.head.sha,
    per_page: 1,
  });
  const mergeBase = mergeBaseComparison.data.merge_base_commit.sha;
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    ...repository,
    pull_number: pullRequest.number,
    per_page: 100,
  });
  const collectionFiles = files.filter((file) => isMatchingCollection(file, suffix));
  const headRepository = currentPull.data.head.repo
    ? {
      owner: currentPull.data.head.repo.owner.login,
      repo: currentPull.data.head.repo.name,
    }
    : repository;
  const results = await Promise.all(
    collectionFiles.map((file) =>
      compareFile(
        octokit,
        repository,
        headRepository,
        file,
        mergeBase,
        currentPull.data.head.sha,
      )),
  );
  const report = renderReport(results, marker);

  try {
    await publishComment(octokit, repository, pullRequest.number, marker, report);
  } catch (error) {
    core.warning(`Unable to publish Postman diff comment: ${error.message}`);
  }

  try {
    await core.summary
      .addHeading('Postman collection diff')
      .addRaw(summaryText(results))
      .write();
  } catch (error) {
    core.warning(`Unable to publish Postman diff summary: ${error.message}`);
  }

  core.info(summaryText(results));
}

if (require.main === module) {
  run().catch((error) => {
    core.warning(`Postman PR diff could not complete: ${error.message}`);
  });
}

module.exports = {
  compareFile,
  isMatchingCollection,
  publishComment,
  readFileAtRef,
  summaryText,
};
