from playwright.sync_api import sync_playwright
import collections
URL='file:///home/ubuntu/oto/dist/Админавтотрап_ОТО.html'
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    pg=b.new_context(viewport={'width':1440,'height':960}).new_page()
    errs=[]
    pg.on('pageerror',lambda e: errs.append('PAGEERR '+str(e)))
    pg.on('console',lambda m: errs.append(m.text) if m.type=='error' else None)
    pg.goto(URL); pg.wait_for_timeout(600)
    pg.click('[data-u="SM-01"]'); pg.click('button[type=submit]'); pg.wait_for_timeout(1500)
    pg.evaluate("OTO.App.call('POST','/time',{scale:10})")
    pg.click('[data-tab=integration]'); pg.wait_for_timeout(500)
    def sc(n): pg.evaluate("document.querySelector('[data-sc=%s]').click()"%n)
    def assign():
        pg.evaluate('''(async()=>{const A=OTO.App;for(const t of A.state.tickets.filter(t=>t.status=='new'||t.status=='in_review')){const c=await A.call('GET','/tickets/'+t.id+'/candidates',null,{quiet:true});const L=c.body.candidates||[];if(L[0])await A.call('POST','/tickets/'+t.id+'/assign',{agentId:L[0].agentId,confirmPreempt:true},{quiet:true})}})()''')
    sc('bad_data'); pg.wait_for_timeout(1000)
    sc('outage_gps'); pg.wait_for_timeout(1000)
    sc('remote_stand'); pg.wait_for_timeout(2500); assign(); pg.wait_for_timeout(5000)
    st=pg.evaluate("OTO.App.state.agents.filter(a=>['assigned','en_route','offered'].includes(a.status)).map(a=>a.id+':'+a.status)"); print(st)
    sc('stuck_engineer'); sc('taxi_on_route')
    for i in range(14):
        pg.wait_for_timeout(2500); assign()
        if i==6: pg.click('[data-tab=dispatch]'); pg.wait_for_timeout(600); pg.screenshot(path='shots/20_risk.png')
    print(pg.evaluate("OTO.App.state.tickets.map(t=>t.id+':'+t.status+':'+t.riskLevel+':'+JSON.stringify(t.normResult||{})).join('\\n')"))
    j=pg.evaluate("OTO.App.call('GET','/journal?limit=800',null,{quiet:true,noRefresh:true}).then(r=>r.body)")
    ev=j.get('events') or j.get('items')
    print(collections.Counter(e['type'] for e in ev))
    for e in ev:
        if e['type'] in ('risk_warning','norm_violated','ingest_error','aircraft_near','route_recalc') and True: print(e['type'], (e.get('text') or '')[:200])
    print(errs)
    b.close()
