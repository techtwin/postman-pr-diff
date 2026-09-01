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
  assert.match(report, /### GET \/users\/\{\{id\}\} - Get user/);
  assert.match(report, /Changed: URL, Headers, Request body/);
  assert.match(report, /<details><summary>View changed fields<\/summary>/);
  assert.match(report, /Removed `\$\.vehicle\.annualMileage`: `12000`/);
  assert.match(report, /Added `\$\.vehicle\.estimatedAnnualMileage`: `12000`/);
  assert.match(report, /<details><summary>View exact body changes \(raw JSON diff\)<\/summary>/);
  assert.match(report, /```diff/);
  assert.match(report, /-\s+"annualMileage": 12000,/);
  assert.match(report, /\+\s+"estimatedAnnualMileage": 12000,/);
  assert.doesNotMatch(report, /GET https:\/\/api\.example\.test\/users\/\{\{id\}\}\?include=vehicles&view=summary` -> `GET https:\/\/api\.example\.test\/users\/\{\{id\}\}\?include=vehicles&view=summary/);
  assert.match(report, /Changed `accept`: `application\/json` -> `application\/vnd\.example\+json`/);
  assert.match(report, /Added `x-request-id`: `request-123`/);
  assert.match(report, /Query added `include`/);
  assert.match(report, /Query changed `view`/);
  assert.doesNotMatch(report, /api\.example\.test|include=vehicles|view=summary/);
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

  assert.match(markdown, /### POST \/api\/books - Create books/);
  assert.match(markdown, /Moved `\$\.vehicle` -> `\$\.obj4\.vehicle`/);
  assert.match(markdown, /<details><summary>View exact body changes \(raw JSON diff\)<\/summary>/);
  assert.match(markdown, /```diff/);
});

