'use strict';

const { canonicalRequest } = require('./collection');
const { changedRequestFields, countChanges } = require('./diff');

const MAX_INLINE_LENGTH = 320;
const MAX_JSON_CHANGES = 60;
const SENSITIVE_NAME = /(?:authorization|cookie|token|secret|password|api[-_]?key|apikey|access[-_]?key|private[-_]?key|^key$)/i;

function escapeMarkdown(value) {
  return String(value).replace(/([\\`*_[\]{}()#+\-.!|<>])/g, '\\$1');
}

function truncateText(value, limit = MAX_INLINE_LENGTH) {
  const text = String(value).replace(/[\r\n\t]+/g, ' ');
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

function inlineCode(value) {
  const text = truncateText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`/g, '\\`');
  return `\`${text}\``;
}

function isSensitiveName(name) {
  return SENSITIVE_NAME.test(String(name));
}

function redactValue(value, name = '') {
  if (isSensitiveName(name)) {
    return '[redacted]';
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactValue(entry, key)]),
    );
  }
  return value;
}

function rawUrl(url) {
  if (typeof url === 'string') {
    return url;
  }
  if (url && typeof url === 'object' && typeof url.raw === 'string') {
    return url.raw;
  }
  if (url && typeof url === 'object') {
    const protocol = url.protocol ? `${url.protocol}://` : '';
    const host = Array.isArray(url.host) ? url.host.join('.') : (url.host || '');
    const path = Array.isArray(url.path) ? url.path.join('/') : (url.path || '');
    const query = Array.isArray(url.query)
      ? url.query
        .filter((entry) => entry && entry.disabled !== true)
        .map((entry) => `${entry.key || ''}=${entry.value || ''}`)
        .join('&')
      : '';
    return `${protocol}${host}${path ? `/${path}` : ''}${query ? `?${query}` : ''}`;
  }
  return '';
}

