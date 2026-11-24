import sys, time, json
from playwright.sync_api import sync_playwright
URL='file:///home/ubuntu/oto/dist/Админавтотрап_ОТО.html'
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    pg=b.new_page(viewport={'width':1440,'height':1000})
    errs=[]
    pg.on('console',lambda m: errs.append(m.type+': '+m.text) if m.type in('error','warning') else None)
    pg.on('pageerror',lambda e: errs.append('PAGEERR '+str(e)))
    pg.goto(URL); pg.wait_for_timeout(600)
    pg.click('[data-u="SM-01"]'); pg.click('button[type=submit]'); pg.wait_for_timeout(2500)
    pg.screenshot(path='shots/03_fit.png')
    # scenario
    pg.click('[data-tab=integration]'); pg.wait_for_timeout(800)
    pg.screenshot(path='shots/04_integration.png')
    pg.click('[data-sc=aog_two_urgent]'); pg.wait_for_timeout(500)
    pg.click('[data-tab=dispatch]'); pg.wait_for_timeout(2500)
    pg.screenshot(path='shots/05_tickets.png')
    pg.click('.oto-ticket >> nth=0'); pg.wait_for_timeout(1500)
    pg.screenshot(path='shots/06_detail.png', full_page=True)
    print('\n'.join(errs[:20]))
    b.close()
