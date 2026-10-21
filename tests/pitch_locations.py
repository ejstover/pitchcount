"""Verify real hit targets and saved locations against an existing app server.

Use tests/auth_mock.py's Vite environment and PITCHWORK_AUTH_FIXTURE=1 for the
authenticated app. The fixture seeds one coach, team, and pitcher before opening.
"""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from auth_mock import install, COACH_ID, TEAM_ID

BASE_URL = os.environ.get('PITCHWORK_BASE_URL', 'http://127.0.0.1:5173')
ARTIFACTS = Path(__file__).resolve().parents[1] / '.test-artifacts'
ARTIFACTS.mkdir(exist_ok=True)
LOCATIONS = {
    'upIn': 'Up and in', 'upOut': 'Up and out',
    'downIn': 'Down and in', 'downOut': 'Down and out',
    'middle': 'Down the middle',
}


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 390, 'height': 844})
    authenticated = bool(os.environ.get('PITCHWORK_AUTH_FIXTURE'))
    if authenticated:
        backend = install(context, role='admin')
        timestamp = '2026-10-19T12:00:00Z'
        pitcher_id = '00000000-0000-4000-8000-000000000003'
        backend.data['teams'] = [{'id': TEAM_ID, 'name': 'Location Team', 'createdAt': timestamp, 'updatedAt': timestamp}]
        backend.data['teamCoaches'] = [{'teamId': TEAM_ID, 'coachId': COACH_ID}]
        backend.data['pitchers'] = [{'id': pitcher_id, 'name': 'Location Test', 'jersey': '14', 'ownerId': COACH_ID,
                                     'archived': False, 'createdAt': timestamp, 'updatedAt': timestamp}]
        backend.data['teamPitchers'] = [{'teamId': TEAM_ID, 'pitcherId': pitcher_id, 'active': True}]
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE_URL)
    page.wait_for_load_state('networkidle')

    def saved():
        expect(page.locator('[data-save-state]')).to_have_attribute('data-save-state', 'saved')

    def nav(name):
        page.get_by_role('navigation').get_by_role('button', name=name, exact=True).click()

    dialog = page.get_by_role('dialog')
    if not authenticated:
        page.get_by_role('button', name='Add your first pitcher').click()
        dialog.get_by_label('Pitcher name').fill('Location Test')
        dialog.get_by_role('button', name='Add pitcher', exact=True).click()
    saved()
    page.locator('.practice-options summary').click()
    page.get_by_label('Practice name').fill('Five locations')
    page.get_by_role('button', name='Start practice', exact=True).click()
    saved()
    expect(page.locator('.pitch-target')).to_have_count(20)
    assert all(text == '' for text in page.locator('.pitch-location-map').all_inner_texts())
    expected = []

    def verify_pitch(kind, location, keyboard=None, position=None):
        target = page.locator(f'.pitch-{kind} .pitch-location-{location}')
        target.scroll_into_view_if_needed()
        if keyboard:
            target.focus()
            page.keyboard.press(keyboard)
        else:
            # Hit the actual quadrant away from the central circle.
            box = target.bounding_box()
            if position is not None:
                pass
            elif location == 'middle':
                position = {'x': box['width'] / 2, 'y': box['height'] / 2}
            else:
                position = {'x': 12 if location.endswith('In') else box['width'] - 12,
                            'y': 12 if location.startswith('up') else box['height'] - 12}
            target.click(position=position)
        saved()
        expected.append((kind, location))
        expect(page.locator('.score-side strong').first).to_have_text(str(len(expected)))
        expect(page.locator('.pitch-log li').first).to_contain_text(LOCATIONS[location])

    for kind in ['ball', 'called', 'foul', 'inPlay']:
        for location in LOCATIONS:
            verify_pitch(kind, location)
    verify_pitch('ball', 'upIn', keyboard='Enter')
    verify_pitch('foul', 'middle', keyboard='Space')
    page.locator('.pitch-ball .pitch-location-upIn').focus()
    verify_pitch('ball', 'middle', position={'x': 12, 'y': 12})

    # The circle's square bounding-box corner belongs to the quadrant behind it.
    circle = page.locator('.pitch-ball .pitch-location-middle')
    circle.scroll_into_view_if_needed()
    box = circle.bounding_box()
    page.mouse.click(box['x'] + 1, box['y'] + 1)
    saved()
    expected.append(('ball', 'upIn'))
    expect(page.locator('.score-side strong').first).to_have_text(str(len(expected)))
    expect(page.locator('.pitch-log li').first).to_contain_text('Up and in')

    # Rapid taps retain both outcome and location, including batter completions.
    rapid = [('called', 'upOut'), ('ball', 'downIn'), ('inPlay', 'middle')]
    page.evaluate("""pitches => {
        for (const [kind, location] of pitches)
            document.querySelector(`.pitch-${kind} .pitch-location-${location}`).click();
    }""", rapid)
    expected.extend(rapid)
    saved()
    expect(page.locator('.score-side strong').first).to_have_text(str(len(expected)))
    page.get_by_role('button', name='Undo last pitch').click()
    saved()
    expect(page.locator('.pitch-log li').first).to_contain_text('Down the middle')
    expect(page.locator('.pitch-log li').first).to_contain_text('undone')
    page.reload()
    saved()
    expect(page.locator('.score-side strong').first).to_have_text(str(len(expected) - 1))
    expect(page.locator('.pitch-log li').first).to_contain_text('Down the middle')

    page.get_by_role('button', name='Pause', exact=True).click()
    saved()
    for target in page.locator('.pitch-target').all():
        expect(target).to_be_disabled()
    page.get_by_role('button', name='Resume', exact=True).click()
    saved()

    for width, height in [(320, 740), (390, 844), (768, 1024), (1440, 1000)]:
        page.set_viewport_size({'width': width, 'height': height})
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        for target in page.locator('.pitch-target').all():
            box = target.bounding_box()
            assert box['width'] >= 48 and box['height'] >= 48
        page.screenshot(path=str(ARTIFACTS / f'locations-{width}.png'), full_page=True)
        if width == 390:
            page.locator('.tracking-card').screenshot(path=str(ARTIFACTS / 'pitch-location-controls.png'))

    nav('Settings')
    with page.expect_download() as download_info:
        page.get_by_role('button', name='Download backup', exact=False).click()
    backup_path = ARTIFACTS / 'pitch-locations-backup.json'
    download_info.value.save_as(backup_path)
    backup = json.loads(backup_path.read_text(encoding='utf-8'))
    events = sorted((e for e in backup['events'] if e['kind'] == 'pitch'), key=lambda e: e['sequence'])
    assert [(e['pitchType'], e['pitchLocation']) for e in events] == expected
    assert events[-1]['voidedAt'] is not None

    nav('Sessions')
    page.locator('.session-row').click()
    expect(page.locator('.history-log th', has_text='Location')).to_be_visible()
    expect(page.locator('.history-log tbody tr')).to_have_count(len(expected))
    for row, (_, location) in zip(page.locator('.history-log tbody tr').all(), expected):
        expect(row.locator('td').nth(3)).to_have_text(LOCATIONS[location])
    assert not errors, errors
    context.close()
    browser.close()
    print('All 20 outcome/location targets, circle hit detection, keyboard, rapid taps, undo, reload, pause, layouts, history, and exported locations passed.')
