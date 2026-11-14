import path from 'node:path';
import process from 'node:process';
import { convertToml, toNdjsonLine } from './convert.js';
import { validateRule } from './validate.js';
import { collectFiles, isToml, readText, ensureDir, writeTextSync, outputNameFor } from './fsutil.js';

const HELP = `rulepress — press Elastic detection-rule TOML into Kibana NDJSON

USAGE
  rulepress <input...> [options]

  <input> is one or more .toml files, or directories searched recursively.

OPTIONS
  -o, --out <dir>      Output directory (default: ./ndjson)
      --bundle <file>  Write every rule into one NDJSON file instead of one file per rule
      --check          Convert and validate only; write nothing
      --strict         Treat warnings as errors (recommended in CI)
      --json           Print a machine-readable report to stdout
  -q, --quiet          Only print errors
  -h, --help           Show this help
  -v, --version        Show the version

EXIT CODES
  0  all rules converted and valid
  1  at least one rule failed to convert or validate
  2  bad usage

EXAMPLES
  rulepress rules/
  rulepress rules/windows/defense_evasion_*.toml -o build/
  rulepress rules/ --bundle rules.ndjson --strict
  rulepress rules/ --check --json
`;

function parseArgs(argv) {
  const opts = {
    inputs: [],
    out: 'ndjson',
    bundle: null,
    check: false,
    strict: false,
    json: false,
    quiet: false,
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new UsageError(`option ${arg} needs a value`);
      }
      i += 1;
      return value;
    };

    switch (arg) {
      case '-o':
      case '--out':
        opts.out = next();
        break;
      case '--bundle':
        opts.bundle = next();
        break;
      case '--check':
        opts.check = true;
        break;
      case '--strict':
        opts.strict = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '-q':
      case '--quiet':
        opts.quiet = true;
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '-v':
      case '--version':
        opts.version = true;
        break;
      default:
        if (arg.startsWith('-')) throw new UsageError(`unknown option ${arg}`);
        opts.inputs.push(arg);
    }
  }

  return opts;
}

class UsageError extends Error {}

async function resolveInputs(inputs) {
  const files = [];
  for (const input of inputs) {
    const abs = path.resolve(input);
    let stat;
    try {
      stat = await import('node:fs/promises').then((m) => m.stat(abs));
    } catch {
      throw new UsageError(`input not found: ${input}`);
    }
    if (stat.isDirectory()) {
      const found = await collectFiles(abs, isToml);
      if (found.length === 0) {
        throw new UsageError(`no .toml files found under ${input}`);
      }
      files.push(...found.map((f) => ({ file: f, root: abs })));
    } else if (isToml(abs)) {
      files.push({ file: abs, root: path.dirname(abs) });
    } else {
      throw new UsageError(`not a .toml file: ${input}`);
    }
  }
  return files;
}

export async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`rulepress: ${error.message}\n\n${HELP}`);
      return 2;
    }
    throw error;
  }

  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }

  if (opts.version) {
    const pkg = await import('./version.js');
    process.stdout.write(`${pkg.VERSION}\n`);
    return 0;
  }

  if (opts.inputs.length === 0) {
    process.stderr.write(`rulepress: no input given\n\n${HELP}`);
    return 2;
  }

  let targets;
  try {
    targets = await resolveInputs(opts.inputs);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`rulepress: ${error.message}\n`);
      return 2;
    }
    throw error;
  }

  const report = { converted: 0, failed: 0, skipped: 0, rules: [] };
  const bundleLines = [];

  for (const { file, root } of targets) {
    const rel = path.relative(process.cwd(), file) || file;
    const entry = { source: rel, kind: null, name: null, rule_id: null, ok: false, errors: [], warnings: [] };

    try {
      const text = await readText(file);
      const converted = convertToml(text, { source: rel });
      entry.kind = converted.kind;

      if (converted.kind !== 'rule') {
        entry.ok = true;
        entry.skipped = true;
        report.skipped += 1;
        report.rules.push(entry);
        continue;
      }

      const { rule, warnings } = converted;
      const check = validateRule(rule, { source: rel });

      entry.name = rule.name ?? null;
      entry.rule_id = rule.rule_id ?? null;
      entry.warnings = [...warnings, ...check.warnings];
      entry.errors = check.errors;

      if (check.errors.length > 0 || (opts.strict && entry.warnings.length > 0)) {
        entry.ok = false;
        report.failed += 1;
      } else {
        entry.ok = true;
        report.converted += 1;

        if (!opts.check) {
          const line = toNdjsonLine(rule);
          if (opts.bundle) {
            bundleLines.push(line);
          } else {
            const outPath = path.join(opts.out, outputNameFor(file, root));
            await ensureDir(path.dirname(outPath));
            writeTextSync(outPath, `${line}\n`);
            entry.output = path.relative(process.cwd(), outPath);
          }
        }
      }
    } catch (error) {
      entry.errors = [error.message];
      report.failed += 1;
    }

    report.rules.push(entry);
  }

  if (opts.bundle && !opts.check && bundleLines.length > 0) {
    await ensureDir(path.dirname(path.resolve(opts.bundle)));
    writeTextSync(path.resolve(opts.bundle), `${bundleLines.join('\n')}\n`);
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (!opts.quiet) {
    for (const entry of report.rules) {
      if (entry.skipped) {
        if (!opts.quietSkipped) {
          process.stdout.write(`skip ${entry.source} (${entry.kind === 'hunt' ? 'hunting query' : 'not a rule'})\n`);
        }
      } else if (entry.ok) {
        const target = entry.output ? ` -> ${entry.output}` : '';
        process.stdout.write(`ok   ${entry.source}${target}\n`);
        for (const warning of entry.warnings) {
          process.stdout.write(`     warn: ${warning}\n`);
        }
      } else {
        process.stdout.write(`FAIL ${entry.source}\n`);
        for (const error of entry.errors) {
          process.stdout.write(`     error: ${error}\n`);
        }
        for (const warning of entry.warnings) {
          process.stdout.write(`     warn: ${warning}\n`);
        }
      }
    }
    const suffix = opts.check ? ' (check only, nothing written)' : '';
    const skipped = report.skipped > 0 ? `, ${report.skipped} skipped` : '';
    process.stdout.write(`\n${report.converted} converted, ${report.failed} failed${skipped}${suffix}\n`);
  }

  return report.failed > 0 ? 1 : 0;
}
