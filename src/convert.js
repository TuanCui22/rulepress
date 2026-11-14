import { parse as parseToml } from 'smol-toml';

/**
 * Top-level TOML tables that exist only in the elastic/detection-rules repo and
 * must never reach the Kibana import payload.
 */
const REPO_ONLY_TABLES = ['metadata', 'transform'];

/**
 * Fields that some hand-edited TOML exports carry as JSON strings instead of
 * real TOML arrays/tables. They are parsed back when they look like JSON.
 */
const JSON_STRING_FIELDS = new Set([
  'actions',
  'exceptions_list',
  'response_actions',
  'filters',
  'risk_score_mapping',
  'severity_mapping',
  'threat',
  'related_integrations',
  'required_fields',
  'tags',
  'references',
  'author',
  'investigation_fields',
]);

/** Deterministic JSON, matching Python's json.dumps(sort_keys=True, separators=(',', ':')). */
export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

/**
 * Expand `$osquery_N` / `$investigate_N` placeholders in the investigation guide
 * into the markdown plugin strings Kibana renders, exactly as the Elastic build
 * does. Returns the rendered note plus any placeholder that had no transform.
 */
export function renderNote(note, transform) {
  if (typeof note !== 'string' || note.length === 0) {
    return { note, missing: [] };
  }

  const rendered = { osquery: [], investigate: [] };
  for (const plugin of Object.keys(rendered)) {
    const entries = transform?.[plugin];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      rendered[plugin].push(`!{${plugin}${stableStringify(entry)}}`);
    }
  }

  const missing = [];
  const DOLLAR = '\u0000rulepress-dollar\u0000';

  let out = note.replace(/\$\$/g, DOLLAR);
  out = out.replace(/\$(osquery|investigate)_(\d+)/g, (match, plugin, index) => {
    const hit = rendered[plugin][Number(index)];
    if (hit === undefined) {
      missing.push(match);
      return match;
    }
    return hit;
  });
  out = out.split(DOLLAR).join('$');

  return { note: out, missing };
}

/**
 * `[rule.new_terms]` uses a dynamic key name: `field` names the payload key that
 * receives `value`. Elastic's own build does `obj[obj["new_terms"]["field"]] = value`,
 * so hard-coding `new_terms_fields` silently breaks any rule that renamed it.
 */
function expandNewTerms(rule, warnings) {
  const newTerms = rule.new_terms;
  if (!isPlainObject(newTerms)) return;

  const key = typeof newTerms.field === 'string' && newTerms.field.length > 0
    ? newTerms.field
    : 'new_terms_fields';

  if (newTerms.value !== undefined) {
    rule[key] = clone(newTerms.value);
  } else {
    warnings.push(`new_terms has no value; ${key} left unset`);
  }

  const window = newTerms.history_window_start;
  if (Array.isArray(window) && window.length > 0) {
    const first = window[0];
    rule.history_window_start = isPlainObject(first) ? first.value : first;
  } else if (typeof window === 'string') {
    rule.history_window_start = window;
  } else {
    warnings.push('new_terms has no history_window_start; Kibana will apply its default');
  }

  delete rule.new_terms;
}

/**
 * `[rule.threshold]` may carry `field`/`cardinality` as a bare string. Kibana
 * expects arrays for both.
 */
function normalizeThreshold(rule) {
  const threshold = rule.threshold;
  if (!isPlainObject(threshold)) return;
  if (threshold.field !== undefined && !Array.isArray(threshold.field)) {
    threshold.field = [threshold.field];
  }
  if (threshold.cardinality !== undefined && !Array.isArray(threshold.cardinality)) {
    threshold.cardinality = [threshold.cardinality];
  }
}

/**
 * `[[rule.filters]]` needs `$state.store` before Kibana will accept it, and
 * `meta.negate` must be a real boolean.
 */
function normalizeFilters(rule) {
  if (!Array.isArray(rule.filters)) return;
  rule.filters = rule.filters.map((filter) => {
    if (!isPlainObject(filter)) return filter;
    const out = clone(filter);
    if (!isPlainObject(out.$state)) out.$state = { store: 'appState' };
    if (isPlainObject(out.meta) && out.meta.negate !== undefined) {
      out.meta.negate = Boolean(out.meta.negate);
    }
    return out;
  });
}

/** Parse JSON-string fields that hand-edited exports leave as strings. */
function reviveJsonStrings(rule, warnings) {
  for (const [key, value] of Object.entries(rule)) {
    if (!JSON_STRING_FIELDS.has(key) || typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) continue;
    try {
      rule[key] = JSON.parse(trimmed);
      warnings.push(`${key} was a JSON string; parsed into a real value`);
    } catch {
      warnings.push(`${key} looks like JSON but did not parse; left as a string`);
    }
  }
}

/**
 * Classify a parsed TOML document.
 *
 * elastic/detection-rules ships three different shapes under the same extension:
 *   - `[rule]`  a Kibana detection rule (what we convert)
 *   - `[hunt]`  a hunting query, a different schema Kibana will not import
 *   - neither   build config such as pyproject.toml
 */
function classify(doc) {
  if (isPlainObject(doc.rule)) return 'rule';
  if (isPlainObject(doc.hunt)) return 'hunt';
  // A bare document is only a rule if it carries the fields a rule must have.
  if (typeof doc.name === 'string' && typeof doc.query === 'string') return 'rule';
  return 'other';
}

/**
 * Convert one Elastic detection-rule TOML document into a Kibana rule object.
 *
 * @param {string} tomlText raw TOML
 * @param {{ source?: string }} [options]
 * @returns {{ kind: 'rule'|'hunt'|'other', rule: object|null, warnings: string[], metadata: object }}
 */
export function convertToml(tomlText, options = {}) {
  const source = options.source ?? '<input>';
  const warnings = [];

  let doc;
  try {
    doc = parseToml(tomlText);
  } catch (error) {
    throw new Error(`${source}: TOML parse failed: ${error.message}`);
  }

  if (!isPlainObject(doc)) {
    throw new Error(`${source}: TOML document is not a table`);
  }

  const kind = classify(doc);
  const metadata = isPlainObject(doc.metadata) ? clone(doc.metadata) : {};
  const transform = isPlainObject(doc.transform) ? clone(doc.transform) : {};

  if (kind !== 'rule') {
    return { kind, rule: null, warnings, metadata };
  }

  let rule;
  if (isPlainObject(doc.rule)) {
    rule = clone(doc.rule);
  } else {
    const bare = clone(doc);
    for (const table of REPO_ONLY_TABLES) delete bare[table];
    rule = bare;
    warnings.push('no [rule] table found; treated the document root as the rule');
  }

  if (Object.keys(rule).length === 0) {
    throw new Error(`${source}: no rule fields found`);
  }

  reviveJsonStrings(rule, warnings);
  expandNewTerms(rule, warnings);
  normalizeThreshold(rule);
  normalizeFilters(rule);

  if (rule.meta !== undefined) {
    delete rule.meta;
    warnings.push('dropped repo-only "meta" table');
  }

  if (typeof rule.note === 'string') {
    const rendered = renderNote(rule.note, transform);
    rule.note = rendered.note;
    for (const placeholder of rendered.missing) {
      warnings.push(`note placeholder ${placeholder} has no matching transform entry`);
    }
  } else if (Object.keys(transform).length > 0) {
    warnings.push('[transform] present but the rule has no note to render into');
  }

  return { kind, rule, warnings, metadata };
}

/** Serialize a rule object as one NDJSON line (no trailing newline). */
export function toNdjsonLine(rule) {
  return JSON.stringify(rule);
}
