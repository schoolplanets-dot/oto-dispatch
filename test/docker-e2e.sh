#!/bin/sh
# Сквозная проверка Docker-образа: сборка → запуск → вход → заявка → перезапуск (данные сохранены) → чат → имитатор.
# Запуск: sh test/docker-e2e.sh   (нужны docker, curl, node; порт P свободен)
set -e
P=${P:-8090}; NET=${NET:---network host}; IMG=oto-dispatch:test; C=oto-e2e; V=oto-e2e-data
D() { sudo docker "$@"; }
cd "$(dirname "$0")/.."
D rm -f $C >/dev/null 2>&1 || true; D volume rm $V >/dev/null 2>&1 || true
echo "1) сборка образа"; D build $NET -q -t $IMG . >/dev/null
run() { D run -d --name $C $NET -e PORT=$P -e SIM=${1:-0} -e SCALE=${2:-1} -v $V:/app/data/runtime $IMG >/dev/null; for i in $(seq 1 30); do curl -sf localhost:$P/api/v1/health >/dev/null && return 0; sleep 1; done; echo "сервер не поднялся"; D logs $C; exit 1; }
echo "2) запуск"; run 0 1
curl -s localhost:$P/ | grep -q 'name="oto-api"' && echo "   интерфейс отдан как web-приложение"
curl -sf localhost:$P/manifest.webmanifest >/dev/null && echo "   PWA-манифест есть"
TOK=$(curl -s -X POST localhost:$P/api/v1/auth/login -H 'Content-Type: application/json' -d '{"userId":"SM-01","pin":"2468"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
[ -n "$TOK" ] && [ "$TOK" != undefined ] && echo "   вход SM-01: токен получен"
TID=$(curl -s -X POST localhost:$P/api/v1/tickets -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d '{"source":"crew","regNo":"VP-BQA","description":"Docker-проверка: течь гидравлики","urgency":"urgent","externalRef":"DOCKER-E2E-1"}' | node -pe 'const r=JSON.parse(require("fs").readFileSync(0)); (r.ticket||r).id')
echo "   заявка создана: $TID"
echo "3) остановка и повторный запуск с тем же томом"
D stop -t 10 $C >/dev/null; D logs $C 2>&1 | grep -q 'данные сохранены' && echo "   корректная остановка: данные записаны"
D rm $C >/dev/null; run 0 1
TOK=$(curl -s -X POST localhost:$P/api/v1/auth/login -H 'Content-Type: application/json' -d '{"userId":"SM-01","pin":"2468"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s "localhost:$P/api/v1/tickets/$TID" -H "Authorization: Bearer $TOK" | grep -q 'Docker-проверка' && echo "   заявка $TID на месте после перезапуска"
echo "4) чат WebSocket /ws/chat"
node -e "const a=new WebSocket('ws://localhost:$P/ws/chat'),b=new WebSocket('ws://localhost:$P/ws/chat');let o=0;b.onmessage=e=>{console.log('   чат: сообщение доставлено');process.exit(0)};const g=()=>{if(++o<2)return;a.send(JSON.stringify({type:'join',room:'r'}));b.send(JSON.stringify({type:'join',room:'r'}));setTimeout(()=>a.send(JSON.stringify({type:'chat',room:'r',message:{id:'m1',sender:'e',text:'ok'}})),200)};a.onopen=g;b.onopen=g;setTimeout(()=>{console.log('   чат: ТАЙМАУТ');process.exit(1)},5000)"
echo "5) учебный режим: SIM=1 SCALE=10"
D rm -f $C >/dev/null; run 1 10; sleep 4; D logs $C 2>&1 | grep -q 'Имитатор запущен' && echo "   имитатор запущен"
for i in $(seq 1 40); do S=$(D inspect --format '{{.State.Health.Status}}' $C); [ "$S" = healthy ] && break; sleep 1; done; echo "   healthcheck: $S"
echo "6) свои PIN: OTO_PINS + OTO_DEMO=0"
D rm -f $C >/dev/null; D volume rm $V >/dev/null
D run -d --name $C $NET -e PORT=$P -e OTO_PINS="SM-01=7391,AG-01=5520" -e OTO_DEMO=0 -v $V:/app/data/runtime $IMG >/dev/null
for i in $(seq 1 30); do curl -sf localhost:$P/api/v1/health >/dev/null && break; sleep 1; done
lg() { curl -s -o /dev/null -w '%{http_code}' -X POST localhost:$P/api/v1/auth/login -H 'Content-Type: application/json' -d "{\"userId\":\"$1\",\"pin\":\"$2\"}"; }
[ "$(lg SM-01 2468)" = 401 ] && echo "   учебный PIN SM-01 отклонён"
[ "$(lg SM-01 7391)" = 200 ] && echo "   новый PIN SM-01 принят"
TOK=$(curl -s -X POST localhost:$P/api/v1/auth/login -H 'Content-Type: application/json' -d '{"userId":"SM-01","pin":"7391"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s localhost:$P/api/v1/users/demo -H "Authorization: Bearer $TOK" | grep -q demoPin || echo "   подсказки PIN скрыты"
curl -s -o /dev/null -X PUT localhost:$P/api/v1/config/location -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{"builtin":"GEO-MAP"}'
[ "$(lg SM-01 7391)" = 200 ] && [ "$(lg AG-01 3381)" = 401 ] && echo "   после смены локации PIN сохранились"
D rm -f $C >/dev/null; D volume rm $V >/dev/null
echo "ГОТОВО: все шаги пройдены"
