import { EngineError } from '../../core/engine';

export interface OpencodeConnection {
  baseUrl: string;
  /** Basic-auth credentials when the server was started with OPENCODE_SERVER_PASSWORD. */
  username?: string;
  password?: string;
  /** Project directory; sent as the `directory` query parameter on every call. */
  directory?: string;
}

/** Thin HTTP client for `opencode serve`. */
export class OpencodeClient {
  constructor(readonly conn: OpencodeConnection) {}

  url(pathname: string, query: Record<string, string | number | boolean | undefined> = {}): string {
    const u = new URL(pathname.replace(/^\//, ''), this.conn.baseUrl.endsWith('/') ? this.conn.baseUrl : this.conn.baseUrl + '/');
    if (this.conn.directory) u.searchParams.set('directory', this.conn.directory);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.conn.password) h.authorization = 'Basic ' + Buffer.from(`${this.conn.username ?? 'opencode'}:${this.conn.password}`).toString('base64');
    return h;
  }

  async request<T>(method: string, pathname: string, options: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    const signals: AbortSignal[] = [];
    if (options.signal) signals.push(options.signal);
    if (options.timeoutMs !== 0) signals.push(AbortSignal.timeout(options.timeoutMs ?? 30_000));
    let res: Response;
    try {
      res = await fetch(this.url(pathname, options.query), {
        method,
        headers: this.headers(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
      });
    } catch (err) {
      throw new EngineError(`opencode server unreachable (${method} ${pathname}): ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await res.text();
    if (!res.ok) throw new EngineError(describeError(res.status, text, method, pathname));
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  get<T>(pathname: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    return this.request<T>('GET', pathname, { query });
  }
  post<T>(pathname: string, body?: unknown, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    return this.request<T>('POST', pathname, { body: body ?? {}, ...options });
  }
}

function describeError(status: number, text: string, method: string, pathname: string): string {
  let detail = text.slice(0, 500);
  try {
    const j = JSON.parse(text);
    detail = j?.data?.message ?? j?.message ?? j?.error?.message ?? j?.name ?? detail;
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
  } catch {
    /* plain text */
  }
  if (status === 401) return 'opencode server rejected the credentials (check OPENCODE_SERVER_PASSWORD / opencodeHub.opencode.serverPassword).';
  return `opencode ${method} ${pathname} failed (${status}): ${detail}`;
}
