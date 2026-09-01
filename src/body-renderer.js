'use strict';

const { parseXml } = require('./formats');
const { canonicalRequest } = require('./collection');
const { stableValue } = require('./stable');
const { isSensitiveName, redactValue } = require('./redaction');
const {
  escapeMarkdown,
  fencedDiff,
  inlineCode,
  lineDiff,
  renderBoundedTextDiff,
  truncateText,
} = require('./render-utils');

const MAX_JSON_CHANGES = 60;
const MAX_RAW_JSON_CHARACTERS = 12_000;
const MAX_RAW_DIFF_LINES = 180;

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
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

function stableJson(value) {
  return JSON.stringify(stableValue(redactValue(value)));
}

function jsonValue(value) {
  return truncateText(canonicalJson(value));
}

function findJsonChanges(before, after, path = '$', changes = []) {
  if (stableJson(before) === stableJson(after)) return changes;
  if (Array.isArray(before) || Array.isArray(after)) {
    changes.push({
      type: 'array-replaced',
      path,
      beforeLength: Array.isArray(before) ? before.length : null,
      afterLength: Array.isArray(after) ? after.length : null,
    });
    return changes;
  }
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') {
    changes.push({ type: 'updated', path, before, after });
    return changes;
  }
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const childPath = jsonPath(path, key);
    if (!(key in before)) changes.push({ type: 'added', path: childPath, value: after[key] });
    else if (!(key in after)) changes.push({ type: 'removed', path: childPath, value: before[key] });
    else findJsonChanges(before[key], after[key], childPath, changes);
  }
  return changes;
}

function compactMovedJsonValues(changes) {
  const additions = changes.filter((change) => change.type === 'added');
  const consumed = new Set();
  const wrappedPath = (value, target, path) => {
    let current = value;
    let currentPath = path;
    while (current && typeof current === 'object' && !Array.isArray(current)) {
      const keys = Object.keys(current);
      if (keys.length !== 1) return null;
      currentPath = jsonPath(currentPath, keys[0]);
      current = current[keys[0]];
      if (stableJson(current) === stableJson(target)) return currentPath;
    }
    return null;
  };

  return changes.flatMap((change) => {
    if (change.type !== 'removed') return consumed.has(change) ? [] : [change];
    const addition = additions.find(
      (candidate) => !consumed.has(candidate) && wrappedPath(candidate.value, change.value, candidate.path),
    );
    if (!addition) return [change];
    consumed.add(addition);
    return [{ type: 'moved', from: change.path, path: wrappedPath(addition.value, change.value, addition.path), value: change.value }];
  }).filter((change) => !consumed.has(change));
}

function renderJsonChange(change) {
  if (change.type === 'added') return `- Added ${inlineCode(change.path)}: ${inlineCode(jsonValue(change.value))}`;
  if (change.type === 'removed') return `- Removed ${inlineCode(change.path)}: ${inlineCode(jsonValue(change.value))}`;
  if (change.type === 'updated') return `- Updated ${inlineCode(change.path)}: ${inlineCode(jsonValue(change.before))} -> ${inlineCode(jsonValue(change.after))}`;
  if (change.type === 'moved') return `- Moved ${inlineCode(change.from)} -> ${inlineCode(change.path)}: ${inlineCode(jsonValue(change.value))}`;
  return `- Replaced array ${inlineCode(change.path)} (${change.beforeLength ?? 'non-array'} items -> ${change.afterLength ?? 'non-array'} items)`;
}

function renderRawJsonDiff(before, after) {
  const previous = canonicalJson(before);
  const current = canonicalJson(after);
  const totalCharacters = previous.length + current.length;
  if (totalCharacters > MAX_RAW_JSON_CHARACTERS) {
    return ['<details><summary>View exact body changes (raw JSON diff)</summary>', '', `Raw JSON diff omitted: ${totalCharacters.toLocaleString()} characters exceeds the ${MAX_RAW_JSON_CHARACTERS.toLocaleString()} character limit.`, '', '</details>', ''];
  }
  const lines = lineDiff(previous, current);
  if (lines.length > MAX_RAW_DIFF_LINES) {
    return ['<details><summary>View exact body changes (raw JSON diff)</summary>', '', `Raw JSON diff omitted: ${lines.length} lines exceeds the ${MAX_RAW_DIFF_LINES} line limit. The structural summary above remains complete up to its own limit.`, '', '</details>', ''];
  }
  return ['<details><summary>View exact body changes (raw JSON diff)</summary>', '', fencedDiff(lines), '', '</details>', ''];
}

