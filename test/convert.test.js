import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertToml, renderNote, stableStringify, toNdjsonLine } from '../src/convert.js';
import { validateRule } from '../src/validate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(here, 'fixtures', name), 'utf8');

/** Minimal valid rule used as a base for negative tests. */
function baseRule(overrides = {}) {
  return {
    name: 'Test Rule',
    rule_id: '11111111-2222-3333-4444-555555555555',
    type: 'query',
    language: 'kuery',
    severity: 'medium',
    risk_score: 47,
    index: ['logs-*'],
    query: 'event.action:"test"',
    ...overrides,
  };
}

test('new_terms: field/value become the payload key named by "field"', () => {
  const { rule } = convertToml(fixture('new_terms_with_transforms.toml'));
  assert.deepEqual(rule.new_terms_fields, ['winlog.event_data.SubjectUserName']);
  assert.equal(rule.history_window_start, 'now-15d');
  assert.equal(rule.new_terms, undefined);
});

test('new_terms: a renamed "field" key is honoured, not hard-coded', () => {
  const toml = `
[rule]
name = "Renamed"
rule_id = "11111111-2222-3333-4444-555555555555"
type = "new_terms"
language = "kuery"
severity = "low"
risk_score = 21
index = ["logs-*"]
query = "event.action:\\"x\\""

[rule.new_terms]
field = "custom_terms_field"
value = ["a.b"]

[[rule.new_terms.history_window_start]]
field = "history_window_start"
value = "now-7d"
`;
  const { rule } = convertToml(toml);
  assert.deepEqual(rule.custom_terms_field, ['a.b']);
  assert.equal(rule.new_terms_fields, undefined);
  assert.equal(rule.history_window_start, 'now-7d');
});

test('filters: $state.store is injected and negate is a real boolean', () => {
  const { rule } = convertToml(fixture('new_terms_with_filters.toml'));
  assert.equal(rule.filters.length, 3);
  for (const filter of rule.filters) {
    assert.deepEqual(filter.$state, { store: 'appState' });
    assert.equal(typeof filter.meta.negate, 'boolean');
  }
});

test('filters: an existing $state is preserved', () => {
  const toml = `
[rule]
name = "Keep state"
rule_id = "11111111-2222-3333-4444-555555555555"
type = "query"
language = "kuery"
severity = "low"
risk_score = 21
index = ["logs-*"]
query = "x"

[[rule.filters]]
[rule.filters.meta]
negate = true
[rule.filters."$state"]
store = "global"
[rule.filters.query.wildcard."process.name"]
case_insensitive = true
value = "benign.exe"
`;
  const { rule } = convertToml(toml);
  assert.deepEqual(rule.filters[0].$state, { store: 'global' });
});

test('threshold: bare string field is wrapped into an array', () => {
  const toml = `
[rule]
name = "Threshold"
rule_id = "11111111-2222-3333-4444-555555555555"
type = "threshold"
language = "kuery"
severity = "medium"
risk_score = 47
index = ["logs-*"]
query = "x"

[rule.threshold]
field = "host.id"
value = 5
`;
  const { rule } = convertToml(toml);
  assert.deepEqual(rule.threshold.field, ['host.id']);
  assert.equal(rule.threshold.value, 5);
});

test('threshold: fixture keeps its array field and value', () => {
  const { rule } = convertToml(fixture('threshold_process_kill.toml'));
  assert.deepEqual(rule.threshold.field, ['host.id', 'process.executable', 'user.name']);
  assert.equal(rule.threshold.value, 15);
});

test('esql: rule converts with no index array required', () => {
  const { rule } = convertToml(fixture('esql_higher_order.toml'));
  assert.equal(rule.type, 'esql');
  assert.equal(rule.language, 'esql');
  assert.ok(rule.query.includes('from .alerts-security.*'));
  const { errors } = validateRule(rule);
  assert.deepEqual(errors, []);
});

test('building block: building_block_type survives conversion', () => {
  const { rule } = convertToml(fixture('building_block_eql.toml'));
  assert.equal(rule.building_block_type, 'default');
  assert.equal(rule.type, 'eql');
});

test('repo-only tables never reach the payload', () => {
  const { rule } = convertToml(fixture('new_terms_with_transforms.toml'));
  assert.equal(rule.metadata, undefined);
  assert.equal(rule.transform, undefined);
});

test('note: $investigate placeholders render into Kibana plugin strings', () => {
  const { rule, warnings } = convertToml(fixture('new_terms_with_transforms.toml'));
  assert.ok(rule.note.includes('!{investigate{'));
  assert.equal(/\$(osquery|investigate)_\d+/.test(rule.note), false);
  assert.deepEqual(warnings, []);
});

test('note: a placeholder with no transform is reported, not silently kept', () => {
  const { note, missing } = renderNote('do this: $osquery_0 and $osquery_9', {
    osquery: [{ label: 'a', query: 'SELECT 1' }],
  });
  assert.ok(note.includes('!{osquery{'));
  assert.deepEqual(missing, ['$osquery_9']);
});

