/**
 * PiG runtime adapter contract.
 *
 * The ZCode services layer depends on this boundary rather than the PiG wire
 * format. A request is complete only when PiG returns a correlated response;
 * asynchronous agent events are delivered through `subscribe`.
 */
export type PigRuntimeId = string & { readonly __brand: "PigRuntimeId" };

export type PigRuntimeState = "starting" | "ready" | "stopping" | "exited" | "failed";

export interface PigRpcErrorShape {
  readonly code?: string;
  readonly message: string;
  readonly details?: unknown;
}

export interface PigRuntimeEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface PigRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface PigRuntimeContract {
  /** Start the owned PiG process. Calling start twice is idempotent. */
  start(): Promise<void>;
  /** Send one command and resolve only its correlated response data. */
  request<T = unknown>(
    command: string,
    params?: Record<string, unknown>,
    options?: PigRequestOptions,
  ): Promise<T>;
  /** Subscribe to PiG notifications and runtime lifecycle events. */
  subscribe(listener: (event: PigRuntimeEvent) => void): () => void;
  /** Read the current local process state without causing I/O. */
  getState(): PigRuntimeState;
  /** Stop the owned process and reject all outstanding requests. */
  shutdown(): Promise<void>;
}

export class PigRpcError extends Error {
  readonly code: string | undefined;
  readonly details: unknown;

  constructor(error: PigRpcErrorShape, options: { cause?: unknown } = {}) {
    super(error.message, options);
    this.name = "PigRpcError";
    this.code = error.code;
    this.details = error.details;
  }
}

export class PigRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "PigRuntimeError";
    this.code = code;
  }
}
