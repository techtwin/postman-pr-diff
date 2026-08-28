'use strict';

const { canonicalRequest } = require('./collection');

function compareCollections(base, head) {
  const keys = new Set([...base.requests.keys(), ...head.requests.keys()]);
  const changes = {
    added: [],
    removed: [],
    modified: [],
    unchanged: [],
  };

  for (const key of [...keys].sort((left, right) => left.localeCompare(right))) {
    const before = base.requests.get(key);
    const after = head.requests.get(key);

    if (!before) {
      changes.added.push({ key, after });
    } else if (!after) {
      changes.removed.push({ key, before });
    } else if (canonicalRequest(before) !== canonicalRequest(after)) {
      changes.modified.push({ key, before, after });
    } else {
      changes.unchanged.push({ key, after });
    }
  }

  return changes;
}

function countChanges(changes) {
  return changes.added.length + changes.removed.length + changes.modified.length;
}

module.exports = { compareCollections, countChanges };
