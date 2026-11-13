"""Bounded admin directory and explicit team browsing, using mocked transport."""
import copy
import json
import os
from pathlib import Path
from playwright.sync_api import expect, sync_playwright
from auth_mock import Backend, URL, install

BASE = os.environ.get('PITCHWORK_BASE_URL', 'http://127.0.0.1:5187')
OUT = Path(__file__).resolve().parents[1] / '.test-artifacts'
OUT.mkdir(exist_ok=True)

class DirectoryBackend(Backend):
    def __init__(self):
        super().__init__('admin')
        self.profiles = [{'id': f'90000000-0000-4000-8000-{n:012d}', 'name': f'Coach {n:03d}', 'email': f'coach{n:03d}@example.com', 'role': 'coach', 'active': True} for n in range(120)]
        self.team = {'id': '80000000-0000-4000-8000-000000000001', 'name': 'Other team', 'archived': False, 'createdAt': '2026-10-20T12:00:00Z', 'updatedAt': '2026-10-20T12:00:00Z'}
        self.requested_scopes = []

    def handle(self, route):
        req = route.request
        payload = json.loads(req.post_data or '{}')
        result = None
        if req.method == 'POST' and '/functions/v1/accounts' in req.url:
            if payload.get('action') == 'list':
                rows = [p for p in self.profiles if (not payload.get('after') or p['id'] > payload['after']) and (not payload.get('search') or p['name'].lower().startswith(payload['search'].lower()))][:50]
                result = {'profiles': rows, 'requests': [], 'memberships': [], 'nextProfiles': rows[-1]['id'] if len(rows) == 50 else None, 'nextRequests': None}
            elif payload.get('action') == 'find_teams':
                result = [self.team]
        elif req.method == 'POST' and '/rest/v1/rpc/get_workspace_page' in req.url:
            self.requested_scopes.append(payload.get('p_team'))
            snapshot = copy.deepcopy(self.data)
            snapshot['teams'] = [self.team] if payload.get('p_team') == self.team['id'] else []
            result = {'epoch': 'test', 'items': [], 'next': None, 'snapshot': snapshot}
        if result is None:
            return super().handle(route)
        route.fulfill(status=200, content_type='application/json', headers={'access-control-allow-origin': '*'}, body=json.dumps(result))

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 390, 'height': 844})
    install(context, role='admin')
    backend = DirectoryBackend()
    context.unroute(URL + '/**')
    context.route(URL + '/**', backend.handle)
    context.unroute('**/api/accounts')
    context.route('**/api/accounts', backend.handle)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE)
    page.wait_for_load_state('networkidle')
    page.locator('.admin-workspace summary').click()
    page.get_by_label('Find a team').fill('Other')
    page.get_by_role('button', name='Search teams', exact=True).click()
    page.get_by_role('button', name='Open team', exact=True).click()
    expect(page.locator('.admin-workspace summary')).to_contain_text('Other team')
    assert backend.team['id'] in backend.requested_scopes
    page.get_by_role('button', name='Settings', exact=True).click()
    rows = page.locator('.account-admin .account-row')
    expect(rows).to_have_count(50)
    expect(rows.first).to_contain_text('coach000@example.com')
    page.get_by_role('button', name='Next directory page').click()
    expect(rows.first).to_contain_text('coach050@example.com')
    expect(rows).to_have_count(50)
    page.get_by_role('button', name='Previous directory page').click()
    expect(rows.first).to_contain_text('coach000@example.com')
    page.get_by_label('Find an account').fill('Coach 119')
    page.get_by_role('button', name='Search accounts', exact=True).click()
    expect(rows).to_have_count(1)
    expect(rows).to_contain_text('coach119@example.com')
    for width in [390, 1440]:
        page.set_viewport_size({'width': width, 'height': 900})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.screenshot(path=str(OUT / f'scalability-admin-{width}.png'))
    assert not errors, errors
    browser.close()
    print('Explicit admin team browsing, bounded directory pages, search, and responsive layouts passed')
