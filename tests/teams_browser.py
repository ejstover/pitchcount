"""Teams UI acceptance; use the test-only Vite settings in auth_mock.py."""
import json
import os
import uuid
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from auth_mock import install, Backend, URL, COACH_ID

BASE = os.environ.get('PITCHWORK_BASE_URL', 'http://127.0.0.1:5184')
OUT = Path(__file__).resolve().parents[1] / '.test-artifacts'
OUT.mkdir(exist_ok=True)


class TeamsBackend(Backend):
    def handle(self, route):
        payload = json.loads(route.request.post_data or '{}')
        if '/rest/v1/rpc/manage' not in route.request.url or route.request.method == 'OPTIONS':
            return super().handle(route)
        action, item = payload['action'], payload['input']
        if action == 'setPitcher':
            self.data['teamPitchers'] = [m for m in self.data['teamPitchers'] if (m['teamId'], m['pitcherId']) != (item['teamId'], item['pitcherId'])]
            self.data['teamPitchers'].append({k: item[k] for k in ['teamId', 'pitcherId', 'active']})
        elif action == 'invite':
            self.data['invitations'].append({'id': str(uuid.uuid4()), 'teamId': item['teamId'], 'teamName': next(t['name'] for t in self.data['teams'] if t['id'] == item['teamId']), 'email': item['email'], 'createdAt': '2026-10-19T12:00:00Z'})
        elif action == 'cancelInvitation':
            self.data['invitations'] = [i for i in self.data['invitations'] if i['id'] != item['id']]
        elif action == 'removeCoach':
            self.data['teamCoaches'] = [m for m in self.data['teamCoaches'] if (m['teamId'], m['coachId']) != (item['teamId'], item['coachId'])]
        else:
            return super().handle(route)
        route.fulfill(status=200, content_type='application/json', headers={'access-control-allow-origin': '*'}, body='{}')


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
    install(context)
    backend = TeamsBackend('coach')
    context.unroute(URL + '/**')
    context.route(URL + '/**', backend.handle)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE)
    page.wait_for_load_state('networkidle')

    def saved():
        expect(page.locator('[data-save-state]')).to_have_attribute('data-save-state', 'saved')

    def nav(name):
        page.get_by_role('navigation').get_by_role('button', name=name, exact=True).click()

    def teams():
        nav('Roster')
        page.get_by_role('button', name='Teams', exact=True).click()

    teams()
    for name in ['Falcons', 'Owls']:
        page.get_by_role('button', name='Create team', exact=True).click()
        page.get_by_label('Team name', exact=True).fill(name)
        page.get_by_role('button', name='Save team', exact=True).click()
        saved()
        expect(page.locator('.team-title')).to_contain_text(name)
        expect(page.get_by_role('button', name='Remove coach Test Coach')).to_be_disabled()
        page.get_by_role('button', name='All teams', exact=False).click()
    assert len(backend.data['teams']) == 2
    page.get_by_role('button', name='Pitchers', exact=True).click()
    for name, assigned in [('Jordan Lee', ['Falcons', 'Owls']), ('Casey Smith', ['Falcons'])]:
        page.get_by_role('button', name='Add pitcher', exact=True).click()
        dialog = page.get_by_role('dialog')
        dialog.get_by_label('Pitcher name').fill(name)
        for team in assigned:
            dialog.get_by_label(team, exact=True).check()
        dialog.get_by_role('button', name='Add pitcher', exact=True).click()
        saved()
    jordan = next(p for p in backend.data['pitchers'] if p['name'] == 'Jordan Lee')
    assert sum(m['pitcherId'] == jordan['id'] for m in backend.data['teamPitchers']) == 2

    teams()
    page.locator('.team-card').filter(has=page.get_by_role('heading', name='Falcons', exact=True)).click()
    page.get_by_role('button', name='Remove Casey Smith from Falcons').click()
    saved()
    page.get_by_label('Add an existing pitcher', exact=True).select_option(label='Casey Smith')
    page.get_by_role('button', name='Assign pitcher', exact=True).click()
    saved()
    expect(page.get_by_role('button', name='Remove Casey Smith from Falcons')).to_be_visible()
    page.get_by_label('Coach’s email').fill('assistant@example.com')
    page.get_by_role('button', name='Invite coach', exact=True).click()
    saved()
    expect(page.get_by_label('Invitation link for assistant@example.com')).to_have_value(URL.replace('https://pitchwork-test.supabase.co', BASE) + '/?invite=' + backend.data['invitations'][0]['id'])
    page.get_by_role('button', name='Cancel invitation', exact=True).click()
    saved()
    expect(page.locator('.invitation-row')).to_have_count(0)
    second = {'id': str(uuid.uuid4()), 'name': 'Second Coach', 'email': 'second@example.com', 'role': 'coach', 'active': True}
    backend.data['coaches'].append(second)
    falcons = next(t['id'] for t in backend.data['teams'] if t['name'] == 'Falcons')
    backend.data['teamCoaches'].append({'teamId': falcons, 'coachId': second['id']})
    if page.locator('.workspace-status').get_attribute('open') is None:
        page.locator('.workspace-status summary').click()
    page.get_by_role('button', name='Refresh & sync').click()
    page.get_by_role('button', name='Remove coach Second Coach').click()
    saved()
    expect(page.get_by_role('button', name='Remove coach Second Coach')).to_have_count(0)

    for width, height, label in [(320, 740, 'small-phone'), (390, 844, 'iphone'), (768, 1024, 'tablet'), (1440, 1000, 'desktop')]:
        page.set_viewport_size({'width': width, 'height': height})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), label + ' team overflow'
        page.screenshot(path=str(OUT / ('teams-' + label + '.png')), full_page=True)

    nav('Practice')
    page.get_by_label('Practice team').select_option(label='Owls')
    expect(page.get_by_label('Starting pitcher').locator('option')).to_have_count(1)
    page.locator('.practice-options summary').click()
    page.get_by_label('Practice name').fill('Owls bullpen')
    page.get_by_role('button', name='Start practice', exact=True).click()
    saved()
    page.get_by_role('button', name='Ball, up and in', exact=True).click()
    saved()
    page.get_by_role('button', name='End session', exact=True).click()
    page.get_by_role('dialog').get_by_role('button', name='End session', exact=True).click()
    saved()
    nav('Roster')
    page.get_by_role('button', name='Edit Jordan Lee', exact=True).click()
    page.get_by_role('dialog').get_by_label('Owls', exact=True).uncheck()
    page.get_by_role('dialog').get_by_role('button', name='Save changes', exact=True).click()
    saved()
    nav('Statistics')
    page.get_by_label('Statistics team').select_option(label='Owls')
    expect(page.locator('.stats-overview .metric-grid div').filter(has=page.get_by_text('Total pitches', exact=True)).locator('dd')).to_have_text('1')
    teams()
    page.locator('.team-card').filter(has=page.get_by_role('heading', name='Owls', exact=True)).click()
    page.get_by_role('button', name='Owls bullpen', exact=False).click()
    expect(page.locator('.stats-overview')).to_contain_text('Owls')
    context.set_offline(True)
    teams()
    expect(page.get_by_role('button', name='Create team', exact=True)).to_be_disabled()
    context.set_offline(False)
    assert not errors, errors
    context.close()
    browser.close()
    print('Team creation, multiple assignments, invitations, coach removal, team-specific practice, historical statistics, offline controls, and responsive layouts passed.')
