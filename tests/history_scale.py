"""Bounded history rendering with all authorized source retained offline.

Run against a dev/preview server built with tests/auth_mock.py's settings.
This is a single-browser history check, not a concurrent-user capacity test.
"""
import json
import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from playwright.sync_api import expect, sync_playwright
from auth_mock import COACH_ID, install

BASE = os.environ.get('PITCHWORK_BASE_URL', 'http://127.0.0.1:5284')
OUT = Path(__file__).resolve().parents[1] / '.test-artifacts'
OUT.mkdir(exist_ok=True)

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 900})
    backend = install(context)
    pitcher = str(uuid.uuid4())
    backend.data['pitchers'] = [{'id': pitcher, 'name': 'History pitcher', 'jersey': '', 'ownerId': COACH_ID, 'archived': False, 'createdAt': '2020-01-01T12:00:00Z', 'updatedAt': '2020-01-01T12:00:00Z'}]
    for n in range(1051):
        sid, appearance, following = [str(uuid.uuid4()) for _ in range(3)]
        stamp = (datetime(2020, 1, 1, 12, tzinfo=timezone.utc) + timedelta(days=n)).isoformat().replace('+00:00', 'Z')
        backend.data['sessions'].append({'id': sid, 'name': f'Scale history {n:04d}', 'notes': '', 'teamId': None, 'recorderId': COACH_ID, 'deviceId': 'synthetic-history-device', 'revision': 1, 'startedAt': stamp, 'updatedAt': stamp, 'endedAt': stamp, 'status': 'ended', 'archived': n >= 1000, 'initialPitcherId': pitcher, 'selectedPitcherId': pitcher, 'initialAppearanceId': appearance, 'pitcherIds': [pitcher], 'nextSequence': 3})
        for seq, kind, current, successor in [(1, 'pitch', appearance, following), (2, 'end', following, str(uuid.uuid4()))]:
            backend.data['events'].append({'id': str(uuid.uuid4()), 'sessionId': sid, 'pitcherId': pitcher, 'appearanceId': current, 'nextAppearanceId': successor, 'sequence': seq, 'timestamp': stamp, 'kind': kind, 'voidedAt': None, **({'pitchType': 'inPlay'} if kind == 'pitch' else {})})
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE)
    page.get_by_role('button', name='Sessions', exact=True).click()
    rows = page.locator('.session-list .session-row')
    expect(rows).to_have_count(50, timeout=30000)
    expect(rows.first).to_contain_text('Scale history 0999')
    expect(page.get_by_role('button', name='Previous practice page')).to_be_disabled()
    page.get_by_role('button', name='Next practice page').click()
    expect(rows.first).to_contain_text('Scale history 0949')
    rows.first.click()
    expect(page.get_by_role('heading', name='Scale history 0949', exact=True)).to_be_visible()
    page.get_by_role('button', name='Sessions', exact=True).click()
    context.set_offline(True)
    page.get_by_label('Filter practices by archive status').select_option('archived')
    expect(rows).to_have_count(50)
    expect(rows.first).to_contain_text('Scale history 1050')
    page.get_by_role('button', name='Next practice page').click()
    expect(rows).to_have_count(1)
    expect(rows.first).to_contain_text('Scale history 1000')
    expect(page.get_by_role('button', name='Next practice page')).to_be_disabled()
    page.get_by_label('Filter practices by archive status').select_option('all')
    expect(rows).to_have_count(50)
    expect(rows.first).to_contain_text('Scale history 1050')
    counts = page.evaluate("""name => new Promise((resolve,reject) => {
      const request=indexedDB.open(name);
      request.onerror=()=>reject(request.error);
      request.onsuccess=()=>{const db=request.result,tx=db.transaction(['sessions','events'],'readonly');
        const sessions=tx.objectStore('sessions').count(),events=tx.objectStore('events').count();
        tx.oncomplete=()=>{resolve({sessions:sessions.result,events:events.result});db.close()};tx.onerror=()=>reject(tx.error)};
    })""", 'pitchwork-account-' + COACH_ID)
    assert counts == {'sessions': 1051, 'events': 2102}, counts
    for width in [390, 1440]:
        page.set_viewport_size({'width': width, 'height': 900})
        page.get_by_role('navigation', name='Practice history pages').scroll_into_view_if_needed()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.screenshot(path=str(OUT / f'history-pages-{width}.png'))
    assert not errors, errors
    (OUT / 'history-scale.json').write_text(json.dumps({'passed': True, 'stored': counts, 'maximumRenderedRows': 50, 'offlinePaging': True, 'scope': 'Single synthetic browser; no capacity claim'}, indent=2))
    browser.close()
    print('50-row history pages, older practice detail, archive filters, offline access and all 1,051 stored practices passed.')
