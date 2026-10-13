# AllVPN reserve for DeepInfra

The server runs Xray and Next.js in one container. Xray reads the HTTPS subscription at runtime and exposes an HTTP CONNECT proxy on `127.0.0.1:18080`. The supplied subscription contains VLESS REALITY nodes; Happ itself is not installed on the server.

Only DeepInfra chat, memory and embeddings use this route. Other providers retain their existing connections. TLS verification remains enabled. Xray has no direct outbound and neither its credentials nor generated content appear in its logs. `.env.local` and temporary runtime files are excluded from Git and the Docker build context.

## Relaxdev configuration

Choose the project stack **Docker / own Dockerfile**. Keep all existing application variables and add:

```dotenv
ALLVPN_ENABLED=1
ALLVPN_SUBSCRIPTION_URL=<private HTTPS subscription>
DEEPINFRA_NETWORK_MODE=allvpn
```

`allvpn` forces DeepInfra through the reserve and fails if it is unavailable. After the test, set `DEEPINFRA_NETWORK_MODE=auto` and redeploy. `auto` starts with the existing `DEEPINFRA_PROXY_URL`, opens a 60-second reserve window after a network error, and then tries the primary again. Authentication, HTTP rate limits, certificate errors and caller cancellations do not trigger switching. `primary` disables the reserve.

Existing retry and accounting rules remain in force. A failed attempt before the stream starts may use the reserve on the existing retry. A partially delivered stream is never regenerated; the next request can use the reserve. Service calls without their own retry use the reserve on their following request.

At startup, nodes are checked in order from `ALLVPN_NODE_INDEX` (default 0). An unauthenticated DeepInfra models request verifies the tunnel without paid generation. An exited Xray process is restarted every 30 seconds. The subscription is refreshed on restart; a running Xray process whose upstream node stops responding requires an application restart or a different preferred node.

The Docker image pins official Xray v26.3.27 and verifies the release SHA-256 checksum. The HTTP listener is not publicly exposed.

## Local checks

```sh
npm run setup:allvpn
npm run verify:allvpn
npm run diagnose:allvpn -- --live --network-only
```

For a short synthetic stream, configure `DEEPINFRA_API_KEY` privately and run `npm run diagnose:allvpn -- --live`. This allows up to two billed attempts, each capped at 128 output tokens, and uses an in-memory accounting store. The report is written under ignored `logs/`. The production admin chat diagnostics also display the selected route and per-attempt route, completion marker and transport timings.

Verified locally: 24 AllVPN behavior checks, 23 admin diagnostic checks, 10 existing DeepInfra network checks, 18 avatar proxy checks, TypeScript for application sources, and a real AllVPN tunnel to DeepInfra (HTTP 200, no billed requests). Server rollout and an authenticated stream must be confirmed separately.
