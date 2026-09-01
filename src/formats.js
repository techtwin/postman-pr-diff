'use strict';

const path = require('node:path');
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const { stableValue } = require('./stable');

const MAX_XML_CHARACTERS = 100_000;
const MAX_XML_DEPTH = 40;
const MAX_XML_NODES = 5_000;
const UNSAFE_XML = /<!DOCTYPE|<!ENTITY|\bSYSTEM\b|\bPUBLIC\b/i;

function enabledFields(fields, mapper) {
  return (Array.isArray(fields) ? fields : [])
    .filter((field) => field && field.disabled !== true)
    .map(mapper)
    .sort((left, right) => left.key.localeCompare(right.key));
}

function normalizeBody(body) {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const normalized = stableValue(body);
  switch (normalized.mode) {
    case 'raw':
      try {
        return { ...normalized, raw: JSON.stringify(stableValue(JSON.parse(normalized.raw))) };
      } catch {
        return normalized;
      }
    case 'urlencoded':
      return {
        ...normalized,
        urlencoded: enabledFields(normalized.urlencoded, (field) => ({
          key: String(field.key || ''),
          value: String(field.value || ''),
        })),
      };
    case 'formdata':
      return {
        ...normalized,
        formdata: enabledFields(normalized.formdata, (field) => ({
          key: String(field.key || ''),
          type: field.type === 'file' ? 'file' : 'text',
          value: field.type === 'file' ? undefined : String(field.value || ''),
          file: field.type === 'file' ? path.basename(String(field.src || field.value || '')) : undefined,
        })),
      };
    case 'graphql':
      return {
        ...normalized,
        graphql: {
          query: String(normalized.graphql?.query || ''),
          variables: normalizeVariables(normalized.graphql?.variables),
        },
      };
    case 'file':
    case 'binary':
      return {
        ...normalized,
        file: { name: path.basename(String(normalized.file?.src || normalized.file?.name || normalized.file || '')) },
      };
    default:
      return normalized;
  }
}

function normalizeVariables(variables) {
  if (typeof variables !== 'string') {
    return stableValue(variables || {});
  }
  try {
    return stableValue(JSON.parse(variables));
  } catch {
    return variables;
  }
}

function parseXml(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_XML_CHARACTERS) {
    throw new Error(`XML exceeds the ${MAX_XML_CHARACTERS.toLocaleString()} character limit.`);
  }
  if (UNSAFE_XML.test(raw)) {
    throw new Error('XML contains a prohibited DTD or entity declaration.');
  }
  const valid = XMLValidator.validate(raw, { allowBooleanAttributes: true });
  if (valid !== true) {
    throw new Error(`Malformed XML: ${valid.err.msg}`);
  }
  const value = new XMLParser({
    allowBooleanAttributes: true,
    attributeNamePrefix: '@',
    ignoreAttributes: false,
    parseAttributeValue: false,
    parseTagValue: false,
    processEntities: false,
    textNodeName: '#text',
    trimValues: true,
  }).parse(raw);
  let nodes = 0;
  function check(node, depth = 0) {
    nodes += 1;
    if (nodes > MAX_XML_NODES || depth > MAX_XML_DEPTH) {
      throw new Error(`XML exceeds the ${MAX_XML_DEPTH} depth or ${MAX_XML_NODES.toLocaleString()} node limit.`);
    }
    if (node && typeof node === 'object') {
      Object.values(node).forEach((child) => {
        if (Array.isArray(child)) child.forEach((entry) => check(entry, depth + 1));
        else check(child, depth + 1);
      });
    }
  }
  check(value);
  return value;
}

function normalizeEvents(events) {
  const counts = new Map();
  return (Array.isArray(events) ? events : [])
    .filter((event) => event && event.script)
    .map((event) => {
      const listen = String(event.listen || 'unknown');
      const index = counts.get(listen) || 0;
      counts.set(listen, index + 1);
      return {
        key: `${listen}:${index + 1}`,
        listen,
        exec: Array.isArray(event.script.exec)
          ? event.script.exec.map(String)
          : [String(event.script.exec || '')],
      };
    });
}

module.exports = { normalizeBody, normalizeEvents, parseXml };
