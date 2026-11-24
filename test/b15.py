# Web-приложение: телефон инженера (iPhone) и чат исходной программы через /ws/chat
from playwright.sync_api import sync_playwright
URL='http://localhost:8080/'
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    errs=[]
    ctx=b.new_context(viewport={'width':390,'height':844},device_scale_factor=2,is_mobile=True,has_touch=True)
    pg=ctx.new_page(); pg.on('pageerror',lambda e: errs.append('PAGEERR '+str(e))); pg.on('console',lambda m: errs.append(m.text) if m.type=='error' else None)
    pg.goto(URL); pg.wait_for_timeout(1200)
    pg.click('[data-u="AG-08"]'); pg.click('button[type=submit]'); pg.wait_for_timeout(2500)
    pg.screenshot(path='shots/57_phone_geo.png')
    print('phone text', pg.inner_text('#otoRoot')[:300].replace('\n',' | '))
    # исходная программа и её чат
    o=b.new_context(viewport={'width':1280,'height':900}).new_page(); o.on('console',lambda m: errs.append('orig: '+m.text) if m.type=='error' else None)
    o.goto(URL+'?mode=orig'); o.wait_for_timeout(2500)
    print('orig chat state', o.evaluate("(document.body.innerText.match(/ОНЛАЙН · КОМАНДА|ЛОКАЛЬНЫЙ СЕАНС|ПОДКЛЮЧЕНИЕ…/)||['?'])[0]"))
    o.screenshot(path='shots/58_orig_web.png')
    print('ERRS', errs[:6])
