import sys
from playwright.sync_api import sync_playwright
URL='file:///home/ubuntu/oto/dist/Админавтотрап_ОТО.html'
sc=sys.argv[1]; scale=int(sys.argv[2]); n=int(sys.argv[3])
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    pg=b.new_context(viewport={'width':1440,'height':960}).new_page()
    errs=[]
    pg.on('pageerror',lambda e: errs.append('PAGEERR '+str(e)))
    pg.goto(URL); pg.wait_for_timeout(600)
    pg.click('[data-u="SM-01"]'); pg.click('button[type=submit]'); pg.wait_for_timeout(1500)
    pg.evaluate("OTO.App.call('POST','/time',{scale:%d})"%scale)
    pg.click('[data-tab=integration]'); pg.wait_for_timeout(500)
    pg.evaluate("document.querySelector('[data-sc=%s]').click()"%sc)
    for i in range(n):
        pg.wait_for_timeout(2000)
        pg.evaluate('''(async()=>{const A=OTO.App;for(const t of A.state.tickets.filter(t=>t.status=='new'||t.status=='in_review')){const c=await A.call('GET','/tickets/'+t.id+'/candidates',null,{quiet:true});const L=c.body.candidates||[];if(L[0])await A.call('POST','/tickets/'+t.id+'/assign',{agentId:L[0].agentId,confirmPreempt:true},{quiet:true})}})()''')
    j=pg.evaluate("OTO.App.call('GET','/journal?limit=400',null,{quiet:true,noRefresh:true}).then(r=>r.body)")
    ev=j.get('events') or j.get('items') or j
    for e in ev[-int(sys.argv[4]) if len(sys.argv)>4 else -40:]:
        print(e.get('t') or e.get('time'), e.get('type'), (e.get('text') or '')[:150])
    print(pg.evaluate("OTO.App.state.tickets.map(t=>t.id+':'+t.status).join(' ')"), errs)
    b.close()
