FROM node:26-slim
WORKDIR /app

COPY package*.json ./
# `npm ci` installs exactly the lockfile (reproducible builds — `install`
# may resolve newer in-range versions and silently drift between builds).
RUN npm ci --omit=dev

COPY server.js .
COPY server-utils.cjs .
COPY tiler.js .
COPY server ./server
COPY schemas ./schemas
COPY web ./web

RUN mkdir data && chown -R node:node /app

USER node
EXPOSE 3000

# Probe the constant-time readiness route. Dataset validation and role-scoped
# hashing belong to /api/version; tying container health to campaign size made
# large instances miss deployment deadlines. node -e is used because
# node:26-slim doesn't ship curl/wget by default.
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const r=require('http').get('http://127.0.0.1:3000/api/health',s=>process.exit(s.statusCode===200?0:1));r.setTimeout(3000,()=>r.destroy());r.on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