function decodeURIComponentSafely(value) {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

function urlParts(url) {
  const raw = rawUrl(url);
  const [withoutFragment] = raw.split('#', 1);
  const [path, query = ''] = withoutFragment.split('?', 2);
  const queryEntries = query
    .split('&')
    .filter(Boolean)
    .map((entry) => {
      const [key, value = ''] = entry.split('=', 2);
      return {
        key: decodeURIComponentSafely(key),
        value: decodeURIComponentSafely(value),
      };
    })
    .sort((left, right) => {
      const keyOrder = left.key.localeCompare(right.key);
      return keyOrder || left.value.localeCompare(right.value);
    });

  return { path, queryEntries };
}

function safeUrl(url) {
  const parts = urlParts(url);
  const safePath = parts.path.replace(
    /^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i,
    '$1[redacted]@',
  );
  const query = parts.queryEntries
    .map(({ key, value }) => `${key}=${isSensitiveName(key) ? '[redacted]' : value}`)
    .join('&');
  return query ? `${safePath}?${query}` : safePath;
}

function requestLabel(request) {
  return `${request.method} ${safeUrl(request.url)}`;
}

function requestName(key) {
  return String(key).split(' / ').at(-1);
}

function requestLines(label, entries) {
  if (entries.length === 0) {
    return '';
  }

  return [
    `<details><summary>${label} (${entries.length})</summary>`,
    '',
    ...entries.map((entry) => `- ${inlineCode(entry.key)}: ${inlineCode(requestLabel(entry.after || entry.before))}`),
    '',
    '</details>',
    '',
  ].join('\n');
}

function headerMap(headers) {
  const values = new Map();
  for (const header of headers || []) {
    const key = header.key || '<unnamed>';
    const entries = values.get(key) || [];
    entries.push({
      disabled: Boolean(header.disabled),
      displayValue: isSensitiveName(key) ? '[redacted]' : header.value,
      value: header.value,
    });
    values.set(key, entries);
  }
  return values;
}

function headerValue(values) {
  return values
    .map((entry) => `${entry.displayValue}${entry.disabled ? ' (disabled)' : ''}`)
    .join(', ');
}

function renderHeaderChanges(before, after) {
  const beforeHeaders = headerMap(before);
  const afterHeaders = headerMap(after);
  const names = [...new Set([...beforeHeaders.keys(), ...afterHeaders.keys()])]
    .sort((left, right) => left.localeCompare(right));
  const lines = [];

  for (const name of names) {
    const previous = beforeHeaders.get(name);
    const current = afterHeaders.get(name);
    if (!previous) {
      lines.push(`- Added ${inlineCode(name)}: ${inlineCode(headerValue(current))}`);
    } else if (!current) {
      lines.push(`- Removed ${inlineCode(name)}: ${inlineCode(headerValue(previous))}`);
    } else if (canonicalRequest(previous) !== canonicalRequest(current)) {
      lines.push(`- Changed ${inlineCode(name)}: ${inlineCode(headerValue(previous))} -> ${inlineCode(headerValue(current))}`);
    }
  }

  return lines.length ? ['**Headers**', '', ...lines, ''] : [];
}

function queryMap(entries) {
  const values = new Map();
  for (const { key, value } of entries) {
    const current = values.get(key) || [];
    current.push(isSensitiveName(key) ? '[redacted]' : value);
    values.set(key, current.sort((left, right) => left.localeCompare(right)));
  }
  return values;
}

function renderUrlChanges(before, after) {
  const previous = urlParts(before);
  const current = urlParts(after);
  const lines = [
    '**URL**',
    '',
    `- Value: ${inlineCode(safeUrl(before))} -> ${inlineCode(safeUrl(after))}`,
  ];

  if (previous.path !== current.path) {
    lines.push(`- Path: ${inlineCode(previous.path)} -> ${inlineCode(current.path)}`);
  }

  const previousQuery = queryMap(previous.queryEntries);
  const currentQuery = queryMap(current.queryEntries);
  const names = [...new Set([...previousQuery.keys(), ...currentQuery.keys()])]
    .sort((left, right) => left.localeCompare(right));
  for (const name of names) {
    const oldValues = previousQuery.get(name);
    const newValues = currentQuery.get(name);
    if (!oldValues) {
      lines.push(`- Query added ${inlineCode(name)}: ${inlineCode(newValues.join(', '))}`);
    } else if (!newValues) {
      lines.push(`- Query removed ${inlineCode(name)}: ${inlineCode(oldValues.join(', '))}`);
    } else if (canonicalRequest(oldValues) !== canonicalRequest(newValues)) {
      lines.push(`- Query changed ${inlineCode(name)}: ${inlineCode(oldValues.join(', '))} -> ${inlineCode(newValues.join(', '))}`);
    }
  }

  return [...lines, ''];
}

function canonicalJson(value) {
  return JSON.stringify(redactValue(value), null, 2);
}

function jsonBodyValue(body) {
  if (!body || body.mode !== 'raw' || typeof body.raw !== 'string') {
    return null;
  }

  try {
    return JSON.parse(body.raw);
  } catch {
    return null;
  }
}

function jsonPath(path, key) {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
    return `${path}.${key}`;
  }
  return `${path}[${JSON.stringify(key)}]`;
}

function stableJson(value) {
  return JSON.stringify(redactValue(value));
}

function jsonValue(value) {
  return truncateText(canonicalJson(value));
}

function findJsonChanges(before, after, path = '$', changes = []) {
  if (stableJson(before) === stableJson(after)) {
    return changes;
  }

  if (Array.isArray(before) || Array.isArray(after)) {
    changes.push({
      type: 'array-replaced',
      path,
      beforeLength: Array.isArray(before) ? before.length : null,
      afterLength: Array.isArray(after) ? after.length : null,
    });
    return changes;
  }

  const beforeObject = before && typeof before === 'object';
  const afterObject = after && typeof after === 'object';
  if (!beforeObject || !afterObject) {
    changes.push({ type: 'updated', path, before, after });
    return changes;
  }

  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort((left, right) => left.localeCompare(right));
  for (const key of keys) {
    const childPath = jsonPath(path, key);
    if (!(key in before)) {
      changes.push({ type: 'added', path: childPath, value: after[key] });
    } else if (!(key in after)) {
      changes.push({ type: 'removed', path: childPath, value: before[key] });
    } else {
      findJsonChanges(before[key], after[key], childPath, changes);
    }
  }
  return changes;
}

