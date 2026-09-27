/**
 * The corner of the Workers runtime API that durable.ts touches.
 *
 * Declared by hand rather than by adding @cloudflare/workers-types: that package
 * redefines Request, Response and friends globally, which would fight the Node types
 * the rest of this project (and its tests) compile against. Only Worker-only files may
 * import 'cloudflare:workers' — Node cannot resolve it.
 */
declare module 'cloudflare:workers' {
  export interface DurableObjectStorage {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put<T>(entries: Record<string, T>): Promise<void>;
    delete(keys: string[]): Promise<number>;
    list<T = unknown>(options?: { prefix?: string; limit?: number; reverse?: boolean }): Promise<Map<string, T>>;
    deleteAll(): Promise<void>;
    getAlarm(): Promise<number | null>;
    setAlarm(scheduledTime: number | Date): Promise<void>;
  }

  export interface DurableObjectState {
    readonly storage: DurableObjectStorage;
  }

  /** The Worker's bindings, readable at module scope — before any request arrives. */
  export const env: unknown;

  export abstract class DurableObject<Env = unknown> {
    protected readonly ctx: DurableObjectState;
    protected readonly env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}
