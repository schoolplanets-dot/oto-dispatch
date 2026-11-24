import sys, time, json
from playwright.sync_api import sync_playwright
URL='file:///home/ubuntu/oto/dist/Админавтотрап_ОТО.html'
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    pg=b.new_page(viewport={'width':1440,'height':900})
    errs=[]
    pg.on('console',lambda m: errs.append(m.type+': '+m.text) if m.type in('error','warning') else None)
    pg.on('pageerror',lambda e: errs.append('PAGEERR '+str(e)))
    pg.goto(URL); pg.wait_for_timeout(1000)
    pg.screenshot(path='shots/01_login.png')
    pg.click('[data-u="SM-01"]'); pg.click('button[type=submit]'); pg.wait_for_timeout(3500)
    pg.screenshot(path='shots/02_dispatch.png')
    print('\n'.join(errs[:20]))
    b.close()
