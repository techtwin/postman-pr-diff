'use strict';

const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const { parseCollection } = require('../src/collection');
const { compareCollections, countChanges } = require('../src/diff');
const { escapeMarkdown, renderModifiedRequest, renderReport } = require('../src/render');

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

test('ignores object-key order in raw JSON request bodies', () => {
  const collection = (raw) => parseCollection(JSON.stringify({
    info: {
      name: 'Body ordering',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: [{
      name: 'Create',
      request: {
        method: 'POST',
        url: 'https://api.example.test/create',
        body: { mode: 'raw', raw },
      },
    }],
  }));
  const changes = compareCollections(
    collection('{"vehicle":"sedan","annualMileage":12000}'),
    collection('{"annualMileage":12000,"vehicle":"sedan"}'),
  );

  assert.equal(changes.modified.length, 0);
  assert.equal(changes.unchanged.length, 1);
});

test('validates the Postman Collection v2.1 schema', () => {
  assert.throws(
    () => parseCollection('{"info":{"schema":"https://example.test"},"item":[]}', 'invalid.json'),
    /not a Postman Collection v2.1/,
  );
});

test('renders readable file paths with valid expandable sections', () => {
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
  assert.match(report, /`collections\/a_\[b\]\.postman_collection\.json`/);
  assert.doesNotMatch(report, /a\\_\\\[b\\\]/);
  assert.equal(escapeMarkdown('*value*'), '\\*value\\*');
});

test('renders structural body paths and safe field-level request changes', async () => {
  const base = parseCollection(await fixture('base.postman_collection.json'), 'base');
  const head = parseCollection(await fixture('head.postman_collection.json'), 'head');
  const report = renderReport(
    [{ path: 'collections/example.postman_collection.json', changes: compareCollections(base, head) }],
    'postman-pr-diff:test',
  );

  assert.match(report, /\*\*Modified \(1\)\*\*/);
  assert.match(report, /### GET https:\/\/api\.example\.test\/users\/\{\{id\}\}\?include=vehicles&view=summary - Get user/);
  assert.match(report, /Changed: URL, Headers, Request body/);
  assert.match(report, /<details><summary>View changed fields<\/summary>/);
  assert.match(report, /Removed `\$\.vehicle\.annualMileage`: `12000`/);
  assert.match(report, /Added `\$\.vehicle\.estimatedAnnualMileage`: `12000`/);
  assert.doesNotMatch(report, /GET https:\/\/api\.example\.test\/users\/\{\{id\}\}\?include=vehicles&view=summary` -> `GET https:\/\/api\.example\.test\/users\/\{\{id\}\}\?include=vehicles&view=summary/);
  assert.match(report, /Changed `accept`: `application\/json` -> `application\/vnd\.example\+json`/);
  assert.match(report, /Added `x-request-id`: `request-123`/);
  assert.match(report, /Query added `include`: `vehicles`/);
  assert.match(report, /Query changed `view`: `full` -> `summary`/);
  assert.match(report, /Changed `x-api-key`: `\[redacted\]` -> `\[redacted\]`/);
  assert.doesNotMatch(report, /before-secret|after-secret/);
});

test('compacts a wrapped object into a structural move instead of a JSON wall', () => {
  const markdown = renderModifiedRequest({
    key: 'Books / Create books',
    before: {
      method: 'POST',
      url: '{{url}}/api/books',
      header: [],
      body: { mode: 'raw', raw: '{"vehicle":{"annualMileage":12000}}' },
      auth: null,
    },
    after: {
      method: 'POST',
      url: '{{url}}/api/books',
      header: [],
      body: { mode: 'raw', raw: '{"obj4":{"vehicle":{"annualMileage":12000}}}' },
      auth: null,
    },
    fields: ['body'],
  });

  assert.match(markdown, /### POST \{\{url\}\}\/api\/books - Create books/);
  assert.match(markdown, /Moved `\$\.vehicle` -> `\$\.obj4\.vehicle`/);
  assert.doesNotMatch(markdown, /```diff/);
});

test('renders authentication types and configuration names without secret values', () => {
  const markdown = renderModifiedRequest({
    key: 'Auth / Token',
    before: {
      method: 'GET',
      url: 'https://api.example.test/token',
      header: [],
      body: null,
      auth: { type: 'bearer', bearer: [{ key: 'token', value: 'before-secret' }] },
    },
    after: {
      method: 'GET',
      url: 'https://api.example.test/token',
      header: [],
      body: null,
      auth: { type: 'apikey', apikey: [{ key: 'value', value: 'after-secret' }] },
    },
    fields: ['auth'],
  });

  assert.match(markdown, /Type: `bearer` -> `apikey`/);
  assert.match(markdown, /Configuration changed: `bearer\.token` -> `apikey\.value` \(values redacted\)/);
  assert.doesNotMatch(markdown, /before-secret|after-secret/);
});
