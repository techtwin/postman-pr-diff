'use strict';

const { countChanges } = require('./diff');

function escapeMarkdown(value) {
  return String(value).replace(/([\\`*_[\]{}()#+\-.!|<>])/g, '\\$1');
}

function requestLabel(request) {
  return `${request.method} ${typeof request.url === 'string' ? request.url : request.url.raw || ''}`;
}

function requestLines(label, entries) {
  if (entries.length === 0) {
    return '';
  }

  return [
    `<details><summary>${label} (${entries.length})</summary>`,
    '',
    ...entries.map((entry) => `- \`${escapeMarkdown(entry.key)}\` — ${escapeMarkdown(requestLabel(entry.after || entry.before))}`),
    '',
    '</details>',
    '',
  ].join('\n');
}

function modifiedLines(entries) {
  if (entries.length === 0) {
    return '';
  }

  return [
    `<details><summary>Modified (${entries.length})</summary>`,
    '',
    ...entries.flatMap((entry) => [
      `- \`${escapeMarkdown(entry.key)}\``,
      `  - \`${escapeMarkdown(requestLabel(entry.before))}\` → \`${escapeMarkdown(requestLabel(entry.after))}\``,
    ]),
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

module.exports = { escapeMarkdown, renderReport };
