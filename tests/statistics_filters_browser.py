"""Unified Statistics controls and account import location; uses auth_mock.py's Vite environment."""
import copy
import os
import uuid
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from auth_mock import install, COACH_ID, TEAM_ID

ROOT = Path(__file__).resolve().parents[1]
BASE_URL = os.environ.get('PITCHWORK_BASE_URL', 'http://127.0.0.1:5311')

def uid():
    return str(uuid.uuid4())

def stats(pitches, batters):
    return dict(pitches=pitches, batters=batters, walks=1, strikeouts=2, games=1, outs=3,
                hits=0, runs=0, earnedRuns=0, hitBatters=0, wildPitches=0,
                strikePct=60, firstPitchPct=50, era=0, whip=1)

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
    backend = install(context, role='admin')
    stamp = '2026-10-10T12:00:00Z'
    other_team, a, b, shared, historic, imported = [uid() for _ in range(6)]
    names = {a: 'Avery Falcon', b: 'Blake Hawk', shared: 'Casey Shared', historic: 'Devin Historical', imported: 'Emery Imported'}
    backend.data['teams'] = [{'id': tid, 'name': name, 'createdAt': stamp, 'updatedAt': stamp} for tid, name in [(TEAM_ID, 'Falcons'), (other_team, 'Hawks')]]
    backend.data['teamCoaches'] = [{'teamId': t['id'], 'coachId': COACH_ID} for t in backend.data['teams']]
    backend.data['pitchers'] = [{'id': pid, 'name': name, 'jersey': '', 'ownerId': COACH_ID, 'archived': pid == historic, 'createdAt': stamp, 'updatedAt': stamp} for pid, name in names.items()]
    backend.data['teamPitchers'] = [{'teamId': tid, 'pitcherId': pid, 'active': True} for tid, pid in [(TEAM_ID, a), (TEAM_ID, shared), (other_team, b), (other_team, shared)]]
    for tid, pid, kinds in [(TEAM_ID, a, ['called', 'ball', 'inPlay']), (other_team, b, ['ball', 'inPlay']), (TEAM_ID, historic, ['foul'])]:
        sid, aid = uid(), uid()
        events = []
        for seq, kind in enumerate(kinds, 1):
            events.append(dict(id=uid(), sessionId=sid, pitcherId=pid, appearanceId=aid, nextAppearanceId=uid(), sequence=seq, timestamp=stamp, kind='pitch', pitchType=kind, pitchLocation='middle', voidedAt=None))
        backend.data['events'].extend(events)
        backend.data['sessions'].append(dict(id=sid, name='Practice', notes='', startedAt=stamp, updatedAt=stamp, endedAt=stamp, status='ended', initialPitcherId=pid, selectedPitcherId=pid, pitcherIds=[pid], initialAppearanceId=aid, nextSequence=len(events)+1, teamId=tid, recorderId=COACH_ID, deviceId=uid(), revision=1))

    def summary(tid, season, start, end, values):
        players = [dict(sourceKey=name.lower()+'|', name=name, jersey='', pitcherId=pid, stats=stats(pitches, batters), sourceValues={}) for pid, name, pitches, batters in values]
        return dict(id=uid(), teamId=tid, season=season, coverageStart=start, coverageEnd=end, fileName='stats.csv', players=players,
                    teamTotals=None, warnings=[], revision=1, importedBy=COACH_ID, importedByName='Test Coach', updatedAt=stamp, fingerprint='fixture')

    september = summary(TEAM_ID, 'September', '2026-09-01', '2026-09-30', [(a, names[a], 100, 20)])
    october = summary(TEAM_ID, 'October', '2026-10-01', '2026-10-20', [(a, names[a], 50, 10), (imported, names[imported], 25, 5)])
    hawks = summary(other_team, 'Fall', '2026-09-01', '2026-10-20', [(b, names[b], 40, 8)])
    backend.data.update(gcSummaries=[september, october, hawks], gcMappings=[])
    page = context.new_page(); errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE_URL); page.wait_for_load_state('networkidle')
    page.get_by_role('navigation').get_by_role('button', name='Statistics', exact=True).click()
    team = page.get_by_label('Statistics team', exact=True)
    pitcher = page.get_by_label('Statistics pitcher', exact=True)
    source = page.get_by_label('Statistics source', exact=True)
    dates = page.get_by_label('Date range', exact=True)
    expect(team).to_have_value(''); expect(pitcher).to_have_value('')
    expect(source).to_have_value('combined'); expect(dates).to_have_value('all')
    expect(page.get_by_label('GC season', exact=True)).to_have_count(0)
    expect(page.get_by_role('button', name='Import GameChanger CSV', exact=True)).to_have_count(0)
    table = page.locator('.gc-statistics .gc-table')
    expect(table.locator('tbody tr').first.locator('td').last.locator('.stat-value')).to_have_text('221')
    expect(page.locator('.gc-game-details')).not_to_have_attribute('open', '')

    team.select_option(TEAM_ID)
    expect(dates).to_have_value('all')
    expect(pitcher.locator('option')).to_have_count(5)
    expect(pitcher.locator('option', has_text='Blake Hawk')).to_have_count(0)
    expect(pitcher.locator('option', has_text='Devin Historical')).to_have_count(1)
    expect(pitcher.locator('option', has_text='Emery Imported')).to_have_count(1)
    expect(table.locator('tbody tr').first.locator('td').last.locator('.stat-value')).to_have_text('179')
    pitcher.select_option(a); team.select_option(other_team)
    expect(pitcher).to_have_value('')
    pitcher.select_option(shared); team.select_option(TEAM_ID)
    expect(pitcher).to_have_value(shared)
    pitcher.select_option('')
    dates.select_option('custom')
    dates.focus(); page.keyboard.press('Tab'); expect(source).to_be_focused()
    page.get_by_label('Start date', exact=True).fill('2026-10-02')
    page.get_by_label('End date', exact=True).fill('2026-10-31')
    page.get_by_role('button', name='Apply', exact=True).click()
    expect(page.get_by_role('status').filter(has_text='excluded because')).to_be_visible()
    expect(table.locator('tbody tr').first.locator('td').last.locator('.stat-value')).to_have_text('4')
    source.select_option('game'); expect(dates).to_have_value('custom'); expect(team).to_have_value(TEAM_ID)
    source.select_option('combined'); page.get_by_role('button', name='Show all time', exact=True).click()
    expect(dates).to_have_value('all')
    expect(table.locator('tbody tr').first.locator('td').last.locator('.stat-value')).to_have_text('179')

    artifacts = ROOT / '.test-artifacts'; artifacts.mkdir(exist_ok=True)
    for width in [320, 390, 768, 1440]:
        page.set_viewport_size({'width': width, 'height': 1000})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
        assert table.evaluate('(t) => t.scrollWidth <= t.parentElement.clientWidth + 1'), width
        controls = [page.get_by_label(label, exact=True) for label in ['Statistics team', 'Statistics pitcher', 'Date range', 'Statistics source']]
        assert all(control.bounding_box()['height'] >= 48 for control in controls)
        assert controls[0].bounding_box()['y'] <= controls[1].bounding_box()['y']
        page.screenshot(path=str(artifacts / f'statistics-simplified-{width}.png'), full_page=True)
        page.locator('.statistics-filters').screenshot(path=str(artifacts / f'statistics-filters-{width}.png'))
        dates.select_option('custom')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), ('custom', width)
        dates.select_option('all')

    conflict = copy.deepcopy(october); conflict.update(id=uid(), season='Overlap', coverageStart='2026-09-15', coverageEnd='2026-10-15')
    backend.data['gcSummaries'].append(conflict)
    page.locator('.workspace-status > summary').click()
    page.get_by_role('button', name='Refresh & sync', exact=True).click()
    expect(page.get_by_role('status').filter(has_text='Overlapping game summaries excluded.')).to_be_visible()
    expect(table.locator('tbody tr').first.locator('td').last.locator('.stat-value')).to_have_text('4')
    team.select_option('')
    expect(table.locator('tbody tr').first.locator('td').last.locator('.stat-value')).to_have_text('46')
    page.get_by_role('button', name='Account settings for Test Coach', exact=True).click()
    account = page.get_by_role('region', name='Account settings', exact=True)
    expect(account.locator('.statistics-account-imports')).not_to_have_attribute('open', '')
    account.get_by_text('GameChanger imports', exact=True).click()
    expect(account.get_by_label('GameChanger CSV', exact=True)).to_be_visible()
    page.screenshot(path=str(artifacts / 'account-gamechanger-imports.png'), full_page=True)
    assert not errors, errors
    browser.close()
    print('Simplified statistics passed: defaults, team-dependent pitchers, all seasons, coverage/overlap safety, source switching, mobile layouts and account imports.')
