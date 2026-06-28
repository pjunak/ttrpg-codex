FROM node:26-slim
WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY server.js .
COPY server-utils.cjs .
COPY tiler.js .
COPY server ./server
COPY web ./web

RUN mkdir data && chown -R node:node /app

USER node
EXPOSE 3000

# Probe /api/version — cheap, doesn't require auth, exercises the
# data-hash code path so a corrupt data dir or wedged event loop
# fails the check. node -e is used because node:26-slim doesn't
# ship curl/wget by default.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/version',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
