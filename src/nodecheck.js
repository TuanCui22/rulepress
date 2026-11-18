/**
 * Node version gate.
 *
 * `engines` in package.json is advisory: npm only warns, and `node bin/...`
 * bypasses npm entirely. A user on Node 16 gets an obscure syntax error from
 * ESM or `node:test` instead of being told what is wrong. This module turns
 * that into one clear sentence.
 */

export const MIN_MAJOR = 18;

/** Parse "18.19.0" / "v20.11.1" into a major number. Returns null if unparseable. */
export function majorOf(version) {
  if (typeof version !== 'string') return null;
  const match = version.trim().match(/^v?(\d+)/);
  return match ? Number(match[1]) : null;
}

/**
 * Check a version string against the minimum.
 * Returns { ok: true } or { ok: false, message }.
 */
export function checkNodeVersion(version, minMajor = MIN_MAJOR) {
  const major = majorOf(version);
  if (major === null) {
    return {
      ok: false,
      message: `Could not read the Node version (got "${version}"). rulepress needs Node ${minMajor} or newer.`,
    };
  }
  if (major < minMajor) {
    return {
      ok: false,
      message:
        `rulepress needs Node ${minMajor} or newer, but this is Node ${major}.\n` +
        `\n` +
        `  Fix it one of these ways:\n` +
        `    - Install a newer Node from https://nodejs.org (LTS is fine)\n` +
        `    - Or with nvm:  nvm install ${minMajor} && nvm use ${minMajor}\n` +
        `    - Or with fnm:  fnm install ${minMajor} && fnm use ${minMajor}\n` +
        `\n` +
        `  Then check with:  node --version`,
    };
  }
  return { ok: true, major };
}

/** Throws with a friendly message when the running Node is too old. */
export function assertNodeVersion(version = process.version, minMajor = MIN_MAJOR) {
  const result = checkNodeVersion(version, minMajor);
  if (!result.ok) {
    const error = new Error(result.message);
    error.code = 'ERR_NODE_VERSION';
    throw error;
  }
  return result.major;
}
