import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Read the dispatcher build id this package ships, so a stale installed plugin can be flagged. */
export function readExpectedExtensionBuildId(
  packageRoot = fileURLToPath(new URL('../../', import.meta.url)),
): string | undefined {
  // ponytail: manifest first (published package), dispatcher.meta.json second (source checkout).
  for (const [file, key] of [
    ['easyeda-bridge-extension.checksums.json', 'dispatcherBuildId'],
    ['easyeda-bridge-extension/dist/dispatcher.meta.json', 'buildId'],
  ] as const) {
    try {
      const value = (JSON.parse(readFileSync(join(packageRoot, file), 'utf8')) as Record<string, unknown>)[key];
      if (typeof value === 'string' && value) return value;
    } catch {
      // fall through to the next source
    }
  }
  return undefined;
}
