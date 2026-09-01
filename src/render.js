'use strict';

const { canonicalRequest } = require('./collection');
const { changedRequestFields, compareEvents, countChanges } = require('./diff');
const { renderBodyChanges } = require('./body-renderer');
const { isSensitiveName } = require('./redaction');
const { escapeMarkdown, inlineCode } = require('./render-utils');
const { renderEventChanges } = require('./script-renderer');

const URL_DISPLAY_MODES = new Set(['full', 'path-only', 'hidden']);

function rawUrl(url) {
  if (typeof url === 'string') return url;
  if (url?.raw) return url.raw;
  if (!url || typeof url !== 'object') return '';

  const protocol = url.protocol ? `${url.protocol}://` : '';
  const host = Array.isArray(url.host) ? url.host.join('.') : (url.host || '');
  const path = Array.isArray(url.path) ? url.path.join('/') : (url.path || '');
  const query = Array.isArray(url.query)
    ? url.query.filter((entry) => entry?.disabled !== true).map((entry) => `${entry.key || ''}=${entry.value || ''}`).join('&')
    : '';
  return `${protocol}${host}${path ? `/${path}` : ''}${query ? `?${query}` : ''}`;
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
  const queryEntries = query.split('&').filter(Boolean).map((entry) => {
    const [key, value = ''] = entry.split('=', 2);
    return { key: decodeURIComponentSafely(key), value: decodeURIComponentSafely(value) };
  }).sort((left, right) => left.key.localeCompare(right.key) || left.value.localeCompare(right.value));
  return { location, path, queryEntries };
}

function safeUrl(url) {
  const parts = urlParts(url);
  const safeLocation = parts.location.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, '$1[redacted]@');
  const query = parts.queryEntries.map(({ key, value }) => `${key}=${isSensitiveName(key) ? '[redacted]' : value}`).join('&');
  return query ? `${safeLocation}?${query}` : safeLocation;
}

function normalizeUrlDisplay(value) {
  return URL_DISPLAY_MODES.has(value) ? value : 'path-only';
}

function displayUrl(url, mode) {
  if (normalizeUrlDisplay(mode) === 'full') return safeUrl(url);
  if (normalizeUrlDisplay(mode) === 'hidden') return '[URL hidden]';
  return urlParts(url).path;
}

function requestLabel(request, urlDisplay) {
  return `${request.method} ${displayUrl(request.url, urlDisplay)}`;
}

function requestName(key) {
  return String(key).split(' / ').at(-1);
}

function requestLines(label, entries, urlDisplay) {
  if (entries.length === 0) return '';
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
  return values.map((entry) => `${entry.displayValue}${entry.disabled ? ' (disabled)' : ''}`).join(', ');
}

