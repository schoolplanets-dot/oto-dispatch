import sys, time, json
from playwright.sync_api import sync_playwright
URL='file:///home/ubuntu/oto/dist/Админавтотрап_ОТО.html'
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    ctx=b.new_context(viewport={'width':1440,'height':960},accept_downloads=True)
    pg=ctx.new_page()
    errs=[]
    pg.on('console',lambda m: errs.append(m.type+': '+m.text) if m.type in('error','warning') else None)
    pg.on('pageerror',lambda e: errs.append('PAGEERR '+str(e)))
    pg.goto(URL); pg.wait_for_timeout(600)
    pg.click('[data-u="SM-01"]'); pg.click('button[type=submit]'); pg.wait_for_timeout(2500)
    pg.click('[data-tab=integration]'); pg.wait_for_timeout(400)
    pg.click('[data-sc=remote_stand]'); pg.wait_for_timeout(400)
    pg.click('[data-tab=dispatch]'); pg.wait_for_timeout(2500)
    pg.click('.oto-ticket >> nth=0'); pg.wait_for_timeout(1500)
    pg.screenshot(path='shots/12_cands.png')
    pg.click('[data-act=assign] >> nth=0'); pg.wait_for_timeout(5000)
    pg.screenshot(path='shots/13_enroute.png')
    print(pg.evaluate("OTO.App.state.tickets.map(t=>t.id+':'+t.status+':'+(t.assigneeId||'')).join(' | ')"))
    ag=pg.evaluate("OTO.App.state.tickets[0].assigneeId")
    pg.click('[data-tab=engineer]'); pg.wait_for_timeout(800)
    pg.select_option('[data-r2=agent]',ag); pg.wait_for_timeout(2500)
    pg.screenshot(path='shots/14_phone_route.png', full_page=True)
    print(pg.evaluate("OTO.App.state.tickets.map(t=>t.id+':'+t.status+':'+(t.assigneeId||'')).join(' | ')"))
    print('\n'.join(errs[:20]))
    b.close()
