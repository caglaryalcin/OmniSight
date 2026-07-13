FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache openssh-client tzdata su-exec iputils libcap \
  && for bin in /bin/ping /usr/bin/ping; do [ -x "$bin" ] && setcap cap_net_raw+ep "$bin" || true; done
RUN addgroup -S omnisight && adduser -S -G omnisight -h /app omnisight

COPY package*.json ./
RUN npm install --omit=dev --no-optional && npm cache clean --force

COPY server.js demo-server.js ./
COPY src ./src
COPY public ./public
# Keep the complete agent distribution in the application image. The server
# exposes these files from /app/agent for Linux and Windows installations.
COPY agent ./agent
COPY docker-entrypoint.sh /usr/local/bin/omnisight-entrypoint
RUN mkdir -p /app/data \
  && chown -R omnisight:omnisight /app/data \
  && chmod +x /usr/local/bin/omnisight-entrypoint

ENV OMNISIGHT_MODE=prod
ENV PORT=3000
ENV TZ=UTC
EXPOSE 3000 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD port="${PORT:-3000}"; if [ "${OMNISIGHT_MODE:-prod}" = "demo" ] && [ "$port" = "3000" ]; then port="${OMNISIGHT_DEMO_PORT:-4000}"; fi; wget -qO- "http://localhost:${port}/healthz" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["omnisight-entrypoint"]
CMD ["omnisight-run"]
