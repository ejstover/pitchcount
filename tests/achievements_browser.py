"""Player clubhouse, offline activity, target recording and private PNG acceptance."""
import os
import json
import struct
import uuid
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from auth_mock import install, COACH_ID, TEAM_ID, PASSWORD

BASE = os.environ.get('PITCHWORK_BASE_URL', 'http://127.0.0.1:5315')
OUT = Path(__file__).resolve().parents[1] / '.test-artifacts' / 'achievements'
OUT.mkdir(parents=True, exist_ok=True)
def uid(): return str(uuid.uuid4())
with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
    backend = install(context, role='player')
    player, mate, sid, aid = uid(), uid(), uid(), uid()
    backend.profile.update(name='Private Person Sentinel', username='private.username', pitcherId=player)
    stamp = '2026-10-20T12:00:00.000Z'
    backend.data.update(pitchers=[dict(id=p, name=name, jersey='', ownerId=COACH_ID, archived=False, createdAt=stamp, updatedAt=stamp) for p, name in [(player, 'Private Person Sentinel'), (mate, 'Teammate')]], teams=[dict(id=TEAM_ID, name='Private Team Sentinel', createdAt=stamp, updatedAt=stamp)], teamPitchers=[dict(teamId=TEAM_ID, pitcherId=p, active=True) for p in [player, mate]], teamCoaches=[], achievementRecords=[], achievementEvaluation=dict(revision=1, processedRevision=1))
    backend.data['sessions'] = [dict(id=sid, name='Private Session Sentinel', notes='Private Note Sentinel', startedAt=stamp, updatedAt=stamp, endedAt=stamp, status='ended', initialPitcherId=player, selectedPitcherId=player, pitcherIds=[player], initialAppearanceId=aid, nextSequence=3, teamId=None, recorderId=COACH_ID, deviceId=uid(), revision=1)]
    backend.data['events'] = [dict(id=uid(), sessionId=sid, pitcherId=player, appearanceId=aid, nextAppearanceId=uid(), sequence=i, timestamp=stamp, kind=kind, voidedAt=None, **({'pitchType': 'called', 'pitchLocation': 'middle'} if kind == 'pitch' else {})) for i, kind in [(1, 'pitch'), (2, 'end')]]
    backend.data['achievementAwards'] = [dict(id=f'{player}:001:career', pitcherId=player, definitionId='001', period='career', earnedAt=stamp, status='qualified', actual=1, evidence=[sid], ruleVersion=1)]
    page = context.new_page()
    page.set_default_timeout(10000)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE); page.wait_for_load_state('networkidle')
    if os.environ.get('PITCHWORK_PWA') == '1':
        page.evaluate('navigator.serviceWorker.ready')
        if not page.evaluate('!!navigator.serviceWorker.controller'):
            page.reload();page.wait_for_load_state('networkidle')
    page.get_by_role('button', name='Awards', exact=True).click()
    expect(page.get_by_role('heading', name='Your clubhouse')).to_be_visible()
    for width in [320, 390, 768, 1440]:
        page.set_viewport_size({'width': width, 'height': 1000})
        page.screenshot(path=str(OUT / f'profile-{width}.png'), full_page=True)
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), ('profile overflow', width, page.evaluate("[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,12).map(e=>[e.tagName,e.className,e.getBoundingClientRect().width])"))
    page.get_by_role('button', name='Collection', exact=True).click()
    expect(page.locator('.award-card')).to_have_count(400)
    assert page.evaluate("(()=>{const ids=[...document.querySelectorAll('.award-patch svg defs [id]')].map(e=>e.id);return new Set(ids).size===ids.length})()")
    for width in [320, 390, 768, 1440]:
        page.set_viewport_size({'width': width, 'height': 1000})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), ('collection overflow', width)
        page.screenshot(path=str(OUT / f'collection-{width}.png'), full_page=False)
    page.get_by_label('Search', exact=True).fill('First Practice')
    page.locator('.award-card').click()
    detail = page.get_by_role('dialog', name='Award details')
    expect(detail.get_by_role('heading', name='First Practice')).to_be_visible()
    with page.expect_download() as download_info:
        detail.get_by_role('button', name='Download PNG', exact=True).click()
    download = download_info.value
    assert download.suggested_filename == 'pitchwork-award-001.png'
    download.save_as(OUT / download.suggested_filename)
    png = (OUT / download.suggested_filename).read_bytes()
    assert struct.unpack('>II', png[16:24]) == (1080, 1080)
    assert all(s.encode() not in png for s in ['Private Person Sentinel', 'private.username', 'Private Team Sentinel', player, 'Private Note Sentinel'])
    with page.expect_download() as story_info:
        detail.get_by_role('button', name='Share story', exact=True).click()
    story_info.value.save_as(OUT / 'award-story.png')
    assert struct.unpack('>II', (OUT / 'award-story.png').read_bytes()[16:24]) == (1080, 1920)
    detail.get_by_role('button', name='Pin to profile').click()
    expect(detail.get_by_role('button', name='Unpin award')).to_be_visible()
    detail.get_by_role('button', name='Close award details').click()
    page.get_by_role('button', name='Activity log', exact=True).click()
    expect(page.get_by_role('heading', name='Log an action', exact=True)).to_be_visible()
    context.set_offline(True)
    page.screenshot(path=str(OUT / 'offline-log.png'), full_page=True)
    page.get_by_label('Action', exact=True).select_option('reflection')
    page.get_by_label('Private note', exact=True).fill('A private learning')
    page.get_by_role('button', name='Log action', exact=True).click()
    expect(page.get_by_text('A private learning', exact=True)).to_be_visible()
    if os.environ.get('PITCHWORK_PWA') != '1':
        context.set_offline(False)
    page.reload();page.wait_for_load_state('networkidle')
    page.get_by_role('button', name='Awards', exact=True).click()
    page.get_by_role('button', name='Activity log', exact=True).click()
    expect(page.get_by_text('A private learning', exact=True)).to_be_visible()
    context.set_offline(False)
    page.evaluate("window.dispatchEvent(new Event('online'))")
    page.wait_for_function("document.querySelector('.workspace-status summary')?.textContent.includes('All changes synced')")
    assert any(r['kind'] == 'checkin' for r in backend.data['achievementRecords'])
    page.get_by_role('button', name='My award goals', exact=True).click()
    page.get_by_label('Goal metric', exact=True).select_option('practice')
    page.get_by_label('Target', exact=True).fill('1')
    page.get_by_role('button', name='Save my award goal', exact=True).click()
    expect(page.get_by_role('button', name='Pause goal', exact=True)).to_be_visible()
    page.get_by_role('button', name='Practice', exact=True).click()
    expect(page.get_by_label('Practice team')).to_have_value('')
    expect(page.get_by_label('Starting pitcher')).to_have_value(player)
    assert page.get_by_label('Starting pitcher').locator('option').count() == 1
    page.get_by_role('button', name='Start practice', exact=True).click()
    page.get_by_label('Intended target', exact=True).select_option('middle')
    page.get_by_role('button', name='Start target drill', exact=True).click()
    expect(page.get_by_role('button', name='Finish target drill')).to_be_enabled()
    for _ in range(10): page.get_by_role('button', name='Called strike, middle', exact=True).click()
    page.get_by_role('button', name='Finish target drill', exact=True).click()
    page.get_by_role('button', name='End session', exact=True).click()
    page.get_by_role('dialog').get_by_role('button', name='End session', exact=True).click()
    page.wait_for_function("document.querySelector('.workspace-status summary')?.textContent.includes('All changes synced')")
    targets = [e for e in backend.data['events'] if e.get('intendedTarget') == 'middle']
    assert len(targets) == 10 and all(e.get('drillId') for e in targets)
    assert not errors, errors
    context.close()
    context = browser.new_context()
    backend = install(context, role='player', signed_in=False)
    backend.profile.update(username='practice.kid', email='internal@players.pitchwork.invalid', pitcherId=player)
    backend.data['pitchers'] = [dict(id=player, name='Player', jersey='', ownerId=COACH_ID, archived=False, createdAt=stamp, updatedAt=stamp)]
    page = context.new_page(); page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE);page.wait_for_load_state('networkidle')
    page.get_by_label('Email address or player username', exact=True).fill('practice.kid')
    page.get_by_label('Password', exact=True).fill(PASSWORD)
    page.get_by_role('button', name='Sign in', exact=True).click()
    expect(page.get_by_role('heading', name='Statistics', exact=True)).to_be_visible()
    page.get_by_role('button', name='Awards', exact=True).click()
    expect(page.get_by_role('heading', name='Your clubhouse')).to_be_visible()
    assert not errors, errors
    browser.close()
print(json.dumps({'status': 'passed', 'widths': [320, 390, 768, 1440], 'designs': 400, 'png': ['1080x1080', '1080x1920'], 'offline_reopen': os.environ.get('PITCHWORK_PWA') == '1'}))
