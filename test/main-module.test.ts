import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainModule } from '../src/index.js';

describe('isMainModule', () => {
  let dir: string;
  let real: string;
  let link: string;

  beforeEach(() => {
    // realpathSync the tmp dir itself (macOS /tmp is a symlink to /private/tmp).
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'mainmod-')));
    real = join(dir, 'real.js');
    link = join(dir, 'link.js');
    writeFileSync(real, '// entry');
    symlinkSync(real, link);
  });

  it('true when argv1 is the same file as the module url', () => {
    expect(isMainModule(real, pathToFileURL(real).href)).toBe(true);
  });

  it('true when argv1 is a SYMLINK to the module file (npm/npx bin case)', () => {
    // import.meta.url resolves to the real path; argv1 is the symlink the bin was invoked as.
    expect(isMainModule(link, pathToFileURL(real).href)).toBe(true);
  });

  it('false for an unrelated path', () => {
    expect(isMainModule(join(dir, 'other.js'), pathToFileURL(real).href)).toBe(false);
  });

  it('false when argv1 is undefined', () => {
    expect(isMainModule(undefined, pathToFileURL(real).href)).toBe(false);
  });
});
