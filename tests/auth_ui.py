"""Authenticated and public UI checks using browser network fixtures.

Use the test-only VITE settings documented in auth_mock.py.
"""
import os
import json
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from auth_mock import install, URL, COACH_ID, TEAM_ID, PASSWORD

BASE = os.environ.get('PITCHWORK_BASE_URL', 'http://127.0.0.1:5187')
OUT = Path(__file__).resolve().parents[1] / '.test-artifacts'
OUT.mkdir(exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    errors = []
    insecure = browser.new_context()
    insecure.add_init_script("Object.defineProperty(window, 'isSecureContext', {value: false})")
    insecure_page = insecure.new_page()
    insecure_page.goto(BASE)
    expect(insecure_page.get_by_role('heading', name='Secure connection required.')).to_be_visible()
    assert insecure_page.locator('input[type=password]').count() == 0
    insecure.close()
    public = browser.new_context(viewport={'width': 390, 'height': 844})
    backend = install(public, signed_in=False)
    page = public.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE)
    page.wait_for_load_state('networkidle')
    expect(page.get_by_role('heading', name='Welcome to Pitchwork.')).to_be_visible()
    page.get_by_role('button', name='Request an account').click()
    page.get_by_label('Your name').fill('New Coach')
    page.get_by_label('Email address').fill('new@example.com')
    page.get_by_label('Requested team').fill('Falcons')
    page.get_by_role('button', name='Send account request').click()
    expect(page.get_by_role('status')).to_contain_text('Request received.')
    assert len(backend.requests) == 1
    assert len(backend.data['coaches']) == 1, 'Request must not create an account'
    page.screenshot(path=str(OUT / 'account-request-mobile.png'), full_page=True)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.get_by_role('button', name='Back to sign in').click()
    page.get_by_label('Email address').fill('coach@example.com')
    page.get_by_label('Password', exact=True).fill('wrong password')
    page.get_by_role('button', name='Sign in', exact=True).click()
    expect(page.get_by_role('alert')).to_contain_text('Could not sign in')
    page.get_by_label('Password', exact=True).fill(PASSWORD)
    page.get_by_role('button', name='Sign in', exact=True).click()
    expect(page.get_by_role('navigation')).to_be_visible()
    public.close()
    print('Public requests, incorrect-password handling, and email/password login passed.')

    admin_context = browser.new_context(viewport={'width': 1440, 'height': 1000})
    admin = install(admin_context, role='admin')
    admin.requests = backend.requests
    admin.data['teams'].append({'id': TEAM_ID, 'name': 'Falcons', 'createdAt': '2026-10-19T12:00:00Z', 'updatedAt': '2026-10-19T12:00:00Z'})
    admin.data['teamCoaches'].append({'coachId': COACH_ID, 'teamId': TEAM_ID})
    page = admin_context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE)
    page.wait_for_load_state('networkidle')
    page.get_by_role('navigation').get_by_role('button', name='Settings', exact=True).click()
    expect(page.get_by_role('heading', name='Accounts & access')).to_be_visible()
    page.get_by_role('button', name='Review & create').click()
    editor = page.locator('.account-editor')
    editor.get_by_role('checkbox', name='Falcons').check()
    editor.get_by_role('button', name='Create account', exact=True).click()
    expect(page.get_by_label('Private password setup link')).to_be_visible()
    account = page.locator('.account-row').filter(has_text='new@example.com')
    expect(account).to_contain_text('Active')
    expect(account).to_contain_text('Falcons')
    account.get_by_role('button', name='Edit access').click()
    editor.get_by_label('Account active').uncheck()
    editor.get_by_role('button', name='Save account access').click()
    expect(account).to_contain_text('Suspended')
    account.get_by_role('button', name='Edit access').click()
    editor.get_by_label('Account active').check()
    editor.get_by_role('button', name='Save account access').click()
    expect(account).to_contain_text('Active')
    page.screenshot(path=str(OUT / 'account-admin-desktop.png'), full_page=True)
    page.set_viewport_size({'width': 320, 'height': 800})
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    admin_context.set_offline(True)
    page.close()
    page = admin_context.new_page()
    # Offline reopening requires a production service worker; dev has none.
    if os.environ.get('PITCHWORK_PWA') == '1':
        page.goto(BASE)
        expect(page.get_by_role('navigation')).to_be_visible()
        expect(page.get_by_text('Offline access', exact=False)).to_be_visible()
    admin_context.set_offline(False)
    page.goto(BASE)
    page.wait_for_load_state('networkidle')
    admin.profile['active'] = False
    page.evaluate("window.dispatchEvent(new Event('focus'))")
    expect(page.get_by_role('heading', name='Welcome to Pitchwork.')).to_be_visible()
    expect(page.get_by_role('alert')).to_contain_text('unapproved or suspended')
    admin_context.close()
    print('Admin approval, team assignment, suspension/reactivation, layout, and access revocation passed.')

    coach_context = browser.new_context()
    install(coach_context, role='coach')
    page = coach_context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE)
    page.wait_for_load_state('networkidle')
    page.get_by_role('navigation').get_by_role('button', name='Settings', exact=True).click()
    expect(page.get_by_role('heading', name='Accounts & access')).to_have_count(0)
    page.get_by_role('button', name='Sign out', exact=True).click()
    expect(page.get_by_role('heading', name='Welcome to Pitchwork.')).to_be_visible()
    assert page.evaluate("localStorage.getItem('pitchwork-approved:' + %s)" % __import__('json').dumps(URL)) is None
    coach_context.close()
    setup_context = browser.new_context()
    setup_backend = install(setup_context, signed_in=False)
    page = setup_context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE + '/#password-setup=valid-setup-token')
    expect(page.get_by_role('heading', name='Choose your password.')).to_be_visible()
    assert 'password-setup' not in page.url, 'Setup credential must be removed from browser history'
    assert not setup_backend.setup_used, 'Opening the page must not consume a setup link'
    page.get_by_label('New password', exact=True).fill(PASSWORD)
    page.get_by_label('Confirm password', exact=True).fill('a different long password')
    page.get_by_role('button', name='Save password', exact=True).click()
    expect(page.get_by_role('alert')).to_contain_text('do not match')
    assert not setup_backend.setup_used
    page.get_by_label('Confirm password', exact=True).fill(PASSWORD)
    page.get_by_role('button', name='Save password', exact=True).click()
    expect(page.get_by_role('navigation')).to_be_visible()
    assert setup_backend.password_updates == 1
    page.goto(BASE + '/#password-setup=valid-setup-token')
    page.get_by_label('New password', exact=True).fill(PASSWORD)
    page.get_by_label('Confirm password', exact=True).fill(PASSWORD)
    page.get_by_role('button', name='Save password', exact=True).click()
    expect(page.get_by_role('alert')).to_contain_text('expired or has already been used')
    assert setup_backend.password_updates == 1
    setup_context.close()
    print('Private password setup, mismatch, fragment removal, and single-use recovery passed.')
    recovery_context = browser.new_context(accept_downloads=True)
    recovery_backend = install(recovery_context, role='coach')
    recovery_backend.fail_upload = True
    recovery_backend.data['pitchers'].append({'id': '30000000-0000-4000-8000-000000000001', 'ownerId': COACH_ID, 'name': 'Private coach A pitcher', 'jersey': '14', 'archived': False, 'createdAt': '2026-10-19T12:00:00Z', 'updatedAt': '2026-10-19T12:00:00Z'})
    page = recovery_context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE)
    page.wait_for_load_state('networkidle')
    page.get_by_role('button', name='Start practice', exact=True).click()
    page.get_by_role('dialog').get_by_role('button', name='Let’s practice').click()
    expect(page.locator('.save-status')).to_have_text('Saved on device')
    recovery_backend.profile['active'] = False
    page.evaluate("window.dispatchEvent(new Event('focus'))")
    expect(page.get_by_role('button', name='Export unsynced work')).to_be_visible()
    with page.expect_download() as recovered:
        page.get_by_role('button', name='Export unsynced work').click()
    data = json.loads(Path(recovered.value.path()).read_text())
    assert data['operations'] and data['format'] == 'pitchwork-unsynced-recovery'
    page.reload()
    expect(page.get_by_role('button', name='Export unsynced work')).to_be_visible()
    assert page.get_by_role('navigation').count() == 0
    recovery_context.close()
    print('Suspended accounts retain exportable unsynced work, including after reload.')

    if os.environ.get('PITCHWORK_PWA') == '1':
        offline_context = browser.new_context()
        offline_backend = install(offline_context, role='coach')
        offline_backend.data['pitchers'].append({'id': '30000000-0000-4000-8000-000000000002', 'ownerId': COACH_ID, 'name': 'Private cached pitcher', 'jersey': '2', 'archived': False, 'createdAt': '2026-10-19T12:00:00Z', 'updatedAt': '2026-10-19T12:00:00Z'})
        page = offline_context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(BASE)
        expect(page.get_by_label('Connection and offline availability')).to_contain_text('Ready offline', timeout=20000)
        page.evaluate("""url => {
          const key = 'pitchwork-auth:' + url;
          const session = JSON.parse(localStorage.getItem(key));
          session.expires_at = Math.floor(Date.now()/1000) - 3600;
          localStorage.setItem(key, JSON.stringify(session));
        }""", URL)
        offline_context.set_offline(True)
        page.close()
        page = offline_context.new_page()
        page.goto(BASE)
        expect(page.get_by_role('navigation')).to_be_visible()
        expect(page.get_by_role('button', name='Start practice', exact=True)).to_be_visible()
        # Change the stored session subject while approval still belongs to A.
        page.evaluate("""url => {
          const key = 'pitchwork-auth:' + url;
          const session = JSON.parse(localStorage.getItem(key));
          session.user.id = '10000000-0000-4000-8000-000000000099';
          session.expires_at = Math.floor(Date.now()/1000) + 86400;
          localStorage.setItem(key, JSON.stringify(session));
        }""", URL)
        page.close()
        page = offline_context.new_page()
        page.goto(BASE)
        expect(page.get_by_role('heading', name='Welcome to Pitchwork.')).to_be_visible()
        assert page.get_by_role('navigation').count() == 0
        assert 'Private cached pitcher' not in page.inner_text('body')
        offline_context.close()
        print('Expired-token offline reopening and cross-account cache isolation passed.')
    assert not errors, errors
    browser.close()
    print('Coach account administration isolation and explicit sign-out passed. No browser errors.')
