# Quickstart — from zero to rules in Kibana

Five steps, about five minutes. No prior knowledge of the Elastic repo needed.

If you already have Node 18+ and just want the command, skip to [step 2](#step-2--install-rulepress).

---

## Step 1 — Install Node.js

rulepress needs Node 18 or newer. Check what you have:

```bash
node --version
```

If that prints `v18.x`, `v20.x`, `v22.x` or higher, you are done with this step.

**Windows**

```powershell
winget install OpenJS.NodeJS.LTS
```

Or download the LTS installer from <https://nodejs.org>.

**Linux (Debian/Ubuntu)**

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**Linux (Fedora/RHEL)**

```bash
sudo dnf install nodejs
```

**macOS**

```bash
brew install node
```

Close and reopen your terminal, then confirm `node --version` shows 18 or higher.

---

## Step 2 — Install rulepress

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/TuanCui22/rulepress/master/install.ps1 | iex
```

If PowerShell refuses to run it:

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/TuanCui22/rulepress/master/install.ps1 | iex"
```

**Linux / macOS**

```bash
curl -fsSL https://raw.githubusercontent.com/TuanCui22/rulepress/master/install.sh | bash
```

**Any OS, if you already cloned the repo**

```bash
npm install -g .
```

Confirm it worked:

```bash
rulepress --version
```

You should see a version number like `2.0.0`. If you see "command not found", the npm global bin folder is not on your PATH — the installer prints the exact line to add.

---

## Step 3 — Get the Elastic rules

You need the TOML rule files. Clone the repo (shallow clone is enough):

```bash
git clone --depth 1 https://github.com/elastic/detection-rules.git
```

No git? Download the ZIP from <https://github.com/elastic/detection-rules/archive/refs/heads/main.zip> and unzip it.

The rules live in `detection-rules/rules/`. That is the folder you point rulepress at.

---

## Step 4 — Convert

Point rulepress at the `rules` folder:

```bash
rulepress detection-rules/rules --bundle rules.ndjson
```

What you will see:

```
ok   detection-rules/rules/linux/defense_evasion_binary_copied_to_suspicious_directory.toml
ok   detection-rules/rules/linux/discovery_account_discovery_via_builtin_tools.toml
...
skip detection-rules/hunting/aws/queries/ec2_discovery.toml (hunting query)

2493 converted, 2 failed, 146 skipped
```

- **converted** — ready to import
- **failed** — a real defect in the rule (the two failures are known bugs in the Elastic repo, both malformed `rule_id` values)
- **skipped** — hunting queries and build config, which Kibana cannot import anyway

### Useful variations

```bash
# Look before you leap: show what would happen, write nothing
rulepress detection-rules/rules --bundle rules.ndjson --dry-run

# Only Linux rules
rulepress detection-rules/rules/linux --bundle linux.ndjson

# One file per rule instead of a bundle
rulepress detection-rules/rules -o ndjson/

# Rebuild automatically while you edit rules
rulepress detection-rules/rules --bundle rules.ndjson --watch
```

---

## Step 5 — Import into Kibana

1. Open Kibana → **Security** → **Detection rules (SIEM)**
2. Click **Import rules**
3. Drop in `rules.ndjson`
4. Review the summary, then confirm

For a large pack, import in batches by folder (`rules/linux/`, `rules/windows/`, …) so one bad rule does not block the rest.

---

## Common problems

### `rulepress: command not found`

npm's global bin folder is not on your PATH.

```bash
# Linux / macOS
echo 'export PATH="$(npm prefix -g)/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc

# Windows PowerShell
$env:Path += ";$(npm prefix -g)"
```

### `rulepress needs Node 18 or newer`

Your Node is too old. Install a newer one (step 1) and reopen the terminal.

### `no .toml files found under ...`

You pointed at the repo root instead of the rules folder. Use `detection-rules/rules`.

### `5 output file(s) already exist`

rulepress will not silently overwrite your previous output. Either add `--force`, or write somewhere else with `-o build/`.

### Kibana rejects the import

Check which rule failed and why:

```bash
rulepress detection-rules/rules --check --json | grep -A3 '"ok": false'
```

Then import everything except that rule.

### The output looks wrong or empty

Run with `--dry-run` first to see what it plans to write, and `--check` to validate without writing.

---

## What next

- Full option list: `rulepress --help`
- Set project defaults: `rulepress --init` creates `rulepress.config.json`
- Use it as a library: see the "Library use" section of the [README](README.md)
- Wire it into CI: `rulepress rules/ --check --strict` exits non-zero on any problem
