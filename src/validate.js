/**
 * Pre-flight checks for a Kibana rule payload.
 *
 * These catch the failures that only surface at import time in Kibana, where the
 * error message is a generic 400 with no field context. Catching them here means
 * a bad rule pack fails in CI instead of halfway through an import.
 */

const RULE_TYPES = new Set(['query', 'eql', 'esql', 'threshold', 'threat_match', 'machine_learning', 'new_terms']);

const QUERY_LANGUAGES = {
  query: new Set(['kuery', 'lucene']),
  eql: new Set(['eql']),
  esql: new Set(['esql']),
  threshold: new Set(['kuery', 'lucene']),
  threat_match: new Set(['kuery', 'lucene']),
  new_terms: new Set(['kuery', 'lucene']),
};

const SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {object} rule converted rule payload
 * @param {{ source?: string }} [options]
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validateRule(rule, options = {}) {
  const source = options.source ?? '<rule>';
  const errors = [];
  const warnings = [];

  if (!isPlainObject(rule)) {
    return { errors: [`${source}: rule is not an object`], warnings };
  }

  for (const field of ['name', 'rule_id', 'type', 'severity', 'risk_score']) {
    if (rule[field] === undefined || rule[field] === null || rule[field] === '') {
      errors.push(`${source}: missing required field "${field}"`);
    }
  }

  if (typeof rule.rule_id === 'string' && !UUID_RE.test(rule.rule_id)) {
    errors.push(`${source}: rule_id "${rule.rule_id}" is not a UUID`);
  }

  if (rule.type !== undefined && !RULE_TYPES.has(rule.type)) {
    errors.push(`${source}: unknown rule type "${rule.type}"`);
  }

  if (rule.severity !== undefined && !SEVERITIES.has(rule.severity)) {
    errors.push(`${source}: severity "${rule.severity}" must be one of ${[...SEVERITIES].join(', ')}`);
  }

  if (rule.risk_score !== undefined) {
    const score = rule.risk_score;
    if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > 100) {
      errors.push(`${source}: risk_score must be an integer 0-100, got ${JSON.stringify(score)}`);
    }
  }

  // Language must match the rule type. Kibana rejects the pair, not just the value.
  const allowedLanguages = QUERY_LANGUAGES[rule.type];
  if (allowedLanguages && rule.language !== undefined && !allowedLanguages.has(rule.language)) {
    errors.push(
      `${source}: language "${rule.language}" is not valid for type "${rule.type}" ` +
      `(expected ${[...allowedLanguages].join(' or ')})`,
    );
  }

  // Query-bearing types need a query; ES|QL and EQL carry it the same way.
  const needsQuery = new Set(['query', 'eql', 'esql', 'threshold', 'threat_match', 'new_terms']);
  if (needsQuery.has(rule.type) && (typeof rule.query !== 'string' || rule.query.trim() === '')) {
    errors.push(`${source}: type "${rule.type}" requires a non-empty query`);
  }

  // Index is required for every type except machine_learning and ES|QL, which
  // read from a query-defined source.
  if (rule.type !== 'machine_learning' && rule.type !== 'esql') {
    if (!Array.isArray(rule.index) || rule.index.length === 0) {
      errors.push(`${source}: missing "index" array`);
    }
  }

  if (rule.type === 'new_terms' && rule.new_terms_fields === undefined) {
    errors.push(`${source}: type "new_terms" requires new_terms_fields`);
  }

  if (rule.type === 'threshold') {
    if (!isPlainObject(rule.threshold)) {
      errors.push(`${source}: type "threshold" requires a [rule.threshold] table`);
    } else if (rule.threshold.value === undefined) {
      errors.push(`${source}: threshold.value is required`);
    }
  }

  // threat_match rules need an indicator index; the field name varies by version.
  if (rule.type === 'threat_match' && rule.threat_index === undefined && rule.threat_indicator_path === undefined) {
    errors.push(`${source}: type "threat_match" requires threat_index or threat_indicator_path`);
  }

  // Repo-only leftovers that Kibana will reject or silently ignore.
  for (const field of ['metadata', 'transform', 'new_terms', 'meta']) {
    if (rule[field] !== undefined) {
      errors.push(`${source}: repo-only field "${field}" must not be in the payload`);
    }
  }

  // Investigation-guide placeholders that were never rendered.
  if (typeof rule.note === 'string') {
    const leftover = rule.note.match(/\$(osquery|investigate)_\d+/g);
    if (leftover) {
      warnings.push(`${source}: note still contains unrendered placeholders: ${[...new Set(leftover)].join(', ')}`);
    }
  }

  // Filters: `$state.store` is optional in the Elastic schema but the Kibana UI
  // always writes one, so a missing store is a warning rather than an error.
  if (Array.isArray(rule.filters)) {
    rule.filters.forEach((filter, i) => {
      if (!isPlainObject(filter)) {
        errors.push(`${source}: filters[${i}] is not an object`);
        return;
      }
      if (!isPlainObject(filter.$state) || typeof filter.$state.store !== 'string') {
        warnings.push(`${source}: filters[${i}] has no $state.store; Kibana will default it`);
      }
    });
  }

  if (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') {
    warnings.push(`${source}: enabled should be a boolean`);
  }

  return { errors, warnings };
}
