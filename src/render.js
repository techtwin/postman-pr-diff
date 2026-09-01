'use strict';

const { canonicalRequest } = require('./collection');
const { stableValue } = require('./stable');
const { changedRequestFields, compareEvents, countChanges } = require('./diff');
const { parseXml } = require('./formats');

const MAX_INLINE_LENGTH = 320;
const MAX_JSON_CHANGES = 60;
const MAX_RAW_JSON_CHARACTERS = 12_000;
const MAX_RAW_DIFF_LINES = 180;
const MAX_RAW_TEXT_CHARACTERS = 8_000;
const MAX_SCRIPT_LINES = 100;
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

function redactText(value) {
  return String(value)
    .replace(
      /((?:authorization|cookie|token|secret|password|api[-_]?key|access[-_]?key)\s*[:=]\s*)([^\s,;&]+)/gi,
      '$1[redacted]',
    )
    .replace(/(Bearer\s+)[^\s,;&]+/gi, '$1[redacted]')
    .replace(
      /((?:pm\.)?[\w.]+\.set\(\s*['"](?:authorization|cookie|token|secret|password|api[-_]?key|access[-_]?key)['"]\s*,\s*['"])[^'"]+/gi,
      '$1[redacted]',
    );
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

function renderBoundedTextDiff(before, after, label, limit = MAX_RAW_TEXT_CHARACTERS) {
  const previous = redactText(before);
  const current = redactText(after);
  if (previous.length + current.length > limit) {
    return [
      `**${label}**`,
      '',
      `- Exact diff omitted: content exceeds the ${limit.toLocaleString()} character limit.`,
      '',
    ];
  }
  const lines = lineDiff(previous, current);
  if (lines.length > MAX_RAW_DIFF_LINES) {
    return [
      `**${label}**`,
      '',
      `- Exact diff omitted: ${lines.length} lines exceeds the ${MAX_RAW_DIFF_LINES} line limit.`,
      '',
    ];
  }
  return [
    `**${label}**`,
    '',
    '<details><summary>View exact changes</summary>',
    '',
    fencedDiff(lines),
    '',
    '</details>',
    '',
  ];
}

function fieldMap(fields) {
  return new Map((fields || []).map((field) => [field.key, field]));
}

function renderFields(before, after, label, fileOnly = false) {
  const previous = fieldMap(before);
  const current = fieldMap(after);
  const keys = [...new Set([...previous.keys(), ...current.keys()])].sort();
  const lines = [`**${label}**`, ''];
  for (const key of keys) {
    const oldValue = previous.get(key);
    const newValue = current.get(key);
    const format = (field) => {
      if (!field) return '';
      if (fileOnly || field.type === 'file') {
        return field.file ? `file: ${field.file}` : 'file metadata';
      }
      return isSensitiveName(key) ? '[redacted]' : field.value;
    };
    if (!oldValue) lines.push(`- Added ${inlineCode(key)}: ${inlineCode(format(newValue))}`);
    else if (!newValue) lines.push(`- Removed ${inlineCode(key)}: ${inlineCode(format(oldValue))}`);
    else if (canonicalRequest(oldValue) !== canonicalRequest(newValue)) {
      lines.push(`- Changed ${inlineCode(key)}: ${inlineCode(format(oldValue))} -> ${inlineCode(format(newValue))}`);
    }
  }
  return lines.length === 2 ? [] : [...lines, ''];
}

function renderXmlChanges(before, after) {
  try {
    const changes = compactMovedJsonValues(findJsonChanges(parseXml(before), parseXml(after)));
    const visible = changes.slice(0, MAX_JSON_CHANGES);
    return [
      `**Request body (XML)** (${changes.length} structural change${changes.length === 1 ? '' : 's'})`,
      '',
      ...visible.map(renderJsonChange),
      ...(changes.length > visible.length ? [`- ${changes.length - visible.length} additional XML changes omitted.`] : []),
      '',
    ];
  } catch (error) {
    return ['**Request body (XML)**', '', `- Structural XML diff unavailable: ${escapeMarkdown(error.message)}. Raw content is not rendered.`, ''];
  }
}

function renderGraphqlChanges(before, after) {
  const previous = before?.graphql || {};
  const current = after?.graphql || {};
  const lines = ['**Request body (GraphQL)**', ''];
  if (previous.query !== current.query) lines.push('- Query changed (see bounded exact diff below).');
  if (canonicalJson(previous.variables) !== canonicalJson(current.variables)) {
    lines.push(`- Variables: ${inlineCode(canonicalJson(previous.variables))} -> ${inlineCode(canonicalJson(current.variables))}`);
  }
  return [...lines, '', ...renderBoundedTextDiff(previous.query || '', current.query || '', 'GraphQL query')];
}

function renderFileBodyChanges(before, after) {
  const name = (body) => body?.file?.name || 'no file';
  return [
    '**Request body (file/binary)**',
    '',
    `- File metadata: ${inlineCode(name(before))} -> ${inlineCode(name(after))}; file content is never read or rendered.`,
    '',
  ];
}

function renderEventChanges(events, label) {
  if (!events?.length) return [];
  const lines = [`**${label}**`, ''];
  for (const event of events) {
    const name = event.after?.listen || event.before?.listen || event.key;
    const before = event.before?.exec?.join('\n') || '';
    const after = event.after?.exec?.join('\n') || '';
    const previous = redactText(before);
    const current = redactText(after);
    lines.push(
      `- ${event.before && event.after ? 'Changed' : event.after ? 'Added' : 'Removed'} ${inlineCode(name)} script.`,
      '<details><summary>View redacted script diff</summary>',
      '',
    );
    if (previous.length + current.length > MAX_SCRIPT_LINES * MAX_INLINE_LENGTH) {
      lines.push(`Script diff omitted: content exceeds the ${MAX_SCRIPT_LINES * MAX_INLINE_LENGTH} character limit.`);
    } else {
      const diff = lineDiff(previous, current);
      lines.push(
        ...(diff.length > MAX_SCRIPT_LINES
          ? [`Script diff omitted: ${diff.length} lines exceeds the ${MAX_SCRIPT_LINES} line limit.`]
          : [fencedDiff(diff)]),
      );
    }
    lines.push('', '</details>', '');
  }
  return lines;
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

  const mode = after?.mode || before?.mode || 'none';
  if (mode === 'urlencoded') return renderFields(before?.urlencoded, after?.urlencoded, 'Request body (URL-encoded)');
  if (mode === 'formdata') return renderFields(before?.formdata, after?.formdata, 'Request body (form-data)');
  if (mode === 'graphql') return renderGraphqlChanges(before, after);
  if (mode === 'file' || mode === 'binary') return renderFileBodyChanges(before, after);
  if (
    mode === 'raw' &&
    (before?.options?.raw?.language === 'xml' || after?.options?.raw?.language === 'xml')
  ) {
    return renderXmlChanges(before?.raw || '', after?.raw || '');
  }
  if ((before && before.mode === 'raw') || (after && after.mode === 'raw')) {
    return renderBoundedTextDiff(before?.raw || '', after?.raw || '', `Request body (${after?.options?.raw?.language || before?.options?.raw?.language || 'raw text'})`);
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
    events: 'Scripts',
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
  if (fields.includes('events')) {
    lines.push(...renderEventChanges(compareEvents(entry.before.events, entry.after.events), 'Request scripts'));
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
    ...renderEventChanges(result.changes.collectionEvents, 'Collection scripts'),
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
  redactText,
  findJsonChanges,
  normalizeUrlDisplay,
  safeUrl,
};
