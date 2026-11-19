// An in-memory WebSocket server for adapter tests: pass `server.factory` as an adapter's
// `socket` option, then accept or refuse each connection, read what the client sent, and send
// provider messages back. Events reach the client on microtasks, as a real socket's would arrive
// asynchronously; `await settle()` lets them land.
import {
  SOCKET_CLOSED,
  SOCKET_CONNECTING,
  SOCKET_OPEN,
  type SocketCloseEvent,
  type SocketFactory,
  type SocketLike,
  type SocketMessageEvent,
} from "../stt/socket";

/** Lets queued socket events and the promise chains they start run. */
export async function settle(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

export class FakeSocketServer {
  readonly sockets: FakeServerSocket[] = [];
  /** Runs for each new connection: accept or refuse it here, or later. */
  onConnection: ((socket: FakeServerSocket) => void) | undefined;

  readonly factory: SocketFactory = (url, protocols) => {
    const socket = new FakeServerSocket(url, protocols ?? []);
    this.sockets.push(socket);
    this.onConnection?.(socket);
    return socket.client;
  };

  /** The newest connection. */
  get last(): FakeServerSocket {
    const socket = this.sockets.at(-1);
    if (!socket) throw new Error("no connection yet");
    return socket;
  }
}

export class FakeServerSocket {
  readonly url: URL;
  readonly protocols: readonly string[];
  readonly client: SocketLike;
  /** Everything the client sent: text as strings, binary as byte copies. */
  readonly received: (string | Uint8Array)[] = [];
  /** The client's own close call, if it made one. */
  clientClose: { code: number | undefined; reason: string | undefined } | undefined;
  /** Runs for each message the client sends, on a microtask, as a server would receive it. */
  onMessage: ((data: string | Uint8Array) => void) | undefined;
  /** Runs when the client closes the socket, on a microtask. */
  onClientClose: ((code: number | undefined) => void) | undefined;
  #readyState = SOCKET_CONNECTING;
  #protocol = "";

  constructor(url: string, protocols: readonly string[]) {
    this.url = new URL(url);
    this.protocols = protocols;
    const server = this;
    this.client = {
      get readyState() {
        return server.#readyState;
      },
      get protocol() {
        return server.#protocol;
      },
      bufferedAmount: 0,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send(data) {
        if (server.#readyState === SOCKET_CONNECTING) {
          throw new Error("InvalidStateError: still connecting");
        }
        if (server.#readyState !== SOCKET_OPEN) return;
        let message: string | Uint8Array;
        if (typeof data === "string") message = data;
        else if (data instanceof ArrayBuffer) message = new Uint8Array(data.slice(0));
        else message = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
        server.received.push(message);
        if (server.onMessage) {
          const onMessage = server.onMessage;
          queueMicrotask(() => onMessage(message));
        }
      },
      close(code, reason) {
        if (server.#readyState === SOCKET_CLOSED) return;
        server.clientClose = { code, reason };
        if (server.onClientClose) {
          const onClientClose = server.onClientClose;
          queueMicrotask(() => onClientClose(code));
        }
        const wasConnecting = server.#readyState === SOCKET_CONNECTING;
        server.#readyState = SOCKET_CLOSED;
        server.#deliver(() =>
          server.client.onclose?.({
            code: wasConnecting ? 1006 : (code ?? 1005),
            reason: reason ?? "",
          }),
        );
      },
    };
  }

  get isOpen(): boolean {
    return this.#readyState === SOCKET_OPEN;
  }

  get isClosed(): boolean {
    return this.#readyState === SOCKET_CLOSED;
  }

  /** Completes the handshake, choosing `protocol` from the offered subprotocols. */
  accept(protocol = this.protocols[0] ?? ""): void {
    if (this.#readyState !== SOCKET_CONNECTING) return;
    this.#readyState = SOCKET_OPEN;
    this.#protocol = protocol;
    this.#deliver(() => this.client.onopen?.());
  }

  /** Fails the handshake, as a refused credential or a network error does in a browser. */
  refuse(code = 1006, reason = ""): void {
    if (this.#readyState !== SOCKET_CONNECTING) return;
    this.#readyState = SOCKET_CLOSED;
    this.#deliver(() => {
      this.client.onerror?.();
      this.client.onclose?.({ code, reason });
    });
  }

  /** Sends a JSON text message to the client. */
  sendJson(message: unknown): void {
    this.sendText(JSON.stringify(message));
  }

  sendText(text: string): void {
    this.#message({ data: text });
  }

  /** Closes from the server's side. */
  close(code = 1000, reason = ""): void {
    if (this.#readyState === SOCKET_CLOSED) return;
    this.#readyState = SOCKET_CLOSED;
    const event: SocketCloseEvent = { code, reason };
    this.#deliver(() => this.client.onclose?.(event));
  }

  /** The client's text messages, parsed as JSON. */
  get json(): Record<string, unknown>[] {
    return this.received
      .filter((message): message is string => typeof message === "string")
      .map((text) => JSON.parse(text) as Record<string, unknown>);
  }

  /** The client's binary messages, as PCM16. */
  get audioMessages(): Int16Array[] {
    return this.received
      .filter((message): message is Uint8Array => typeof message !== "string")
      .map((bytes) => new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2));
  }

  /** All the client's audio, joined. */
  get audio(): Int16Array {
    const messages = this.audioMessages;
    const out = new Int16Array(messages.reduce((sum, message) => sum + message.length, 0));
    let at = 0;
    for (const message of messages) {
      out.set(message, at);
      at += message.length;
    }
    return out;
  }

  #message(event: SocketMessageEvent): void {
    if (this.#readyState !== SOCKET_OPEN) return;
    this.#deliver(() => this.client.onmessage?.(event));
  }

  #deliver(callback: () => void): void {
    queueMicrotask(callback);
  }
}
