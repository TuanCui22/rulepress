import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { convertToml, toNdjsonLine } from './convert.js';
import { validateRule } from './validate.js';
import { collectFiles, isToml, readText, ensureDir, writeTextSync, outputNameFor } from './fsutil.js';
import { loadConfig, writeConfig, shouldWrite, findOverwrites, CONFIG_NAME } from './config.js';
import { openDirectory, isInteractive } from './platform.js';

const HELP = `rulepress — press Elastic detection-rule TOML into Kibana NDJSON

USAGE
  rulepress <input...> [options]
  rulepress --init           create a config file in this folder

  <input> is one or more .toml files, or directories searched recursively.

OPTIONS
  -o, --out <dir>      Output directory (default: ./ndjson)
      --bundle <file>  Write every rule into one NDJSON file instead of one file per rule
      --dry-run        Show what would be written, write nothing
      --force          Overwrite existing output files without asking
      --watch          Re-convert whenever a .toml file changes (Ctrl+C to stop)
      --open           Open the output folder when finished
      --init           Create ${CONFIG_NAME} with default settings
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
  rulepress rules/ --bundle rules.ndjson
  rulepress rules/ --dry-run
  rulepress rules/ --bundle rules.ndjson --force --open
  rulepress rules/ --watch
  rulepress rules/ --check --json
`;

class UsageError extends Error {}

const BOOLEAN_FLAGS = {
  '--dry-run': 'dryRun',
  '--force': 'force',
  '--watch': 'watch',
  '--open': 'open',
  '--init': 'init',
  '--check': 'check',
  '--strict': 'strict',
  '--json': 'json',
  '-q': 'quiet',
  '--quiet': 'quiet',
  '-h': 'help',
  '--help': 'help',
  '-v': 'version',
  '--version': 'version',
};

const VALUE_FLAGS = {
  '-o': 'out',
  '--out': 'out',
  '--bundle': 'bundle',
};

export function parseArgs(argv) {
  const opts = {
    inputs: [],
    out: 'ndjson',
    bundle: null,
    dryRun: false,
    force: false,
    watch: false,
    open: false,
    init: false,
    check: false,
    strict: false,
    json: false,
    quiet: false,
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg in BOOLEAN_FLAGS) {
      opts[BOOLEAN_FLAGS[arg]] = true;
      continue;
    }

    if (arg in VALUE_FLAGS) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new UsageError(
          `option ${arg} needs a value.\n\n  Example: rulepress rules/ ${arg} ${arg === '--bundle' ? 'rules.ndjson' : 'build/'}`,
        );
      }
      opts[VALUE_FLAGS[arg]] = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('-')) {
      const suggestion = suggestFlag(arg);
      throw new UsageError(
        `unknown option ${arg}${suggestion ? `\n\n  Did you mean ${suggestion}?` : ''}\n\n  Run 'rulepress --help' to see all options.`,
      );
    }

    opts.inputs.push(arg);
  }

  return opts;
}

/** Closest known flag by edit distance, for "did you mean" hints. */
function suggestFlag(unknown) {
  const known = [...Object.keys(BOOLEAN_FLAGS), ...Object.keys(VALUE_FLAGS)];
  let best = null;
  let bestScore = Infinity;
  for (const candidate of known) {
    const score = editDistance(unknown.toLowerCase(), candidate.toLowerCase());
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  // Only suggest when it is plausibly a typo.
  return bestScore <= Math.max(2, Math.floor(unknown.length / 3)) ? best : null;
}

function editDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const grid = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) grid[i][0] = i;
  for (let j = 0; j < cols; j += 1) grid[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      grid[i][j] = Math.min(grid[i - 1][j] + 1, grid[i][j - 1] + 1, grid[i - 1][j - 1] + cost);
    }
  }
  return grid[rows - 1][cols - 1];
}

async function resolveInputs(inputs) {
  const files = [];
  for (const input of inputs) {
    const abs = path.resolve(input);
    let stat;
    try {
      stat = await import('node:fs/promises').then((m) => m.stat(abs));
    } catch {
      throw new UsageError(
        `input not found: ${input}\n\n` +
          `  Checked: ${abs}\n` +
          `  Tip: pass the folder that contains the .toml files, for example:\n` +
          `       rulepress ./detection-rules/rules`,
      );
    }
    if (stat.isDirectory()) {
      const found = await collectFiles(abs, isToml);
      if (found.length === 0) {
        throw new UsageError(
          `no .toml files found under ${input}\n\n` +
            `  That folder exists but contains no rules.\n` +
            `  Tip: point at the 'rules' subfolder of elastic/detection-rules.`,
        );
      }
      files.push(...found.map((f) => ({ file: f, root: abs })));
    } else if (isToml(abs)) {
      files.push({ file: abs, root: path.dirname(abs) });
    } else {
      throw new UsageError(
        `not a .toml file: ${input}\n\n  rulepress only converts Elastic detection-rule .toml files.`,
      );
    }
  }
  return files;
}

