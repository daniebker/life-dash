# Life Dash. Stage 1 builds the React dashboard into one HTML file; stage 2 runs the TypeScript server
# directly with Node (type stripping, Node >= 22.18). The server has no npm dependencies at runtime.

FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY shared ./shared
COPY client ./client
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DB_PATH=/data/life-dash.db

WORKDIR /app
COPY --chown=root:root package.json ./
COPY --chown=root:root shared ./shared
COPY --chown=root:root server ./server
COPY --from=build --chown=root:root /src/dist ./dist

# The database lives on a volume at /data, owned by the unprivileged "node" user.
RUN node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22||(a===22&&b<18)) { console.error("Node >= 22.18 required, got "+process.versions.node); process.exit(1) }' \
 && mkdir -p /data && chown node:node /data
VOLUME /data
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "server/server.ts"]
