"""Measure actual local history reads during UI sync notifications.

Requires the Vite development server with auth_mock.py's test settings. The
instrumentation is installed only in this isolated browser, never in the app.
"""
import json
import os
from pathlib import Path
from playwright.sync_api import expect, sync_playwright
from auth_mock import Backend, URL, COACH_ID, install

BASE=os.environ.get('PITCHWORK_BASE_URL','http://127.0.0.1:5288')
OUT=Path(__file__).resolve().parents[1]/'.test-artifacts'

class ReadBackend(Backend):
    def __init__(self):
        super().__init__('coach')
        self.reject=False
    def handle(self,route):
        if self.reject and route.request.method=='POST' and '/rest/v1/rpc/get_workspace' in route.request.url:
            route.fulfill(status=503,content_type='application/json',headers={'access-control-allow-origin':'*'},body=json.dumps({'message':'Synthetic workspace unavailable','code':'PGRST003'}))
            return
        super().handle(route)

with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True)
    context=browser.new_context(viewport={'width':390,'height':844})
    install(context)
    backend=ReadBackend()
    context.unroute(URL+'/**')
    context.route(URL+'/**',backend.handle)
    context.unroute('**/api/accounts')
    context.route('**/api/accounts',backend.handle)
    context.add_init_script("""if(location.hostname==='127.0.0.1'){
      const metrics=window.__snapshotReads={count:0,hold:false,held:[],ready:false};
      import('/src/storage.ts').then(({Repository})=>{
        const original=Repository.prototype.snapshot;
        Repository.prototype.snapshot=function(...args){
          metrics.count++;
          const result=original.apply(this,args);
          return metrics.hold?result.then(value=>new Promise(resolve=>metrics.held.push(()=>resolve(value)))):result;
        };
        metrics.ready=true;
      });
    }""")
    page=context.new_page()
    errors=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    page.goto(BASE)
    page.wait_for_load_state('networkidle')
    page.wait_for_function('window.__snapshotReads?.ready && window.__snapshotReads.count>0')
    page.locator('.workspace-status summary').click()
    feedback=page.locator('.status-details .sync-feedback')
    def sync():
        button=page.get_by_role('button',name='Refresh & sync',exact=True)
        if not button.is_visible():
            page.locator('.workspace-status summary').click()
        button.click()
    expect(feedback).to_have_text('All changes synced')
    page.evaluate('window.__snapshotReads.count=0')
    sync()
    page.wait_for_load_state('networkidle')
    expect(feedback).to_have_text('All changes synced')
    ordinary=page.evaluate('window.__snapshotReads.count')
    assert ordinary==1,ordinary

    # Completion status arrives while the data read is still held. It must not
    # invalidate that read and lose newly authorized or revoked data.
    pitcher={'id':'40000000-0000-4000-8000-000000000001','name':'Latest source player','jersey':'','ownerId':COACH_ID,'archived':False,'createdAt':'2026-01-01T00:00:00Z','updatedAt':'2026-01-01T00:00:00Z'}
    backend.data['pitchers']=[pitcher]
    page.evaluate('window.__snapshotReads.hold=true')
    sync()
    page.wait_for_function('window.__snapshotReads.held.length>0')
    expect(feedback).to_have_text('All changes synced')
    page.evaluate('window.__snapshotReads.hold=false;window.__snapshotReads.held.splice(0).forEach(release=>release())')
    page.get_by_role('button',name='Roster',exact=True).click()
    expect(page.get_by_text(pitcher['name'],exact=True)).to_be_visible()
    backend.data['pitchers']=[]
    page.evaluate('window.__snapshotReads.hold=true')
    sync()
    page.wait_for_function('window.__snapshotReads.held.length>0')
    expect(feedback).to_have_text('All changes synced')
    page.evaluate('window.__snapshotReads.hold=false;window.__snapshotReads.held.splice(0).forEach(release=>release())')
    expect(page.get_by_text(pitcher['name'],exact=True)).to_have_count(0)

    backend.reject=True
    page.evaluate('window.__snapshotReads.count=0')
    sync()
    expect(feedback).to_contain_text('Synthetic workspace unavailable')
    failures=page.evaluate('window.__snapshotReads.count')
    assert failures==0,failures
    assert not errors,errors
    OUT.mkdir(exist_ok=True)
    (OUT/'snapshot-reads.json').write_text(json.dumps({'passed':True,'successfulSyncHistoryReads':ordinary,'failedSyncHistoryReads':failures,'delayedAdditionAndRevocationVisible':True,'scope':'Single browser with mocked transport'},indent=2))
    browser.close()
    print('One history read per successful sync, zero on a status-only failure, and delayed addition/revocation refreshes passed.')
