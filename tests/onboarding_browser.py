"""Coach setup, optional invitations, invite acceptance, recovery and responsive QA.

Run against Vite with the public test settings documented in auth_mock.py.
SQL permissions and the real Edge handler are tested separately by Vitest.
"""
import copy
import json
import os
import uuid
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from auth_mock import Backend, URL, TEAM_ID, PASSWORD, make_session

BASE = os.environ.get('PITCHWORK_BASE_URL', 'http://127.0.0.1:5187')
OUT = Path(__file__).resolve().parents[1] / '.test-artifacts'
OUT.mkdir(exist_ok=True)


class OnboardingBackend(Backend):
    def __init__(self):
        super().__init__('coach')
        self.signup = None
        self.player_invites = []
        self.fail_mail = False
        self.fail_invite_response = False
        self.recovery = []

    def handle(self, route):
        req = route.request
        if req.method != 'POST' or '/functions/v1/accounts' not in req.url:
            return super().handle(route)
        payload = json.loads(req.post_data or '{}')
        action = payload.get('action')
        result, status = {}, 200
        if action == 'coach_signup':
            if self.fail_mail:
                result, status = {'error': 'Could not send your code. Wait a minute and resend it.'}, 503
            else:
                self.signup = self.signup or payload
                result = {'message': 'If this email can create a new account, a verification code is on its way.'}
        elif action == 'verify_coach_signup':
            if payload['code'] != '123456':
                result, status = {'error': 'This code is invalid or expired. Resend it and try again.'}, 400
            else:
                self.profile.update(name=self.signup['name'], email=self.signup['email'], onboardingTeamId=TEAM_ID)
                self.data['teams'] = [{'id': TEAM_ID, 'name': self.signup['teamName'], 'archived': False, 'createdAt': '2026-11-12T00:00:00Z', 'updatedAt': '2026-11-12T00:00:00Z'}]
                self.data['teamCoaches'] = [{'teamId': TEAM_ID, 'coachId': self.profile['id']}]
                result = make_session(self.profile)
        elif action == 'finish_onboarding':
            self.profile['onboardingTeamId'] = None
        elif action == 'player_invitations':
            if payload['operation'] == 'list':
                result = copy.deepcopy(self.player_invites)
            elif payload['operation'] == 'create':
                entry = next((i for i in self.player_invites if i['id'] == payload['requestId']), None)
                if not entry:
                    pid = payload.get('pitcherId') or str(uuid.uuid4())
                    player = next((p for p in self.data['pitchers'] if p['id'] == pid), None)
                    if not player:
                        player = {'id': pid, 'name': payload['name'], 'jersey': '', 'ownerId': self.profile['id'], 'archived': False, 'createdAt': '2026-11-12T00:00:00Z', 'updatedAt': '2026-11-12T00:00:00Z'}
                        self.data['pitchers'].append(player)
                        self.data['teamPitchers'].append({'teamId': TEAM_ID, 'pitcherId': pid, 'active': True})
                    for invite in self.player_invites:
                        if invite['pitcherId'] == pid:
                            invite['revokedAt'] = '2026-11-12T00:00:00Z'
                    entry = {'id': payload['requestId'], 'pitcherId': pid, 'name': player['name'], 'expiresAt': '2099-11-19T00:00:00Z', 'acceptedAt': None, 'revokedAt': None}
                    self.player_invites.append(entry)
                result = {**entry, 'inviteLink': BASE + '/#player-invite=' + 'a' * 64}
                if self.fail_invite_response:
                    self.fail_invite_response = False
                    route.abort('failed')
                    return
            else:
                next(i for i in self.player_invites if i['id'] == payload['id'])['revokedAt'] = '2026-11-12T00:00:00Z'
        elif action == 'invitation_details':
            entry = next((i for i in self.player_invites if not i['revokedAt'] and not i['acceptedAt']), None)
            if not entry or payload['token'] != 'a' * 64:
                result, status = {'error': 'This invitation is unavailable or expired. Ask your coach for a new link.'}, 400
            else:
                result = {'teamName': self.data['teams'][0]['name'], 'playerName': entry['name']}
        elif action == 'accept_player_invitation':
            entry = next(i for i in self.player_invites if not i['revokedAt'] and not i['acceptedAt'])
            entry['acceptedAt'] = '2026-11-12T00:00:00Z'
            self.profile = {'id': str(uuid.uuid4()), 'email': 'player@players.pitchwork.invalid', 'name': entry['name'], 'username': payload['username'], 'role': 'player', 'active': True, 'pitcherId': entry['pitcherId']}
            self.data['coaches'].append(self.profile)
            result = make_session(self.profile)
        elif action == 'recover_password':
            self.recovery.append(payload['email'])
            result = {'message': 'If an account exists, a password reset email is on its way.'}
        else:
            return super().handle(route)
        route.fulfill(status=status, headers={'access-control-allow-origin': '*', 'content-type': 'application/json'}, body=json.dumps(result))


def install(context, backend):
    context.route(URL + '/**', backend.handle)


