# Sai Jyothsna Caterers & Suppliers — web application
# Stateful backend (SQLite file lives in /app/data). Run with a named volume
# so the database survives container restarts, and back that volume up.
# NOTE: Vercel / serverless hosting is NOT suitable for this app — the
# SQLite database must live on a persistent disk (VPS + pm2/systemd, or
# Docker with a volume, as here).

FROM node:24-alpine

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Application code (server + static frontend)
COPY server ./server
COPY public ./public

RUN mkdir -p data public/uploads

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

VOLUME ["/app/data"]

# The database is created and seeded automatically on first start.
CMD ["node", "server/server.js"]
