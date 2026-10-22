"""Heat-map/date acceptance checks using the auth_mock.py Vite environment."""
import os
import uuid
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from auth_mock import install, COACH_ID, TEAM_ID

BASE_URL = os.environ.get('PITCHWORK_BASE_URL', 'http://127.0.0.1:5173')
ARTIFACTS = Path(__file__).resolve().parents[1] / '.test-artifacts'
ARTIFACTS.mkdir(exist_ok=True)


def uid(name):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, 'pitchwork-statistics-' + name))


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 1000}, timezone_id='America/New_York')
    backend = install(context, role='admin')
    stamp = '2026-10-01T12:00:00Z'
    p1, p2, team2 = uid('p1'), uid('p2'), uid('team2')
    backend.data['teams'] = [{'id': team, 'name': name, 'createdAt': stamp, 'updatedAt': stamp} for team, name in [(TEAM_ID, 'Falcons'), (team2, 'Hawks')]]
    backend.data['teamCoaches'] = [{'teamId': team['id'], 'coachId': COACH_ID} for team in backend.data['teams']]
    backend.data['pitchers'] = [{'id': pitcher, 'name': name, 'jersey': '', 'ownerId': COACH_ID, 'archived': pitcher == p2, 'createdAt': stamp, 'updatedAt': stamp} for pitcher, name in [(p1, 'Jordan Lee'), (p2, 'Morgan Diaz')]]
    backend.data['teamPitchers'] = [{'teamId': team['id'], 'pitcherId': p1, 'active': True} for team in backend.data['teams']]
    for key, started, team in [('current-week', '2026-10-19T03:50:00Z', TEAM_ID), ('last-week', '2026-10-12T12:00:00Z', team2), ('last-month', '2026-09-15T12:00:00Z', TEAM_ID)]:
        sid = uid(key)
        events = []
        # First practice begins Sunday night locally; all pitches land Monday.
        for sequence, (kind, location, pitcher, voided) in enumerate([
            ('ball', 'upIn', p1, False), ('called', 'upOut', p1, False),
            ('swinging', None, p1, False), ('inPlay', 'middle', p1, False),
            ('inPlay', 'downOut', p1, True), ('switch', None, p2, False),
            ('foul', 'downIn', p2, False),
        ], 1):
            event = {'id': uid(f'{key}-{sequence}'), 'sessionId': sid, 'pitcherId': pitcher, 'appearanceId': uid(key + '-a'), 'nextAppearanceId': uid(f'{key}-after-{sequence}'), 'sequence': sequence, 'timestamp': '2026-10-19T04:10:00Z' if key == 'current-week' else started, 'kind': 'switch' if kind == 'switch' else 'pitch', 'voidedAt': started if voided else None}
            if kind != 'switch':
                event['pitchType'] = kind
            if location:
                event['pitchLocation'] = location
            events.append(event)
        backend.data['events'].extend(events)
        backend.data['sessions'].append({'id': sid, 'name': key, 'notes': '', 'startedAt': started, 'updatedAt': started, 'endedAt': started, 'status': 'ended', 'teamId': team, 'recorderId': COACH_ID, 'deviceId': uid('other-device'), 'revision': 1, 'initialPitcherId': p1, 'selectedPitcherId': p2, 'pitcherIds': [p1, p2], 'initialAppearanceId': uid(key + '-a'), 'nextSequence': 8, 'archived': key == 'last-month'})
    page = context.new_page()
    page.clock.set_fixed_time('2026-10-20T16:00:00Z')
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE_URL)
    page.wait_for_load_state('networkidle')

    def nav(name):
        page.get_by_role('navigation').get_by_role('button', name=name, exact=True).click()

    def saved():
        expect(page.locator('[data-save-state]')).to_have_attribute('data-save-state', 'saved')

    def total(value):
        expect(page.locator('.stats-overview .metric-grid dd > .stat-value').first).to_have_text(str(value))

    def coverage(located, pitches):
        expect(page.locator('.heatmap-coverage')).to_have_text(f'Locations recorded for {located} of {pitches} pitches.')

    nav('Statistics')
    expect(page.get_by_label('Statistics source', exact=True)).to_have_value('combined')
    page.get_by_label('Statistics source', exact=True).select_option('practice')
    total(15)
    coverage(12, 15)
    expect(page.get_by_label('Date range', exact=True)).to_have_value('all')
    expect(page.get_by_label('Outcome', exact=True)).to_have_value('all')
    expect(page.locator('.heatmap-frequent')).to_contain_text('(tie)')
    for location, count in [('upIn', 3), ('upOut', 3), ('downIn', 3), ('downOut', 0), ('middle', 3)]:
        expect(page.locator(f'.heatmap-{location} strong')).to_have_text(str(count))
    positions = {key: page.locator('.heatmap-' + key).bounding_box() for key in ['upIn', 'upOut', 'downIn', 'downOut', 'middle']}
    assert positions['upIn']['x'] < positions['upOut']['x']
    assert positions['upIn']['y'] < positions['downIn']['y']
    assert positions['middle']['x'] > positions['upIn']['x']
    page.get_by_label('Outcome', exact=True).select_option('strikes')
    coverage(3, 6)
    total(15)
    expect(page.locator('.heatmap-upOut .heatmap-region-data')).to_contain_text('100%')
    green = page.locator('.heatmap-upOut').evaluate('(element) => getComputedStyle(element).backgroundColor')
    page.get_by_label('Outcome', exact=True).select_option('ball')
    coverage(3, 3)
    expect(page.locator('.heatmap-frequent')).to_contain_text('Most common ball location')
    assert green == page.locator('.heatmap-upIn').evaluate('(element) => getComputedStyle(element).backgroundColor')
    page.get_by_label('Outcome', exact=True).focus()
    page.keyboard.press('Home')
    page.keyboard.press('Enter')
    expect(page.get_by_label('Outcome', exact=True)).to_have_value('all')

    for preset, count, row in [('thisWeek', 5, 'current-week'), ('lastWeek', 5, 'last-week'), ('twoWeeks', 10, None), ('lastMonth', 5, 'last-month')]:
        page.get_by_label('Date range', exact=True).select_option(preset)
        total(count)
        expect(page.locator('.session-row')).to_have_count(2 if preset == 'twoWeeks' else 1)
        if row:
            expect(page.locator('.session-row')).to_contain_text(row)
    # Draft/invalid custom ranges must not change the applied last-month range.
    page.get_by_label('Date range', exact=True).select_option('custom')
    page.get_by_role('button', name='Apply', exact=True).click()
    expect(page.get_by_role('alert')).to_contain_text('Choose both dates')
    total(5)
    page.get_by_label('Start date', exact=True).fill('2026-10-19')
    page.get_by_label('End date', exact=True).fill('2026-10-18')
    page.get_by_role('button', name='Apply', exact=True).click()
    expect(page.get_by_role('alert')).to_be_visible()
    expect(page.locator('.stats-overview .small-label')).to_contain_text('Sep')
    page.get_by_label('Start date', exact=True).fill('2026-10-18')
    page.get_by_role('button', name='Apply', exact=True).click()
    total(5)
    coverage(4, 5)
    expect(page.locator('.stats-overview .small-label')).to_contain_text('Oct 18, 2026')
    page.get_by_label('Statistics pitcher').select_option(p1)
    total(4)
    page.get_by_label('Statistics team').select_option(team2)
    total(0)
    expect(page.locator('.heatmap-empty')).to_be_visible()
    page.get_by_label('Statistics team').select_option(TEAM_ID)
    total(4)
    nav('Roster')
    nav('Statistics')
    expect(page.get_by_label('Start date', exact=True)).to_have_value('2026-10-18')
    total(4)

    page.get_by_label('Statistics pitcher').select_option('')
    page.get_by_label('Statistics team').select_option('')
    page.get_by_label('Date range', exact=True).select_option('all')
    for width, height in [(320, 740), (390, 844), (768, 1024), (1440, 1000)]:
        page.set_viewport_size({'width': width, 'height': height})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
        for control in page.locator('.statistics-dates select, .heatmap-outcome select').all():
            assert control.bounding_box()['height'] >= 48
        page.screenshot(path=str(ARTIFACTS / f'statistics-{width}.png'), full_page=True)
        if width == 1440:
            page.locator('.pitch-heatmap').screenshot(path=str(ARTIFACTS / 'statistics-heatmap-desktop.png'))
        page.get_by_label('Date range', exact=True).select_option('custom')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), ('custom', width)
        if width == 390:
            page.locator('.statistics-filters').screenshot(path=str(ARTIFACTS / 'statistics-custom-390.png'))
        page.get_by_label('Date range', exact=True).select_option('all')

    page.locator('.session-row', has_text='current-week').click()
    expect(page.locator('.session-pitcher .pitch-heatmap')).to_have_count(2)
    first, second = page.locator('.session-pitcher').all()
    expect(first.locator('.heatmap-coverage')).to_contain_text('3 of 4')
    expect(second.locator('.heatmap-coverage')).to_contain_text('1 of 1')
    first.get_by_label('Outcome', exact=True).select_option('strikes')
    expect(first.locator('.heatmap-coverage')).to_contain_text('1 of 2')
    expect(second.get_by_label('Outcome', exact=True)).to_have_value('all')
    first.get_by_label('Outcome', exact=True).select_option('all')
    for width, height in [(320, 740), (390, 844), (768, 1024), (1440, 1000)]:
        page.set_viewport_size({'width': width, 'height': height})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), ('session', width)
        page.screenshot(path=str(ARTIFACTS / f'statistics-session-{width}.png'), full_page=True)
        if width == 320:
            first.locator('.pitch-heatmap').screenshot(path=str(ARTIFACTS / 'statistics-session-map-320.png'))

    # New practice and undo must immediately update the current-session map.
    nav('Practice')
    page.get_by_role('button', name='Start practice', exact=True).click()
    saved()
    page.get_by_role('button', name='Ball, upper left', exact=True).click()
    saved()
    page.get_by_role('button', name='Called strike, middle', exact=True).click()
    saved()
    nav('Statistics')
    page.get_by_label('Statistics scope').select_option('current')
    total(2)
    coverage(2, 2)
    nav('Practice')
    page.get_by_role('button', name='Undo last pitch').click()
    saved()
    nav('Statistics')
    total(1)
    coverage(1, 1)
    page.get_by_label('Date range', exact=True).select_option('lastMonth')
    total(0)
    coverage(0, 0)
    page.reload()
    saved()
    nav('Statistics')
    expect(page.get_by_label('Date range', exact=True)).to_have_value('all')
    expect(page.get_by_label('Statistics source', exact=True)).to_have_value('combined')
    page.get_by_label('Statistics source', exact=True).select_option('practice')
    expect(page.get_by_label('Statistics scope')).to_have_value('all')
    total(16)
    assert not errors, errors
    context.close()
    browser.close()
    print('Heat-map counts, coverage, outcomes, historical orientation, dates, filter intersections, archive history, session maps, undo, defaults, keyboard, and all four layouts passed.')
