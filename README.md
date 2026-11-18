# rulepress

Press Elastic detection-rule TOML into Kibana-importable NDJSON.

The [elastic/detection-rules](https://github.com/elastic/detection-rules) repo ships rules as TOML, but Kibana's
**Detection rules → Import** only accepts NDJSON. `rulepress` does that conversion and, unlike a naive
`toml → json` dump, it applies the same payload reshaping the Elastic build does, so the rules actually import.

**[→ Quickstart: zero to Kibana in five steps](QUICKSTART.md)** · [Tiếng Việt](README.vi.md)

## Install

**Windows**

```powershell
irm https://raw.githubusercontent.com/TuanCui22/rulepress/master/install.ps1 | iex
```

**Linux / macOS**

```bash
curl -fsSL https://raw.githubusercontent.com/TuanCui22/rulepress/master/install.sh | bash
```

**Any OS with npm**

```bash
npm install -g rulepress
```

**No install, straight from a clone**

```bash
git clone https://github.com/TuanCui22/rulepress.git
cd rulepress
npm install
node bin/rulepress.js --help
```

Requires Node 18 or newer. The CLI checks this on startup and tells you exactly how to upgrade if it is too old.

## Use

```bash
rulepress <input...> [options]
```

`<input>` is one or more `.toml` files, or directories searched recursively.

```bash
# one file per rule, into ./ndjson
rulepress rules/

# one combined file for a single Kibana import
rulepress rules/ --bundle rules.ndjson

# see what would happen without writing anything
rulepress rules/ --dry-run

# rebuild automatically while you edit
rulepress rules/ --bundle rules.ndjson --watch

# CI: convert and validate, write nothing, fail on any warning
rulepress rules/ --check --strict
```

### Options

| Option | Meaning |
|---|---|
| `-o, --out <dir>` | Output directory (default `./ndjson`) |
| `--bundle <file>` | Write every rule into one NDJSON file |
| `--dry-run` | Show what would be written, write nothing |
| `--force` | Overwrite existing output files without refusing |
| `--watch` | Re-convert whenever a `.toml` file changes |
| `--open` | Open the output folder when finished |
| `--init` | Create `rulepress.config.json` with default settings |
| `--check` | Convert and validate only; write nothing |
| `--strict` | Treat warnings as errors (recommended in CI) |
| `--json` | Machine-readable report on stdout |
| `-q, --quiet` | Only print errors |
| `-h, --help` | Help |
| `-v, --version` | Version |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | All rules converted and valid |
| `1` | At least one rule failed to convert or validate |
| `2` | Bad usage |

The exit codes make it usable as a CI gate: a rule pack that would fail at import time fails the build instead.

### Safe by default

- **Nothing is overwritten silently.** If an output file already exists, rulepress refuses and lists what it would
  have replaced. Add `--force` when you mean it.
- **`--dry-run` writes nothing at all** — not even an empty folder.
- **`--init` will not clobber an existing config** without `--force`.
- **Mistakes get suggestions.** `--dry-runn` produces "Did you mean `--dry-run`?", and a bad path prints the
  absolute path it checked plus the folder you probably meant.

### Project config

`rulepress --init` writes `rulepress.config.json`:

```json
{
  "out": "ndjson",
  "bundle": null,
  "strict": false,
  "quiet": false,
  "skip": ["node_modules", ".git", "dist", "build"]
}
```

Values in the file act as defaults; anything passed on the command line wins.

## Why not just convert TOML to JSON

A straight conversion produces a file Kibana rejects or silently mangles. Three things break:

| What the TOML has | What Kibana needs | What a naive converter does |
|---|---|---|
| `[rule.new_terms]` with `field` / `value` | a top-level key **named by** `field` | hard-codes `new_terms_fields`, breaking any renamed rule |
| `$investigate_0` in `note` | `!{investigate{...}}` plugin string | leaves the literal `$investigate_0` in the alert |
| `[rule.threshold]` with a bare string `field` | an array | passes the string through |
| `[metadata]` / `[transform]` tables | nothing — repo-only | ships them into the payload |
| a UTF-8 BOM from a Windows editor | no BOM | crashes the TOML parser |

`rulepress` handles all of these, plus ES|QL rules, building blocks, and `[[rule.filters]]` (it defaults
`$state.store` to `appState` when absent, matching what the Kibana UI writes).

## What gets skipped

`elastic/detection-rules` uses `.toml` for three different things. Only the first is a Kibana rule:

- `[rule]` — a detection rule. Converted.
- `[hunt]` — a hunting query (`hunting/**`). A different schema Kibana will not import. Skipped, reported as `skip`.
- neither — build config such as `pyproject.toml`. Skipped.

Skipping is not a failure, so a full-repo run stays green.

## Validation

Each converted rule is checked for the things Kibana only tells you about with a generic 400:

- required fields (`name`, `rule_id`, `type`, `severity`, `risk_score`)
- `rule_id` is a real UUID
- `language` matches `type` (`eql`/`eql`, `esql`/`esql`, `kuery` or `lucene` for the rest)
- `index` present where the type needs it (ES|QL does not)
- `new_terms_fields` present for `new_terms`
- `threshold.value` present for `threshold`
- no repo-only leftovers (`metadata`, `transform`, `new_terms`, `meta`)
- every filter carries `$state.store` (defaulted, and flagged if it was missing)
- no unrendered `$osquery_N` / `$investigate_N` left in `note`

## Cross-platform

rulepress runs on Windows, Linux and macOS. That is enforced, not assumed:

- **CI runs the full suite on all three OSes** across Node 18, 20 and 22
  ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).
