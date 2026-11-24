# Вариант образа для Amvera Cloud (amvera.ru): порт 80, данные в постоянном хранилище /data.
# Контекст сборки — корень репозитория. Параметры меняются в панели Amvera: «Переменные».
FROM node:22-alpine
WORKDIR /app
COPY . .
RUN node tools/geo-pack.js && node build.js
# SCALE: 1 — реальное время, 10 — ускорение; SIM: 1 — имитатор; OTO_PINS / OTO_DEMO — свои PIN (см. docs/Развёртывание_Docker.md)
ENV PORT=80 SCALE=1 SIM=0 PACK=GEO-MAP OTO_DEMO=1 OTO_DATA_DIR=/data TZ=Europe/Moscow NODE_ENV=production
EXPOSE 80
CMD ["sh", "-c", "exec node server/node-server.js --port ${PORT} --scale ${SCALE} --pack ${PACK} $( [ \"${SIM}\" = 1 ] && echo --sim )"]
