from playwright.sync_api import sync_playwright
URL='file:///home/ubuntu/oto/dist/Админавтотрап_ОТО.html'
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    errs=[]
    # lead context creates ticket via same origin? separate contexts have separate localStorage, so do all in one page
    ctx=b.new_context(viewport={'width':390,'height':844},device_scale_factor=2,is_mobile=True,has_touch=True)
    pg=ctx.new_page()
    pg.on('pageerror',lambda e: errs.append('PAGEERR '+str(e)))
    pg.on('console',lambda m: errs.append(m.text) if m.type=='error' else None)
    pg.goto(URL); pg.wait_for_timeout(800)
    pg.click('[data-u="SM-01"]'); pg.click('button[type=submit]'); pg.wait_for_timeout(1500)
    pg.evaluate("OTO.App.sim.stop && OTO.App.sim.stop()")
    pg.evaluate("OTO.App.logout()"); pg.wait_for_timeout(500)
    pg.click('[data-u="AG-05"]'); pg.click('button[type=submit]'); pg.wait_for_timeout(2500)
    pg.screenshot(path='shots/32_m_eng.png')
    print(pg.evaluate("document.documentElement.scrollWidth+' '+innerWidth"), errs)
    b.close()