/** One conversion pass. Returns the report object. */
async function runOnce(targets, opts, { quietSkipped = false } = {}) {
  const report = { converted: 0, failed: 0, skipped: 0, written: 0, wouldWrite: 0, rules: [] };
  const bundleLines = [];
  const plannedWrites = [];

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
            plannedWrites.push({ path: outPath, line });
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

  // ---- overwrite protection -------------------------------------------
  // Check every target before writing anything, so a refusal never leaves a
  // half-written output directory behind.
  const allTargets = plannedWrites.map((p) => p.path);
  if (opts.bundle && bundleLines.length > 0) allTargets.push(path.resolve(opts.bundle));
  const overwrites = findOverwrites(allTargets);

  if (overwrites.length > 0 && !opts.force && !opts.dryRun) {
    const list = overwrites.slice(0, 5).map((f) => `    ${path.relative(process.cwd(), f)}`).join('\n');
    const more = overwrites.length > 5 ? `\n    … and ${overwrites.length - 5} more` : '';
    throw new UsageError(
      `${overwrites.length} output file(s) already exist:\n${list}${more}\n\n` +
        `  Nothing was written.\n` +
        `  Re-run with --force to overwrite, or pick another folder with -o.`,
    );
  }

  // ---- write ----------------------------------------------------------
  if (!opts.check && !opts.dryRun) {
    for (const { path: outPath, line } of plannedWrites) {
      await ensureDir(path.dirname(outPath));
      writeTextSync(outPath, `${line}\n`);
      report.written += 1;
    }
    if (opts.bundle && bundleLines.length > 0) {
      await ensureDir(path.dirname(path.resolve(opts.bundle)));
      writeTextSync(path.resolve(opts.bundle), `${bundleLines.join('\n')}\n`);
      report.written += 1;
    }
  } else if (opts.dryRun) {
    report.wouldWrite = plannedWrites.length + (opts.bundle && bundleLines.length > 0 ? 1 : 0);
  }

  return report;
}

function printReport(report, opts, { quietSkipped = false } = {}) {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (opts.quiet) return;

  for (const entry of report.rules) {
    if (entry.skipped) {
      if (!quietSkipped) {
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

  const parts = [`${report.converted} converted`, `${report.failed} failed`];
  if (report.skipped > 0) parts.push(`${report.skipped} skipped`);
  if (opts.check) parts.push('check only, nothing written');
  if (opts.dryRun) parts.push(`dry run, ${report.wouldWrite} file(s) would be written`);
  process.stdout.write(`\n${parts.join(', ')}\n`);
}

/** Re-run whenever a .toml under the inputs changes. */
async function watchLoop(inputs, opts) {
  const { watch } = await import('node:fs');
  process.stdout.write('watching for changes… (Ctrl+C to stop)\n');

  let running = false;
  let pending = false;

  const rebuild = async () => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      const targets = await resolveInputs(inputs);
      const report = await runOnce(targets, { ...opts, force: true }, { quietSkipped: true });
      const stamp = new Date().toLocaleTimeString();
      process.stdout.write(
        `[${stamp}] ${report.converted} converted, ${report.failed} failed, ${report.skipped} skipped\n`,
      );
    } catch (error) {
      process.stdout.write(`[${new Date().toLocaleTimeString()}] ${error.message}\n`);
    } finally {
      running = false;
      if (pending) {
        pending = false;
        await rebuild();
      }
    }
  };

  await rebuild();

  for (const input of inputs) {
    const abs = path.resolve(input);
    let target = abs;
    try {
      const stat = await import('node:fs/promises').then((m) => m.stat(abs));
      if (!stat.isDirectory()) target = path.dirname(abs);
    } catch {
      continue;
    }
    watch(target, { recursive: true }, (_event, filename) => {
      if (filename && isToml(filename)) void rebuild();
    });
  }

  // Keep the process alive until Ctrl+C.
  await new Promise(() => {});
}

export async function main(argv, { cwd = process.cwd(), interactive = isInteractive() } = {}) {
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

  // ---- --init ---------------------------------------------------------
  if (opts.init) {
    const result = await writeConfig(cwd, { force: opts.force });
    if (!result.ok) {
      process.stderr.write(
        `rulepress: ${CONFIG_NAME} ${result.reason} at ${result.path}\n\n` +
          `  Re-run with --force to replace it.\n`,
      );
      return 2;
    }
    process.stdout.write(`created ${path.relative(cwd, result.path) || CONFIG_NAME}\n`);
    process.stdout.write(`\nEdit it to set defaults, then run 'rulepress <input>'.\n`);
    return 0;
  }

  if (opts.inputs.length === 0) {
    process.stderr.write(
      `rulepress: no input given\n\n` +
        `  Point it at a folder of .toml rules:\n` +
        `    rulepress ./detection-rules/rules\n\n` +
        `  Or see all options:\n` +
        `    rulepress --help\n`,
    );
    return 2;
  }

  // ---- config defaults ------------------------------------------------
  const loaded = await loadConfig(cwd);
  if (loaded.error) {
    process.stderr.write(`rulepress: ${loaded.path}: ${loaded.error}\n`);
    return 2;
  }
  if (loaded.found) {
    if (loaded.config.out && !argv.some((a) => a === '-o' || a === '--out')) {
      opts.out = loaded.config.out;
    }
    if (loaded.config.bundle && !argv.includes('--bundle')) {
      opts.bundle = loaded.config.bundle;
    }
    if (loaded.config.strict === true) opts.strict = true;
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

  // ---- --watch --------------------------------------------------------
  if (opts.watch) {
    await watchLoop(opts.inputs, opts);
    return 0;
  }

  // ---- single pass ----------------------------------------------------
  let report;
  try {
    report = await runOnce(targets, opts);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`rulepress: ${error.message}\n`);
      return 2;
    }
    throw error;
  }

  printReport(report, opts);

  // ---- --open ---------------------------------------------------------
  if (opts.open && !opts.check && !opts.dryRun && report.failed === 0) {
    const target = opts.bundle ? path.dirname(path.resolve(opts.bundle)) : path.resolve(opts.out);
    const opened = await openDirectory(target);
    if (!opened.ok && !opts.quiet) {
      process.stderr.write(`rulepress: could not open ${target}: ${opened.reason}\n`);
    }
  }

  return report.failed > 0 ? 1 : 0;
}

export { runOnce, printReport, suggestFlag };
