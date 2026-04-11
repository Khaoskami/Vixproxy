FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++ gcc
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .

FROM node:20-alpine
RUN apk add --no-cache tini su-exec
WORKDIR /app
RUN addgroup -S vixproxy && adduser -S vixproxy -G vixproxy
COPY --from=builder /app /app
RUN mkdir -p /app/data && chown -R vixproxy:vixproxy /app/data
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/vixproxy.db
EXPOSE 3000

# Entrypoint runs as root only long enough to fix volume ownership
# (Railway-mounted volumes come back as root:root on every boot), then
# drops to the unprivileged vixproxy user before exec'ing the server.
RUN printf '#!/bin/sh\nset -e\nmkdir -p /app/data\nchown -R vixproxy:vixproxy /app/data\nexec su-exec vixproxy "$@"\n' > /usr/local/bin/entrypoint.sh \
    && chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "src/server.js"]
