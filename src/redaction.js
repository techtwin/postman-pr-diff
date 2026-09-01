'use strict';

const SENSITIVE_NAME = /(?:authorization|cookie|token|secret|password|api[-_]?key|apikey|access[-_]?key|private[-_]?key|^key$)/i;

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

module.exports = { isSensitiveName, redactText, redactValue };
