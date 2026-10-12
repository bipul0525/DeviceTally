# The DeviceTally server outside Cloudflare: one container, data in /data (one SQLite file).
#   docker compose up -d     (see docker-compose.yml and docs/self-hosting.md)
FROM node:24-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build:node

FROM node:24-slim
WORKDIR /app
COPY --from=build /src/dist/server.mjs ./server.mjs
COPY migrations ./migrations
ENV PORT=8787 DATA_DIR=/data NODE_ENV=production
RUN mkdir /data && chown node:node /data
VOLUME /data
EXPOSE 8787
USER node
HEALTHCHECK CMD node -e "fetch('http://localhost:'+process.env.PORT+'/api/meta').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server.mjs"]
