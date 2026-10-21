"""GameChanger UI acceptance; SQL authorization and atomicity are tested in server.test.ts."""
import copy
import csv
import io
import json
import os
import uuid
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from auth_mock import install, COACH_ID, TEAM_ID, URL

ROOT = Path(__file__).resolve().parents[1]
BASE_URL = os.environ.get('PITCHWORK_BASE_URL', 'http://127.0.0.1:5191')

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
    backend = install(context, role='admin')
    stamp = '2026-10-01T12:00:00.000Z'
    pid, sid, aid = [str(uuid.uuid4()) for _ in range(3)]
    backend.data.update(gcSummaries=[], gcMappings=[])
    backend.data['teams'] = [{'id': TEAM_ID, 'name': 'Falcons', 'archived': False, 'createdAt': stamp, 'updatedAt': stamp}]
    backend.data['teamCoaches'] = [{'teamId': TEAM_ID, 'coachId': COACH_ID}]
    backend.data['pitchers'] = [{'id': pid, 'name': 'Pitcher 1 Sample', 'jersey': '8', 'ownerId': COACH_ID, 'archived': False, 'createdAt': stamp, 'updatedAt': stamp}]
    backend.data['teamPitchers'] = [{'teamId': TEAM_ID, 'pitcherId': pid, 'active': True}]
    events = []
    for seq, kind in enumerate(['called', 'ball', 'inPlay'], 1):
        events.append({'id': str(uuid.uuid4()), 'sessionId': sid, 'pitcherId': pid, 'appearanceId': aid, 'nextAppearanceId': str(uuid.uuid4()), 'sequence': seq, 'timestamp': stamp, 'kind': 'pitch', 'pitchType': kind, 'pitchLocation': 'middle', 'voidedAt': None})
    events.append({'id': str(uuid.uuid4()), 'sessionId': sid, 'pitcherId': pid, 'appearanceId': events[-1]['nextAppearanceId'], 'nextAppearanceId': str(uuid.uuid4()), 'sequence': 4, 'timestamp': stamp, 'kind': 'end', 'voidedAt': None})
    backend.data['events'] = events
    backend.data['sessions'] = [{'id': sid, 'name': 'Bullpen', 'notes': '', 'startedAt': stamp, 'updatedAt': stamp, 'endedAt': stamp, 'status': 'ended', 'initialPitcherId': pid, 'initialAppearanceId': aid, 'selectedPitcherId': pid, 'pitcherIds': [pid], 'nextSequence': 5, 'teamId': TEAM_ID, 'recorderId': COACH_ID, 'deviceId': str(uuid.uuid4()), 'revision': 1}]
    lose_response = [True]
    commits = []

    def manage(route):
        req = route.request
        if req.method == 'OPTIONS':
            return backend.handle(route)
        payload = json.loads(req.post_data or '{}')
        action, item = payload.get('action'), payload.get('input', {})
        if action not in ('importGameChanger', 'removeGameChanger'):
            return backend.handle(route)
        headers = {'access-control-allow-origin': '*', 'content-type': 'application/json'}
        if item['operationId'] in backend.operations:
            route.fulfill(status=200, headers=headers, body='{}')
            return
        if action == 'removeGameChanger':
            backend.data['gcSummaries'] = []
        else:
            old = next((s for s in backend.data['gcSummaries'] if s['teamId'] == item['teamId'] and s['season'].lower() == item['season'].lower()), None)
            for p in item['newPitchers']:
                backend.data['pitchers'].append({**p, 'ownerId': COACH_ID, 'archived': False, 'createdAt': stamp, 'updatedAt': stamp})
                backend.data['teamPitchers'].append({'teamId': item['teamId'], 'pitcherId': p['id'], 'active': True})
            summary = {k: copy.deepcopy(item[k]) for k in ['teamId', 'season', 'coverageStart', 'coverageEnd', 'fileName', 'players', 'teamTotals', 'warnings']}
            summary.update(id=old['id'] if old else str(uuid.uuid4()), revision=old['revision'] + 1 if old else 1, importedBy=COACH_ID, importedByName='Test Coach', updatedAt=stamp, fingerprint='fixture')
            backend.data['gcSummaries'] = [summary]
            for p in item['players']:
                backend.data['gcMappings'] = [m for m in backend.data['gcMappings'] if m['sourceKey'] != p['sourceKey']]
                backend.data['gcMappings'].append({'teamId': item['teamId'], 'season': item['season'].lower(), 'sourceKey': p['sourceKey'], 'pitcherId': p['pitcherId']})
            commits.append(item)
        backend.operations[item['operationId']] = True
        if action == 'importGameChanger' and lose_response[0]:
            lose_response[0] = False
            route.fulfill(status=503, headers=headers, body=json.dumps({'message': 'Response lost after commit. Retry the same import.'}))
        else:
            route.fulfill(status=200, headers=headers, body='{}')

    context.route(URL + '/rest/v1/rpc/manage', manage)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE_URL)
    page.wait_for_load_state('networkidle')
    if os.environ.get('PITCHWORK_GC_PWA'):
        page.evaluate('navigator.serviceWorker.ready')
        if not page.evaluate('!!navigator.serviceWorker.controller'):
            page.reload(); page.wait_for_load_state('networkidle')

    def nav(name):
        page.get_by_role('navigation').get_by_role('button', name=name, exact=True).click()

    nav('Settings')
    page.get_by_text('GameChanger imports', exact=True).click()
    page.get_by_label('GameChanger CSV', exact=True).set_input_files(ROOT / 'tests/fixtures/gamechanger.csv')
    page.get_by_label('Season name', exact=True).fill('Fall 2026')
    page.get_by_label('Season coverage start', exact=True).fill('2026-09-01')
    page.get_by_label('Export cutoff date', exact=True).fill('2026-10-20')
    matches = page.locator('.gc-match')
    expect(matches).to_have_count(4)
    for index in range(4):
        row = matches.nth(index)
        if index:
            row.locator('select').select_option('create')
        row.get_by_role('checkbox').check()
    page.get_by_label('I confirm the season name', exact=False).check()
    page.get_by_role('button', name='Review import', exact=True).click()
    expect(page.locator('.gc-import .gc-table')).to_contain_text('535')
    (ROOT / '.test-artifacts').mkdir(exist_ok=True)
    for width in [320, 390, 1440]:
        page.set_viewport_size({'width': width, 'height': 1000})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.locator('.gc-import').screenshot(path=str(ROOT / '.test-artifacts' / f'gc-import-{width}.png'))
    page.get_by_role('button', name='Import summary', exact=True).click()
    expect(page.get_by_role('alert')).to_contain_text('Response lost')
    page.get_by_role('button', name='Retry same import', exact=True).click()
    expect(page.get_by_role('status').filter(has_text='GameChanger summary saved')).to_be_visible()
    assert len(commits) == 1 and len(backend.data['pitchers']) == 4

    def repeat_file(content, name):
        page.get_by_label('GameChanger CSV', exact=True).set_input_files({'name': name, 'mimeType': 'text/csv', 'buffer': content})
        page.get_by_label('Season name', exact=True).fill('Fall 2026')
        page.get_by_label('Season coverage start', exact=True).fill('2026-09-01')
        page.get_by_label('Export cutoff date', exact=True).fill('2026-10-20')
        for row in page.locator('.gc-match').all():
            expect(row.get_by_role('checkbox')).to_be_checked()
        page.get_by_label('I confirm the season name', exact=False).check()
        page.get_by_role('button', name='Review import', exact=True).click()

    content = (ROOT / 'tests/fixtures/gamechanger.csv').read_bytes()
    repeat_file(content, 'different(6).csv')
    expect(page.get_by_role('status').filter(has_text='Already imported')).to_be_visible()
    expect(page.get_by_role('button', name='Replace summary', exact=True)).to_be_disabled()
    page.get_by_role('button', name='Done', exact=True).click()
    # A corrected export reduces pitches; it replaces rather than adds.
    rows = list(csv.reader(io.StringIO(content.decode())))
    start = rows[0].index('Pitching')
    rows[2][start + 4] = '190'
    stream = io.StringIO(); csv.writer(stream).writerows(rows)
    repeat_file(stream.getvalue().encode(), 'corrected.csv')
    page.get_by_role('button', name='Replace summary', exact=True).click()
    expect(page.get_by_role('status').filter(has_text='GameChanger summary saved')).to_be_visible()
    assert len(commits) == 2 and backend.data['gcSummaries'][0]['revision'] == 2

    nav('Statistics')
    expect(page.get_by_label('Statistics source', exact=True)).to_have_value('combined')
    expect(page.get_by_label('Date range', exact=True)).to_have_value('all')
    expect(page.get_by_label('GC season', exact=True)).to_have_count(0)
    expect(page.get_by_role('button', name='Import GameChanger CSV', exact=True)).to_have_count(0)
    page.get_by_label('Statistics team', exact=True).select_option(TEAM_ID)
    expect(page.get_by_label('Date range', exact=True)).to_have_value('all')
    expect(page.locator('.heatmap-coverage')).to_contain_text('3 of 3')
    table = page.locator('.gc-statistics .gc-table')
    expect(table.locator('tbody tr').first).to_contain_text('529')
    expect(table.locator('tbody tr').first).to_contain_text('532')
    expect(table.get_by_text('Estimated', exact=True)).to_have_count(2)
    page.get_by_label('Date range', exact=True).select_option('custom')
    page.get_by_label('Start date', exact=True).fill('2026-10-01')
    page.get_by_label('End date', exact=True).fill('2026-10-20')
    page.get_by_role('button', name='Apply', exact=True).click()
    expect(page.get_by_role('status').filter(has_text='excluded because the dates')).to_be_visible()
    page.get_by_role('button', name='Show all time', exact=True).click()
    expect(table.locator('tbody tr').first).to_contain_text('532')

    artifacts = ROOT / '.test-artifacts'; artifacts.mkdir(exist_ok=True)
    for width in [320, 390, 768, 1440]:
        page.set_viewport_size({'width': width, 'height': 1000})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'Overflow at {width}'
        assert table.evaluate('(table) => table.scrollWidth <= table.parentElement.clientWidth + 1'), f'Comparison table clipped at {width}'
        page.screenshot(path=str(artifacts / f'gc-statistics-{width}.png'), full_page=True)
        page.locator('.gc-statistics .settings-card').first.screenshot(path=str(artifacts / f'gc-comparison-{width}.png'))
    nav('Settings')
    with page.expect_download() as download:
        page.get_by_role('button', name='Download backup', exact=False).click()
    backup_path = artifacts / 'gc-roundtrip.backup.json'
    download.value.save_as(backup_path)
    backup = json.loads(backup_path.read_text(encoding='utf-8'))
    assert backup['version'] == 4 and len(backup['gcSummaries']) == 1 and len(backup['gcMappings']) == 4
    transfer = browser.new_context(viewport={'width': 390, 'height': 900})
    imported_backend = install(transfer, role='admin')
    imported_page = transfer.new_page(); imported_page.goto(BASE_URL); imported_page.wait_for_load_state('networkidle')
    imported_page.get_by_role('navigation').get_by_role('button', name='Settings', exact=True).click()
    imported_page.get_by_label('Restore from a JSON backup').set_input_files(backup_path)
    imported_page.get_by_label('I understand this imports separate copies into my account.').check()
    imported_page.get_by_role('button', name='Import backup copies', exact=True).click()
    imported_page.get_by_text('GameChanger imports', exact=True).click()
    expect(imported_page.locator('.gc-saved')).to_contain_text('Fall 2026')
    restored = imported_backend.data['gcSummaries'][0]
    assert restored['teamId'] != TEAM_ID and restored['players'][0]['pitcherId'] != backend.data['gcSummaries'][0]['players'][0]['pitcherId']
    transfer.close()
    page.reload(); page.wait_for_load_state('networkidle')
    # Verify the cached IndexedDB summary and disabled writes while offline.
    context.set_offline(True)
    if os.environ.get('PITCHWORK_GC_PWA'):
        page.reload(); page.wait_for_load_state('domcontentloaded')
    nav('Settings')
    page.get_by_text('GameChanger imports', exact=True).click()
    expect(page.locator('.gc-saved')).to_contain_text('Fall 2026')
    expect(page.get_by_label('GameChanger CSV', exact=True)).to_be_disabled()
    context.set_offline(False)
    page.on('dialog', lambda dialog: dialog.accept())
    page.get_by_role('button', name='Remove summary', exact=True).click()
    expect(page.get_by_role('status').filter(has_text='GameChanger summary removed')).to_be_visible()
    assert len([e for e in backend.data['events'] if e['kind'] == 'pitch']) == 3
    assert not errors, errors
    browser.close()
    print('GameChanger browser acceptance passed: import/retry, dedupe, replacement, comparisons, dates, offline cache, removal and responsive layouts.')
