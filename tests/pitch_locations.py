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
    'upIn': 'Upper left', 'upOut': 'Upper right',
    'downIn': 'Lower left', 'downOut': 'Lower right',
    'middle': 'Middle',
}


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 390, 'height': 844}, has_touch=True, is_mobile=True)
    authenticated = bool(os.environ.get('PITCHWORK_AUTH_FIXTURE'))
    if authenticated:
        backend = install(context, role=os.environ.get('PITCHWORK_ROLE', 'admin'))
        timestamp = '2026-10-19T12:00:00Z'
        pitcher_id = '00000000-0000-4000-8000-000000000003'
        backend.data['teams'] = [{'id': TEAM_ID, 'name': 'Location Team', 'createdAt': timestamp, 'updatedAt': timestamp}]
        backend.data['teamCoaches'] = [{'teamId': TEAM_ID, 'coachId': COACH_ID}]
        backend.data['pitchers'] = [{'id': pitcher_id, 'name': 'Location Test', 'jersey': '14', 'ownerId': COACH_ID,
                                     'archived': False, 'createdAt': timestamp, 'updatedAt': timestamp}]
        backend.data['teamPitchers'] = [{'teamId': TEAM_ID, 'pitcherId': pitcher_id, 'active': True}]
        if backend.profile['role'] == 'player':
            backend.profile['pitcherId'] = pitcher_id
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE_URL)
    page.wait_for_load_state('networkidle')

    if authenticated and backend.profile['role'] == 'player':
        page.get_by_role('navigation').get_by_role('button', name='Practice', exact=True).click()

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
    expect(page.locator('.zone-target')).to_have_count(9)
    expected = []
    zone = page.locator('.single-pitch-zone')

    def check(kind, location):
        expected.append((kind, location))
        saved()
        expect(page.locator('.score-side strong').first).to_have_text(str(len(expected)))
        expect(page.locator('.pitch-log li').first).to_contain_text(LOCATIONS[location])

    def tap(x, y, kind, location):
        zone.scroll_into_view_if_needed()
        box = zone.bounding_box()
        page.touchscreen.tap(box['x'] + box['width'] * x, box['y'] + box['height'] * y)
        check(kind, location)

    # Actual touch input covers each inner region and each filled diagonal corner.
    points = [(.12,.12,'ball','upIn'), (.88,.12,'ball','upOut'),
              (.12,.88,'ball','downIn'), (.88,.88,'ball','downOut'),
              (.3,.3,'called','upIn'), (.7,.3,'called','upOut'),
              (.3,.7,'called','downIn'), (.7,.7,'called','downOut'), (.5,.5,'called','middle')]
    for x,y,kind,location in points:
        tap(x,y,kind,location)
    # The straight outside bands are also tappable, with no gaps.
    for x,y,location in [(.3,.1,'upIn'),(.7,.1,'upOut'),(.1,.3,'upIn'),(.9,.3,'upOut'),
                         (.1,.7,'downIn'),(.9,.7,'downOut'),(.3,.9,'downIn'),(.7,.9,'downOut')]:
        tap(x,y,'ball',location)
    # Every special outcome can be located inside or outside, and resets each time.
    for kind,label in [('swinging','Swing'),('foul','Foul'),('inPlay','In play')]:
        for x,y,_,location in points:
            option=page.get_by_role('button',name=label,exact=True)
            option.click()
            expect(option).to_have_attribute('aria-pressed','true')
            tap(x,y,kind,location)
            expect(option).to_have_attribute('aria-pressed','false')
    option=page.get_by_role('button',name='Foul',exact=True)
    option.click(); option.click()
    expect(option).to_have_attribute('aria-pressed','false')
    option.click(); option.focus(); page.keyboard.press('Escape')
    tap(.5,.5,'called','middle')

    # Native keyboard activation must save exactly once.
    page.locator('.zone-called.zone-upIn').focus(); page.keyboard.press('Enter')
    check('called','upIn')
    page.locator('.zone-called.zone-middle').focus(); page.keyboard.press('Space')
    check('called','middle')
    # The square corner around the circle still belongs to the quadrant behind it.
    tap(.405,.405,'called','upIn')

    def drag(start,end,commit=True):
        zone.scroll_into_view_if_needed()
        box=zone.bounding_box()
        def at(point): return (box['x']+point[0]*box['width'],box['y']+point[1]*box['height'])
        page.mouse.move(*at(start)); page.mouse.down()
        page.mouse.move(*at(end),steps=6)
        if commit: expect(page.locator('.zone-preview')).to_have_count(1)
        page.mouse.up()

    # Adjust across the boundary, then lift. Only the final region is saved.
    drag((.3,.3),(.9,.7)); check('ball','downOut')
    drag((.1,.7),(.7,.3)); check('called','upOut')
    before=len(expected)
    drag((.5,.5),(1.1,.5),False)
    saved(); expect(page.locator('.score-side strong').first).to_have_text(str(before))
    # An operating-system interruption and clipped-corner tap save nothing.
    zone.scroll_into_view_if_needed(); box=zone.bounding_box()
    page.mouse.move(box['x']+box['width']/2,box['y']+box['height']/2); page.mouse.down()
    expect(page.locator('.zone-preview')).to_have_count(1)
    zone.dispatch_event('pointercancel',{'pointerId':1})
    page.mouse.up()
    expect(page.locator('.zone-preview')).to_have_count(0)
    zone.scroll_into_view_if_needed(); box=zone.bounding_box()
    page.touchscreen.tap(box['x']+2,box['y']+2)
    expect(page.locator('.score-side strong').first).to_have_text(str(before))

    # Rapid commands use the current one-shot selection even before React renders.
    page.get_by_role('button',name='Foul',exact=True).click()
    page.evaluate("""() => {
        document.querySelector('.zone-called.zone-upOut').click();
        document.querySelector('.zone-ball.zone-downIn').click();
        document.querySelector('.zone-called.zone-middle').click();
    }""")
    expected.extend([('foul','upOut'),('ball','downIn'),('called','middle')])
    saved()
    expect(page.locator('.score-side strong').first).to_have_text(str(len(expected)))
    page.get_by_role('button', name='Undo last pitch').click()
    undone_index = len(expected) - 1
    saved()
    expect(page.locator('.pitch-log li').first).to_contain_text('Middle')
    expect(page.locator('.pitch-log li').first).to_contain_text('undone')
    page.reload()
    if authenticated and backend.profile['role'] == 'player':
        nav('Practice')
    saved()
    expect(page.locator('.score-side strong').first).to_have_text(str(len(expected) - 1))
    expect(page.locator('.pitch-log li').first).to_contain_text('Middle')

    page.get_by_role('button', name='Pause', exact=True).click()
    saved()
    for target in page.locator('.zone-target').all():
        expect(target).to_be_disabled()
    page.get_by_role('button', name='Resume', exact=True).click()
    saved()

    for width, height in [(320,740),(390,844),(844,390),(667,375),(740,320),(768,1024),(1440,1000)]:
        page.set_viewport_size({'width': width, 'height': height})
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        for target in page.locator('.zone-target').all():
            box = target.bounding_box()
            assert box['width'] >= 48 and box['height'] >= 48
        # Record a real touch after every rotation/resize, then check the layout.
        zone.scroll_into_view_if_needed(); box=zone.bounding_box()
        page.touchscreen.tap(box['x']+box['width']*.12,box['y']+box['height']*.88)
        expected.append(('ball','downIn'))
        saved()
        expect(page.locator('.score-side strong').first).to_have_text(str(len(expected)-1))
        expect(page.locator('.pitch-log li').first).to_contain_text('Lower left')
        page.evaluate('window.scrollTo(0,0)')
        if width == 390:
            actions=page.locator('.tracking-actions').bounding_box()
            navigation=page.get_by_role('navigation').bounding_box()
            assert actions['y']+actions['height'] <= navigation['y']
        if width > height and 360 <= height <= 540:
            for selector in ['.single-pitch-zone','.zone-outcomes','.tracking-actions']:
                box=page.locator(selector).bounding_box()
                assert box['y'] >= 0 and box['y'] + box['height'] <= height, (width,height,selector,box)
        prefix='player-locations' if authenticated and backend.profile['role'] == 'player' else 'locations'
        page.screenshot(path=str(ARTIFACTS / f'{prefix}-{width}.png'), full_page=True)
        if width == 390:
            page.locator('.tracking-card').screenshot(path=str(ARTIFACTS / f'{prefix}-controls.png'))

    nav('Settings')
    with page.expect_download() as download_info:
        page.get_by_role('button', name='Download backup', exact=False).click()
    backup_path = ARTIFACTS / 'pitch-locations-backup.json'
    download_info.value.save_as(backup_path)
    backup = json.loads(backup_path.read_text(encoding='utf-8'))
    events = sorted((e for e in backup['events'] if e['kind'] == 'pitch'), key=lambda e: e['sequence'])
    assert [(e['pitchType'], e['pitchLocation']) for e in events] == expected
    assert events[undone_index]['voidedAt'] is not None

    nav('Sessions')
    page.locator('.session-row').click()
    expect(page.locator('.history-log th', has_text='Location')).to_be_visible()
    expect(page.locator('.history-log tbody tr')).to_have_count(len(expected))
    for row, (_, location) in zip(page.locator('.history-log tbody tr').all(), expected):
        expect(row.locator('td').nth(3)).to_have_text(LOCATIONS[location])
    assert not errors, errors
    context.close()
    browser.close()
    print('Shared-zone touch targets, diagonal corners, special outcomes, drag adjustment/cancel, keyboard, rapid taps, undo, reload, pause, portrait/landscape, history and backup passed.')
