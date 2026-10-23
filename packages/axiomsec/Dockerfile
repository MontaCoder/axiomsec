FROM alpine:3.22 AS base

# Disable the runtime transpiler cache by default inside Docker containers.
# On ephemeral containers, the cache is not useful
ARG BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=${BUN_RUNTIME_TRANSPILER_CACHE_PATH}
RUN apk add --no-cache libgcc libstdc++ ripgrep chromium nss freetype harfbuzz ca-certificates ttf-freefont
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/lib
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV CHROMIUM_PATH=/usr/bin/chromium-browser

FROM base AS build-amd64
COPY packages/axiomsec/dist/axiomsec-linux-x64-baseline-musl/bin/axiomsec /usr/local/bin/axiomsec

FROM base AS build-arm64
COPY packages/axiomsec/dist/axiomsec-linux-arm64-musl/bin/axiomsec /usr/local/bin/axiomsec

ARG TARGETARCH
FROM build-${TARGETARCH}
RUN axiomsec --version
ENTRYPOINT ["axiomsec"]
