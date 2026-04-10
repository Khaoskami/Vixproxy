# Root-level fallback Dockerfile for single-service Railway deploys.
# Used when the Railway service points at the repo root (no Root Directory
# override). Builds and runs the backend. For the canonical two-service
# monorepo setup, create separate services with Root Directory set to
# `backend` and `frontend` — those directories have their own Dockerfiles.

FROM node:20-alpine AS build
WORKDIR /app
COPY backend/package*.json ./backend/
RUN npm --prefix backend install
COPY backend/ ./backend/
RUN npm --prefix backend run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/backend/node_modules ./backend/node_modules
COPY --from=build /app/backend/package.json ./backend/
EXPOSE 3000
CMD ["node", "backend/dist/index.js"]
