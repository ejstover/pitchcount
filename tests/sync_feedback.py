"""Sync feedback at iPhone width; run with auth_mock.py's test-only Vite settings."""
import json
import os
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from auth_mock import Backend, URL, install

BASE = os.environ.get('PITCHWORK_BASE_URL', 'http://127.0.0.1:5184')
OUT = Path(__file__).resolve().parents[1] / '.test-artifacts'
OUT.mkdir(exist_ok=True)


class SyncBackend(Backend):
    def __init__(self):
        super().__init__('coach')
        self.hold = False
        self.reject = False
        self.held = []
        self.workspace_calls = 0

    def handle(self, route):
        if '/rest/v1/rpc/get_workspace' in route.request.url and route.request.method == 'POST':
            self.workspace_calls += 1
            if self.hold:
                self.held.append(route)
                return
            if self.reject:
                route.fulfill(status=400, content_type='application/json',
                              headers={'access-control-allow-origin': '*'},
                              body=json.dumps({'message': 'Recorded events cannot change', 'code': 'P0001'}))
                return
        super().handle(route)

    def release(self):
        self.hold = False
        for route in self.held:
            super().handle(route)
        self.held.clear()


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    install(context)
    backend = SyncBackend()
    context.unroute(URL + '/**')
    context.route(URL + '/**', backend.handle)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE)
    page.wait_for_load_state('networkidle')
    page.locator('.workspace-status summary').click()
    details = page.locator('.status-details')
    feedback = details.locator('.sync-feedback')
    expect(feedback).to_have_text('All changes synced')

    # Even an empty manual sync must acknowledge the tap and its result.
    page.get_by_role('button', name='Refresh & sync').click()
    expect(page.get_by_role('button', name='Refresh & sync')).to_be_enabled()
    expect(feedback).to_have_text('All changes synced')
    page.clock.install()
    backend.hold = True
    before = backend.workspace_calls
    with page.expect_request(lambda req: '/rest/v1/rpc/get_workspace' in req.url and req.method == 'POST'):
        page.get_by_role('button', name='Refresh & sync').click()
    busy = details.get_by_role('button', name='Syncing…', exact=True)
    expect(busy).to_be_disabled()
    expect(busy).to_have_attribute('aria-busy', 'true')
    expect(feedback).to_have_text('Syncing…')
    expect(details.locator('dl > div').filter(has=page.get_by_text('Device', exact=True))).to_contain_text('Saved on device')
    busy.evaluate('(button) => { button.click(); button.click(); }')
    page.clock.fast_forward(15001)
    expect(feedback).to_contain_text('Taking longer than expected…')
    assert backend.workspace_calls == before + 1
    assert len(backend.held) == 1
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.screenshot(path=str(OUT / 'sync-iphone-slow.png'), full_page=True)
    backend.release()
    expect(feedback).to_have_text('All changes synced')
    expect(page.get_by_role('button', name='Refresh & sync')).to_be_enabled()

    backend.reject = True
    page.get_by_role('button', name='Refresh & sync').click()
    expect(feedback).to_contain_text('Recorded events cannot change')
    expect(details.locator('dl > div').filter(has=page.get_by_text('Team sync', exact=True))).to_contain_text('Sync needs attention')
    notice = page.locator('.pwa-notice.sync-error')
    expect(notice).to_be_visible()
    expect(notice).to_have_css('background-color', 'rgb(251, 228, 221)')
    expect(feedback).to_contain_text('Your saved work remains on this device.')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.screenshot(path=str(OUT / 'sync-iphone-error.png'), full_page=True)
    backend.reject = False
    page.get_by_role('button', name='Refresh & sync').click()
    expect(feedback).to_have_text('All changes synced')
    expect(notice).to_have_count(0)

    # New local pitches can arrive while the last download is in progress.
    page.get_by_role('navigation').get_by_role('button', name='Roster', exact=True).click()
    page.get_by_role('button', name='Add pitcher', exact=True).click()
    page.get_by_label('Pitcher name').fill('Sync Tester')
    page.get_by_role('dialog').get_by_role('button', name='Add pitcher', exact=True).click()
    page.get_by_role('navigation').get_by_role('button', name='Practice', exact=True).click()
    page.get_by_role('button', name='Start practice', exact=True).click()
    expect(page.locator('.workspace-status summary')).to_contain_text('All changes synced')
    page.locator('.workspace-status summary').click()
    backend.hold = True
    with page.expect_request(lambda req: '/rest/v1/rpc/get_workspace' in req.url and req.method == 'POST'):
        page.get_by_role('button', name='Refresh & sync').click()
    page.get_by_role('button', name='Ball, up and in', exact=True).click()
    expect(page.locator('[data-save-state]')).to_have_attribute('data-save-state', 'saved')
    backend.release()
    expect(feedback).to_have_text('Changes still waiting to sync')
    page.clock.fast_forward(301)
    expect(feedback).to_have_text('All changes synced')
    assert len(backend.data['events']) == 1

    context.set_offline(True)
    expect(page.get_by_role('button', name='Refresh & sync')).to_be_disabled()
    expect(feedback).to_contain_text('Offline. Changes will sync when you reconnect.')
    expect(details.locator('dl > div').filter(has=page.get_by_text('Device', exact=True))).to_contain_text('Saved on device')
    page.screenshot(path=str(OUT / 'sync-iphone-offline.png'), full_page=True)
    context.set_offline(False)
    expect(feedback).to_have_text('All changes synced')
    assert not errors, errors
    context.close()
    browser.close()
    print('iPhone sync progress, slow requests, repeated taps, empty sync, errors, retry, pending work, and offline feedback passed.')
