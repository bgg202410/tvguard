# 零第三方依赖：镜像里没有 npm install，构建不需要外网拉包
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8088 \
    DATA_DIR=/data \
    TZ=CST-8

# 不装 tzdata（避免构建时要连 apk 源）：用 POSIX 时区写法，Node 的 Date 一样按东八区
COPY package.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8088

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8088/api/v1/ping >/dev/null || exit 1

CMD ["node", "src/app.js"]