- **CI performs a real end-to-end conversion** and validates every NDJSON line, not just unit tests.
- **CI fails if any source file contains CRLF.** A CRLF shebang (`#!/usr/bin/env node\r`) makes the CLI fail on
  Linux with `bad interpreter: No such file or directory`. [`.gitattributes`](.gitattributes) pins LF for source
  and CRLF only for `.ps1` / `.cmd` / `.bat`.
- **Path handling uses `node:path` throughout**, so Windows backslashes and POSIX slashes both work.
- **`--open` picks the right command per OS**: `explorer` on Windows, `open` on macOS, `xdg-open` on Linux.

## Library use

```js
import { convertToml, validateRule, toNdjsonLine } from 'rulepress';
import fs from 'node:fs';

const { kind, rule, warnings } = convertToml(fs.readFileSync('rule.toml', 'utf8'), { source: 'rule.toml' });
if (kind !== 'rule') throw new Error(`not a detection rule: ${kind}`);

const { errors } = validateRule(rule, { source: 'rule.toml' });
if (errors.length) throw new Error(errors.join('\n'));

fs.writeFileSync('rule.ndjson', toNdjsonLine(rule) + '\n');
```

## Tested against the real repo

Run over all 2,629 TOML files in `elastic/detection-rules@main`:

```
2482 converted, 2 failed, 146 skipped
```

The 2 failures are genuine defects in that repo, not converter bugs — both `rule_id` values are 37 characters:

- `rules/_deprecated/exfiltration_rds_snapshot_export.toml` → `119c8877-8613-416d-a98a-96b6664ee73a5`
- `rules/windows/defense_evasion_modify_ownership_os_files.toml` → `7eb54028-ca72-4eb7-8185-b6864572347db`

Kibana would reject both too. `rulepress` catches them before the import does.

## Importing into Kibana

1. `rulepress rules/ --bundle rules.ndjson`
2. Kibana → **Security** → **Detection rules (SIEM)** → **Import rules**
3. Upload `rules.ndjson`

For a large pack, import in batches by directory (`rules/windows/`, `rules/linux/`, …) so one bad rule does not
block the rest.

## Development

```bash
npm install
npm test          # 61 tests
npm run lint      # syntax check
```

## License

MIT
