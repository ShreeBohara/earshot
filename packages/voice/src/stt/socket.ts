// The seams adapters run on: a minimal WebSocket and a clock. Production uses the browser's
// WebSocket and timers; tests pass a fake server's sockets and fake timers.

export const SOCKET_CONNECTING = 0;
export const SOCKET_OPEN = 1;
export const SOCKET_CLOSING = 2;
export const SOCKET_CLOSED = 3;

/** A received message: text as a string, binary as an ArrayBuffer. */
export interface SocketMessageEvent {
  readonly data: string | ArrayBuffer;
}

export interface SocketCloseEvent {
  readonly code: number;
  readonly reason: string;
}

/** The part of the WebSocket API adapters use. */
export interface SocketLike {
  readonly readyState: number;
  /** The subprotocol the server chose, or "". */
  readonly protocol: string;
  readonly bufferedAmount: number;
  onopen: (() => void) | null;
  onmessage: ((event: SocketMessageEvent) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: SocketCloseEvent) => void) | null;
  send(data: string | ArrayBufferView | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

export type SocketFactory = (url: string, protocols?: readonly string[]) => SocketLike;

/**
 * A `SocketLike` over the platform's WebSocket: the browser's, or Node 22+'s global one. Binary
 * messages arrive as ArrayBuffers.
 */
export const createBrowserSocket: SocketFactory = (url, protocols) => {
  const socket = new WebSocket(url, protocols ? [...protocols] : undefined);
  socket.binaryType = "arraybuffer";
  const wrapper: SocketLike = {
    get readyState() {
      return socket.readyState;
    },
    get protocol() {
      return socket.protocol;
    },
    get bufferedAmount() {
      return socket.bufferedAmount;
    },
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    // Every buffer Earshot sends is ArrayBuffer-backed; WebSocket refuses shared memory anyway.
    send: (data) => socket.send(data as string | BufferSource),
    close: (code, reason) => socket.close(code, reason),
  };
  socket.addEventListener("open", () => wrapper.onopen?.());
  socket.addEventListener("message", (event: MessageEvent) => {
    const data: unknown = event.data;
    if (typeof data === "string" || data instanceof ArrayBuffer) wrapper.onmessage?.({ data });
  });
  socket.addEventListener("error", () => wrapper.onerror?.());
  socket.addEventListener("close", (event: CloseEvent) =>
    wrapper.onclose?.({ code: event.code, reason: event.reason }),
  );
  return wrapper;
};

/** Time and timers. `now` is monotonic ms. */
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * The platform clock. It looks the globals up on every call, so Vitest's fake timers (with
 * `performance` faked too) drive it.
 */
export const systemClock: Clock = {
  now: () => globalThis.performance.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};
