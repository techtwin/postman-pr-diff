'use strict';

const { canonicalRequest } = require('./collection');
const { changedRequestFields, countChanges } = require('./diff');

const MAX_INLINE_LENGTH = 320;
const MAX_BODY_LENGTH = 20_000;
const MAX_BODY_LINES = 240;
const MAX_DIFF_LINES = 140;
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
    current.push(isSensitiveName(key) ? '<redacted>' : value);
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

function jsonBody(body) {
  if (!body || body.mode !== 'raw' || typeof body.raw !== 'string') {
    return null;
  }

  try {
    return canonicalJson(JSON.parse(body.raw));
  } catch {
    return null;
  }
}

function lineDiff(before, after) {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  if (beforeLines.length > MAX_BODY_LINES || afterLines.length > MAX_BODY_LINES) {
    return null;
  }

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
    } else if (right < afterLines.length && (left === beforeLines.length || table[left][right + 1] >= table[left + 1][right])) {
      lines.push(`+ ${afterLines[right]}`);
      right += 1;
    } else {
      lines.push(`- ${beforeLines[left]}`);
      left += 1;
    }
  }
  return lines.length <= MAX_DIFF_LINES ? lines : null;
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

function renderBodyChanges(before, after) {
  const previousJson = jsonBody(before);
  const currentJson = jsonBody(after);
  if (previousJson !== null && currentJson !== null) {
    if (previousJson.length > MAX_BODY_LENGTH || currentJson.length > MAX_BODY_LENGTH) {
      return ['**Body**', '', '- JSON body changed but is too large to render safely.', ''];
    }
    const lines = lineDiff(previousJson, currentJson);
    if (lines) {
      return ['**Body (semantic JSON)**', '', fencedDiff(lines), ''];
    }
    return ['**Body**', '', '- JSON body changed but is too large to render safely.', ''];
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
  const lines = [
    `<details><summary>${inlineCode(entry.key)}: ${inlineCode(requestLabel(entry.before))} -> ${inlineCode(requestLabel(entry.after))}</summary>`,
    '',
    `Changed fields: ${fields.map(inlineCode).join(', ')}`,
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
    `<details><summary>Modified (${entries.length})</summary>`,
    '',
    ...entries.map(renderModifiedRequest),
    '',
    '</details>',
    '',
  ].join('\n');
}

function renderFile(result) {
  const title = `### \`${escapeMarkdown(result.path)}\``;
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
    `**${total} semantic request change${total === 1 ? '' : 's'}**`,
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
  safeUrl,
};
