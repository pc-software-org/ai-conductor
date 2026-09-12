import { describe, it, expect, vi, afterEach } from 'vitest';
import { DownstreamConnection } from '../src/registry/connection.js';
import { makeEchoServer } from './helpers/echoServer.js';
import type { ServerDefinition } from '../src/config/schema.js';

const def: ServerDefinition = { id: 'srvA', enabled: true, autoRetry: true, transport: { type: 'stdio', command: 'x', args: [], env: {} } };

afterEach(() => vi.useRealTimers());

describe('DownstreamConnection', () => {
  it('starts idle and hydrates capabilities from cache for advertising', () => {
    const conn = new DownstreamConnection(def, async () => { throw new Error('should not connect'); }, {
      cachedCaps: { tools: [{ name: 'echo' } as any], resources: [], prompts: [] },
    });
    expect(conn.state).toBe('idle');
    expect(conn.hydrated).toBe(true);
    expect(conn.capabilities.tools.map((t) => t.name)).toEqual(['echo']);
  });

  it('ensureConnected connects, fetches caps, and routes a tool call', async () => {
    const { clientTransport } = await makeEchoServer('A');
    const conn = new DownstreamConnection(def, async () => clientTransport);
    await conn.ensureConnected();
    expect(conn.state).toBe('connected');
    expect(conn.hydrated).toBe(false);
    expect(conn.capabilities.tools.map((t) => t.name)).toContain('echo');
    const res = await conn.callTool('echo', { text: 'hi' });
    expect((res.content as { text: string }[])[0].text).toBe('A:hi');
  });

  it('dedupes concurrent ensureConnected into a single connect', async () => {
    const { clientTransport } = await makeEchoServer('A');
    let calls = 0;
    const conn = new DownstreamConnection(def, async () => { calls++; return clientTransport; });
    await Promise.all([conn.ensureConnected(), conn.ensureConnected(), conn.ensureConnected()]);
    expect(calls).toBe(1);
    expect(conn.state).toBe('connected');
  });

  it('evicts itself to idle after the idle timeout, then reconnects on next access', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const conn = new DownstreamConnection(def, async () => { calls++; return (await makeEchoServer('A')).clientTransport; }, { idleMs: 1000 });
    await conn.ensureConnected();
    expect(conn.state).toBe('connected');
    await vi.advanceTimersByTimeAsync(1001);
    expect(conn.state).toBe('idle');
    await conn.ensureConnected();
    expect(conn.state).toBe('connected');
    expect(calls).toBe(2);
  });

  it('records error state when the transport fails (does not throw out of callTool path)', async () => {
    const conn = new DownstreamConnection(def, async () => { throw new Error('boom'); });
    await expect(conn.ensureConnected()).rejects.toThrow('boom');
    expect(conn.state).toBe('error');
    expect(conn.error).toContain('boom');
  });

  it('retries a failed stdio connect exactly once, then succeeds', async () => {
    let attempts = 0;
    const conn = new DownstreamConnection(def, async () => {
      attempts++;
      if (attempts === 1) throw new Error('spawn failed');
      return (await makeEchoServer('A')).clientTransport;
    });

    await conn.ensureConnected();

    expect(conn.state).toBe('connected');
    expect(attempts).toBe(2);
    expect(conn.error).toBeUndefined();
  });

  it('gives up after the single stdio retry instead of looping', async () => {
    let attempts = 0;
    const conn = new DownstreamConnection(def, async () => {
      attempts++;
      throw new Error('spawn failed');
    });

    await expect(conn.ensureConnected()).rejects.toThrow('spawn failed');

    expect(attempts).toBe(2); // genau ein Wiederholungsversuch, kein Dauerloop
    expect(conn.state).toBe('error');
  });

  it('does not retry a remote (http) connect — the downstream is not ours to restart', async () => {
    const httpDef: ServerDefinition = {
      id: 'srvHttp',
      enabled: true,
      transport: { type: 'http', url: 'https://example.invalid/mcp', headers: {} },
    };
    let attempts = 0;
    const conn = new DownstreamConnection(httpDef, async () => {
      attempts++;
      throw new Error('unreachable');
    });

    await expect(conn.ensureConnected()).rejects.toThrow('unreachable');

    expect(attempts).toBe(1);
    expect(conn.state).toBe('error');
  });

  it('skips the retry when autoRetry is switched off for that server', async () => {
    const noRetryDef: ServerDefinition = { ...def, autoRetry: false };
    let attempts = 0;
    const conn = new DownstreamConnection(noRetryDef, async () => {
      attempts++;
      throw new Error('spawn failed');
    });

    await expect(conn.ensureConnected()).rejects.toThrow('spawn failed');

    expect(attempts).toBe(1);
    expect(conn.state).toBe('error');
  });
});
