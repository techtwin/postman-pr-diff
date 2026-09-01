'use strict';

const { redactText } = require('./redaction');
const { fencedDiff, inlineCode, lineDiff } = require('./render-utils');

const MAX_SCRIPT_CHARACTERS = 32_000;
const MAX_SCRIPT_LINES = 100;

function renderEventChanges(events, label) {
  if (!events?.length) {
    return [];
  }

  const lines = [`**${label}**`, ''];
  for (const event of events) {
    const name = event.after?.listen || event.before?.listen || event.key;
    const before = redactText(event.before?.exec?.join('\n') || '');
    const after = redactText(event.after?.exec?.join('\n') || '');
    lines.push(
      `- ${event.before && event.after ? 'Changed' : event.after ? 'Added' : 'Removed'} ${inlineCode(name)} script.`,
      '<details><summary>View redacted script diff</summary>',
      '',
    );

    if (before.length + after.length > MAX_SCRIPT_CHARACTERS) {
      lines.push(`Script diff omitted: content exceeds the ${MAX_SCRIPT_CHARACTERS.toLocaleString()} character limit.`);
    } else {
      const diff = lineDiff(before, after);
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

module.exports = { renderEventChanges };