function compactMovedJsonValues(changes) {
  const additions = changes.filter((change) => change.type === 'added');
  const consumed = new Set();

  function singleChildWrapperPath(value, target, path) {
    let current = value;
    let currentPath = path;
    while (current && typeof current === 'object' && !Array.isArray(current)) {
      const keys = Object.keys(current);
      if (keys.length !== 1) {
        return null;
      }
      currentPath = jsonPath(currentPath, keys[0]);
      current = current[keys[0]];
      if (stableJson(current) === stableJson(target)) {
        return currentPath;
      }
    }
    return null;
  }

  return changes.flatMap((change) => {
    if (change.type !== 'removed') {
      return consumed.has(change) ? [] : [change];
    }
    const addition = additions.find(
      (candidate) =>
        !consumed.has(candidate) &&
        singleChildWrapperPath(candidate.value, change.value, candidate.path),
    );
    if (!addition) {
      return [change];
    }
    consumed.add(addition);
    return [{
      type: 'moved',
      from: change.path,
      path: singleChildWrapperPath(addition.value, change.value, addition.path),
      value: change.value,
    }];
  }).filter((change) => !consumed.has(change));
}

function renderJsonChange(change) {
  switch (change.type) {
    case 'added':
      return `- Added ${inlineCode(change.path)}: ${inlineCode(jsonValue(change.value))}`;
    case 'removed':
      return `- Removed ${inlineCode(change.path)}: ${inlineCode(jsonValue(change.value))}`;
    case 'updated':
      return `- Updated ${inlineCode(change.path)}: ${inlineCode(jsonValue(change.before))} -> ${inlineCode(jsonValue(change.after))}`;
    case 'moved':
      return `- Moved ${inlineCode(change.from)} -> ${inlineCode(change.path)}: ${inlineCode(jsonValue(change.value))}`;
    case 'array-replaced':
      return `- Replaced array ${inlineCode(change.path)} (${change.beforeLength ?? 'non-array'} items -> ${change.afterLength ?? 'non-array'} items)`;
    default:
      return '';
  }
}

function renderBodyChanges(before, after) {
  const previousJson = jsonBodyValue(before);
  const currentJson = jsonBodyValue(after);
  if (previousJson !== null && currentJson !== null) {
    const changes = compactMovedJsonValues(findJsonChanges(previousJson, currentJson));
    const visible = changes.slice(0, MAX_JSON_CHANGES);
    const omitted = changes.length - visible.length;
    return [
      `**Request body** (${changes.length} structural change${changes.length === 1 ? '' : 's'})`,
      '',
      ...visible.map(renderJsonChange),
      ...(omitted ? [`- ${omitted} additional structural change${omitted === 1 ? '' : 's'} omitted.`] : []),
      '',
    ];
  }

  if ((before && before.mode === 'raw') || (after && after.mode === 'raw')) {
    return ['**Body**', '', '- Raw non-JSON body changed; content is omitted to avoid exposing sensitive data.', ''];
  }

  return [
    '**Body**',
    '',
    `- Request body configuration changed: ${inlineCode(before?.mode || 'none')} -> ${inlineCode(after?.mode || 'none')}; content is omitted to avoid exposing sensitive data.`,
    '',
  ];
}

