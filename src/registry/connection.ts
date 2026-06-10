import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  ToolListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { VERSION } from '../version.js';
import type { ServerDefinition } from '../config/schema.js';
import type { Capabilities, ConnState } from '../types.js';

export type TransportFactory = (def: ServerDefinition) => Promise<Transport>;

export interface ConnectionOptions {
  idleMs?: number; // 0 disables idle eviction (keep-warm)
  onChange?: () => void; // called when capabilities change (caller persists + notifies upstream)
  cachedCaps?: Capabilities; // hydrate for advertising while still idle
}

const EMPTY: Capabilities = { tools: [], resources: [], prompts: [] };

export class DownstreamConnection {
  state: ConnState = 'idle';
  error?: string;
  capabilities: Capabilities;
  hydrated: boolean; // true while capabilities come from cache (not a live fetch)

  private readonly idleMs: number;
  private readonly onChange?: () => void;
  private client?: Client;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private connecting?: Promise<void>;

  constructor(
    readonly def: ServerDefinition,
    private readonly transportFactory: TransportFactory,
    opts: ConnectionOptions = {},
  ) {
    this.capabilities = opts.cachedCaps ?? { ...EMPTY };
    this.hydrated = opts.cachedCaps !== undefined;
    this.idleMs = opts.idleMs ?? 0;
    this.onChange = opts.onChange;
  }

  // Connect if not already connected. Concurrent callers share one in-flight connect.
  // Every call (re)starts the idle timer.
  async ensureConnected(): Promise<void> {
    this.touch();
    if (this.state === 'connected') return;
    if (!this.connecting) {
      this.connecting = this.doConnect().finally(() => {
        this.connecting = undefined;
      });
    }
    return this.connecting;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    await this.ensureConnected();
    this.touch();
    return this.client!.callTool({ name, arguments: args });
  }

  async readResource(uri: string): Promise<any> {
    await this.ensureConnected();
    this.touch();
    return this.client!.readResource({ uri });
  }

  async getPrompt(name: string, args: Record<string, unknown>): Promise<any> {
    await this.ensureConnected();
    this.touch();
    return this.client!.getPrompt({ name, arguments: args as Record<string, string> });
  }

  async refresh(): Promise<boolean> {
    const before = JSON.stringify(this.capabilities);
    const caps = this.client!.getServerCapabilities() ?? {};
    this.capabilities = {
      tools: caps.tools ? (await this.client!.listTools()).tools : [],
      resources: caps.resources ? (await this.client!.listResources()).resources : [],
      prompts: caps.prompts ? (await this.client!.listPrompts()).prompts : [],
    };
    return JSON.stringify(this.capabilities) !== before;
  }

  async close(): Promise<void> {
    this.clearIdle();
    await this.client?.close().catch(() => undefined);
    this.client = undefined;
    // Back to idle: capabilities stay in memory for advertising and we can reconnect.
    if (this.state !== 'error') this.state = 'idle';
  }

  private async doConnect(): Promise<void> {
    this.state = 'connecting';
    // Fresh client per connect — a closed Client is not reusable after idle eviction.
    const client = new Client({ name: 'ai-conductor', version: VERSION });
    try {
      const transport = await this.transportFactory(this.def);
      await client.connect(transport);
      this.client = client;
      client.onclose = () => {
        if (this.state === 'connected') this.state = 'idle';
        this.onChange?.();
      };
      this.registerNotificationHandlers(client);
      const changed = await this.refresh();
      this.state = 'connected';
      this.error = undefined;
      this.hydrated = false;
      this.touch();
      if (changed) this.onChange?.();
    } catch (err) {
      this.state = 'error';
      this.error = err instanceof Error ? err.message : String(err);
      await client.close().catch(() => undefined);
      this.client = undefined;
      throw err;
    }
  }

  private registerNotificationHandlers(client: Client): void {
    const refreshAndNotify = async () => {
      await this.refresh().catch(() => undefined);
      this.onChange?.();
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, refreshAndNotify);
    client.setNotificationHandler(ResourceListChangedNotificationSchema, refreshAndNotify);
    client.setNotificationHandler(PromptListChangedNotificationSchema, refreshAndNotify);
  }

  private touch(): void {
    this.clearIdle();
    if (this.idleMs > 0) {
      this.idleTimer = setTimeout(() => {
        void this.close();
      }, this.idleMs);
      this.idleTimer.unref?.();
    }
  }

  private clearIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }
}
