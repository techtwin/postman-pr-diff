'use strict';

const { canonicalRequest, stableValue } = require('./collection');
const { changedRequestFields, countChanges } = require('./diff');

const MAX_INLINE_LENGTH = 320;
const MAX_JSON_CHANGES = 60;
const MAX_RAW_JSON_CHARACTERS = 12_000;
const MAX_RAW_DIFF_LINES = 180;
const SENSITIVE_NAME = /(?:authorization|cookie|token|secret|password|api[-_]?key|apikey|access[-_]?key|private[-_]?key|^key$)/i;
const URL_DISPLAY_MODES = new Set(['full', 'path-only', 'hidden']);

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
  const [location, query = ''] = withoutFragment.split('?', 2);
  const absolute = location.match(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)(\/.*)?$/i);
  const templated = location.match(/^\{\{[^}]+\}\}(\/.*)?$/);
  const path = absolute?.[2] || templated?.[1] || location || '/';
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

  return { location, path, queryEntries };
}

function safeUrl(url) {
  const parts = urlParts(url);
  const safeLocation = parts.location.replace(
    /^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i,
    '$1[redacted]@',
  );
  const query = parts.queryEntries
    .map(({ key, value }) => `${key}=${isSensitiveName(key) ? '[redacted]' : value}`)
    .join('&');
  return query ? `${safeLocation}?${query}` : safeLocation;
}

function normalizeUrlDisplay(value) {
  return URL_DISPLAY_MODES.has(value) ? value : 'path-only';
}

function displayUrl(url, mode) {
  switch (normalizeUrlDisplay(mode)) {
    case 'full':
      return safeUrl(url);
    case 'hidden':
      return '[URL hidden]';
    default:
      return urlParts(url).path;
  }
}

function requestLabel(request, urlDisplay) {
  return `${request.method} ${displayUrl(request.url, urlDisplay)}`;
}

function requestName(key) {
  return String(key).split(' / ').at(-1);
}

function requestLines(label, entries, urlDisplay) {
  if (entries.length === 0) {
    return '';
  }

  return [
    `<details><summary>${label} (${entries.length})</summary>`,
    '',
    ...entries.map((entry) => `- ${inlineCode(entry.key)}: ${inlineCode(requestLabel(entry.after || entry.before, urlDisplay))}`),
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

function renderUrlChanges(before, after, urlDisplay) {
  const mode = normalizeUrlDisplay(urlDisplay);
  if (mode === 'hidden') {
    return ['**URL**', '', '- URL changed; URL details are hidden by configuration.', ''];
  }

  const previous = urlParts(before);
  const current = urlParts(after);
  const lines = ['**URL**', ''];

  if (mode === 'full') {
    lines.push(`- Value: ${inlineCode(safeUrl(before))} -> ${inlineCode(safeUrl(after))}`);
  }

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
      lines.push(mode === 'full'
        ? `- Query added ${inlineCode(name)}: ${inlineCode(newValues.join(', '))}`
        : `- Query added ${inlineCode(name)}`);
    } else if (!newValues) {
      lines.push(mode === 'full'
        ? `- Query removed ${inlineCode(name)}: ${inlineCode(oldValues.join(', '))}`
        : `- Query removed ${inlineCode(name)}`);
    } else if (canonicalRequest(oldValues) !== canonicalRequest(newValues)) {
      lines.push(mode === 'full'
        ? `- Query changed ${inlineCode(name)}: ${inlineCode(oldValues.join(', '))} -> ${inlineCode(newValues.join(', '))}`
        : `- Query changed ${inlineCode(name)}`);
    }
  }

  return [...lines, ''];
}

