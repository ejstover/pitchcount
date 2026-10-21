"""Browser acceptance checks. Run against an existing dev or preview server.

Requires Python Playwright and its Chromium browser, separate from app dependencies.
Use the mocked Supabase Vite environment documented in tests/auth_mock.py.
Example: python tests/browser_smoke.py
"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from auth_mock import install, COACH_ID, TEAM_ID

BASE_URL = os.environ.get('PITCHWORK_BASE_URL', 'http://127.0.0.1:5173')
ARTIFACTS = Path(__file__).resolve().parents[1] / '.test-artifacts'
ARTIFACTS.mkdir(exist_ok=True)


def exercise(browser, label):
    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
    backend = install(context, role='admin')
    stamp = '2026-10-19T12:00:00Z'
    backend.data['teams'] = [{'id': TEAM_ID, 'name': 'Falcons', 'createdAt': stamp, 'updatedAt': stamp}]
    backend.data['teamCoaches'] = [{'teamId': TEAM_ID, 'coachId': COACH_ID}]
    context.add_init_script("Object.defineProperty(crypto, 'randomUUID', {value: undefined, configurable: true})")
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE_URL)
    page.wait_for_load_state('networkidle')
    expect(page.get_by_role('heading', name='Practice', exact=True)).to_be_visible()
    print(f'{label} initial buttons: {page.get_by_role("button").all_text_contents()}')
    page.screenshot(path=str(ARTIFACTS / f'{label}-welcome.png'), full_page=True)

    def saved():
        expect(page.locator('[data-save-state]')).to_have_attribute('data-save-state', 'saved')

    def nav(name):
        page.get_by_role('navigation').get_by_role('button', name='Roster' if name == 'Pitchers' else name, exact=True).click()

    def count(balls, strikes):
        expect(page.locator('.count-numbers').get_by_label(f'{balls} balls', exact=True)).to_be_visible()
        expect(page.locator('.count-numbers').get_by_label(f'{strikes} strikes', exact=True)).to_be_visible()

    def pitch(kind):
        page.locator(f'.pitch-{kind} .pitch-location-middle').click()
        saved()

    def block_writes(store):
        page.evaluate("""targetStore => {
            const originalAdd = IDBObjectStore.prototype.add;
            const originalPut = IDBObjectStore.prototype.put;
            window.restoreTransactions = () => {
                IDBObjectStore.prototype.add = originalAdd;
                IDBObjectStore.prototype.put = originalPut;
            };
            for (const [method, original] of [['add', originalAdd], ['put', originalPut]]) {
                IDBObjectStore.prototype[method] = function(...args) {
                    if (this.name === targetStore) throw new DOMException('Simulated disk failure', 'QuotaExceededError');
                    return original.apply(this, args);
                };
            }
        }""", store)

    page.get_by_role('button', name='Add your first pitcher').click()
    dialog = page.get_by_role('dialog')
    expect(dialog.get_by_label('Pitcher name')).to_be_focused()
    dialog.get_by_label('Pitcher name').fill('Jordan Lee')
    dialog.get_by_label('Jersey number').fill('14')
    dialog.get_by_label('Falcons', exact=True).check()
    dialog.get_by_role('button', name='Add pitcher', exact=True).click()
    saved()
    nav('Pitchers')
    page.get_by_role('button', name='Add pitcher', exact=True).click()
    dialog.get_by_label('Pitcher name').fill('Morgan Diaz')
    dialog.get_by_label('Jersey number').fill('7')
    dialog.get_by_label('Falcons', exact=True).check()
    dialog.get_by_role('button', name='Add pitcher', exact=True).click()
    saved()
    expect(page.locator('.pitcher-card')).to_have_count(2)
    page.get_by_role('searchbox', name='Search pitchers').fill('14')
    expect(page.locator('.pitcher-card')).to_have_count(1)
    page.get_by_role('searchbox', name='Search pitchers').fill('')
    nav('Practice')
    page.locator('.practice-options summary').click()
    page.get_by_label('Practice name').fill('Sunday bullpen')
    page.get_by_label('Starting pitcher').select_option(label='Jordan Lee · #14')
    page.get_by_role('button', name='Start practice', exact=True).click()
    saved()
    count(0, 0)
    # Dispatch rapid taps before waiting for saves to exercise ordering.
    page.evaluate("""() => {
        for (const kind of ['ball', 'called', 'foul', 'foul'])
            document.querySelector('.pitch-' + kind + ' .pitch-location-middle').click();
    }""")
    saved()
    count(1, 2)
    expect(page.locator('.score-side')).to_contain_text('75%')
    expect(page.locator('.score-side').locator('strong').first).to_have_text('4')

    for width, height, name in [(1440, 1000, 'desktop'), (768, 1024, 'tablet'), (390, 844, 'iphone'), (320, 740, 'small-phone')]:
        page.set_viewport_size({'width': width, 'height': height})
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), f'{name} horizontal overflow'
        for target in page.locator('button:visible, select:visible, input:visible, summary:visible').all():
            box = target.bounding_box()
            assert box is None or box['height'] >= 47.9, f'{name} small touch target: {target.inner_text()}'
        if name == 'iphone':
            page.evaluate('window.scrollTo(0, 0)')
            undo_box = page.get_by_role('button', name='Undo last pitch').bounding_box()
            navigation_box = page.get_by_role('navigation').bounding_box()
            assert undo_box['y'] + undo_box['height'] <= navigation_box['y'], 'Undo should fit above phone navigation'
        page.screenshot(path=str(ARTIFACTS / f'{label}-{name}-practice.png'), full_page=True)

    page.get_by_role('button', name='Record swinging strike').click()
    saved()
    expect(page.locator('.pitch-log li').first).to_contain_text('Not recorded')
    count(0, 0)
    expect(page.locator('.mini-stats')).to_contain_text('1')
    page.get_by_role('button', name='Undo last pitch').click()
    saved()
    count(1, 2)
    page.reload()
    saved()
    count(1, 2)
    page.get_by_role('button', name='Next batter', exact=True).click()
    saved()
    count(0, 0)
    pitch('ball')
    page.get_by_role('button', name='Change pitcher', exact=True).click()
    dialog.get_by_role('button', name='Morgan Diaz').click()
    saved()
    count(0, 0)
    pitch('ball')
    page.get_by_role('button', name='Change pitcher', exact=True).click()
    dialog.get_by_role('button', name='Jordan Lee').click()
    saved()
    count(0, 0)
    page.get_by_role('button', name='Undo last pitch').click()
    saved()
    expect(page.locator('.pitcher-heading')).to_contain_text('Morgan Diaz')
    count(0, 0)

    page.get_by_role('button', name='Pause', exact=True).click()
    saved()
    for target in page.locator('.pitch-target').all():
        expect(target).to_be_disabled()
    page.reload()
    saved()
    expect(page.get_by_text('Practice paused.', exact=False)).to_be_visible()
    page.get_by_role('button', name='Resume', exact=True).click()
    saved()
    pitch('ball')
    page.get_by_label('Coaching notes').fill('Good extension. Work the outside edge next time.')
    page.get_by_role('button', name='Save notes', exact=True).click()
    saved()
    page.reload()
    saved()
    expect(page.get_by_label('Coaching notes')).to_have_value('Good extension. Work the outside edge next time.')
    page.get_by_role('button', name='Reset count', exact=True).click()
    dialog.get_by_role('button', name='Reset count', exact=True).click()
    saved()
    count(0, 0)

    # Simulate a disk failure, restore storage, and verify Retry saves only once.
    block_writes('appearances')
    page.locator('.pitch-called .pitch-location-upIn').click()
    expect(page.get_by_role('alert')).to_contain_text('Couldn’t save your changes.')
    count(0, 0)
    for target in page.locator('.pitch-target').all():
        expect(target).to_be_disabled()
    page.evaluate('window.restoreTransactions()')
    page.get_by_role('button', name='Retry', exact=True).click()
    saved()
    expect(page.get_by_role('alert')).to_have_count(0)
    count(0, 1)
    expect(page.locator('.pitch-log li').first).to_contain_text('Up and in')
    context.set_offline(True)
    pitch('ball')
    count(1, 1)
    context.set_offline(False)
    # Keyboard access and native dialog Escape behavior.
    page.get_by_role('button', name='Change pitcher', exact=True).focus()
    page.keyboard.press('Enter')
    expect(dialog).to_be_visible()
    page.keyboard.press('Escape')
    expect(dialog).to_have_count(0)

    # Removal requires all related practices to be ended first.
    nav('Practice')
    page.get_by_role('button', name='End session', exact=True).click()
    dialog.get_by_role('button', name='End session', exact=True).click()
    saved()
    expect(page.get_by_role('button', name='Start practice', exact=True)).to_be_visible()

    nav('Pitchers')
    jordan = page.locator('.pitcher-card').filter(has=page.get_by_role('heading', name='Jordan Lee'))
    page.get_by_role('button', name='Edit Jordan Lee', exact=True).click()
    dialog.get_by_label('Falcons', exact=True).uncheck()
    dialog.get_by_role('button', name='Save changes', exact=True).click()
    saved()
    jordan.get_by_role('button', name='Remove', exact=True).click()
    dialog.get_by_role('button', name='Archive', exact=True).click()
    expect(dialog).to_have_count(0)
    saved()
    expect(page.locator('.pitcher-card')).to_have_count(1)
    page.get_by_label('Filter roster by archive status').select_option('archived')
    expect(page.locator('.pitcher-card')).to_have_count(1)
    expect(page.locator('.pitcher-card')).to_contain_text('Jordan Lee')
    page.locator('.pitcher-card').get_by_role('button', name='Remove', exact=True).click()
    dialog.get_by_role('button', name='Reactivate', exact=True).click()
    expect(dialog).to_have_count(0)
    saved()
    page.get_by_label('Filter roster by archive status').select_option('active')
    expect(page.locator('.pitcher-card')).to_have_count(2)
    page.get_by_role('button', name='Edit Jordan Lee', exact=True).click()
    dialog.get_by_label('Jersey number').fill('21')
    dialog.get_by_role('button', name='Save changes', exact=True).click()
    saved()
    expect(jordan).to_contain_text('#21')
    nav('Sessions')
    page.locator('.session-row').click()
    expect(page.get_by_role('heading', name='Sunday bullpen', exact=True)).to_be_visible()
    expect(page.get_by_label('Coaching notes')).to_have_value('Good extension. Work the outside edge next time.')
    expect(page.locator('.history-log tbody tr')).to_have_count(10)
    expect(page.locator('.history-log')).to_contain_text('Undone')
    page.screenshot(path=str(ARTIFACTS / f'{label}-session-history.png'), full_page=True)
    nav('Statistics')
    expect(page.locator('.stats-overview')).to_contain_text('First-pitch strike %')
    page.get_by_label('Statistics pitcher').select_option(label='Jordan Lee')
    expect(page.locator('.stats-overview')).to_contain_text('Jordan Lee')
    assert not errors, f'Browser errors: {errors}'
    context.close()
    print(f'{label}: complete workflow, responsive layouts, keyboard access, persistence, and save recovery passed')


with sync_playwright() as playwright:
    chromium = playwright.chromium.launch(headless=True)
    exercise(chromium, 'chromium')
    chromium.close()
