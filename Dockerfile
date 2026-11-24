# Web-приложение ОТО: интерфейс + REST API + имитатор + чат. Внешних npm-зависимостей нет.
FROM node:22-alpine
WORKDIR /app
COPY . .
# сборка локации из слоёв QGIS (data/geo/*.geojson) и единого HTML (dist/)
RUN node tools/geo-pack.js && node build.js && mkdir -p /app/data/runtime && chown -R node:node /app/data/runtime
# Параметры запуска (переопределяются через -e / docker-compose.yml):
#   PORT  — порт внутри контейнера; SCALE — ускорение времени (1 = реальное время);
#   SIM   — 1 = включить имитатор движения, пусто/0 = выключить; PACK — локация (GEO-MAP | SVO-DEMO | ZIA-DEMO)
#   OTO_PINS — свои PIN/ключи: "SM-01=7391,AG-01=5520"; OTO_DEMO=0 — скрыть подсказки учебных PIN на экране входа
ENV PORT=8080 SCALE=1 SIM=0 PACK=GEO-MAP OTO_DEMO=1 NODE_ENV=production
EXPOSE 8080
# заявки, журнал и состояние хранятся здесь — подключайте том, чтобы данные переживали обновления
VOLUME ["/app/data/runtime"]
USER node
HEALTHCHECK --interval=20s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/v1/health" >/dev/null || exit 1
CMD ["sh", "-c", "exec node server/node-server.js --port ${PORT} --scale ${SCALE} --pack ${PACK} $( [ \"${SIM}\" = 1 ] && echo --sim )"]
