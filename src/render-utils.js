'use strict';

const { redactText } = require('./redaction');

const MAX_INLINE_LENGTH = 320;
const MAX_RAW_DIFF_LINES = 180;
const MAX_RAW_TEXT_CHARACTERS = 8_000;

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

module.exports = {
  MAX_INLINE_LENGTH,
  MAX_RAW_DIFF_LINES,
  escapeMarkdown,
  fencedDiff,
  inlineCode,
  lineDiff,
  renderBoundedTextDiff,
  truncateText,
};