function authConfiguration(auth) {
  if (!auth || typeof auth !== 'object') {
    return [];
  }

  return Object.entries(auth)
    .filter(([key]) => key !== 'type')
    .flatMap(([key, value]) => {
      if (Array.isArray(value)) {
        return value.map((entry) => `${key}.${entry?.key || 'value'}`);
      }
      return [key];
    })
    .sort((left, right) => left.localeCompare(right));
}

function renderAuthChanges(before, after) {
  const previousType = before?.type || 'none';
  const currentType = after?.type || 'none';
  const previousConfig = authConfiguration(before);
  const currentConfig = authConfiguration(after);
  const lines = ['**Authentication**', ''];

  if (previousType !== currentType) {
    lines.push(`- Type: ${inlineCode(previousType)} -> ${inlineCode(currentType)}`);
  }
  if (canonicalRequest(previousConfig) !== canonicalRequest(currentConfig) || previousType === currentType) {
    lines.push(`- Configuration changed: ${inlineCode(previousConfig.join(', ') || 'none')} -> ${inlineCode(currentConfig.join(', ') || 'none')} (values redacted)`);
  }
  return [...lines, ''];
}

function renderModifiedRequest(entry) {
  const fields = entry.fields || changedRequestFields(entry.before, entry.after);
  const labels = {
    auth: 'Authentication',
    body: 'Request body',
    header: 'Headers',
    method: 'Method',
    url: 'URL',
  };
  const lines = [
    `### ${requestLabel(entry.after)} - ${requestName(entry.key)}`,
    '',
    `Changed: ${fields.map((field) => labels[field]).join(', ')}`,
    '',
    '<details><summary>View changed fields</summary>',
    '',
  ];

  if (fields.includes('method')) {
    lines.push('**Method**', '', `- ${inlineCode(entry.before.method)} -> ${inlineCode(entry.after.method)}`, '');
  }
  if (fields.includes('url')) {
    lines.push(...renderUrlChanges(entry.before.url, entry.after.url));
  }
  if (fields.includes('header')) {
    lines.push(...renderHeaderChanges(entry.before.header, entry.after.header));
  }
  if (fields.includes('body')) {
    lines.push(...renderBodyChanges(entry.before.body, entry.after.body));
  }
  if (fields.includes('auth')) {
    lines.push(...renderAuthChanges(entry.before.auth, entry.after.auth));
  }

  lines.push('</details>', '');
  return lines.join('\n');
}

function modifiedLines(entries) {
  if (entries.length === 0) {
    return '';
  }

  return [
    `**Modified (${entries.length})**`,
    '',
    ...entries.map(renderModifiedRequest),
    '',
  ].join('\n');
}

function renderFile(result) {
  const title = `### ${inlineCode(result.path)}`;
  if (result.error) {
    return `${title}\n\n> Unable to compare this file: ${escapeMarkdown(result.error)}\n`;
  }

  const total = countChanges(result.changes);
  if (total === 0) {
    return `${title}\n\nNo semantic request changes detected.\n`;
  }

  return [
    title,
    '',
    `**${total} semantic request change${total === 1 ? '' : 's'}** (${result.changes.added.length} added, ${result.changes.removed.length} removed, ${result.changes.modified.length} modified)`,
    '',
    requestLines('Added', result.changes.added),
    requestLines('Removed', result.changes.removed),
    modifiedLines(result.changes.modified),
  ].join('\n');
}

function truncate(markdown, limit = 60_000) {
  if (markdown.length <= limit) {
    return markdown;
  }

  return `${markdown.slice(0, limit - 78)}\n\n> Report truncated because it exceeded the comment size limit.\n`;
}

function renderReport(results, marker) {
  const body = [
    `<!-- ${marker} -->`,
    '## Postman collection diff',
    '',
    results.length === 0
      ? 'No changed Postman collection files matched the configured suffix.'
      : results.map(renderFile).join('\n'),
  ].join('\n');

  return truncate(body);
}

module.exports = {
  escapeMarkdown,
  renderReport,
  renderModifiedRequest,
  findJsonChanges,
  safeUrl,
};
