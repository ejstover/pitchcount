"""Production-only acceptance tests for offline, backups, and real worker updates.

Start npm run preview -- --port 4174, then run this script.
Build with tests/auth_mock.py's mocked Supabase environment and use a fresh profile.
Only the ignored worker artifact is changed; PITCHWORK_WORKER overrides dist/sw.js.
"""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from auth_mock import install

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / '.test-artifacts'
ARTIFACTS.mkdir(exist_ok=True)
BASE_URL = os.environ.get('PITCHWORK_BASE_URL', 'http://127.0.0.1:4174')
WORKER = Path(os.environ.get('PITCHWORK_WORKER', str(ROOT / 'dist' / 'sw.js')))


def saved(page):
    expect(page.locator('.save-status')).to_have_text('Saved on device')


def nav(page, name):
    page.get_by_role('navigation').get_by_role('button', name=name, exact=True).click()


def wait_offline(page):
    expect(page.get_by_label('Connection and offline availability')).to_contain_text('Ready offline', timeout=20000)
    page.evaluate('navigator.serviceWorker.ready.then(() => true)')


def count(page, balls, strikes):
    expect(page.locator('.count-numbers').get_by_label(f'{balls} balls', exact=True)).to_be_visible()
    expect(page.locator('.count-numbers').get_by_label(f'{strikes} strikes', exact=True)).to_be_visible()


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 390, 'height': 844}, accept_downloads=True)
    install(context, role='admin')
    errors = []
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE_URL)
    page.wait_for_load_state('networkidle')
    wait_offline(page)
    print('Initial cache ready; production manifest and service worker installed.')
    page.get_by_role('button', name='Add your first pitcher').click()
    dialog = page.get_by_role('dialog')
    dialog.get_by_label('Pitcher name').fill('Casey Offline')
    dialog.get_by_role('button', name='Add pitcher', exact=True).click()
    saved(page)
    page.get_by_role('button', name='Start practice', exact=True).click()
    dialog.get_by_label('Practice name').fill('Airplane mode bullpen')
    dialog.get_by_role('button', name='Let’s practice').click()
    saved(page)
    page.locator('.pitch-ball .pitch-location-middle').click()
    saved(page)
    count(page, 1, 0)

    # Close the tab, turn off networking, and launch a brand-new tab on the origin.
    page.close()
    context.set_offline(True)
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE_URL)
    saved(page)
    wait_offline(page)
    count(page, 1, 0)
    expect(page.get_by_label('Connection and offline availability')).to_contain_text('Offline')
    page.locator('.pitch-ball .pitch-location-middle').click()
    saved(page)
    page.reload()
    saved(page)
    count(page, 2, 0)
    context.set_offline(False)
    print('Offline close/reopen, scoring, and reload recovery passed.')

    nav(page, 'Settings')
    with page.expect_download() as exported:
        page.get_by_role('button', name='Download backup', exact=False).click()
    download = exported.value
    backup_file = ARTIFACTS / download.suggested_filename
    download.save_as(backup_file)
    saved(page)
    backup = json.loads(backup_file.read_text(encoding='utf-8'))
    assert backup['format'] == 'pitchwork-backup' and len(backup['events']) == 2
    assert all(event['pitchLocation'] == 'middle' for event in backup['events'])
    for width, height, label in [(320, 740, 'small-phone'), (390, 844, 'iphone'), (768, 1024, 'tablet'), (1440, 1000, 'desktop')]:
        page.set_viewport_size({'width': width, 'height': height})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'Settings overflow on {label}'
        page.screenshot(path=str(ARTIFACTS / f'settings-{label}.png'), full_page=True)

    # Transfer the downloaded file into another browser profile: no shared IndexedDB.
    target_context = browser.new_context(viewport={'width': 390, 'height': 844}, accept_downloads=True)
    install(target_context, role='admin')
    target = target_context.new_page()
    target.on('pageerror', lambda error: errors.append(str(error)))
    target.goto(BASE_URL)
    target.wait_for_load_state('networkidle')
    wait_offline(target)
    nav(target, 'Settings')
    target.get_by_label('Restore from a JSON backup').set_input_files({'name': 'broken.json', 'mimeType': 'application/json', 'buffer': b'{broken'})
    expect(target.get_by_role('alert')).to_contain_text('not valid JSON')
    target.get_by_label('Restore from a JSON backup').set_input_files(backup_file)
    expect(target.get_by_role('heading', name='Ready to restore')).to_be_visible()
    expect(target.get_by_role('button', name='Import backup copies')).to_be_disabled()
    target.get_by_label('I understand this imports separate copies into my account.').check()
    target.get_by_role('button', name='Import backup copies').click()
    saved(target)
    expect(target.get_by_text('Backup copies imported.', exact=False)).to_be_visible()
    nav(target, 'Sessions')
    target.locator('.session-row').click()
    expect(target.locator('.history-log tbody tr')).to_have_count(2)
    expect(target.locator('.history-log')).to_contain_text('Down the middle')
    target_context.set_offline(True)
    target.reload()
    saved(target)
    nav(target, 'Sessions')
    target.locator('.session-row').click()
    expect(target.locator('.history-log tbody tr')).to_have_count(2)
    target_context.close()
    print('JSON download, invalid-file rejection, imported copies, device transfer, and offline restore recovery passed.')

    # A changed worker script triggers a genuine waiting update, without changing source.
    nav(page, 'Practice')
    original = WORKER.read_bytes()
    try:
        WORKER.write_bytes(original + b'\n// Acceptance test: next release\n')
        page.evaluate('navigator.serviceWorker.getRegistration().then(reg => reg.update())')
        update = page.get_by_role('button', name='Update app', exact=True)
        expect(update).to_be_visible(timeout=20000)
        expect(update).to_be_disabled()
        count(page, 2, 0)
        page.get_by_label('Coaching notes').fill('Unsaved update check')
        page.get_by_role('button', name='Pause', exact=True).click()
        saved(page)
        expect(update).to_be_disabled()
        nav(page, 'Settings')
        expect(page.get_by_role('button', name='Download backup', exact=False)).to_be_disabled()
        nav(page, 'Practice')
        expect(page.get_by_label('Coaching notes')).to_have_value('Unsaved update check')
        page.get_by_role('button', name='Save notes', exact=True).click()
        saved(page)
        expect(update).to_be_enabled()
        page.get_by_role('button', name='End session', exact=True).click()
        expect(update).to_be_disabled()
        page.get_by_role('dialog').get_by_role('button', name='Keep practicing').click()
        expect(update).to_be_enabled()
        page.evaluate('window.acceptanceReloadMarker = true')
        update.click()
        page.wait_for_function('window.acceptanceReloadMarker !== true')
        saved(page)
        count(page, 2, 0)
        expect(page.get_by_label('Coaching notes')).to_have_value('Unsaved update check')
        expect(page.get_by_role('button', name='Resume', exact=True)).to_be_visible()
        expect(page.get_by_role('button', name='Update app', exact=True)).to_have_count(0)
        print('Real worker update waited for pause, saved notes, and closed forms; applied update preserved records.')
    finally:
        WORKER.write_bytes(original)
        context.close()
        browser.close()
    assert not errors, f'Browser errors: {errors}'