function fieldMap(fields) {
  return new Map((fields || []).map((field) => [field.key, field]));
}

function renderFields(before, after, label) {
  const previous = fieldMap(before);
  const current = fieldMap(after);
  const lines = [`**${label}**`, ''];
  for (const key of [...new Set([...previous.keys(), ...current.keys()])].sort()) {
    const oldValue = previous.get(key);
    const newValue = current.get(key);
    const value = (field) => field?.type === 'file'
      ? (field.file ? `file: ${field.file}` : 'file metadata')
      : (isSensitiveName(key) ? '[redacted]' : field?.value);
    if (!oldValue) lines.push(`- Added ${inlineCode(key)}: ${inlineCode(value(newValue))}`);
    else if (!newValue) lines.push(`- Removed ${inlineCode(key)}: ${inlineCode(value(oldValue))}`);
    else if (canonicalRequest(oldValue) !== canonicalRequest(newValue)) lines.push(`- Changed ${inlineCode(key)}: ${inlineCode(value(oldValue))} -> ${inlineCode(value(newValue))}`);
  }
  return lines.length === 2 ? [] : [...lines, ''];
}

function renderXmlChanges(before, after) {
  try {
    const changes = compactMovedJsonValues(findJsonChanges(parseXml(before), parseXml(after)));
    const visible = changes.slice(0, MAX_JSON_CHANGES);
    return [
      `**Request body (XML)** (${changes.length} structural change${changes.length === 1 ? '' : 's'})`,
      '', ...visible.map(renderJsonChange),
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
  if (canonicalJson(previous.variables) !== canonicalJson(current.variables)) lines.push(`- Variables: ${inlineCode(canonicalJson(previous.variables))} -> ${inlineCode(canonicalJson(current.variables))}`);
  return [...lines, '', ...renderBoundedTextDiff(previous.query || '', current.query || '', 'GraphQL query')];
}

function renderFileBodyChanges(before, after) {
  const name = (body) => body?.file?.name || 'no file';
  return ['**Request body (file/binary)**', '', `- File metadata: ${inlineCode(name(before))} -> ${inlineCode(name(after))}; file content is never read or rendered.`, ''];
}

function renderBodyChanges(before, after) {
  const previousJson = jsonBodyValue(before);
  const currentJson = jsonBodyValue(after);
  if (previousJson !== null && currentJson !== null) {
    const changes = compactMovedJsonValues(findJsonChanges(previousJson, currentJson));
    const visible = changes.slice(0, MAX_JSON_CHANGES);
    return [
      `**Request body** (${changes.length} structural change${changes.length === 1 ? '' : 's'})`,
      '', ...visible.map(renderJsonChange),
      ...(changes.length > visible.length ? [`- ${changes.length - visible.length} additional structural changes omitted.`] : []),
      '', ...renderRawJsonDiff(previousJson, currentJson),
    ];
  }

  const mode = after?.mode || before?.mode || 'none';
  if (mode === 'urlencoded') return renderFields(before?.urlencoded, after?.urlencoded, 'Request body (URL-encoded)');
  if (mode === 'formdata') return renderFields(before?.formdata, after?.formdata, 'Request body (form-data)');
  if (mode === 'graphql') return renderGraphqlChanges(before, after);
  if (mode === 'file' || mode === 'binary') return renderFileBodyChanges(before, after);
  if (mode === 'raw' && (before?.options?.raw?.language === 'xml' || after?.options?.raw?.language === 'xml')) {
    return renderXmlChanges(before?.raw || '', after?.raw || '');
  }
  if (mode === 'raw') {
    return renderBoundedTextDiff(before?.raw || '', after?.raw || '', `Request body (${after?.options?.raw?.language || before?.options?.raw?.language || 'raw text'})`);
  }
  return ['**Body**', '', `- Request body configuration changed: ${inlineCode(before?.mode || 'none')} -> ${inlineCode(after?.mode || 'none')}; content is omitted to avoid exposing sensitive data.`, ''];
}

module.exports = { findJsonChanges, renderBodyChanges };
