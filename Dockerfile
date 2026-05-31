FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-optional && npm cache clean --force

COPY . .
RUN mkdir -p /app/credentials

ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://localhost:${PORT}/login" >/dev/null 2>&1 || exit 1

CMD ["npm", "start"]
