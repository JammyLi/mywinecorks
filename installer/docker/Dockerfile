# MyWineCorks self-hosted server — Docker image for Mac / Linux / NAS (SPEC §10.2).
#   docker build -f installer/docker/Dockerfile -t mywinecorks .
# The build embeds the HQ license public key from installer/keys/hq-license-public.pem
# (override with --build-arg TRUST_KEY=path/in/repo.pem).

FROM node:22-bookworm AS build
ARG TARGETARCH
ARG TRUST_KEY=installer/keys/hq-license-public.pem
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile
RUN test -f "$TRUST_KEY" || (echo "Missing $TRUST_KEY (the HQ license public key)" && exit 1)
RUN node scripts/release/build.mjs --platform "linux-$([ "$TARGETARCH" = arm64 ] && echo arm64 || echo x64)" --trust "$TRUST_KEY" --out /out \
 && mv /out/linux-* /out/server

FROM node:22-bookworm-slim
ENV NODE_ENV=production DATA_DIR=/data PORT=3500 HTTPS_PORT=5543
WORKDIR /opt/mywinecorks
COPY --from=build /out/server/launcher.mjs ./launcher.mjs
COPY --from=build /out/server/app ./app
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3500 5543
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:3500/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "launcher.mjs"]
