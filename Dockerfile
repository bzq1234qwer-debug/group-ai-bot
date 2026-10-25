FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# 运行时不依赖任何第三方包：只用 Node 自带的 node:sqlite / fetch / WebSocket
COPY package.json ./
COPY src ./src
COPY tools/console.ts tools/console.html ./tools/

ENV CONSOLE_HOST=0.0.0.0
EXPOSE 7799

CMD ["node", "tools/console.ts"]
