import { describe, it, expect } from 'vitest';
import { DownstreamConnection } from '../src/registry/connection.js';
import { makeEchoServer } from './helpers/echoServer.js';

describe('DownstreamConnection', () => {
  it('connects, fetches capabilities, and routes a tool call', async () => {
    const { clientTransport } = await makeEchoServer('A');
    const conn = new DownstreamConnection(
      { id: 'srvA', enabled: true, transport: { type: 'stdio', command: 'unused', args: [], env: {} } },
      async () => clientTransport, // injected transport factory
    );
    await conn.connect();
    expect(conn.state).toBe('connected');
    expect(conn.capabilities.tools.map((t) => t.name)).toContain('echo');
    expect(conn.capabilities.resources.map((r) => r.uri)).toContain('mem://greeting');
    expect(conn.capabilities.prompts.map((p) => p.name)).toContain('greet');

    const res = await conn.client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    expect((res.content as { text: string }[])[0].text).toBe('A:hi');
    await conn.close();
    expect(conn.state).toBe('disconnected');
  });
});
