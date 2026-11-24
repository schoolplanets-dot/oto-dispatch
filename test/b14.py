# Web-приложение по карте (слои QGIS): вкладка «Карта», подложка, свойства объектов, пробный маршрут, заявка
import sys
from playwright.sync_api import sync_playwright
URL=sys.argv[1] if len(sys.argv)>1 else 'http://localhost:8080/'
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    errs=[]
    pg=b.new_context(viewport={'width':1440,'height':960}).new_page()
    pg.on('pageerror',lambda e: errs.append('PAGEERR '+str(e)))
    pg.on('console',lambda m: errs.append(m.text) if m.type=='error' else None)
    pg.goto(URL); pg.wait_for_timeout(1500)
    print('transport', pg.evaluate("OTO.App.api.transport.label"), 'web', pg.evaluate("OTO.App.web"))
    pg.click('[data-u="SM-01"]'); pg.click('button[type=submit]'); pg.wait_for_timeout(2500)
    print('pack', pg.evaluate("OTO.App.state.pack.id"), pg.evaluate("OTO.App.state.pack.name"))
    pg.screenshot(path='shots/50_dispatch_geo.png')
    pg.click('[data-tab=map]'); pg.wait_for_timeout(1500)
    pg.screenshot(path='shots/51_map.png')
    print('edges drawn', pg.evaluate("document.querySelectorAll('[data-pane=map] .oto-edge').length"), 'stand zones', pg.evaluate("document.querySelectorAll('[data-pane=map] .oto-stand-zone').length"))
    # свойства участка
    pg.evaluate("OTO.Tabs.map.pick('edge:'+OTO.App.state.pack.edges.find(e=>e.src&&e.src.spd_kmh===20).id)")
    print('info', pg.inner_text('[data-pane=map] [data-r=info]').replace('\n',' | ')[:300])
    pg.evaluate("OTO.Tabs.map.pick('stand:MS09')"); print('stand', pg.inner_text('[data-pane=map] [data-r=info]').replace('\n',' | ')[:200])
    # пробный маршрут: Ангар -> МС-9 на спецтранспорте
    pg.select_option('[data-pane=map] [data-r=tmode]','vehicle')
    pg.click('[data-pane=map] [data-a=from]'); pg.evaluate("OTO.Tabs.map.pick('area:'+OTO.App.state.pack.areas.find(a=>a.src&&a.src.name==='Ангар').id)")
    pg.click('[data-pane=map] [data-a=to]'); pg.evaluate("OTO.Tabs.map.pick('stand:MS09')"); pg.wait_for_timeout(800)
    print('trial', pg.inner_text('[data-pane=map] [data-r=trial]').replace('\n',' | ')[:400])
    pg.screenshot(path='shots/52_map_route.png')
    # подложка OSM
    pg.select_option('[data-pane=map] [data-r=base]','osm'); pg.wait_for_timeout(4000)
    print('tiles', pg.evaluate("document.querySelectorAll('[data-pane=map] .oto-tile').length"))
    pg.screenshot(path='shots/53_map_osm.png')
    pg.select_option('[data-pane=map] [data-r=base]','sat'); pg.wait_for_timeout(4000); pg.click('[data-pane=map] [data-z=in]'); pg.click('[data-pane=map] [data-z=in]'); pg.wait_for_timeout(3000)
    pg.screenshot(path='shots/54_map_sat.png')
    pg.select_option('[data-pane=map] [data-r=base]','none')
    # заявка и движение
    r=pg.evaluate("""(async()=>{const r=await OTO.App.call('POST','/tickets',{source:'crew',regNo:'VP-BQA',description:'Течь гидравлики у основной стойки шасси',urgency:'urgent',externalRef:'WEB-'+Date.now()});return r.status+' '+(r.body.ticket&&r.body.ticket.id)})()""")
    print('ticket', r); pg.wait_for_timeout(1000)
    tid=r.split(' ')[1]
    print('apply', pg.evaluate(f"""(async()=>{{const c=await OTO.App.ses.get('/tickets/{tid}/candidates');const b=(c.body.candidates||c.body)[0];const a=await OTO.App.call('POST','/tickets/{tid}/assign',{{agentId:b.agentId}});return b.agentId+' '+Math.round(b.eta.totalS)+'s '+a.status}})()"""))
    pg.wait_for_timeout(20000)
    print('status', pg.evaluate(f"OTO.App.state.tickets.find(t=>t.id==='{tid}').status"))
    pg.screenshot(path='shots/55_map_live.png')
    pg.click('[data-tab=dispatch]'); pg.wait_for_timeout(1500); pg.screenshot(path='shots/56_dispatch_live.png')
    print('ERRS', errs[:8])
