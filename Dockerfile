# Life Dash server. No npm dependencies: SQLite comes from Node's built-in node:sqlite (Node >= 22.13).
FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DB_PATH=/data/life-dash.db

WORKDIR /app
COPY --chown=root:root package.json index.html parsers.js ./
COPY --chown=root:root server ./server

# The database lives on a volume at /data, owned by the unprivileged "node" user.
RUN node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22||(a===22&&b<13)) { console.error("Node >= 22.13 required, got "+process.versions.node); process.exit(1) }' \
 && mkdir -p /data && chown node:node /data
VOLUME /data
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "server/server.mjs"]
