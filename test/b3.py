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
    pg.click('[data-u="SM-01"]'); pg.click('button[type=submit]'); pg.wait_for_timeout(2000)
    pg.select_option('[data-r=scale]','60'); pg.wait_for_timeout(1500)
    pg.click('[data-tab=integration]'); pg.wait_for_timeout(500)
    pg.click('[data-sc=single]'); pg.wait_for_timeout(500)
    pg.click('[data-tab=dispatch]'); pg.wait_for_timeout(2500)
    pg.click('.oto-ticket >> nth=0'); pg.wait_for_timeout(1500)
    pg.click('[data-act=assign] >> nth=0'); pg.wait_for_timeout(4000)
    pg.screenshot(path='shots/07_assigned.png')
    for i in range(4):
        pg.wait_for_timeout(3000)
        print(i, pg.evaluate("OTO.App.state.tickets.map(t=>t.id+':'+t.status+':'+(t.assigneeId||'')+':'+(t.normResult?JSON.stringify(t.normResult.met):'-')).join(' | ')"))
    pg.screenshot(path='shots/08_progress.png')
    ag=pg.evaluate("OTO.App.state.tickets[0].assigneeId")
    pg.click('[data-tab=engineer]'); pg.wait_for_timeout(1500)
    if ag: pg.select_option('[data-r2=agent]',ag); pg.wait_for_timeout(2500)
    pg.screenshot(path='shots/09_phone.png', full_page=True)
    pg.click('[data-tab=journal]'); pg.wait_for_timeout(1500)
    pg.screenshot(path='shots/10_journal.png')
    with pg.expect_download() as d: pg.click('[data-x=xlsx]')
    dl=d.value; dl.save_as('/tmp/journal.xlsx'); print('dl',dl.suggested_filename)
    with pg.expect_download() as d: pg.click('[data-x=csv]')
    d.value.save_as('/tmp/journal.csv')
    for tab in ['integration','classifier','location','api']:
        pg.click('[data-tab=%s]'%tab); pg.wait_for_timeout(1200); pg.screenshot(path='shots/11_%s.png'%tab)
    print('\n'.join(errs[:20]))
    b.close()
