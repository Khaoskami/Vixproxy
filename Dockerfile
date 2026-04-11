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
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/vixproxy.db
EXPOSE 3000

# tini is PID 1; the entrypoint script fixes /app/data ownership and
# drops to the unprivileged vixproxy user via su-exec before exec'ing node.
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
