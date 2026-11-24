from playwright.sync_api import sync_playwright
URL='file:///home/ubuntu/oto/dist/Админавтотрап_ОТО.html'
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    errs=[]
    pg=b.new_context(viewport={'width':1440,'height':960}).new_page()
    pg.on('pageerror',lambda e: errs.append('PAGEERR '+str(e)))
    pg.on('console',lambda m: errs.append(m.text) if m.type=='error' else None)
    pg.goto(URL+'?mode=orig'); pg.wait_for_timeout(1000)
    print('orig root visible', pg.evaluate("getComputedStyle(document.getElementById('otoRoot')).display"), pg.evaluate("!!document.getElementById('otoOpen')"))
    pg.screenshot(path='test/shots/40_orig0.png')
    pg.fill('#authPin','3381'); pg.click('#authSubmit'); pg.wait_for_timeout(1500)
    pg.screenshot(path='test/shots/40_orig.png')
    pg.click('#otoOpen'); pg.wait_for_timeout(1500)
    print('after click', pg.evaluate("getComputedStyle(document.getElementById('otoRoot')).display"))
    pg.screenshot(path='test/shots/40_mod.png'); pg.click('text=К исходной программе')
    pg.wait_for_timeout(500); print('back', pg.evaluate("getComputedStyle(document.getElementById('otoRoot')).display"))
    # http mode
    pg.goto(URL+'?api=http://localhost:8089'); pg.wait_for_timeout(2000)
    print(pg.evaluate("document.querySelector('.oto-login') ? 'login' : document.body.innerText.slice(0,200)"))
    pg.evaluate("localStorage.setItem('oto-mode','1')"); pg.goto(URL+'?api=http://localhost:8089'); pg.wait_for_timeout(1500); pg.click('[data-u="SM-01"]'); pg.click('button[type=submit]'); pg.wait_for_timeout(4000)
    pg.screenshot(path='test/shots/41_http.png')
    print(pg.evaluate("OTO.App.state && OTO.App.state.tickets.length"), errs)
    b.close()
