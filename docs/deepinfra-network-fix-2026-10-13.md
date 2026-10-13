# DeepInfra HTTPS route

Live diagnostics on 13 October reproduced a stalled Mistral SSE response both in native fetch and the application pipeline. Native fetch received 4103 bytes in 12 chunks, then failed after a 73-second pending read. Application calls stopped at their unchanged 45-second idle watchdog. This establishes that the watchdog alone does not cause the upstream stall; it does not distinguish the provider from the direct network route.

`DEEPINFRA_PROXY_URL` enables pointwise HTTPS CONNECT tunnels for the two fixed DeepInfra OpenAI endpoints. Chat streaming uses an explicit Undici ProxyAgent; memory and embedding Axios requests use HttpsProxyAgent with environment proxy handling disabled for those requests. TLS certificate verification remains enabled. Database, billing, mail and other providers keep their existing transport.

Set the variable to the outbound proxy address provided in RelaxDev → project → Variables → Webhook / Proxy. Do not enable global proxy variables. Emptying this variable and restarting restores the direct DeepInfra route. No automatic fallback or retry of a partial answer is introduced, so a stalled request cannot cause duplicate generations or billing through a hidden retry.

The protected `/ru/admin/chat-diagnostics` comparison always starts with native direct fetch and then runs the actual application pipeline using the configured route. The report records `pipelineRoute`. Each comparison uses independent requests with identical synthetic input; repeated results and passive application logs are needed to assess stability. The direct report also retains allowlisted exception type and socket cause code, with no error text or generated content.

Validation: eight route isolation/cancellation/configuration checks, 23 protected-admin checks, 23 transport checks, 58 diagnostic checks, TypeScript, ESLint and production build. Live acceptance is recorded separately after deployment.
