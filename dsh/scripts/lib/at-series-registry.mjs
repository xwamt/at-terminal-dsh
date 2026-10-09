/**
 * Reading the AT Series bridge registry (`~/.at-series/bridges/`).
 *
 * Shared by `enable-mcp.mjs` and `probe-hub.mjs` because both need the same answer
 * to the same question: **which host slug is live right now?**
 *
 * ## Why that question exists at all
 *
 * The Hub is host-scoped, and the scoping is a single environment variable:
 *
 * ```js
 * function resolveHostAppFromEnv(env) { return slugifyHostAppId(env[AT_SERIES_HOST_APP]) ?? 'unknown' }
 * ```
 *
 * (`AT_SERIES_HOST_APP` is the literal name in the shipped bundle.) The slug is the
 * directory a plugin's bridge records live under, and `slugifyHostAppId` just
 * lowercases and replaces runs of non-alphanumerics with `-`. There is **no
 * wildcard**: an unset variable resolves to `unknown`, which is a real directory —
 * so a Hub started without it silently serves the wrong bucket and reports
 * `healthyBridges: 0` for everything. Measuring that is what caught the first draft
 * of the MCP row, which omitted the variable and looked correct.
 *
 * The consequence is that the value has to be discovered, not assumed: whichever IDE
 * the user currently has AT Terminal running in is the one whose slug is correct.
 * `detectLiveHostAppId` picks the bucket with the freshest heartbeat, which is the
 * only signal available from outside the IDE.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The root the Hub and every AT Series plugin agree on. */
export function registryRoot() {
  return process.env.AT_SERIES_HOME ?? join(homedir(), '.at-series');
}

/** `slugifyHostAppId` from the shipped bundle, reproduced so we can validate a value. */
export function slugifyHostAppId(value) {
  if (typeof value !== 'string') return undefined;
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug.length > 0 ? slug : undefined;
}

function readRecord(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Every host bucket with what it currently holds.
 *
 * `freshestAt` is the newest heartbeat in the bucket, which is how liveness is
 * judged: a plugin republics on a timer, so a bucket whose newest record is old is a
 * bucket whose IDE has gone away.
 */
export function listHostBuckets() {
  const root = join(registryRoot(), 'bridges');
  let directories;
  try {
    directories = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return [];
  }

  const buckets = [];
  for (const directory of directories) {
    const dir = join(root, directory.name);
    let files;
    try {
      files = readdirSync(dir).filter((name) => name.endsWith('.json'));
    } catch {
      continue;
    }
    let freshestAt = 0;
    const providers = new Map();
    let malformed = 0;
    for (const file of files) {
      const record = readRecord(join(dir, file));
      if (record === undefined) {
        malformed += 1;
        continue;
      }
      if (typeof record.updatedAt === 'number' && record.updatedAt > freshestAt) {
        freshestAt = record.updatedAt;
      }
      if (typeof record.pluginId === 'string') {
        const existing = providers.get(record.pluginId);
        if (existing === undefined || (record.updatedAt ?? 0) > existing.updatedAt) {
          providers.set(record.pluginId, {
            pluginId: record.pluginId,
            pluginVersion: record.pluginVersion,
            toolCount: Array.isArray(record.tools) ? record.tools.length : 0,
            updatedAt: record.updatedAt ?? 0,
            pid: record.pid
          });
        }
      }
    }
    buckets.push({
      hostApp: directory.name,
      records: files.length,
      malformed,
      freshestAt,
      providers: [...providers.values()].sort((a, b) => a.pluginId.localeCompare(b.pluginId))
    });
  }
  return buckets.sort((a, b) => b.freshestAt - a.freshestAt);
}

/**
 * The host slug to hand the Hub: the bucket with the newest heartbeat, provided it
 * is recent enough to be a running IDE rather than abandoned records.
 *
 * `maxAgeMs` defaults to 10 minutes — an AT Series plugin heartbeats far more often
 * than that, and the 406 stale records on the machine this was written on were all
 * weeks old, so the gap between "live" and "abandoned" is not close.
 */
export function detectLiveHostAppId({ maxAgeMs = 10 * 60 * 1000, now = Date.now() } = {}) {
  const buckets = listHostBuckets();
  const live = buckets.find((bucket) => now - bucket.freshestAt <= maxAgeMs);
  return live === undefined ? undefined : { hostApp: live.hostApp, bucket: live };
}

/** One-line summary of a bucket, for the scripts' install checks. */
export function describeBucket(bucket) {
  if (bucket === undefined) return '(none)';
  const age = bucket.freshestAt === 0 ? 'never' : `${Math.round((Date.now() - bucket.freshestAt) / 1000)}s ago`;
  const fresh = bucket.providers.filter((provider) => Date.now() - provider.updatedAt <= 5 * 60 * 1000);
  const names = (fresh.length > 0 ? fresh : bucket.providers)
    .map((provider) => `${provider.pluginId}@${provider.pluginVersion}(${provider.toolCount})`)
    .join(', ');
  return `${bucket.records} record(s), newest heartbeat ${age} — ${names || '(no plugins)'}`;
}

/** True when the registry directory exists at all; used by the install checks. */
export function registryExists() {
  try {
    return statSync(join(registryRoot(), 'bridges')).isDirectory();
  } catch {
    return false;
  }
}
