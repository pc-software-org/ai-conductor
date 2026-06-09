import { describe, it, expect } from 'vitest';
import { DownstreamManager } from '../src/registry/manager.js';
import { makeEchoServer } from './helpers/echoServer.js';

function factoryFor(transports: Record<string, any>) {
  return async (def: { id: string }) => {
    const t = transports[def.id];
    if (!t) throw new Error(`no transport for ${def.id}`);
    return t;
  };
}

describe('DownstreamManager', () => {
  it('starts enabled servers and lists their info', async () => {
    const a = await makeEchoServer('A');
    const mgr = new DownstreamManager(factoryFor({ srvA: a.clientTransport }));
    await mgr.start([{ id: 'srvA', enabled: true, transport: { type: 'stdio', command: 'x', args: [], env: {} } }]);
    expect(mgr.list()).toEqual([
      expect.objectContaining({ id: 'srvA', state: 'connected', toolCount: 1 }),
    ]);
    await mgr.closeAll();
  });

  it('add() connects and remove() disconnects', async () => {
    const b = await makeEchoServer('B');
    const mgr = new DownstreamManager(factoryFor({ srvB: b.clientTransport }));
    await mgr.add({ id: 'srvB', enabled: true, transport: { type: 'stdio', command: 'x', args: [], env: {} } });
    expect(mgr.get('srvB')?.state).toBe('connected');
    await mgr.remove('srvB');
    expect(mgr.get('srvB')).toBeUndefined();
  });

  it('a failing connect leaves the manager usable (error state, not a throw that kills others)', async () => {
    const c = await makeEchoServer('C');
    const mgr = new DownstreamManager(factoryFor({ srvC: c.clientTransport })); // srvBad has no transport
    await mgr.start([
      { id: 'srvBad', enabled: true, transport: { type: 'stdio', command: 'x', args: [], env: {} } },
      { id: 'srvC', enabled: true, transport: { type: 'stdio', command: 'x', args: [], env: {} } },
    ]);
    const info = mgr.list();
    expect(info.find((i) => i.id === 'srvBad')?.state).toBe('error');
    expect(info.find((i) => i.id === 'srvC')?.state).toBe('connected');
    await mgr.closeAll();
  });
});
