FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./
RUN mkdir -p /app/data

CMD ["node", "index.js"]
