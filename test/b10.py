from playwright.sync_api import sync_playwright
URL='file:///home/ubuntu/oto/dist/Админавтотрап_ОТО.html'
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    errs=[]
    ctx=b.new_context(viewport={'width':390,'height':844},device_scale_factor=2,is_mobile=True,has_touch=True)
    pg=ctx.new_page()
    pg.on('pageerror',lambda e: errs.append('PAGEERR '+str(e)))
    pg.on('console',lambda m: errs.append(m.text) if m.type=='error' else None)
    pg.goto(URL); pg.wait_for_timeout(800)
    pg.screenshot(path='shots/30_m_login.png')
    print(pg.evaluate("Array.from(document.querySelectorAll('[data-u]')).map(e=>e.dataset.u).join(',')"))
    pg.click('[data-u="AG-05"]'); pg.fill('input[type=password],input[name=pin],input[data-pin]','4292' if False else '5203') if pg.query_selector('input[type=password],input[name=pin],input[data-pin]') else None
    pg.screenshot(path='shots/31_m_pin.png')
    pg.click('button[type=submit]'); pg.wait_for_timeout(2500)
    pg.screenshot(path='shots/32_m_eng.png')
    print(pg.evaluate("document.body.scrollWidth+' '+innerWidth"))
    # lead on mobile
    pg.evaluate("OTO.App.logout()"); pg.wait_for_timeout(500)
    pg.click('[data-u="SM-01"]'); pg.click('button[type=submit]'); pg.wait_for_timeout(2500)
    pg.screenshot(path='shots/33_m_lead.png')
    print('sw',pg.evaluate("document.documentElement.scrollWidth+' '+innerWidth"))
    # location switch on desktop
    pg2=b.new_context(viewport={'width':1440,'height':960}).new_page()
    pg2.on('pageerror',lambda e: errs.append('PAGEERR2 '+str(e)))
    pg2.on('console',lambda m: errs.append(m.text) if m.type=='error' else None)
    pg2.goto(URL); pg2.wait_for_timeout(600)
    pg2.click('[data-u="SM-01"]'); pg2.click('button[type=submit]'); pg2.wait_for_timeout(1500)
    pg2.click('[data-tab=location]'); pg2.wait_for_timeout(500)
    pg2.screenshot(path='shots/34_loc.png')
    print(pg2.evaluate("Array.from(document.querySelectorAll('[data-tab=location]')).length"))
    print(pg2.evaluate("Array.from(document.querySelectorAll('button,[data-pack],[data-act]')).filter(e=>/ZIA|pack|Пакет|Переключ/i.test(e.outerHTML.slice(0,200))).map(e=>e.outerHTML.slice(0,160)).slice(0,6).join('\\n')"))
    print(errs)
    b.close()
