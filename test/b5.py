from playwright.sync_api import sync_playwright
URL='file:///home/ubuntu/oto/dist/Админавтотрап_ОТО.html'
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    pg=b.new_context(viewport={'width':1440,'height':960}).new_page()
    errs=[]
    pg.on('console',lambda m: errs.append(m.type+': '+m.text) if m.type in('error','warning') else None)
    pg.on('pageerror',lambda e: errs.append('PAGEERR '+str(e)))
    pg.goto(URL); pg.wait_for_timeout(600)
    pg.click('[data-u="SM-01"]'); pg.click('button[type=submit]'); pg.wait_for_timeout(1500)
    pg.select_option('select >> nth=0','60') if False else None
    pg.click('[data-tab=integration]'); pg.wait_for_timeout(500)
    scs=pg.evaluate("Array.from(document.querySelectorAll('[data-sc]')).map(e=>e.dataset.sc)")
    print(scs)
    for sc in scs:
        pg.evaluate("OTO.App.call('POST','/admin/reset',{}).then(()=>OTO.App.onLocationChanged())")
        pg.wait_for_timeout(800)
        pg.click('[data-tab=integration]'); pg.wait_for_timeout(300)
        pg.evaluate("document.querySelector('[data-sc=%s]').click()"%sc)
        pg.wait_for_timeout(300)
        pg.evaluate("OTO.App.call('POST','/time',{scale:60})")
        for i in range(9):
            pg.wait_for_timeout(2000)
            pg.evaluate('''(async()=>{const A=OTO.App;const s=A.state;for(const t of s.tickets.filter(t=>t.status=='new'||t.status=='in_review')){const c=await A.call('GET','/tickets/'+t.id+'/candidates');const L=(c.body&&c.body.candidates)||[];const top=L.find(x=>x.eligible!==false&&!x.rejected);if(top){const r=await A.call('POST','/tickets/'+t.id+'/assign',{agentId:top.agentId,confirmPreempt:true},{quiet:true});(window.__l=window.__l||[]).push(t.id+'>'+top.agentId+':'+r.status+(r.body&&r.body.error?r.body.error.message||JSON.stringify(r.body.error):''))}else (window.__l=window.__l||[]).push(t.id+' no cand '+L.length+' rej '+((c.body.rejected||[]).map(x=>x.agentId+':'+x.reasons[0]).join('|')).slice(0,300))}})()''')
        pg.wait_for_timeout(6000)
        r=pg.evaluate("""(()=>{const s=OTO.App.state;return {sc:'%s',t:s.tickets.map(t=>t.id.slice(-4)+':'+t.status+(t.normResult?(t.normResult.met?'+':'!'):'')+(t.urgency||'')).join(' '),risk:s.tickets.filter(t=>t.riskLevel&&t.riskLevel!='ok').length}})()"""%sc)
        r['log']=pg.evaluate('window.__l||[]'); pg.evaluate('window.__l=[]'); print(r)
    print('\n'.join(errs[:20]))
    b.close()
