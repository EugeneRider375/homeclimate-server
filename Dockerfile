FROM node:20-alpine

# better-sqlite3 требует нативной компиляции
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

# Убираем build-инструменты — образ меньше
RUN apk del python3 make g++

COPY . .
RUN mkdir -p /data

EXPOSE 3000
CMD ["node", "server.js"]
