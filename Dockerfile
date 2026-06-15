FROM node:22-alpine

WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY src/ ./src/

# Config is mounted at runtime — provide a default so the image still boots standalone
COPY config/ ./config/

EXPOSE 6969

ENV PORT=6969 \
    NODE_ENV=production

CMD ["node", "src/server.js"]
