FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production \
    PORT=6969

# Install dependencies first for better layer caching.
# Use the lockfile for reproducible builds, falling back if it's absent.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src/ ./src/

# Config is mounted at runtime — bundle a default so the image still boots standalone
COPY config/ ./config/

EXPOSE 6969

# Drop root privileges (the node:alpine image ships a "node" user)
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||6969)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
