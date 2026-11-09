FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV WORLDSAWAY_SURVEY_IMPORT_FILE=/app/content/altaway-regions-2026-11-08.json
WORKDIR /app
# The running image needs Node only; the compiler and TS loader stay in the build stage.
COPY --chown=node:node package.json ./
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node protocol ./protocol
COPY --chown=node:node resources ./resources
COPY --chown=node:node content ./content
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8080 1701 1702
# Mount persistent storage with Docker -v or a Railway Volume; Railway rejects VOLUME instructions.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+(process.env.WORLDSAWAY_HTTP_PORT||8080)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/src/cli.js", "--host", "0.0.0.0"]
