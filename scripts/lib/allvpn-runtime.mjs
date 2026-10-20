import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { connect, createServer } from 'node:net';
import { fetch as proxyFetch, ProxyAgent } from 'undici';
import dotenv from 'dotenv';

export function loadAllvpnEnv() {
  // Keep deployment environment authoritative. Local overrides follow Next's precedence.
  dotenv.config({ path: ['.env.local', '.env'], quiet: true });
}
const safeError = () => new Error('AllVPN configuration or connection is unavailable');

export function parseAllvpnSubscription(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 2_000_000) throw safeError();
  let decoded = text.trim();
  if (!decoded.startsWith('vless://') && /^[A-Za-z0-9+/=_\s-]+$/.test(decoded)) decoded = Buffer.from(decoded, 'base64').toString('utf8');
  const lines = decoded.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  if (!lines.length || lines.length > 1000) throw safeError();
  return lines.map((line, index) => {
    // Unsupported formats stay in the index but are never executed or passed to Xray.
    try {
      const url = new URL(line), p = url.searchParams;
      const id = decodeURIComponent(url.username), publicKey = p.get('pbk'), sni = p.get('sni');
      const network = p.get('type') || 'tcp', flow = p.get('flow') || '', shortId = p.get('sid') || '';
      if (url.protocol !== 'vless:' || url.password || !url.hostname || !url.port
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
        || p.get('security') !== 'reality' || !['tcp', 'raw', 'grpc'].includes(network)
        || !['', 'xtls-rprx-vision', 'xtls-rprx-vision-udp443'].includes(flow)
        || (network === 'grpc' && flow) || (p.get('encryption') && p.get('encryption') !== 'none')
        || !publicKey || !/^[A-Za-z0-9_-]{43}$/.test(publicKey) || !sni || !/^[A-Za-z0-9.-]+$/.test(sni)
        || !/^(?:[0-9a-f]{2}){0,8}$/i.test(shortId)) return null;
      const streamSettings = { network: network === 'tcp' ? 'raw' : network, security: 'reality',
        realitySettings: { fingerprint: p.get('fp') || 'chrome', serverName: sni, password: publicKey, shortId,
          spiderX: p.get('spx') || '/' } };
      if (network === 'grpc') streamSettings.grpcSettings = { serviceName: p.get('serviceName') || '', multiMode: p.get('mode') === 'multi' };
      return { index, outbound: { tag: 'allvpn', protocol: 'vless',
        settings: { vnext: [{ address: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port),
          users: [{ id, encryption: 'none', flow }] }] }, streamSettings } };
    } catch { return null; }
  });
}

export function allvpnConfig(node, port) {
  if (!node || !Number.isInteger(port) || port < 1024 || port > 65535) throw safeError();
  return {
    log: { loglevel: 'none', access: 'none', error: 'none' },
    inbounds: [{ tag: 'local-http', listen: '127.0.0.1', port, protocol: 'http', settings: {} }],
    // Only the VPN outbound: no direct route on errors, and no public proxy listener.
    outbounds: [node.outbound],
  };
}

export async function fetchAllvpnNodes(subscriptionUrl) {
  try {
    const url = new URL(subscriptionUrl);
    if (url.protocol !== 'https:' || url.username || url.password) throw safeError();
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Accept: 'text/plain' } });
    if (!response.ok) throw safeError();
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      if (size > 2_000_000) throw safeError();
      chunks.push(Buffer.from(chunk));
    }
    return parseAllvpnSubscription(Buffer.concat(chunks).toString('utf8'));
  } catch { throw safeError(); }
}

async function freePort(port) {
  const server = createServer();
  try {
    await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', ok); });
    return server.address().port;
  } finally { if (server.listening) await new Promise(ok => server.close(ok)); }
}
async function listening(port) {
  return new Promise(ok => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(200);
    const finish = value => { socket.destroy(); ok(value); };
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.once('timeout', () => finish(false));
  });
}
export function xrayPath() {
  return process.env['ALLVPN_XRAY_PATH']?.trim() || resolve('.runtime/allvpn', process.platform === 'win32' ? 'xray.exe' : 'xray');
}

export async function startAllvpnGateway({ subscriptionUrl = process.env['ALLVPN_SUBSCRIPTION_URL'],
  binaryPath = xrayPath(), port = 18080, nodeIndex = Number(process.env['ALLVPN_NODE_INDEX'] || 0), onEvent = () => {} } = {}) {
  let workdir, child;
  async function removeWorkdir() {
    if (!workdir) return;
    const absolute = resolve(workdir);
    if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith('newverse-allvpn-')) throw safeError();
    await rm(absolute, { recursive: true, force: true });
  }
  async function stopChild() {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const ended = once(child, 'exit').catch(() => {});
      child.kill();
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      await ended; clearTimeout(timer);
    }
    child = undefined;
  }
  try {
    if (!Number.isInteger(nodeIndex) || nodeIndex < 0) throw safeError();
    const nodes = await fetchAllvpnNodes(subscriptionUrl);
    if (nodeIndex >= nodes.length) throw safeError();
    port = await freePort(port);
    workdir = await mkdtemp(join(tmpdir(), 'newverse-allvpn-'));
    await chmod(workdir, 0o700);
    const configPath = join(workdir, 'config.json');
    const candidates = [...nodes.slice(nodeIndex), ...nodes.slice(0, nodeIndex)].filter(Boolean);
    for (const node of candidates) {
      await writeFile(configPath, JSON.stringify(allvpnConfig(node, port)), { mode: 0o600 });
      child = spawn(binaryPath, ['run', '-c', configPath], { stdio: 'ignore', windowsHide: true });
      let failed = false;
      child.once('error', () => { failed = true; });
      for (let attempt = 0; attempt < 40 && !failed && child.exitCode === null; attempt++) {
        if (await listening(port)) break;
        await new Promise(ok => setTimeout(ok, 50));
      }
      if (!failed && child.exitCode === null && await listening(port)) {
        const agent = new ProxyAgent(`http://127.0.0.1:${port}`);
        try {
          // Unauthenticated GET: checks CONNECT + TLS + DeepInfra reachability, no billed generation.
          const response = await proxyFetch('https://api.deepinfra.com/v1/openai/models', {
            dispatcher: agent, redirect: 'error', signal: AbortSignal.timeout(8000),
          });
          await response.body?.cancel();
          if (response.status >= 200 && response.status < 500 && response.status !== 407) {
            const selectedChild = child;
            onEvent({ event: 'allvpn_ready', nodeIndex: node.index, nodeCount: nodes.length, upstreamStatus: response.status });
            return { proxyUrl: `http://127.0.0.1:${port}`, nodeIndex: node.index, nodeCount: nodes.length,
              isRunning: () => selectedChild.exitCode === null && selectedChild.signalCode === null,
              stop: async () => { await stopChild(); await removeWorkdir(); } };
          }
        } catch {} finally { await agent.destroy(); }
      }
      onEvent({ event: 'allvpn_node_unavailable', nodeIndex: node.index });
      await stopChild();
    }
    throw safeError();
  } catch {
    await stopChild();
    await removeWorkdir();
    throw safeError();
  }
}
