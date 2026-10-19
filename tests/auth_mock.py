"""Browser-only network fixture. Production has no test login or auth bypass.

Build/run with VITE_SUPABASE_URL=https://pitchwork-test.supabase.co and
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_browser_test. Call install(context).
Real authorization rules are tested separately against the SQL migrations.
"""
import base64
import copy
import json
import time
import uuid

URL = 'https://pitchwork-test.supabase.co'
COACH_ID = '10000000-0000-4000-8000-000000000001'
TEAM_ID = '20000000-0000-4000-8000-000000000001'


def install(context, role='coach', signed_in=True):
    backend = Backend(role)
    context.route(URL + '/**', backend.handle)
    if signed_in:
        profile = backend.profile
        now = int(time.time())
        token = '.'.join(base64.urlsafe_b64encode(json.dumps(p).encode()).decode().rstrip('=') for p in [
            {'alg': 'HS256', 'typ': 'JWT'}, {'sub': COACH_ID, 'aud': 'authenticated', 'role': 'authenticated', 'iat': now, 'exp': now + 86400},
        ]) + '.browser-test-signature'
        user = {**profile, 'aud': 'authenticated', 'email_confirmed_at': '2026-01-01T00:00:00Z', 'app_metadata': {'provider': 'google', 'providers': ['google']}, 'user_metadata': {'name': profile['name']}, 'identities': [{'provider': 'google', 'id': COACH_ID}], 'created_at': '2026-01-01T00:00:00Z'}
        session = {'access_token': token, 'refresh_token': 'browser-test-refresh', 'expires_at': now + 86400, 'expires_in': 86400, 'token_type': 'bearer', 'user': user}
        context.add_init_script("""(() => {
          if (!localStorage.getItem('pitchwork-browser-initialized')) {
            localStorage.setItem('pitchwork-auth:' + %s, %s);
            localStorage.setItem('pitchwork-browser-initialized', 'true');
          }
        })()""" % (json.dumps(URL), json.dumps(json.dumps(session))))
    return backend


