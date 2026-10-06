FROM node:20-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends luajit \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY index.js lib.js server.js sandbox.js harness.lua ./

ENV PORT=3000
EXPOSE 3000

USER node

CMD ["node", "index.js"]
