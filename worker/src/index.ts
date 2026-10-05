// ghosttape Worker: /api/* goes to the relay Durable Object; everything else is static assets (web/dist).
// wrangler.jsonc sets assets.run_worker_first = ["/api/*"], so asset requests never invoke (or bill) this script.
//
//   GET /api/state   JSON status, usage vs caps, engine state, recent candles
//   GET /api/tape    WebSocket for viewers (snapshot, then every packet + status changes)
//   GET /api/ingest  WebSocket for the uplink (ESP32 over Wi-Fi, or the browser USB bridge)

import { currentLimits } from './config';
import type { Env } from './env';
import { toUplink } from './ingest';
import { isLocalHost } from './limits';
import { LABEL } from './relay';

export { TapeRelay } from './relay';

const json = (status: number, body: unknown): Response =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

/** Answers a WebSocket upgrade with one message and a close, without touching the Durable Object. */
function refuseSocket(text: string, code: number, reason: string): Response {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.send(text);
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);

    // Fail closed: the local-test override must never be live on a deployed host.
    if (env.ALLOW_TEST_OVERRIDE !== undefined && !isLocalHost(url.hostname)) {
      return json(503, { error: 'ALLOW_TEST_OVERRIDE is set on a non-local host; refusing all API requests' });
    }

    const path = url.pathname;
    if (path !== '/api/state' && path !== '/api/tape' && path !== '/api/ingest') return json(404, { error: 'not found' });
    if (req.method !== 'GET') return json(405, { error: 'GET only' });
    const isSocket = path !== '/api/state';
    if (isSocket && req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json(426, { error: 'WebSocket upgrade required' });

    // Per-IP rate limits (namespaces 2001/2002) keep reconnect storms from eating the shared daily request budget.
    const ip = req.headers.get('cf-connecting-ip') ?? 'local';
    const limiter = path === '/api/ingest' ? env.INGEST_LIMITER : env.VIEW_LIMITER;
    if (limiter && !(await limiter.limit({ key: `${path}:${ip}` })).success) {
      return isSocket ? refuseSocket(path === '/api/ingest' ? 'GT1,REJECT,rate_limited,-' : JSON.stringify({ type: 'status', status: { message: 'too many connections, retry later' } }), 4008, 'rate limited')
        : json(429, { error: 'rate limited' });
    }

    // Online mode off (limits.jsonc): answer here, so the Durable Object is never woken (zero DO usage).
    const limits = currentLimits(env);
    if (!limits.online_enabled) {
      const message = 'online mode is off';
      if (path === '/api/state') return json(200, { label: LABEL, online_enabled: false, uplink_connected: false, status: { online_enabled: false, uplink: 'down', frozen: true, message } });
      if (path === '/api/tape') return refuseSocket(JSON.stringify({ type: 'status', status: { online_enabled: false, uplink: 'down', frozen: true, message } }), 4003, message);
      return refuseSocket(toUplink.pause('offline'), 4003, message);
    }

    return env.TAPE.get(env.TAPE.idFromName('main')).fetch(req);
  },
} satisfies ExportedHandler<Env>;
