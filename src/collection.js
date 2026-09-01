'use strict';

const { normalizeBody, normalizeEvents } = require('./formats');
const { stableValue } = require('./stable');

function normalizeHeaders(headers) {
  if (!Array.isArray(headers)) {
    return [];
  }

  return headers
    .map((header) => ({
      key: String(header.key || '').toLowerCase(),
      value: String(header.value || ''),
      disabled: Boolean(header.disabled),
    }))
    .sort((left, right) => {
      const keyOrder = left.key.localeCompare(right.key);
      return keyOrder || left.value.localeCompare(right.value);
    });
}

function normalizeRequest(request, events) {
  const source = request && typeof request === 'object' ? request : {};

  return stableValue({
    method: String(source.method || 'GET').toUpperCase(),
    url: source.url || '',
    header: normalizeHeaders(source.header),
    body: normalizeBody(source.body),
    events: normalizeEvents(events),
    auth: source.auth || null,
  });
}

function requestKey(path) {
  return path.map((part) => String(part || 'Untitled request')).join(' / ');
}

function addRequest(requests, duplicateCounts, path, request, events) {
  const key = requestKey(path);
  const count = duplicateCounts.get(key) || 0;
  const uniqueKey = count === 0 ? key : `${key} (${count + 1})`;
  duplicateCounts.set(key, count + 1);
  requests.set(uniqueKey, normalizeRequest(request, events));

  return uniqueKey;
}

function collectItems(items, path, requests, duplicateCounts) {
  if (!Array.isArray(items)) {
    return;
  }

  for (const item of items) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    if (item.request) {
      addRequest(requests, duplicateCounts, [...path, item.name], item.request, item.event);
    } else if (Array.isArray(item.item)) {
      collectItems(item.item, [...path, item.name], requests, duplicateCounts);
    }
  }
}

function parseCollection(content, fileName = 'collection') {
  let collection;
  try {
    collection = JSON.parse(content);
  } catch (error) {
    throw new Error(`${fileName} is not valid JSON: ${error.message}`);
  }

  const schema = collection?.info?.schema;
  if (
    typeof schema !== 'string' ||
    !schema.includes('schema.getpostman.com/json/collection/v2.1.0/')
  ) {
    throw new Error(`${fileName} is not a Postman Collection v2.1 document.`);
  }
  const requests = new Map();
  collectItems(collection.item, [], requests, new Map());

  return {
    name: String(collection.info.name || fileName),
    events: normalizeEvents(collection.event),
    requests,
  };
}

function canonicalRequest(request) {
  return JSON.stringify(request);
}

module.exports = {
  canonicalRequest,
  normalizeRequest,
  normalizeBody,
  parseCollection,
  stableValue,
};
