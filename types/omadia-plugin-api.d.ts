/**
 * Local type stubs for `@omadia/plugin-api`.
 *
 * The real package is provided by the Omadia host at runtime — it is NOT
 * published to npm, so you do not (and cannot) `npm install` it. These ambient
 * declarations mirror the host's public surface closely enough to compile this
 * plugin offline. At runtime the host injects the genuine implementations.
 *
 * Kept in sync with the Omadia version this plugin targets — in particular the
 * `net` accessor (raw-TCP egress), which a recent core revision adds alongside
 * `http`. Guard usage with `if (ctx.net)` so the plugin still loads on an older
 * core that predates it.
 */
declare module '@omadia/plugin-api' {
  export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

  /** Vault-backed secrets declared as `type: secret` setup fields. */
  export interface SecretsAccessor {
    /** Returns the secret, or `undefined` if it was never set. */
    get(name: string): Promise<string | undefined>;
    /** Returns the secret, or throws if missing. */
    require(name: string): Promise<string>;
  }

  /** Plain (non-secret) setup fields from the manifest `setup.fields`. */
  export interface ConfigAccessor {
    get<T = string>(name: string): T | undefined;
  }

  /** Cross-plugin service registry. Keys are strings; contracts are by convention. */
  export interface ServicesAccessor {
    get<T>(name: string): T | undefined;
    has(name: string): boolean;
    provide<T>(name: string, impl: T): () => void;
    replace<T>(name: string, impl: T): () => void;
  }

  /** A native tool the orchestrator can call. Mirror this under manifest `capabilities`. */
  export interface NativeToolSpec {
    readonly name: string;
    readonly description: string;
    readonly input_schema: {
      readonly type: 'object';
      readonly properties: Record<string, unknown>;
      readonly required?: readonly string[];
    };
    readonly domain?: string;
  }

  /** A native tool ALWAYS returns a string (commonly JSON the model reads). */
  export type NativeToolHandler = (input: unknown) => Promise<string>;

  export interface ToolsAccessor {
    register(spec: NativeToolSpec, handler: NativeToolHandler): void;
  }

  export interface RoutesAccessor {
    register(prefix: string, router: unknown): () => void;
  }

  export interface UiRoutesAccessor {
    register(prefix: string, router: unknown): () => void;
  }

  export interface HttpResponse {
    readonly status: number;
    readonly ok: boolean;
    readonly headers: Record<string, string>;
    text(): Promise<string>;
    json<T = unknown>(): Promise<T>;
    arrayBuffer(): Promise<ArrayBuffer>;
  }

  /**
   * Allow-listed outbound HTTP. Present only when the manifest declares
   * `permissions.network.outbound`. All traffic is gated against that list.
   */
  export interface HttpAccessor {
    fetch(
      url: string,
      init?: { method?: string; headers?: Record<string, string>; body?: string },
    ): Promise<HttpResponse>;
  }

  /** Raw outbound TCP connection options for `ctx.net.connect`. */
  export interface NetConnectOptions {
    readonly host: string;
    readonly port: number;
    /** true → kernel performs the TLS handshake and resolves with an already
     *  encrypted socket (implicit TLS / SMTPS :465). false/omitted → a plain
     *  TCP socket the caller may upgrade itself (STARTTLS :587). */
    readonly tls?: boolean;
    /** TLS SNI servername; defaults to `host`. Ignored when `tls` is falsy. */
    readonly servername?: string;
  }

  /**
   * Allow-listed raw-TCP egress for line protocols `ctx.http` cannot speak
   * (SMTP/IMAP/…). Present only when the manifest declares
   * `permissions.network.outbound_tcp` and the referenced operator config
   * resolves to a concrete host:port. Every `connect` is pinned to that exact
   * allow-listed target.
   */
  export interface NetAccessor {
    connect(options: NetConnectOptions): Promise<import('node:net').Socket>;
  }

  export interface NotificationsAccessor {
    send(message: string, context?: Record<string, unknown>): Promise<void>;
  }

  export interface JobsAccessor {
    schedule(name: string, cron: string, handler: () => Promise<void>): () => void;
  }

  export interface ScratchDirAccessor {
    readonly path: string;
  }

  export interface MemoryAccessor {
    [key: string]: unknown;
  }
  export interface KnowledgeGraphAccessor {
    [key: string]: unknown;
  }
  export interface LlmAccessor {
    [key: string]: unknown;
  }
  export interface SubAgentAccessor {
    [key: string]: unknown;
  }

  /**
   * The single argument the host passes to a plugin's `activate(ctx)`. Every
   * external effect (secrets, network, filesystem, memory, graph, LLM) flows
   * through a `ctx` accessor scoped by the plugin's manifest permissions.
   */
  export interface PluginContext {
    readonly agentId: string;
    readonly domain: string;
    readonly secrets: SecretsAccessor;
    readonly config: ConfigAccessor;
    readonly services: ServicesAccessor;
    readonly smokeMode: boolean;
    readonly tools: ToolsAccessor;
    readonly routes: RoutesAccessor;
    readonly uiRoutes: UiRoutesAccessor;
    readonly notifications: NotificationsAccessor;
    readonly jobs: JobsAccessor;
    readonly scratch?: ScratchDirAccessor;
    readonly http?: HttpAccessor;
    readonly net?: NetAccessor;
    readonly memory?: MemoryAccessor;
    readonly knowledgeGraph?: KnowledgeGraphAccessor;
    readonly llm?: LlmAccessor;
    readonly subAgent?: SubAgentAccessor;
    log(...args: unknown[]): void;
  }
}
