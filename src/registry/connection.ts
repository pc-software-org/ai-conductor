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

export class DownstreamConnection {
  state: ConnState = 'connecting';
  error?: string;
  capabilities: Capabilities = { tools: [], resources: [], prompts: [] };
  readonly client: Client;

  constructor(
    readonly def: ServerDefinition,
    private readonly transportFactory: TransportFactory,
    private readonly onChange?: () => void,
  ) {
    this.client = new Client({ name: 'ai-conductor', version: VERSION });
  }

  async connect(): Promise<void> {
    this.state = 'connecting';
    try {
      const transport = await this.transportFactory(this.def);
      await this.client.connect(transport);
      this.client.onclose = () => {
        if (this.state === 'connected') this.state = 'disconnected';
        this.onChange?.();
      };
      this.registerNotificationHandlers();
      await this.refresh();
      this.state = 'connected';
    } catch (err) {
      this.state = 'error';
      this.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  private registerNotificationHandlers(): void {
    const refreshAndNotify = async () => {
      await this.refresh().catch(() => undefined);
      this.onChange?.();
    };
    this.client.setNotificationHandler(ToolListChangedNotificationSchema, refreshAndNotify);
    this.client.setNotificationHandler(ResourceListChangedNotificationSchema, refreshAndNotify);
    this.client.setNotificationHandler(PromptListChangedNotificationSchema, refreshAndNotify);
  }

  async refresh(): Promise<void> {
    const caps = this.client.getServerCapabilities() ?? {};
    this.capabilities = {
      tools: caps.tools ? (await this.client.listTools()).tools : [],
      resources: caps.resources ? (await this.client.listResources()).resources : [],
      prompts: caps.prompts ? (await this.client.listPrompts()).prompts : [],
    };
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
    this.state = 'disconnected';
  }
}
