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
const MAX_RAW_JSON_CHARACTERS = 24_000;
const MAX_RAW_DIFF_LINES = 400;
const MAX_CONTEXT_DIFF_LINES = 120;
const MAX_CONTEXT_DIFF_CHARACTERS = 12_000;
const DIFF_CONTEXT_LINES = 3;
const MAX_DIFF_LINE_CHARACTERS = 400;

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
  const previousLines = previous.split('\n');
  const currentLines = current.split('\n');
  const requiresContext = totalCharacters > MAX_RAW_JSON_CHARACTERS
    || previousLines.length > MAX_RAW_DIFF_LINES
    || currentLines.length > MAX_RAW_DIFF_LINES;
  const lines = requiresContext
    ? edgeDiff(previousLines, currentLines)
    : lineDiff(previous, current);
  const exceedsLimit = requiresContext
    || lines.length > MAX_RAW_DIFF_LINES
    || lines.join('\n').length > MAX_CONTEXT_DIFF_CHARACTERS;
  const display = exceedsLimit ? contextualDiff(lines) : lines;
  const note = exceedsLimit
    ? `Raw JSON diff truncated: ${previousLines.length + currentLines.length} source lines and ${totalCharacters.toLocaleString()} characters; showing the first and last changed hunks.`
    : '';

  return [
    '<details><summary>View exact body changes (raw JSON diff)</summary>',
    '',
    ...(note ? [note, ''] : []),
    fencedDiff(display),
    '',
    '</details>',
    '',
  ];
}

function edgeDiff(before, after) {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - suffix - 1] === after[after.length - suffix - 1]
  ) {
    suffix += 1;
  }

  return [
    ...before.slice(Math.max(0, prefix - DIFF_CONTEXT_LINES), prefix).map((line) => `  ${line}`),
    ...before.slice(prefix, before.length - suffix).map((line) => `- ${line}`),
    ...after.slice(prefix, after.length - suffix).map((line) => `+ ${line}`),
    ...after.slice(after.length - suffix, after.length - suffix + DIFF_CONTEXT_LINES).map((line) => `  ${line}`),
  ];
}

function diffHunks(lines) {
  const changes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.startsWith('+ ') || line.startsWith('- '));
  if (changes.length === 0) {
    return [{ start: 0, end: lines.length - 1 }];
  }

  const ranges = changes.map(({ index }) => ({
    start: Math.max(0, index - DIFF_CONTEXT_LINES),
    end: Math.min(lines.length - 1, index + DIFF_CONTEXT_LINES),
  }));
  return ranges.reduce((hunks, range) => {
    const previous = hunks.at(-1);
    if (previous && range.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      hunks.push(range);
    }
    return hunks;
  }, []);
}

function truncateDiffLine(line) {
  if (line.length <= MAX_DIFF_LINE_CHARACTERS) {
    return line;
  }
  return `${line.slice(0, MAX_DIFF_LINE_CHARACTERS - 52)}... [${line.length - MAX_DIFF_LINE_CHARACTERS + 52} characters omitted]`;
}

function contextualDiff(lines) {
  const hunks = diffHunks(lines);
  const selected = hunks.length === 1 ? hunks : [hunks[0], hunks.at(-1)];
  const output = [];
  let previousEnd = -1;

  for (const hunk of selected) {
    if (previousEnd >= 0 && hunk.start > previousEnd + 1) {
      output.push(`  ... ${hunk.start - previousEnd - 1} unchanged lines omitted ...`);
    }
    const hunkLines = lines
      .slice(hunk.start, hunk.end + 1)
      .map(truncateDiffLine);
    output.push(...truncateHunk(hunkLines));
    if (output.length >= MAX_CONTEXT_DIFF_LINES) {
      break;
    }
    previousEnd = hunk.end;
  }
  return limitContextOutput(output);
}

function truncateHunk(lines) {
  const maxLines = Math.max(2, Math.floor(MAX_CONTEXT_DIFF_LINES / 2));
  if (lines.length <= maxLines) {
    return lines;
  }
  const edgeSize = Math.floor((maxLines - 1) / 2);
  return [
    ...lines.slice(0, edgeSize),
    `  ... ${lines.length - (edgeSize * 2)} hunk lines omitted ...`,
    ...lines.slice(-edgeSize),
  ];
}

function limitContextOutput(lines) {
  const compact = lines.map(truncateDiffLine);
  if (compact.length <= MAX_CONTEXT_DIFF_LINES && compact.join('\n').length <= MAX_CONTEXT_DIFF_CHARACTERS) {
    return compact;
  }

  const first = [];
  const last = [];
  let firstIndex = 0;
  let lastIndex = compact.length - 1;
  const halfBudget = Math.floor((MAX_CONTEXT_DIFF_CHARACTERS - 80) / 2);
  let firstLength = 0;
  let lastLength = 0;

  while (firstIndex <= lastIndex && first.length < MAX_CONTEXT_DIFF_LINES / 2) {
    const line = compact[firstIndex];
    if (firstLength + line.length + 1 > halfBudget) break;
    first.push(line);
    firstLength += line.length + 1;
    firstIndex += 1;
  }
  while (lastIndex >= firstIndex && last.length < MAX_CONTEXT_DIFF_LINES / 2) {
    const line = compact[lastIndex];
    if (lastLength + line.length + 1 > halfBudget) break;
    last.unshift(line);
    lastLength += line.length + 1;
    lastIndex -= 1;
  }

  return [
    ...first,
    `  ... ${Math.max(0, lastIndex - firstIndex + 1)} diff lines omitted ...`,
    ...last,
  ];
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
