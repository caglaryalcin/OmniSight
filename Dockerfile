FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache openssh-client sshpass tzdata

COPY package*.json ./
RUN npm install --omit=dev --no-optional && npm cache clean --force

COPY . .
RUN mkdir -p /app/data

ENV PORT=3000
ENV TZ=UTC
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://localhost:${PORT}/login" >/dev/null 2>&1 || exit 1

CMD ["npm", "start"]
