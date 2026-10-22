"""Inline goal editing and player-account acceptance; use auth_mock.py's Vite settings."""
import os
import uuid
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from auth_mock import install, COACH_ID, TEAM_ID

BASE = os.environ.get('PITCHWORK_BASE_URL', 'http://127.0.0.1:5311')
ARTIFACTS = Path(__file__).resolve().parents[1] / '.test-artifacts' / 'goals'
ARTIFACTS.mkdir(parents=True, exist_ok=True)
STAMP = '2026-10-21T12:00:00.000Z'
def uid():
    return str(uuid.uuid4())

def seed(backend):
    pitcher, mate = uid(), uid()
    backend.data.update(
        teams=[dict(id=TEAM_ID, name='Falcons', createdAt=STAMP, updatedAt=STAMP)],
        pitchers=[dict(id=p, name=name, jersey='', ownerId=COACH_ID, archived=False, createdAt=STAMP, updatedAt=STAMP) for p, name in [(pitcher, 'Jordan'), (mate, 'Riley')]],
        teamPitchers=[dict(teamId=TEAM_ID, pitcherId=p, active=True) for p in [pitcher, mate]],
        teamCoaches=[dict(teamId=TEAM_ID, coachId=COACH_ID)] if backend.profile['role'] != 'player' else [], goals=[])
    sid, aid = uid(), uid()
    backend.data['sessions'] = [dict(id=sid, name='Bullpen', notes='', startedAt=STAMP, updatedAt=STAMP, endedAt=STAMP, status='ended', initialPitcherId=pitcher, selectedPitcherId=pitcher, pitcherIds=[pitcher], initialAppearanceId=aid, nextSequence=4, teamId=TEAM_ID, recorderId=COACH_ID, deviceId=uid(), revision=1)]
    backend.data['events'] = [dict(id=uid(), sessionId=sid, pitcherId=pitcher, appearanceId=aid, nextAppearanceId=uid(), sequence=n, timestamp=STAMP, kind='pitch', pitchType=kind, pitchLocation='middle', voidedAt=None) for n, kind in enumerate(['called', 'ball', 'inPlay'], 1)]
    return pitcher, mate

def goal(scope, pitcher=None, target=60, metric='strikePct'):
    return dict(id=uid(), scope=scope, teamId=None if scope == 'personal' else TEAM_ID, pitcherId=pitcher, metric=metric, direction='min', target=target, revision=1, updatedAt=STAMP, updatedBy=COACH_ID)

def stat(page, metric='Strike %'):
    return page.locator(f'.stats-overview .stat-goals[aria-label="{metric} goals"]')