test('contextually truncates oversized raw JSON diffs while preserving structural changes', () => {
  const before = { mode: 'raw', raw: JSON.stringify({ description: 'before'.repeat(3_000) }) };
  const after = { mode: 'raw', raw: JSON.stringify({ description: 'after'.repeat(3_000) }) };
  const markdown = renderModifiedRequest({
    key: 'Books / Update books',
    before: { method: 'PUT', url: '/api/books', header: [], body: before, auth: null },
    after: { method: 'PUT', url: '/api/books', header: [], body: after, auth: null },
    fields: ['body'],
  });

  assert.match(markdown, /Updated `\$\.description`/);
  assert.match(markdown, /Raw JSON diff truncated: .* showing the first and last changed hunks/);
  assert.match(markdown, /```diff/);
  assert.match(markdown, /characters omitted/);
});

test('keeps first and last changed lines when a multiline JSON diff exceeds its line budget', () => {
  const beforeValue = Object.fromEntries(
    Array.from({ length: 500 }, (_, index) => [`field${index}`, `before-${index}`]),
  );
  const afterValue = Object.fromEntries(
    Array.from({ length: 500 }, (_, index) => [`field${index}`, `after-${index}`]),
  );
  const markdown = renderModifiedRequest({
    key: 'Books / Bulk update',
    before: { method: 'PUT', url: '/books', header: [], body: { mode: 'raw', raw: JSON.stringify(beforeValue) }, auth: null },
    after: { method: 'PUT', url: '/books', header: [], body: { mode: 'raw', raw: JSON.stringify(afterValue) }, auth: null },
    fields: ['body'],
  });

  assert.match(markdown, /Raw JSON diff truncated/);
  assert.match(markdown, /-\s+"field0": "before-0"/);
  assert.match(markdown, /\+\s+"field0": "after-0"/);
  assert.match(markdown, /-\s+"field99": "before-99"/);
  assert.match(markdown, /\+\s+"field99": "after-99"/);
  assert.match(markdown, /changed-region lines omitted|hunk lines omitted|diff lines omitted/);
});

test('does not duplicate one-sided additions in a bounded JSON preview', () => {
  const fields = Object.fromEntries(
    Array.from({ length: 500 }, (_, index) => [`field${index}`, `value-${index}`]),
  );
  const markdown = renderModifiedRequest({
    key: 'Books / Add field',
    before: { method: 'PUT', url: '/books', header: [], body: { mode: 'raw', raw: JSON.stringify(fields) }, auth: null },
    after: { method: 'PUT', url: '/books', header: [], body: { mode: 'raw', raw: JSON.stringify({ aaa: 'new', ...fields }) }, auth: null },
    fields: ['body'],
  });
  const added = markdown.match(/\+\s+"aaa": "new",/g) || [];

  assert.equal(added.length, 1);
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

test('uses explicit full and hidden URL display modes only when configured', () => {
  const result = [{
    path: 'collections/example.postman_collection.json',
    changes: {
      added: [{
        key: 'Books / List books',
        after: { method: 'GET', url: 'https://internal.example.test/api/books?region=us-east-1' },
      }],
      removed: [],
      modified: [],
      unchanged: [],
    },
  }];

  const full = renderReport(result, 'postman-pr-diff:test', 'full');
  const hidden = renderReport(result, 'postman-pr-diff:test', 'hidden');

  assert.match(full, /https:\/\/internal\.example\.test\/api\/books\?region=us-east-1/);
  assert.match(hidden, /GET \[URL hidden\]/);
  assert.doesNotMatch(hidden, /internal\.example\.test|us-east-1/);
});

test('renders supported Postman body formats and scripts without leaking private content', async () => {
  const base = parseCollection(await fixture('multiformat-base.postman_collection.json'), 'base');
  const head = parseCollection(await fixture('multiformat-head.postman_collection.json'), 'head');
  const changes = compareCollections(base, head);
  const report = renderReport([{ path: 'formats.postman_collection.json', changes }], 'postman-pr-diff:test');

  assert.equal(changes.modified.length, 6);
  assert.match(report, /Request body \(XML\)/);
  assert.match(report, /Updated `\$\.book\["\@id"\]`/);
  assert.match(report, /Request body \(URL-encoded\)/);
  assert.match(report, /Changed `enabled`: `old` -> `new`/);
  assert.doesNotMatch(report, /ignored/);
  assert.match(report, /Request body \(form-data\)/);
  assert.match(report, /file: before\.jpg/);
  assert.doesNotMatch(report, /\/private\//);
  assert.match(report, /Request body \(GraphQL\)/);
  assert.match(report, /GraphQL query/);
  assert.match(report, /Request body \(javascript\)/);
  assert.match(report, /Request body \(file\/binary\)/);
  assert.match(report, /Collection scripts/);
  assert.match(report, /Request scripts/);
  assert.doesNotMatch(report, /before-secret|after-secret/);
});

test('reports malformed and oversized XML safely without parsing external entities', () => {
  const malformed = renderModifiedRequest({
    key: 'XML / Malformed',
    before: { method: 'POST', url: '/xml', header: [], body: { mode: 'raw', raw: '<book>', options: { raw: { language: 'xml' } } }, auth: null, events: [] },
    after: { method: 'POST', url: '/xml', header: [], body: { mode: 'raw', raw: '<book><x /></book>', options: { raw: { language: 'xml' } } }, auth: null, events: [] },
    fields: ['body'],
  });
  const dtd = renderModifiedRequest({
    key: 'XML / DTD',
    before: { method: 'POST', url: '/xml', header: [], body: { mode: 'raw', raw: '<!DOCTYPE x><x />', options: { raw: { language: 'xml' } } }, auth: null, events: [] },
    after: { method: 'POST', url: '/xml', header: [], body: { mode: 'raw', raw: '<x />', options: { raw: { language: 'xml' } } }, auth: null, events: [] },
    fields: ['body'],
  });

  assert.match(malformed, /Structural XML diff unavailable/);
  assert.match(dtd, /prohibited DTD or entity declaration/);
  assert.doesNotMatch(dtd, /<!DOCTYPE/);
});

test('applies XML depth and size limits and renders HTML as bounded raw text', () => {
  const deeplyNested = `${'<node>'.repeat(41)}${'</node>'.repeat(41)}`;
  const deep = renderModifiedRequest({
    key: 'XML / Deep',
    before: { method: 'POST', url: '/xml', header: [], body: { mode: 'raw', raw: deeplyNested, options: { raw: { language: 'xml' } } }, auth: null, events: [] },
    after: { method: 'POST', url: '/xml', header: [], body: { mode: 'raw', raw: '<node />', options: { raw: { language: 'xml' } } }, auth: null, events: [] },
    fields: ['body'],
  });
  const oversized = renderModifiedRequest({
    key: 'XML / Large',
    before: { method: 'POST', url: '/xml', header: [], body: { mode: 'raw', raw: `<node>${'x'.repeat(100_001)}</node>`, options: { raw: { language: 'xml' } } }, auth: null, events: [] },
    after: { method: 'POST', url: '/xml', header: [], body: { mode: 'raw', raw: '<node />', options: { raw: { language: 'xml' } } }, auth: null, events: [] },
    fields: ['body'],
  });
  const html = renderModifiedRequest({
    key: 'Raw / HTML',
    before: { method: 'POST', url: '/html', header: [], body: { mode: 'raw', raw: '<p>old</p>', options: { raw: { language: 'html' } } }, auth: null, events: [] },
    after: { method: 'POST', url: '/html', header: [], body: { mode: 'raw', raw: '<p>new</p>', options: { raw: { language: 'html' } } }, auth: null, events: [] },
    fields: ['body'],
  });

  assert.match(deep, /depth or 5,000 node limit/);
  assert.match(oversized, /100,000 character limit/);
  assert.match(html, /Request body \(html\)/);
  assert.match(html, /```diff/);
});