function renderHeaderChanges(before, after) {
  const previous = headerMap(before);
  const current = headerMap(after);
  const lines = [];
  for (const name of [...new Set([...previous.keys(), ...current.keys()])].sort()) {
    const oldValue = previous.get(name);
    const newValue = current.get(name);
    if (!oldValue) lines.push(`- Added ${inlineCode(name)}: ${inlineCode(headerValue(newValue))}`);
    else if (!newValue) lines.push(`- Removed ${inlineCode(name)}: ${inlineCode(headerValue(oldValue))}`);
    else if (canonicalRequest(oldValue) !== canonicalRequest(newValue)) lines.push(`- Changed ${inlineCode(name)}: ${inlineCode(headerValue(oldValue))} -> ${inlineCode(headerValue(newValue))}`);
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
  if (mode === 'hidden') return ['**URL**', '', '- URL changed; URL details are hidden by configuration.', ''];

  const previous = urlParts(before);
  const current = urlParts(after);
  const lines = ['**URL**', ''];
  if (mode === 'full') lines.push(`- Value: ${inlineCode(safeUrl(before))} -> ${inlineCode(safeUrl(after))}`);
  if (previous.path !== current.path) lines.push(`- Path: ${inlineCode(previous.path)} -> ${inlineCode(current.path)}`);

  const oldQuery = queryMap(previous.queryEntries);
  const newQuery = queryMap(current.queryEntries);
  for (const name of [...new Set([...oldQuery.keys(), ...newQuery.keys()])].sort()) {
    const oldValues = oldQuery.get(name);
    const newValues = newQuery.get(name);
    if (!oldValues) lines.push(mode === 'full' ? `- Query added ${inlineCode(name)}: ${inlineCode(newValues.join(', '))}` : `- Query added ${inlineCode(name)}`);
    else if (!newValues) lines.push(mode === 'full' ? `- Query removed ${inlineCode(name)}: ${inlineCode(oldValues.join(', '))}` : `- Query removed ${inlineCode(name)}`);
    else if (canonicalRequest(oldValues) !== canonicalRequest(newValues)) lines.push(mode === 'full' ? `- Query changed ${inlineCode(name)}: ${inlineCode(oldValues.join(', '))} -> ${inlineCode(newValues.join(', '))}` : `- Query changed ${inlineCode(name)}`);
  }
  return [...lines, ''];
}

function renderModifiedRequest(entry, urlDisplay) {
  const fields = entry.fields || changedRequestFields(entry.before, entry.after);
  const labels = { auth: 'Authentication', body: 'Request body', events: 'Scripts', header: 'Headers', method: 'Method', url: 'URL' };
  const lines = [
    `### ${requestLabel(entry.after, urlDisplay)} - ${requestName(entry.key)}`,
    '',
    `Changed: ${fields.map((field) => labels[field]).join(', ')}`,
    '',
    '<details><summary>View changed fields</summary>',
    '',
  ];
  if (fields.includes('method')) lines.push('**Method**', '', `- ${inlineCode(entry.before.method)} -> ${inlineCode(entry.after.method)}`, '');
  if (fields.includes('url')) lines.push(...renderUrlChanges(entry.before.url, entry.after.url, urlDisplay));
  if (fields.includes('header')) lines.push(...renderHeaderChanges(entry.before.header, entry.after.header));
  if (fields.includes('body')) lines.push(...renderBodyChanges(entry.before.body, entry.after.body));
  if (fields.includes('auth')) lines.push(...renderAuthChanges(entry.before.auth, entry.after.auth));
  if (fields.includes('events')) lines.push(...renderEventChanges(compareEvents(entry.before.events, entry.after.events), 'Request scripts'));
  lines.push('</details>', '');
  return lines.join('\n');
}

function renderAuthChanges(before, after) {
  const config = (auth) => Object.entries(auth || {}).filter(([key]) => key !== 'type').flatMap(([key, value]) => Array.isArray(value) ? value.map((entry) => `${key}.${entry?.key || 'value'}`) : [key]).sort();
  const oldType = before?.type || 'none';
  const newType = after?.type || 'none';
  const oldConfig = config(before);
  const newConfig = config(after);
  const lines = ['**Authentication**', ''];
  if (oldType !== newType) lines.push(`- Type: ${inlineCode(oldType)} -> ${inlineCode(newType)}`);
  if (canonicalRequest(oldConfig) !== canonicalRequest(newConfig) || oldType === newType) lines.push(`- Configuration changed: ${inlineCode(oldConfig.join(', ') || 'none')} -> ${inlineCode(newConfig.join(', ') || 'none')} (values redacted)`);
  return [...lines, ''];
}

function renderFile(result, urlDisplay) {
  const title = `### ${inlineCode(result.path)}`;
  if (result.error) return `${title}\n\n> Unable to compare this file: ${escapeMarkdown(result.error)}\n`;
  const total = countChanges(result.changes);
  const collectionEvents = result.changes.collectionEvents || [];
  if (total === 0) return `${title}\n\nNo semantic request changes detected.\n`;
  return [
    title, '',
    `**${total} semantic change${total === 1 ? '' : 's'}** (${result.changes.added.length} added, ${result.changes.removed.length} removed, ${result.changes.modified.length} modified, ${collectionEvents.length} collection script change${collectionEvents.length === 1 ? '' : 's'})`,
    '',
    requestLines('Added', result.changes.added, urlDisplay),
    requestLines('Removed', result.changes.removed, urlDisplay),
    result.changes.modified.length ? ['**Modified (' + result.changes.modified.length + ')**', '', ...result.changes.modified.map((entry) => renderModifiedRequest(entry, urlDisplay)), ''].join('\n') : '',
    ...renderEventChanges(collectionEvents, 'Collection scripts'),
  ].join('\n');
}

function renderReport(results, marker, urlDisplay = 'path-only') {
  const body = [
    `<!-- ${marker} -->`,
    '## Postman collection diff',
    '',
    results.length === 0 ? 'No changed Postman collection files matched the configured suffix.' : results.map((result) => renderFile(result, normalizeUrlDisplay(urlDisplay))).join('\n'),
  ].join('\n');
  return body.length <= 60_000 ? body : `${body.slice(0, 59_922)}\n\n> Report truncated because it exceeded the comment size limit.\n`;
}

module.exports = { escapeMarkdown, normalizeUrlDisplay, renderModifiedRequest, renderReport, safeUrl };
