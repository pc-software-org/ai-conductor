import { describe, it, expect, vi } from 'vitest';
import { installShutdownHandlers } from '../src/index.js';

// A minimal stand-in for the bits of `process` that installShutdownHandlers touches,
// so we can drive the registered signal handlers synchronously in a test.
function fakeProc() {
  const handlers: Record<string, (signal: string) => unknown> = {};
  return {
    on: (signal: string, fn: (signal: string) => unknown) => {
      handlers[signal] = fn;
    },
    exit: vi.fn(),
    emit: (signal: string) => handlers[signal]?.(signal),
  };
}

describe('installShutdownHandlers', () => {
  it('calls manager.closeAll() and exits cleanly on SIGTERM', async () => {
    const closeAll = vi.fn().mockResolvedValue(undefined);
    const proc = fakeProc();

    installShutdownHandlers({ manager: { closeAll } as never }, proc);
    await proc.emit('SIGTERM');

    expect(closeAll).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledWith(0);
  });

  it('registers handlers for both SIGINT and SIGTERM', async () => {
    const closeAll = vi.fn().mockResolvedValue(undefined);
    const proc = fakeProc();

    installShutdownHandlers({ manager: { closeAll } as never }, proc);
    await proc.emit('SIGINT');

    expect(closeAll).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledWith(0);
  });

  it('is idempotent: a second signal does not close again', async () => {
    const closeAll = vi.fn().mockResolvedValue(undefined);
    const proc = fakeProc();

    installShutdownHandlers({ manager: { closeAll } as never }, proc);
    await proc.emit('SIGINT');
    await proc.emit('SIGTERM');

    expect(closeAll).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledTimes(1);
  });
});
