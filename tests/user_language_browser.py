"""Check player/coach language, mobile layouts, and service errors in context."""
import json
import os
import uuid
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from auth_mock import install, COACH_ID

BASE = os.environ.get('PITCHWORK_BASE_URL', 'http://127.0.0.1:5328')
OUT = Path(__file__).resolve().parents[1] / '.test-artifacts' / 'user-language'
OUT.mkdir(parents=True, exist_ok=True)
TECHNICAL = ['VITE_SUPABASE', 'docs/AUTH.md', 'production preview', 'after publishing', 'server version', 'schema cache', 'auth hook', 'non-2xx', 'closed window']

def check_copy(page):
    text = page.locator('body').inner_text()
    assert all(term not in text for term in TECHNICAL), text
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Horizontal overflow'

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    errors = []
    for role in ['admin', 'coach', 'player']:
        context = browser.new_context(viewport={'width': 390, 'height': 844})
        backend = install(context, role=role)
        if role == 'player':
            pid = str(uuid.uuid4())
            backend.profile['pitcherId'] = pid
            backend.data['pitchers'] = [dict(id=pid, name='Practice Player', jersey='', ownerId=COACH_ID, archived=False, createdAt='2026-10-20T12:00:00.000Z', updatedAt='2026-10-20T12:00:00.000Z')]
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(BASE)
        page.wait_for_load_state('networkidle')
        assert page.get_by_role('navigation', name='Main navigation').get_by_role('button').count() == 6
        for name in ['Practice', 'Roster', 'Statistics', 'Sessions', 'Awards', 'Settings']:
            page.get_by_role('navigation', name='Main navigation').get_by_role('button', name=name, exact=True).click()
            page.wait_for_load_state('networkidle')
            check_copy(page)
        expect(page.get_by_label('Restore from a backup file')).to_have_count(0 if role == 'player' else 1)
        expect(page.get_by_text('Offline access is not ready yet.', exact=False)).to_be_visible()
        for width in [320, 390, 768, 1440]:
            page.set_viewport_size({'width': width, 'height': 1000})
            check_copy(page)
            page.screenshot(path=str(OUT / f'{role}-settings-{width}.png'), full_page=True)
        if role == 'player':
            page.get_by_role('button', name='Practice', exact=True).click()
            expect(page.get_by_text('Choose your pitcher profile to start your own practice.', exact=True)).to_be_visible()
            page.get_by_role('button', name='Awards', exact=True).click()
            page.get_by_role('button', name='My award goals', exact=True).click()
            expect(page.get_by_label('Goal period', exact=True)).to_be_visible()
            for width in [320, 390, 768, 1440]:
                page.set_viewport_size({'width': width, 'height': 1000})
                check_copy(page)
            page.get_by_role('button', name='Collection', exact=True).click()
            page.get_by_label('Search', exact=True).fill('My Strike Goal')
            assert all('goal period' in text for text in page.locator('.award-card small').all_text_contents())
        else:
            page.get_by_role('button', name='Awards', exact=True).click()
            expect(page.get_by_role('heading', name='Set up a player account', exact=True)).to_be_visible()
        context.close()

    # A service failure must show a useful notice without leaking database names.
    context = browser.new_context()
    install(context, role='admin')
    page = context.new_page()
    page.goto(BASE)
    page.wait_for_load_state('networkidle')
    context.route('**/rest/v1/rpc/get_workspace*', lambda route: route.fulfill(status=500, content_type='application/json', body=json.dumps({'message':'Could not find the function public.get_workspace in the schema cache', 'code':'PGRST202'})))
    page.locator('.workspace-status summary').click()
    page.get_by_role('button', name='Refresh & sync', exact=True).click()
    expect(page.locator('.sync-error').first).to_contain_text('contact your admin')
    check_copy(page)
    page.screenshot(path=str(OUT / 'sync-service-error.png'), full_page=True)
    context.close()

    # Malformed backups offer recovery advice instead of JSON parsing details.
    context = browser.new_context()
    install(context, role='coach')
    page = context.new_page()
    page.goto(BASE)
    page.wait_for_load_state('networkidle')
    page.get_by_role('button', name='Settings', exact=True).click()
    page.get_by_label('Restore from a backup file').set_input_files({'name':'broken.json','mimeType':'application/json','buffer':b'{broken'})
    expect(page.get_by_role('alert')).to_contain_text('Choose an original Pitchwork backup')
    check_copy(page)
    context.close()

    # Public sign-in also translates failures from the existing account service.
    context = browser.new_context()
    install(context, signed_in=False)
    context.route('**/api/accounts', lambda route: route.fulfill(status=503, content_type='application/json', body=json.dumps({'error':'Player sign-in is not configured.'})))
    page = context.new_page()
    page.goto(BASE)
    page.wait_for_load_state('networkidle')
    page.get_by_label('Email address or player username', exact=True).fill('player.name')
    page.get_by_label('Password', exact=True).fill('a secure practice passphrase')
    page.get_by_role('button', name='Sign in', exact=True).click()
    expect(page.get_by_role('alert')).to_contain_text('Player sign-in is temporarily unavailable')
    check_copy(page)
    context.close()
    assert not errors, errors
    browser.close()
print('Player, coach, admin, 320/390/768/1440 layouts, sync errors, backups, and sign-in language passed.')
