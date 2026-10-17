# External reserve: deployment status

The embedded AllVPN gateway was removed from the application on 2026-10-17 after Relaxdev blocked builds containing its VPN/proxy component. Do not restore that integration on Relaxdev or move it to another product of that platform.

The production Docker image installs no VPN binary. npm start launches Next.js and the existing authenticated character-generation worker through scripts/start-app.mjs. The worker's enable/disable flags and loopback endpoint are unchanged.

For Relaxdev, use DEEPINFRA_NETWORK_MODE=primary with the existing DEEPINFRA_PROXY_URL. Disable ALLVPN_ENABLED on the old running image before replacing it, and remove the private subscription and obsolete local gateway settings from the platform. The new application image needs no VPN process or subscription.

A private local transfer backup is retained outside Git under .runtime/allvpn-transfer-2026-10-17/, with a ZIP copy under logs/. It preserves the original integration, source checksums, a standalone loopback gateway client and the private subscription. It contains no application API keys, database credentials, or admin/cron secrets. Keep this archive private. It is excluded from the Docker context and is not part of the deployed repository.

Use that backup only on a separate server where the operator permits it. Its listener remains local to that server; authenticated, access-restricted HTTPS CONNECT access from the application must be configured separately before any remote connection. That setup is deferred, rather than exposing an open proxy.

The application retains the external-reserve routing interface (ALLVPN_PROXY_URL with DEEPINFRA_NETWORK_MODE=auto) for a future permitted external endpoint. Do not set that URL to the former 127.0.0.1:18080 listener on Relaxdev: it no longer exists. Do not enable external failover until the new endpoint is configured and tested.

Relaxdev's published rules allow an application's outgoing API requests through an external proxy (section 2.4). A project/build block may still require a support review after the prohibited component is removed: https://relaxdev.ru/rules .
