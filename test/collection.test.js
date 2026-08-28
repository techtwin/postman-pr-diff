'use strict';

const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const { parseCollection } = require('../src/collection');
const { compareCollections, countChanges } = require('../src/diff');
const { escapeMarkdown, renderReport } = require('../src/render');

async function fixture(name) {
  return readFile(path.join(__dirname, 'fixtures', name), 'utf8');
}

test('finds additions, removals, modifications, and nested-folder requests', async () => {
  const base = parseCollection(await fixture('base.postman_collection.json'), 'base');
  const head = parseCollection(await fixture('head.postman_collection.json'), 'head');
  const changes = compareCollections(base, head);

  assert.deepEqual(changes.added.map((change) => change.key), ['Users / Admin / List audits']);
  assert.deepEqual(changes.removed.map((change) => change.key), ['Legacy / Delete user']);
  assert.deepEqual(changes.modified.map((change) => change.key), ['Users / Get user']);
  assert.equal(countChanges(changes), 3);
});

test('ignores JSON object key order in semantically identical requests', async () => {
  const base = parseCollection(await fixture('base.postman_collection.json'), 'base');
  const head = parseCollection(await fixture('head.postman_collection.json'), 'head');
  const changes = compareCollections(base, head);

  assert.deepEqual(changes.unchanged.map((change) => change.key), ['Auth / Login']);
});

test('validates the Postman Collection v2.1 schema', () => {
  assert.throws(
    () => parseCollection('{"info":{"schema":"https://example.test"},"item":[]}', 'invalid.json'),
    /not a Postman Collection v2.1/,
  );
});

test('renders compact escaped Markdown with expandable request details', () => {
  const report = renderReport(
    [{
      path: 'collections/a_[b].postman_collection.json',
      changes: {
        added: [{ key: 'Users / Get *one*', after: { method: 'GET', url: 'https://example.test/a_b' } }],
        removed: [],
        modified: [],
        unchanged: [],
      },
    }],
    'postman-pr-diff:test',
  );

  assert.match(report, /<details><summary>Added \(1\)<\/summary>/);
  assert.match(report, /a\\_\\\[b\\\]/);
  assert.equal(escapeMarkdown('*value*'), '\\*value\\*');
});
