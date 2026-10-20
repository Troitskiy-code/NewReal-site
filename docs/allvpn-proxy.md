# AllVPN reserve for outgoing application requests

Relaxdev support confirmed on 2026-10-20, in the project support chat, that the previous Xray detection was a false alarm and the previous integration may be restored. Their permission covers the project's own proxy use without external distribution. The gateway must remain private to the application.

## Production configuration

- Keep the existing DEEPINFRA_PROXY_URL unchanged: it is the primary route.
- Set ALLVPN_ENABLED=1 and the private ALLVPN_SUBSCRIPTION_URL in Relaxdev's environment settings.
- Set DEEPINFRA_NETWORK_MODE=auto. Transport failures open a 60-second reserve window, then the primary is tried again. HTTP/authentication/rate-limit/certificate errors and user cancellations do not change routes; partially delivered chat responses are not replayed.
- npm start uses scripts/start-app.mjs to launch Next, the existing character and memory workers, and the private AllVPN gateway. Worker flags are preserved. A reserve startup failure in auto mode is logged without credentials and does not stop the primary application; startup retries a stopped gateway every 30 seconds.
- Docker installs the pinned official Xray binary with SHA-256 verification. Its HTTP CONNECT listener binds only to 127.0.0.1:18080. No proxy route or listener is exposed through the application's public port 8080.
- Startup supplies ALLVPN_PROXY_URL automatically when the embedded gateway is enabled. For a separately hosted reserve, disable the embedded gateway and supply an authenticated HTTP(S) CONNECT endpoint instead.

Keep DEEPINFRA_NETWORK_MODE=primary as a kill switch. Forced allvpn mode is reserved for explicit diagnostics; production normally stays in auto. Switching off ALLVPN_ENABLED alone stops the gateway but does not override a manually configured external ALLVPN_PROXY_URL.

## Verification and secrets

npm run verify:allvpn checks subscription parsing, private binding, failover, cooldown, and streaming retry behavior without external network calls. npm run verify:startup checks application/worker startup and reserve failures with synthetic credentials. Gateway readiness uses an unauthenticated models GET and does not generate paid content.

Store subscription URLs only in ignored .env.local files or private platform environment settings. Do not place them in source, build logs, screenshots, or support messages. Xray payload logging is disabled and temporary configuration files have restricted permissions.

The private transfer backup from 2026-10-17 remains under .runtime/allvpn-transfer-2026-10-17/, with a ZIP copy under logs/. It includes the subscription and is excluded from both Git and the Docker build context. It can still be used for a later move to a permitted separate server.
