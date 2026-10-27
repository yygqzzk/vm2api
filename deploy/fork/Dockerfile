# Fork-only overlay: keep the upstream runtime, web assets and pinned kernels intact.
FROM ghcr.io/dofastted/vm2api:v1.4.015@sha256:ff178d9229e5c363b71f0f55d83f1fcbc79ba7ae4c35682cfa32a88264fc71cf
WORKDIR /opt/vm2api

# Refuse to overlay these modules on an incompatible upstream release.
RUN printf '%s\n' \
    'd0e3e10bc6143e507580d016fccaa151a095b767231956421f5f986004ea306c  src/lib/transport/go-worker-client.mjs' \
    'e6c5ab6520377995eb3008dfc334e507e73db4bb4a4da69ffa179ce2f2a548a3  src/lib/transport/codex-kernel-client.mjs' \
    '114773cbcdacd75173d96762a95e62aa842c855e20d5f44467e3185d7a77d561  src/lib/protocol/handle-codex.mjs' \
    | sha256sum -c -

COPY src/lib/transport/go-worker-client.mjs src/lib/transport/codex-kernel-client.mjs src/lib/transport/codex-stream-policy.mjs ./src/lib/transport/
COPY src/lib/protocol/handle-codex.mjs ./src/lib/protocol/
ARG FORK_REVISION=dev
LABEL org.opencontainers.image.source="https://github.com/yygqzzk/vm2api" \
      org.opencontainers.image.revision="${FORK_REVISION}" \
      io.vm2api.fork.feature="codex-early-sse"
