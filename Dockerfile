# ── Stage 1: Get curl-impersonate from official Docker image ──
FROM lwthiker/curl-impersonate:0.6-chrome AS curl-src

# ── Stage 2: Install bun dependencies ─────────────────────────
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

# ── Stage 3: Final image ──────────────────────────────────────
FROM oven/bun:1
WORKDIR /app

# Install runtime deps for curl-impersonate (NSS + zlib)
RUN apt-get update && \
    apt-get install -y --no-install-recommends libnss3 nss-plugin-pem ca-certificates zlib1g && \
    rm -rf /var/lib/apt/lists/*

# Copy curl-impersonate binaries + libraries from official image
COPY --from=curl-src /usr/local/bin/curl_* /usr/local/bin/
COPY --from=curl-src /usr/local/bin/curl-impersonate-chrome /usr/local/bin/
COPY --from=curl-src /usr/local/lib/libcurl-impersonate-chrome* /usr/local/lib/
RUN ldconfig

# Verify curl-impersonate works
RUN curl_chrome116 --version

# Copy dependencies and source
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV PORT=3110
EXPOSE 3110

CMD ["bun", "src/serve.ts"]
