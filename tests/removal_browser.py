"""Removal UI acceptance against the mocked Supabase development server."""
import os
import uuid
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from auth_mock import install, COACH_ID, TEAM_ID

BASE = os.environ.get('PITCHWORK_BASE_URL', 'http://127.0.0.1:5188')
OUT = Path(__file__).resolve().parents[1] / '.test-artifacts'
OUT.mkdir(exist_ok=True)


def exercise(browser, width, height):
    context = browser.new_context(viewport={'width': width, 'height': height})
    backend = install(context, role='admin')
    stamp = '2026-10-20T12:00:00Z'
    pid, sid, aid, coach = [str(uuid.uuid4()) for _ in range(4)]
    backend.data['teams'] = [{'id': TEAM_ID, 'name': 'Falcons', 'archived': False, 'createdAt': stamp, 'updatedAt': stamp}]
    backend.data['teamCoaches'] = [{'teamId': TEAM_ID, 'coachId': COACH_ID}]
    backend.data['pitchers'] = [{'id': pid, 'name': 'Jordan Lee', 'jersey': '14', 'ownerId': COACH_ID, 'archived': False, 'createdAt': stamp, 'updatedAt': stamp}]
    backend.data['teamPitchers'] = [{'teamId': TEAM_ID, 'pitcherId': pid, 'active': True}]
    backend.data['coaches'].append({'id': coach, 'name': 'Second Coach', 'email': 'second@example.com', 'role': 'coach', 'active': True})
    backend.requests.append({'id': str(uuid.uuid4()), 'name': 'Requester', 'email': 'request@example.com', 'requested_team': 'Falcons', 'status': 'pending'})
    backend.data['sessions'] = [{'id': sid, 'name': 'Tuesday bullpen', 'notes': 'Good extension', 'startedAt': stamp, 'updatedAt': stamp, 'endedAt': stamp, 'status': 'ended', 'archived': False, 'initialPitcherId': pid, 'initialAppearanceId': aid, 'selectedPitcherId': pid, 'pitcherIds': [pid], 'nextSequence': 3, 'teamId': TEAM_ID, 'recorderId': COACH_ID, 'deviceId': str(uuid.uuid4()), 'revision': 3}]
    backend.data['events'] = [{'id': str(uuid.uuid4()), 'sessionId': sid, 'pitcherId': pid, 'appearanceId': aid, 'nextAppearanceId': str(uuid.uuid4()), 'sequence': i, 'timestamp': stamp, 'kind': kind, 'voidedAt': None, **({'pitchType': 'called'} if kind == 'pitch' else {})} for i, kind in [(1, 'pitch'), (2, 'end')]]
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE)
    page.wait_for_load_state('networkidle')
    dialog = page.get_by_role('dialog')

    def nav(name):
        page.get_by_role('navigation').get_by_role('button', name=name, exact=True).click()

    def remove_player():
        nav('Roster')
        page.locator('.pitcher-card').get_by_role('button', name='Remove', exact=True).click()
        expect(dialog.get_by_label('Removal option')).to_be_visible()

    def delete(name):
        dialog.get_by_label('Removal option').select_option('delete')
        action = dialog.get_by_role('button', name='Delete permanently', exact=True)
        expect(action).to_be_disabled()
        dialog.get_by_role('textbox').fill('wrong')
        expect(action).to_be_disabled()
        dialog.get_by_role('textbox').fill(name)
        action.click()
        try:
            expect(dialog).to_have_count(0)
        except AssertionError:
            print(dialog.inner_text())
            raise

    remove_player()
    expect(dialog.get_by_role('button', name='Archive', exact=True)).to_be_disabled()
    dialog.get_by_label('Removal option').select_option('delete')
    expect(dialog.get_by_text('Delete all related practices individually', exact=False)).to_be_visible()
    page.screenshot(path=str(OUT / f'removal-{width}-dependencies.png'), full_page=True)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    dialog.get_by_role('button', name='Tuesday bullpen', exact=False).click()
    page.get_by_role('button', name='Remove practice').click()
    dialog.get_by_role('button', name='Archive', exact=True).click()
    expect(dialog).to_have_count(0)
    expect(page.get_by_text('Archived', exact=True)).to_be_visible()
    # Archive preserves the recorded pitch and derived statistics.
    expect(page.locator('.stats-overview dd').first).to_have_text('1')
    nav('Sessions')
    expect(page.locator('.session-row')).to_have_count(0)
    page.get_by_label('Filter practices by archive status').select_option('archived')
    page.locator('.session-row').click()
    page.get_by_role('button', name='Remove practice').click()
    dialog.get_by_role('button', name='Reactivate', exact=True).click()
    expect(dialog).to_have_count(0)
    page.get_by_role('button', name='Remove practice').click()
    dialog.get_by_label('Removal option').select_option('delete')
    dialog.get_by_role('textbox').fill('Tuesday bullpen')
    backend.fail_remove = True
    dialog.get_by_role('button', name='Delete permanently', exact=True).click()
    expect(dialog.get_by_role('alert')).to_contain_text('Simulated removal failure')
    expect(dialog).to_be_visible()
    backend.fail_remove = False
    dialog.get_by_role('button', name='Delete permanently', exact=True).click()
    expect(dialog).to_have_count(0)
    assert not backend.data['sessions'] and not backend.data['events']

    remove_player()
    dialog.get_by_label('Removal option').select_option('delete')
    dialog.get_by_role('textbox').fill('Jordan Lee')
    dialog.get_by_role('button', name='Cancel', exact=True).click()
    assert len(backend.data['pitchers']) == 1
    remove_player()
    delete('Jordan Lee')
    expect(page.locator('.pitcher-card')).to_have_count(0)
    assert not backend.data['teamPitchers']

    page.get_by_role('button', name='Teams', exact=True).click()
    page.locator('.team-card').click()
    page.get_by_role('button', name='Remove team').click()
    dialog.get_by_role('button', name='Archive', exact=True).click()
    expect(dialog).to_have_count(0)
    assert backend.data['teams'][0]['archived']
    page.get_by_role('button', name='All teams', exact=False).click()
    expect(page.locator('.team-card')).to_have_count(0)
    page.get_by_label('Filter teams by archive status').select_option('archived')
    page.locator('.team-card').click()
    page.get_by_role('button', name='Remove team').click()
    dialog.get_by_role('button', name='Reactivate', exact=True).click()
    expect(dialog).to_have_count(0)
    page.get_by_role('button', name='Remove team').click()
    delete('Falcons')
    assert not backend.data['teams'] and not backend.data['teamCoaches']

    nav('Settings')
    page.get_by_role('button', name='Remove account').click()
    dialog.get_by_role('button', name='Suspend account', exact=True).click()
    expect(dialog).to_have_count(0)
    page.get_by_label('Filter accounts by status').select_option('archived')
    page.get_by_role('button', name='Remove account').click()
    dialog.get_by_role('button', name='Reactivate account', exact=True).click()
    expect(dialog).to_have_count(0)
    page.get_by_label('Filter accounts by status').select_option('active')
    page.get_by_role('button', name='Remove account').click()
    delete('second@example.com')
    expect(page.get_by_role('button', name='Remove account')).to_have_count(0)
    page.get_by_role('button', name='Remove request').click()
    expect(dialog.get_by_role('button', name='Delete permanently', exact=True)).to_be_disabled()
    dialog.get_by_role('textbox').fill('request@example.com')
    dialog.get_by_role('button', name='Delete permanently', exact=True).click()
    expect(dialog).to_have_count(0)
    assert not backend.requests
    assert not errors, errors
    context.close()
    print(f'PASS removal flows {width}x{height}')


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    for width, height in [(1440, 1000), (390, 844)]:
        exercise(browser, width, height)
    for role in ['viewer', 'coach']:
        context = browser.new_context(viewport={'width': 390, 'height': 844})
        backend = install(context, role=role)
        stamp = '2026-10-20T12:00:00Z'
        backend.data['pitchers'] = [{'id': str(uuid.uuid4()), 'name': 'Permission check', 'jersey': '', 'ownerId': COACH_ID, 'archived': False, 'createdAt': stamp, 'updatedAt': stamp}]
        page = context.new_page()
        page.goto(BASE)
        page.wait_for_load_state('networkidle')
        page.get_by_role('navigation').get_by_role('button', name='Roster', exact=True).click()
        remove = page.locator('.pitcher-card').get_by_role('button', name='Remove', exact=True)
        if role == 'viewer':
            expect(remove).to_be_disabled()
        else:
            expect(remove).to_be_enabled()
            context.set_offline(True)
            expect(remove).to_be_disabled()
        context.close()
    print('PASS viewer and offline removal controls')
    browser.close()