class Backend:
    def __init__(self, role):
        self.profile = {'id': COACH_ID, 'email': 'coach@example.com', 'name': 'Test Coach', 'role': role, 'active': True}
        self.data = {'coaches': [self.profile], 'teams': [], 'teamPitchers': [], 'teamCoaches': [], 'pitchers': [], 'invitations': [], 'sessions': [], 'events': []}
        self.operations = {}
        self.requests = []
        self.fail_upload = False

    def handle(self, route):
        req = route.request
        if '/auth/v1/token' in req.url:
            # An expired-token offline test must produce a retryable network
            # failure, rather than a fake404 that revokes the SDK session.
            route.abort('internetdisconnected')
            return
        headers = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json'}
        if req.method == 'OPTIONS':
            route.fulfill(status=204, headers=headers)
            return
        payload = json.loads(req.post_data or '{}')
        result, status = {}, 200
        if '/functions/v1/accounts' in req.url:
            action = payload['action']
            if action == 'request':
                self.requests.append({'id': str(uuid.uuid4()), 'name': payload['name'], 'email': payload['email'], 'requested_team': payload['requestedTeam'], 'status': 'pending'})
                result = {'message': 'Request received.'}
            elif not self.profile['active']:
                status, result = 403, {'error': 'Your account is unapproved or suspended. Contact the admin.', 'code': 'access_denied'}
            elif action == 'profile':
                result = self.profile
            elif action == 'list':
                result = {'profiles': self.data['coaches'], 'requests': self.requests, 'memberships': [{'coach_id': m['coachId'], 'team_id': m['teamId']} for m in self.data['teamCoaches']]}
            elif action in ('create', 'update'):
                account_id = payload.get('id') or str(uuid.uuid4())
                if action == 'create':
                    self.data['coaches'].append({'id': account_id, 'name': payload['name'], 'email': payload['email'], 'role': 'coach', 'active': True})
                for account in self.data['coaches']:
                    if account['id'] == account_id:
                        account['active'] = payload['active']
                self.data['teamCoaches'] = [m for m in self.data['teamCoaches'] if m['coachId'] != account_id] + [{'coachId': account_id, 'teamId': t} for t in payload['teamIds']]
                for request in self.requests:
                    if request['email'] == payload.get('email'):
                        request['status'] = 'approved'
            elif action == 'reject':
                for request in self.requests:
                    if request['id'] == payload['id']:
                        request['status'] = 'rejected'
        elif '/auth/v1/user' in req.url:
            result = self.profile
        elif '/auth/v1/logout' in req.url:
            result = {}
        elif '/rest/v1/rpc/get_workspace' in req.url:
            result = copy.deepcopy(self.data)
        elif '/rest/v1/rpc/upload_practice' in req.url:
            op = payload['operation']
            if self.fail_upload:
                status, result = 503, {'message': 'Simulated connection loss', 'code': 'network'}
            elif op['id'] in self.operations:
                result = self.operations[op['id']]
            else:
                self.data['sessions'] = [s for s in self.data['sessions'] if s['id'] != op['sessionId']] + [op['session']]
                self.data['events'] = [e for e in self.data['events'] if e['sessionId'] != op['sessionId']] + op['events']
                result = op['session']['revision']
                self.operations[op['id']] = result
        elif '/rest/v1/rpc/manage' in req.url:
            action, item = payload['action'], payload['input']
            stamp = '2026-10-19T12:00:00.000Z'
            if action == 'saveTeam':
                self.data['teams'] = [t for t in self.data['teams'] if t['id'] != item['id']] + [{'id': item['id'], 'name': item['name'], 'createdAt': stamp, 'updatedAt': stamp}]
                if not any(m['teamId'] == item['id'] and m['coachId'] == COACH_ID for m in self.data['teamCoaches']):
                    self.data['teamCoaches'].append({'teamId': item['id'], 'coachId': COACH_ID})
            elif action == 'savePitcher':
                self.data['pitchers'] = [p for p in self.data['pitchers'] if p['id'] != item['id']] + [{'id': item['id'], 'name': item['name'], 'jersey': item['jersey'], 'ownerId': COACH_ID, 'archived': False, 'createdAt': stamp, 'updatedAt': stamp}]
                self.data['teamPitchers'] = [m for m in self.data['teamPitchers'] if m['pitcherId'] != item['id']] + [{'teamId': tid, 'pitcherId': item['id'], 'active': True} for tid in item['teamIds']]
            elif action == 'archivePitcher':
                for pitcher in self.data['pitchers']:
                    if pitcher['id'] == item['pitcherId']:
                        pitcher['archived'] = item['archived']
            elif action == 'restore':
                backup = copy.deepcopy(item['backup'])
                # Browser acceptance fixture mirrors the server's copy semantics.
                mapping = {p['id']: str(uuid.uuid4()) for p in backup['pitchers']}
                teams = {t['id']: str(uuid.uuid4()) for t in backup['teams']}
                for team in backup['teams']:
                    team['id'] = teams[team['id']]
                    self.data['teams'].append(team)
                    self.data['teamCoaches'].append({'teamId': team['id'], 'coachId': COACH_ID})
                for pitcher in backup['pitchers']:
                    pitcher['id'], pitcher['ownerId'] = mapping[pitcher['id']], COACH_ID
                    self.data['pitchers'].append(pitcher)
                for membership in backup['teamPitchers']:
                    membership.update(teamId=teams[membership['teamId']], pitcherId=mapping[membership['pitcherId']])
                    self.data['teamPitchers'].append(membership)
                for session in backup['sessions']:
                    old = session['id']; session['id'] = str(uuid.uuid4()); session['recovered'] = True
                    session.update(teamId=teams.get(session['teamId']), recorderId=COACH_ID, deviceId=item['deviceId'], revision=1)
                    for key in ['initialPitcherId', 'selectedPitcherId']:
                        session[key] = mapping[session[key]]
                    session['pitcherIds'] = [mapping[p] for p in session['pitcherIds']]
                    self.data['sessions'].append(session)
                    for event in backup['events']:
                        if event['sessionId'] == old:
                            event.update(id=str(uuid.uuid4()), sessionId=session['id'], pitcherId=mapping[event['pitcherId']])
                            self.data['events'].append(event)
        else:
            status, result = 404, {'message': 'Unmocked endpoint: ' + req.url}
        route.fulfill(status=status, headers=headers, body=json.dumps(result))
