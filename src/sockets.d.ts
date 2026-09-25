// cloudflare:sockets 模块类型声明（@cloudflare/workers-types 部分版本未包含）
declare module 'cloudflare:sockets' {
  export interface Socket {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    closed: Promise<void>;
    opened: Promise<SocketInfo>;
    close(): Promise<void>;
    startTls(options?: TlsOptions): Socket;
  }
  export interface SocketInfo {
    remoteAddress?: string;
    localAddress?: string;
  }
  export interface TlsOptions {
    expectedServerHostname?: string;
  }
  export function connect(
    address: string | { hostname: string; port: number },
    options?: { secureTransport?: 'on' | 'off' | 'starttls'; allowHalfOpen?: boolean },
  ): Socket;
}