function canonicalJson(value) {
  return JSON.stringify(stableValue(redactValue(value)), null, 2);
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
  return JSON.stringify(stableValue(redactValue(value)));
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

function lineDiff(before, after) {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const table = Array.from(
    { length: beforeLines.length + 1 },
    () => Array(afterLines.length + 1).fill(0),
  );

  for (let left = beforeLines.length - 1; left >= 0; left -= 1) {
    for (let right = afterLines.length - 1; right >= 0; right -= 1) {
      table[left][right] = beforeLines[left] === afterLines[right]
        ? table[left + 1][right + 1] + 1
        : Math.max(table[left + 1][right], table[left][right + 1]);
    }
  }

  const lines = [];
  let left = 0;
  let right = 0;
  while (left < beforeLines.length || right < afterLines.length) {
    if (left < beforeLines.length && right < afterLines.length && beforeLines[left] === afterLines[right]) {
      lines.push(`  ${beforeLines[left]}`);
      left += 1;
      right += 1;
    } else if (
      left < beforeLines.length &&
      (right === afterLines.length || table[left + 1][right] >= table[left][right + 1])
    ) {
      lines.push(`- ${beforeLines[left]}`);
      left += 1;
    } else {
      lines.push(`+ ${afterLines[right]}`);
      right += 1;
    }
  }
  return lines;
}

function fencedDiff(lines) {
  const source = lines.join('\n');
  const longestBacktickRun = Math.max(
    2,
    ...[...source.matchAll(/`+/g)].map((match) => match[0].length),
  );
  const fence = '`'.repeat(longestBacktickRun + 1);
  return `${fence}diff\n${source}\n${fence}`;
}

function renderRawJsonDiff(before, after) {
  const previous = canonicalJson(before);
  const current = canonicalJson(after);
  const totalCharacters = previous.length + current.length;

  if (totalCharacters > MAX_RAW_JSON_CHARACTERS) {
    return [
      '<details><summary>View exact body changes (raw JSON diff)</summary>',
      '',
      `Raw JSON diff omitted: ${totalCharacters.toLocaleString()} characters exceeds the ${MAX_RAW_JSON_CHARACTERS.toLocaleString()} character limit.`,
      '',
      '</details>',
      '',
    ];
  }

  const lines = lineDiff(previous, current);
  if (lines.length > MAX_RAW_DIFF_LINES) {
    return [
      '<details><summary>View exact body changes (raw JSON diff)</summary>',
      '',
      `Raw JSON diff omitted: ${lines.length} lines exceeds the ${MAX_RAW_DIFF_LINES} line limit. The structural summary above remains complete up to its own limit.`,
      '',
      '</details>',
      '',
    ];
  }

  return [
    '<details><summary>View exact body changes (raw JSON diff)</summary>',
    '',
    fencedDiff(lines),
    '',
    '</details>',
    '',
  ];
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
      ...renderRawJsonDiff(previousJson, currentJson),
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

function renderModifiedRequest(entry, urlDisplay) {
  const fields = entry.fields || changedRequestFields(entry.before, entry.after);
  const labels = {
    auth: 'Authentication',
    body: 'Request body',
    header: 'Headers',
    method: 'Method',
    url: 'URL',
  };
  const lines = [
    `### ${requestLabel(entry.after, urlDisplay)} - ${requestName(entry.key)}`,
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
    lines.push(...renderUrlChanges(entry.before.url, entry.after.url, urlDisplay));
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

function modifiedLines(entries, urlDisplay) {
  if (entries.length === 0) {
    return '';
  }

  return [
    `**Modified (${entries.length})**`,
    '',
    ...entries.map((entry) => renderModifiedRequest(entry, urlDisplay)),
    '',
  ].join('\n');
}

function renderFile(result, urlDisplay) {
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
    requestLines('Added', result.changes.added, urlDisplay),
    requestLines('Removed', result.changes.removed, urlDisplay),
    modifiedLines(result.changes.modified, urlDisplay),
  ].join('\n');
}

function truncate(markdown, limit = 60_000) {
  if (markdown.length <= limit) {
    return markdown;
  }

  return `${markdown.slice(0, limit - 78)}\n\n> Report truncated because it exceeded the comment size limit.\n`;
}

function renderReport(results, marker, urlDisplay = 'path-only') {
  const mode = normalizeUrlDisplay(urlDisplay);
  const body = [
    `<!-- ${marker} -->`,
    '## Postman collection diff',
    '',
    results.length === 0
      ? 'No changed Postman collection files matched the configured suffix.'
      : results.map((result) => renderFile(result, mode)).join('\n'),
  ].join('\n');

  return truncate(body);
}

module.exports = {
  escapeMarkdown,
  renderReport,
  renderModifiedRequest,
  findJsonChanges,
  normalizeUrlDisplay,
  safeUrl,
};
