"""New account form, email-code, and approval checks against the browser fixture."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from auth_mock import install

BASE = os.environ.get('PITCHWORK_BASE_URL', 'http://127.0.0.1:5187')
OUT = Path(__file__).resolve().parents[1] / '.test-artifacts'
OUT.mkdir(exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 390, 'height': 844})
    backend = install(context, signed_in=False)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.clock.install()
    page.goto(BASE)
    page.wait_for_load_state('networkidle')
    page.get_by_role('button', name='Request an account').click()
    expect(page.get_by_label('Account type')).to_have_value('player')
    expect(page.get_by_label('Team name (optional)')).not_to_have_attribute('required', '')
    assert not page.get_by_label('Linked pitcher').count()
    assert not page.get_by_text('Choose a pitcher you own').count()
    page.get_by_label('Account type').select_option('coach')
    expect(page.get_by_label('Player username')).to_have_count(0)
    expect(page.get_by_label('Team name', exact=True)).to_have_attribute('required', '')
    page.get_by_label('Account type').select_option('player')
    page.get_by_label('Your name').fill('New Pitcher')
    page.get_by_label('Player username').fill('Practice.Star')
    page.get_by_label('Email address', exact=True).fill('PLAYER@example.com')
    backend.fail_verification_email = True
    page.get_by_role('button', name='Send account request').click()
    expect(page.get_by_role('alert')).to_contain_text('Could not send')
    backend.fail_verification_email = False
    page.get_by_role('button', name='Send account request').click()
    expect(page.get_by_label('Verification code')).to_be_visible()
    assert backend.requests[0]['username'] == 'practice.star'
    assert backend.requests[0]['requested_team'] == ''
    assert not backend.data['coaches'][-1]['active']
    expect(page.get_by_role('button', name='Resend code in')).to_be_disabled()
    page.get_by_label('Verification code').fill('000000')
    page.get_by_role('button', name='Verify email', exact=True).click()
    expect(page.get_by_role('alert')).to_contain_text('invalid or expired')
    page.clock.fast_forward(61000)
    page.get_by_role('button', name='Resend code', exact=True).click()
    expect(page.get_by_role('button', name='Resend code in')).to_be_disabled()
    page.get_by_label('Verification code').fill('123456')
    page.get_by_role('button', name='Verify email', exact=True).click()
    expect(page.get_by_role('status')).to_contain_text('Email verified—waiting for admin approval')
    assert not backend.data['coaches'][-1]['active']
    assert not page.get_by_role('navigation').count()
    page.screenshot(path=str(OUT / 'verified-player-request-mobile.png'), full_page=True)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    # A second attempt to consume the same code fails.
    assert page.evaluate("""async () => (await fetch('/api/accounts', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'verify_request',email:'player@example.com',code:'123456'})})).status""") == 400
    page.get_by_role('button', name='Back to sign in', exact=True).click()
    page.get_by_role('button', name='Request an account').click()
    page.get_by_label('Account type').select_option('coach')
    page.get_by_label('Your name').fill('New Coach')
    page.get_by_label('Email address', exact=True).fill('newcoach@example.com')
    page.get_by_label('Team name', exact=True).fill('Falcons')
    page.get_by_role('button', name='Send account request').click()
    expect(page.get_by_label('Verification code')).to_be_visible()
    assert backend.requests[-1]['role'] == 'coach'
    context.close()

    context = browser.new_context(viewport={'width': 390, 'height': 1000})
    admin = install(context, role='admin')
    admin.requests = backend.requests
    admin.data['coaches'] += backend.data['coaches'][1:]
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE)
    page.wait_for_load_state('networkidle')
    page.get_by_role('button', name='Account settings for Test Coach', exact=True).click()
    coach_row = page.locator('.account-row').filter(has_text='newcoach@example.com')
    coach_row.get_by_role('button', name='Review & create').click()
    editor = page.locator('.account-editor')
    expect(editor.get_by_role('button', name='Approve account')).to_be_disabled()
    expect(editor).to_contain_text('Create new team')
    editor.get_by_role('button', name='Cancel', exact=True).click()
    player_row = page.locator('.account-row').filter(has_text='player@example.com')
    player_row.get_by_role('button', name='Review & create').click()
    expect(editor.get_by_label('Linked pitcher')).to_have_count(0)
    expect(editor).to_contain_text('No team assignment')
    expect(editor.get_by_label('Player username')).to_have_value('practice.star')
    editor.get_by_role('button', name='Approve account').click()
    expect(page.get_by_label('Private password setup link')).to_be_visible()
    approved = page.locator('.account-row').filter(has_text='practice.star').filter(has=page.get_by_role('button', name='Edit access', exact=True))
    expect(approved).to_contain_text('Linked pitcher: New Pitcher')
    assert len(admin.data['pitchers']) == 1
    assert not admin.data['teamCoaches']
    page.screenshot(path=str(OUT / 'approved-player-account-mobile.png'), full_page=True)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    context.close()
    browser.close()
    assert not errors, errors
    print('Player/coach forms, role switching, mail failure, expired code, resend, pending approval and new pitcher approval passed.')
