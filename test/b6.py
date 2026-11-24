from playwright.sync_api import sync_playwright
URL='file:///home/ubuntu/oto/dist/Админавтотрап_ОТО.html'
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    pg=b.new_context(viewport={'width':1440,'height':960}).new_page()
    pg.goto(URL); pg.wait_for_timeout(600)
    pg.click('[data-u="SM-01"]'); pg.click('button[type=submit]'); pg.wait_for_timeout(1500)
    pg.click('[data-tab=integration]'); pg.wait_for_timeout(500)
    pg.evaluate("document.querySelector('[data-sc=single]').click()")
    pg.wait_for_timeout(9000)
    print(pg.evaluate('''(async()=>{const A=OTO.App;const t=A.state.tickets[0];const c=await A.call('GET','/tickets/'+t.id+'/candidates');const L=c.body.candidates;const r=await A.call('POST','/tickets/'+t.id+'/assign',{agentId:L[0].agentId,confirmPreempt:true});return JSON.stringify([t.status,L.length,L[0]&&L[0].agentId,r.status,JSON.stringify(r.body).slice(0,300),c.body.rejected&&c.body.rejected.length])})()'''))
    b.close()