def fit(page):
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Horizontal overflow'


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    errors = []
    for width in [320, 390, 768, 1440]:
        context = browser.new_context(viewport={'width': width, 'height': 1000})
        backend = OnboardingBackend()
        install(context, backend)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(BASE)
        page.wait_for_load_state('networkidle')
        page.get_by_role('button', name='Create a team').click()
        expect(page.get_by_role('heading', name='Your team starts with you.')).to_be_visible()
        page.get_by_label('Your name', exact=True).fill('Sam Coach')
        page.get_by_label('Email address', exact=True).fill('sam@example.com')
        page.get_by_label('Team name', exact=True).fill('Riverside Falcons 14U')
        fit(page)
        page.screenshot(path=str(OUT / f'coach-signup-{width}.png'), full_page=True)
        if width == 390:
            backend.fail_mail = True
            page.get_by_role('button', name='Create my team').click()
            expect(page.get_by_role('alert')).to_contain_text('Could not send')
            backend.fail_mail = False
        page.get_by_role('button', name='Create my team').click()
        expect(page.get_by_role('button', name='Resend code in')).to_be_disabled()
        if width == 390:
            page.reload()
            expect(page.get_by_label('Email verification code')).to_be_visible()
            assert 'password' not in page.evaluate("sessionStorage.getItem('pitchwork-coach-signup')")
        page.get_by_label('Email verification code').fill('000000')
        page.get_by_label('Choose a password').fill(PASSWORD)
        page.get_by_role('button', name='Show', exact=True).click()
        expect(page.locator('input[name=password]')).to_have_attribute('type', 'text')
        page.get_by_role('button', name='Hide', exact=True).click()
        page.get_by_role('button', name='Verify & continue').click()
        expect(page.get_by_role('alert')).to_contain_text('invalid or expired')
        page.get_by_label('Email verification code').fill('123456')
        page.get_by_role('button', name='Verify & continue').click()
        expect(page.get_by_role('heading', name='Riverside Falcons 14U')).to_be_visible()
        assert not page.evaluate("sessionStorage.getItem('pitchwork-coach-signup')")
        fit(page)
        if width == 320:
            page.get_by_role('button', name='Go to my dugout').click()
            expect(page.get_by_role('navigation')).to_be_visible()
            assert not backend.data['pitchers'], 'Inviting players must be optional'
        else:
            page.get_by_label('Player’s name').fill('Jordan Player')
            backend.fail_invite_response = True
            page.get_by_role('button', name='Create player invitation').click()
            expect(page.get_by_role('alert')).to_contain_text('Could not connect')
            page.get_by_role('button', name='Create player invitation').click()
            link = page.get_by_label('Player invitation link for Jordan Player')
            expect(link).to_be_visible()
            assert len(backend.data['pitchers']) == 1, 'An uncertain retry must not duplicate players'
            fit(page)
            page.screenshot(path=str(OUT / f'coach-invitations-{width}.png'), full_page=True)
            invite_link = link.input_value()
            page.reload()
            expect(page.get_by_role('heading', name='Riverside Falcons 14U')).to_be_visible()
            expect(page.get_by_text('Pending · expires', exact=False)).to_be_visible()
            page.get_by_role('button', name='Go to my dugout').click()
            expect(page.get_by_role('navigation')).to_be_visible()
            page.get_by_role('navigation').get_by_role('button', name='Roster', exact=True).click()
            page.get_by_role('button', name='Teams', exact=True).click()
            page.get_by_role('button', name='YOUR DUGOUT Riverside Falcons 14U').click()
            expect(page.get_by_role('heading', name='Invite your players')).to_be_visible()
            expect(page.locator('.member-row strong').filter(has_text='Jordan Player')).to_have_count(2)
            if width == 390:
                player_context = browser.new_context(viewport={'width': 390, 'height': 844})
                install(player_context, backend)
                player_page = player_context.new_page()
                player_page.on('pageerror', lambda error: errors.append(str(error)))
                player_page.goto(invite_link)
                player_page.wait_for_load_state('networkidle')
                expect(player_page.get_by_role('heading', name='Join Riverside Falcons 14U.')).to_be_visible()
                assert '#player-invite' not in player_page.url
                player_page.reload()
                expect(player_page.get_by_label('Player username')).to_be_visible()
                player_page.get_by_label('Player username').fill('jordan.player')
                player_page.get_by_label('Choose a password').fill(PASSWORD)
                fit(player_page)
                player_page.screenshot(path=str(OUT / 'player-invitation-390.png'), full_page=True)
                player_page.get_by_role('button', name='Join my team').click()
                expect(player_page.get_by_role('navigation')).to_be_visible()
                expect(player_page.get_by_role('heading', name='Statistics', exact=True)).to_be_visible()
                assert not player_page.evaluate("sessionStorage.getItem('pitchwork-player-invite')")
                player_context.close()
            else:
                page.get_by_role('button', name='Revoke invitation for Jordan Player').click()
                expect(page.locator('.player-invites').get_by_role('status')).to_contain_text('Invitation revoked')
        context.close()

    context = browser.new_context(viewport={'width': 390, 'height': 844})
    backend = OnboardingBackend()
    install(context, backend)
    page = context.new_page()
    page.goto(BASE)
    page.wait_for_load_state('networkidle')
    page.get_by_role('button', name='Forgot your password?').click()
    page.get_by_label('Account email').fill('sam@example.com')
    page.get_by_role('button', name='Send password reset email').click()
    expect(page.get_by_role('status')).to_contain_text('If an account exists')
    assert backend.recovery == ['sam@example.com']
    page.goto(BASE + '/#player-invite=' + 'f' * 64)
    expect(page.get_by_role('alert')).to_contain_text('unavailable or expired')
    context.close()
    browser.close()
    assert not errors, errors
    print('Signup, verification, skip/resume, invitation retry/revoke/acceptance, recovery and 320/390/768/1440px layouts passed.')
