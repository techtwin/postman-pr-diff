'use strict';

const { canonicalRequest } = require('./collection');

const REQUEST_FIELDS = ['method', 'url', 'header', 'body', 'auth', 'events'];

function compareEvents(before = [], after = []) {
  const beforeMap = new Map(before.map((event) => [event.key, event]));
  const afterMap = new Map(after.map((event) => [event.key, event]));
  const keys = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort();
  return keys.flatMap((key) => {
    const previous = beforeMap.get(key);
    const current = afterMap.get(key);
    if (canonicalRequest(previous) === canonicalRequest(current)) return [];
    return [{ key, before: previous, after: current }];
  });
}

function changedRequestFields(before, after) {
  return REQUEST_FIELDS.filter(
    (field) => canonicalRequest(before[field]) !== canonicalRequest(after[field]),
  );
}

function compareCollections(base, head) {
  const keys = new Set([...base.requests.keys(), ...head.requests.keys()]);
  const changes = {
    added: [],
    removed: [],
    modified: [],
    unchanged: [],
    collectionEvents: compareEvents(base.events, head.events),
  };

  for (const key of [...keys].sort((left, right) => left.localeCompare(right))) {
    const before = base.requests.get(key);
    const after = head.requests.get(key);

    if (!before) {
      changes.added.push({ key, after });
    } else if (!after) {
      changes.removed.push({ key, before });
    } else if (canonicalRequest(before) !== canonicalRequest(after)) {
      changes.modified.push({
        key,
        before,
        after,
        fields: changedRequestFields(before, after),
      });
    } else {
      changes.unchanged.push({ key, after });
    }
  }

  return changes;
}

function countChanges(changes) {
  return changes.added.length + changes.removed.length + changes.modified.length;
}

module.exports = { changedRequestFields, compareCollections, compareEvents, countChanges };