test('note: a literal $$ is not treated as a placeholder', () => {
  const { note, missing } = renderNote('cost is $$5 and $osquery_0', {
    osquery: [{ label: 'a', query: 'SELECT 1' }],
  });
  assert.ok(note.includes('cost is $5'));
  assert.deepEqual(missing, []);
});

test('note: no transform section leaves the note untouched', () => {
  const { rule } = convertToml(fixture('threshold_process_kill.toml'));
  assert.equal(rule.note.includes('!{'), false);
});

test('JSON-string fields are revived when a hand-edited export leaves them as strings', () => {
  const toml = `
[rule]
name = "Stringy"
rule_id = "11111111-2222-3333-4444-555555555555"
type = "query"
language = "kuery"
severity = "low"
risk_score = 21
index = ["logs-*"]
query = "x"
tags = '["Domain: Endpoint","OS: Linux"]'
`;
  const { rule, warnings } = convertToml(toml);
  assert.deepEqual(rule.tags, ['Domain: Endpoint', 'OS: Linux']);
  assert.ok(warnings.some((w) => w.includes('tags')));
});

test('a document with no [rule] table is treated as the rule, with a warning', () => {
  const toml = `
name = "Bare"
rule_id = "11111111-2222-3333-4444-555555555555"
type = "query"
language = "kuery"
severity = "low"
risk_score = 21
index = ["logs-*"]
query = "x"
`;
  const { rule, warnings } = convertToml(toml);
  assert.equal(rule.name, 'Bare');
  assert.ok(warnings.some((w) => w.includes('no [rule] table')));
});

test('invalid TOML fails with the source name in the message', () => {
  assert.throws(
    () => convertToml('this is not = = toml', { source: 'broken.toml' }),
    /broken\.toml: TOML parse failed/,
  );
});

test('stableStringify sorts keys for deterministic plugin output', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(stableStringify({ z: [{ y: 1, x: 2 }] }), '{"z":[{"x":2,"y":1}]}');
});

test('toNdjsonLine emits exactly one line with no trailing newline', () => {
  const line = toNdjsonLine(baseRule());
  assert.equal(line.includes('\n'), false);
  assert.equal(JSON.parse(line).name, 'Test Rule');
});

// --- validation -------------------------------------------------------------

test('validate: a clean rule passes', () => {
  const { errors } = validateRule(baseRule());
  assert.deepEqual(errors, []);
});

test('validate: missing required fields are all reported', () => {
  const { errors } = validateRule({});
  for (const field of ['name', 'rule_id', 'type', 'severity', 'risk_score']) {
    assert.ok(errors.some((e) => e.includes(`"${field}"`)), `expected an error for ${field}`);
  }
});

test('validate: a non-UUID rule_id is rejected', () => {
  const { errors } = validateRule(baseRule({ rule_id: 'not-a-uuid' }));
  assert.ok(errors.some((e) => e.includes('not a UUID')));
});

test('validate: language must match the rule type', () => {
  const { errors } = validateRule(baseRule({ type: 'eql', language: 'kuery' }));
  assert.ok(errors.some((e) => e.includes('not valid for type "eql"')));
});

test('validate: esql does not require an index array', () => {
  const { errors } = validateRule(baseRule({ type: 'esql', language: 'esql', index: undefined }));
  assert.deepEqual(errors, []);
});

test('validate: risk_score outside 0-100 is rejected', () => {
  const { errors } = validateRule(baseRule({ risk_score: 150 }));
  assert.ok(errors.some((e) => e.includes('risk_score')));
});

test('validate: new_terms without new_terms_fields is rejected', () => {
  const { errors } = validateRule(baseRule({ type: 'new_terms' }));
  assert.ok(errors.some((e) => e.includes('new_terms_fields')));
});

test('validate: threshold without a threshold table is rejected', () => {
  const { errors } = validateRule(baseRule({ type: 'threshold' }));
  assert.ok(errors.some((e) => e.includes('[rule.threshold]')));
});

test('validate: a leftover repo-only field is an error', () => {
  const { errors } = validateRule(baseRule({ metadata: { maturity: 'production' } }));
  assert.ok(errors.some((e) => e.includes('repo-only field "metadata"')));
});

test('validate: filters without $state.store are rejected', () => {
  const { errors } = validateRule(baseRule({ filters: [{ meta: { negate: true } }] }));
  assert.ok(errors.some((e) => e.includes('$state.store')));
});

test('validate: unrendered note placeholders are a warning, not an error', () => {
  const { errors, warnings } = validateRule(baseRule({ note: 'run $osquery_0' }));
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes('$osquery_0')));
});

// --- document classification ------------------------------------------------

test('a [hunt] document is classified as a hunting query, not a rule', () => {
  const { kind, rule } = convertToml(fixture('hunting_query.toml'));
  assert.equal(kind, 'hunt');
  assert.equal(rule, null);
});

test('a build-config TOML is classified as neither', () => {
  const { kind, rule } = convertToml('[project]\nname = "x"\nversion = "1.0"\n');
  assert.equal(kind, 'other');
  assert.equal(rule, null);
});

test('a bare document with name and query is still treated as a rule', () => {
  const { kind } = convertToml('name = "Bare"\nquery = "x"\n');
  assert.equal(kind, 'rule');
});
