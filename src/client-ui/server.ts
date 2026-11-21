import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UIServerOptions {
  /** Port to listen on. Default: 7890 */
  port?: number;
  /** Host to bind. Default: 127.0.0.1 */
  host?: string;
  /** ObserverBus instance for SSE event streaming */
  observerBus?: ObserverBusLike;
  /** PluginHubFacade for REST API endpoints */
  facade?: FacadeLike;
}

/** Minimal ObserverBus contract – subscribe returns an unsubscribe fn */
interface ObserverBusLike {
  subscribe(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    types: any[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    callback: (event: any) => void,
  ): () => void;
}

/** Minimal Facade contract */
interface FacadeLike {
  getStatus?(): Record<string, unknown> | Promise<Record<string, unknown>>;
  getCapabilities?(): Array<Record<string, unknown>> | Promise<Array<Record<string, unknown>>>;
  getCapability?(id: string): Record<string, unknown> | null | Promise<Record<string, unknown> | null>;
  startPlugin?(id: string): Promise<unknown>;
  stopPlugin?(id: string): Promise<unknown>;
}

// ─── HTML cache ───────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
let htmlCache: string | null = null;

function loadHTML(): string {
  if (htmlCache === null) {
    htmlCache = readFileSync(join(__dirname, 'index.html'), 'utf-8');
  }
  return htmlCache;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function jsonResponse(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function errorResponse(res: ServerResponse, message: string, status = 500): void {
  jsonResponse(res, { error: message }, status);
}

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

// ─── UIServer ─────────────────────────────────────────────────────────────────

export class UIServer {
  private readonly port: number;
  private readonly host: string;
  private readonly observerBus: ObserverBusLike | undefined;
  private readonly facade: FacadeLike | undefined;
  private server: Server | null = null;
  private sseClients: Set<ServerResponse> = new Set();
  private unsubBus: (() => void) | null = null;
  private _running = false;

  constructor(options?: UIServerOptions) {
    this.port = options?.port ?? 7890;
    this.host = options?.host ?? '127.0.0.1';
    this.observerBus = options?.observerBus;
    this.facade = options?.facade;
  }

  /** Whether the server is currently listening */
  get running(): boolean {
    return this._running;
  }

  /** Start the HTTP server */
  async start(): Promise<{ url: string; port: number }> {
    if (this._running) {
      throw new Error('UIServer is already running');
    }

    const server = createServer((req, res) => this.handleRequest(req, res));

    // Subscribe to ObserverBus for SSE broadcasting (listen on wildcard '*')
    if (this.observerBus) {
      this.unsubBus = this.observerBus.subscribe(['*'], (event) => {
        this.broadcastSSE(event);
      });
    }

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, this.host, () => resolve());
    });

    this.server = server;
    this._running = true;

    const addr = server.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : this.port;
    const url = `http://${this.host}:${actualPort}`;

    console.log(`[PluginHub UI] Listening at ${url}`);
    return { url, port: actualPort };
  }

  /** Stop the server gracefully */
  async stop(): Promise<void> {
    if (!this._running || !this.server) return;

    // Close all SSE connections
    for (const client of this.sseClients) {
      client.end();
    }
    this.sseClients.clear();

    // Unsubscribe from bus
    if (this.unsubBus) {
      this.unsubBus();
      this.unsubBus = null;
    }

    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });

    this.server = null;
    this._running = false;
    console.log('[PluginHub UI] Stopped');
  }

  // ── Request Router ─────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', `http://${this.host}:${this.port}`);
    const path = url.pathname;

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    try {
      // ── Static ───────────────────────────────────────
      if (path === '/' && method === 'GET') {
        const html = loadHTML();
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        res.end(html);
        return;
      }

      // ── GET /api/status ──────────────────────────────
      if (path === '/api/status' && method === 'GET') {
        if (!this.facade?.getStatus) {
          jsonResponse(res, { status: 'ok', capabilities: 0 });
          return;
        }
        const status = await this.facade.getStatus();
        jsonResponse(res, status);
        return;
      }

      // ── GET /api/capabilities ────────────────────────
      if (path === '/api/capabilities' && method === 'GET') {
        if (!this.facade?.getCapabilities) {
          jsonResponse(res, []);
          return;
        }
        const caps = await this.facade.getCapabilities();
        jsonResponse(res, caps);
        return;
      }

      // ── GET /api/capabilities/:id ────────────────────
      const capMatch = path.match(/^\/api\/capabilities\/(.+)$/);
      if (capMatch && method === 'GET') {
        const id = decodeURIComponent(capMatch[1]);
        if (!this.facade?.getCapability) {
          errorResponse(res, 'Capability not found', 404);
          return;
        }
        const cap = await this.facade.getCapability(id);
        if (!cap) {
          errorResponse(res, 'Capability not found', 404);
          return;
        }
        jsonResponse(res, cap);
        return;
      }

      // ── GET /api/events (SSE) ────────────────────────
      if (path === '/api/events' && method === 'GET') {
        this.handleSSE(req, res);
        return;
      }

      // ── POST /api/plugins/:id/start ──────────────────
      const startMatch = path.match(/^\/api\/plugins\/(.+)\/start$/);
      if (startMatch && method === 'POST') {
        const id = decodeURIComponent(startMatch[1]);
        if (!this.facade?.startPlugin) {
          errorResponse(res, 'startPlugin not available', 501);
          return;
        }
        await parseBody(req); // consume body
        const result = await this.facade.startPlugin(id);
        jsonResponse(res, { ok: true, id, result });
        return;
      }

      // ── POST /api/plugins/:id/stop ───────────────────
      const stopMatch = path.match(/^\/api\/plugins\/(.+)\/stop$/);
      if (stopMatch && method === 'POST') {
        const id = decodeURIComponent(stopMatch[1]);
        if (!this.facade?.stopPlugin) {
          errorResponse(res, 'stopPlugin not available', 501);
          return;
        }
        await parseBody(req); // consume body
        const result = await this.facade.stopPlugin(id);
        jsonResponse(res, { ok: true, id, result });
        return;
      }

      // ── 404 ──────────────────────────────────────────
      errorResponse(res, 'Not Found', 404);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[PluginHub UI] Error handling ${method} ${path}:`, msg);
      errorResponse(res, msg, 500);
    }
  }

  // ── SSE Handler ────────────────────────────────────────

  private handleSSE(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    // Send initial keepalive
    res.write(': connected\n\n');

    this.sseClients.add(res);

    res.on('close', () => {
      this.sseClients.delete(res);
    });
  }

  private broadcastSSE(event: Record<string, unknown>): void {
    const data = JSON.stringify(event);
    const payload = `event: event\ndata: ${data}\n\n`;
    for (const client of this.sseClients) {
      client.write(payload);
    }
  }
}
