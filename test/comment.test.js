'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { publishComment } = require('../src/index');

function octokitWithComments(comments) {
  const calls = [];
  const octokit = {
    paginate: async (method, options) => {
      calls.push({ method, options });
      return comments;
    },
    rest: {
      issues: {
        listComments: Symbol('listComments'),
        updateComment: async (options) => calls.push({ method: 'updateComment', options }),
        createComment: async (options) => calls.push({ method: 'createComment', options }),
      },
    },
  };

  return { calls, octokit };
}

test('updates the existing marked GitHub Actions comment', async () => {
  const { calls, octokit } = octokitWithComments([
    { id: 42, user: { login: 'github-actions[bot]' }, body: '<!-- marker -->\nOld report' },
  ]);

  await publishComment(octokit, { owner: 'octo', repo: 'example' }, 7, 'marker', 'New report');

  assert.deepEqual(calls[1], {
    method: 'updateComment',
    options: { owner: 'octo', repo: 'example', comment_id: 42, body: 'New report' },
  });
});

test('creates the marked comment when no matching action comment exists', async () => {
  const { calls, octokit } = octokitWithComments([
    { id: 42, user: { login: 'github-actions[bot]' }, body: '<!-- another marker -->' },
  ]);

  await publishComment(octokit, { owner: 'octo', repo: 'example' }, 7, 'marker', 'New report');

  assert.deepEqual(calls[1], {
    method: 'createComment',
    options: { owner: 'octo', repo: 'example', issue_number: 7, body: 'New report' },
  });
});
