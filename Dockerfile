# The freight workspace keeps a SQLite database and the attachments it has read,
# so it needs a writable filesystem. Mount a volume at /data; a container with
# no volume loses every request, quotation and session when it is replaced.
#
#   docker build -t mobility-pro-command .
#   docker run -p 4310:4310 -v mpc-data:/data --env-file .env.local mobility-pro-command
#
# Node 24 is not optional: the application uses the built-in node:sqlite, which
# is what keeps it free of native build dependencies.

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4310
# Storage lives on the volume, never in the image layer.
ENV FREIGHT_DATA_DIR=/data/freight
ENV MPC_DATA_DIR=/data/operations

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/next.config.mjs ./next.config.mjs
# Both have to be runnable inside the container holding the data. A backup
# nobody can restore from in place is not a backup.
COPY --from=build /app/scripts/backup.mjs ./scripts/backup.mjs
COPY --from=build /app/scripts/restore.mjs ./scripts/restore.mjs

# Runs unprivileged, and owns only its own data.
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4310

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4310)+'/api/freight/health').then(r=>r.json()).then(b=>process.exit(b.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "next", "start", "-p", "4310"]