def sync(page):
    page.locator('.workspace-status > summary').click()
    page.get_by_role('button', name='Refresh & sync', exact=True).click()
    expect(page.get_by_role('button', name='Refresh & sync', exact=True)).to_be_enabled()
    page.locator('.workspace-status > summary').click()

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    errors = []
    context = browser.new_context(viewport=dict(width=1440, height=1000))
    backend = install(context)
    pitcher, mate = seed(backend)
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE); page.wait_for_load_state('networkidle')
    page.get_by_role('button', name='Statistics', exact=True).click()
    page.get_by_label('Statistics team', exact=True).select_option(TEAM_ID)
    page.get_by_label('Statistics source', exact=True).select_option('practice')
    strike = stat(page)
    strike.locator('summary').click()
    strike.get_by_label('Target', exact=True).fill('60')
    strike.get_by_role('button', name='Save goal', exact=True).click()
    expect(strike).to_contain_text('Team · Falcons goal ≥60%')
    expect(strike).to_contain_text('6.7 percentage points above goal')
    page.get_by_label('Statistics pitcher', exact=True).select_option(pitcher)
    strike = stat(page)
    # The existing details element remains open across filter changes.
    if not strike.locator('details').get_attribute('open') == '':
        strike.locator('summary').click()
    strike.get_by_label('Target', exact=True).fill('70')
    strike.get_by_role('button', name='Save goal', exact=True).click()
    expect(strike).to_contain_text('Coach · Falcons goal ≥70%')
    expect(strike).to_contain_text('3.3 percentage points below goal')
    expect(strike.locator('.goal-form')).to_have_count(1)
    for source in ['practice', 'combined', 'game']:
        page.get_by_label('Statistics source', exact=True).select_option(source)
        expect(stat(page)).to_contain_text('≥70%')
        if source == 'game':
            expect(stat(page)).to_contain_text('Result unavailable')
        for width in [320, 390, 768, 1440]:
            page.set_viewport_size(dict(width=width, height=1000))
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (source, width)
            if source != 'practice':
                assert page.locator('.gc-statistics .gc-table').evaluate('(t) => t.scrollWidth <= t.parentElement.clientWidth + 1'), (source, width)
            page.screenshot(path=str(ARTIFACTS / f'coach-{source}-{width}.png'), full_page=True)
    context.close()

    context = browser.new_context(viewport=dict(width=390, height=1000))
    backend = install(context, role='player'); pitcher, mate = seed(backend)
    backend.profile['pitcherId'] = pitcher
    personal = goal('personal', pitcher, 50)
    backend.data['goals'] = [goal('team', target=60), goal('coach', pitcher, 70), personal, goal('personal', mate, 75)]
    page = context.new_page(); page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE); page.wait_for_load_state('networkidle')
    expect(page.get_by_role('heading', name='Statistics', exact=True)).to_be_visible()
    expect(page.get_by_label('Statistics pitcher', exact=True)).to_have_value(pitcher)
    strike = stat(page)
    expect(strike.locator('.goal-annotation .goal-warning')).to_have_count(2)
    strike.locator('summary').click()
    expect(strike.locator('.goal-form')).to_have_count(1)
    strike.get_by_label('Target', exact=True).fill('55')
    strike.get_by_role('button', name='Save goal', exact=True).click()
    expect(strike).to_contain_text('Personal goal ≥55%')
    backend.data['goals'] = [{**g, 'target': 56, 'revision': g['revision'] + 1} if g['id'] == personal['id'] else g for g in backend.data['goals']]
    strike.get_by_label('Target', exact=True).fill('54')
    strike.get_by_role('button', name='Save goal', exact=True).click()
    expect(strike.get_by_role('alert')).to_contain_text('Refresh')
    strike.get_by_role('button', name='Refresh goal', exact=True).click()
    expect(strike.get_by_label('Target', exact=True)).to_have_value('56')
    backend.data['goals'][0]['target'] = 80
    sync(page)
    expect(strike).to_contain_text('Falcons team standard ≥80%')
    if os.environ.get('PITCHWORK_GOALS_PWA') == '1':
        page.evaluate('navigator.serviceWorker.ready.then(() => true)')
    context.set_offline(True)
    expect(strike.get_by_role('button', name='Save goal', exact=True)).to_be_disabled()
    expect(strike).to_contain_text('Reconnect to edit goals.')
    if os.environ.get('PITCHWORK_GOALS_PWA') == '1':
        page.reload(); page.wait_for_load_state('domcontentloaded')
        expect(stat(page)).to_contain_text('Personal goal ≥56%')
        expect(stat(page)).to_contain_text('Falcons team standard ≥80%')
        strike = stat(page)
        strike.locator('summary').click()
        expect(strike.get_by_role('button', name='Save goal', exact=True)).to_be_disabled()
    context.set_offline(False)
    expect(strike.get_by_role('button', name='Save goal', exact=True)).to_be_enabled()
    page.screenshot(path=str(ARTIFACTS / 'player-warning-editor-390.png'), full_page=True)
    page.get_by_label('Statistics pitcher', exact=True).select_option(mate)
    expect(stat(page)).to_contain_text('Personal goal ≥75%')
    expect(stat(page).locator('.goal-form')).to_have_count(0)
    page.get_by_label('Statistics pitcher', exact=True).select_option(pitcher)
    strike = stat(page)
    if not strike.locator('details').get_attribute('open') == '':
        strike.locator('summary').click()
    strike.get_by_role('button', name='Remove goal', exact=True).click()
    expect(strike.locator('.goal-annotation').filter(has_text='Personal goal')).to_have_count(0)
    page.get_by_role('button', name='Practice', exact=True).click()
    expect(page.get_by_label('Practice team', exact=True).locator('option')).to_have_count(1)
    assert page.locator('.start-form select').nth(1).locator('option').evaluate_all('(options) => options.map(o => o.value)') == [pitcher]
    page.get_by_role('button', name='Start practice', exact=True).click()
    page.get_by_role('button', name='Called strike, middle', exact=True).click()
    page.get_by_role('button', name='End session', exact=True).click()
    page.get_by_role('dialog').get_by_role('button', name='End session', exact=True).click()
    expect(page.get_by_label('All changes synced. Save and sync details', exact=True)).to_be_visible()
    assert any(s['teamId'] is None and s['pitcherIds'] == [pitcher] for s in backend.data['sessions'])
    page.get_by_role('button', name='Account settings for Test Coach', exact=True).click()
    expect(page.get_by_text('GameChanger imports', exact=True)).to_have_count(0)
    expect(page.get_by_label('Restore from a JSON backup', exact=True)).to_have_count(0)
    context.close()

    context = browser.new_context(viewport=dict(width=390, height=1000))
    backend = install(context, role='admin'); pitcher, mate = seed(backend)
    page = context.new_page(); page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE); page.wait_for_load_state('networkidle')
    page.get_by_role('button', name='Account settings for Test Coach', exact=True).click()
    page.get_by_role('button', name='Create account', exact=True).click()
    editor = page.locator('.account-editor')
    editor.get_by_label('Name', exact=True).fill('Jordan Player')
    editor.get_by_label('Email address', exact=True).fill('jordan@example.com')
    editor.get_by_label('Account type', exact=True).select_option('player')
    editor.get_by_label('Linked pitcher', exact=True).select_option(pitcher)
    editor.get_by_label('Player username', exact=True).fill('jordan.player')
    expect(editor.get_by_text('Assigned teams', exact=True)).to_have_count(0)
    editor.get_by_role('button', name='Create account', exact=True).click()
    expect(page.locator('.account-row').filter(has_text='jordan.player')).to_contain_text('Linked pitcher: Jordan')
    page.screenshot(path=str(ARTIFACTS / 'admin-player-account-390.png'), full_page=True)
    assert not errors, errors
    context.close(); browser.close()
    print('Goals passed: inline editing, source/filter comparisons, warnings, conflicts, offline controls, teammates, player permissions, admin linking and responsive layouts.')
