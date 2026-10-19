#!/usr/bin/python3
"""Optional single-project IPv4 transport exception. Install root-owned, never setuid.

Only metadata is requested from Docker (never Config.Env). Docker administrators
are necessarily trusted. State is a write-ahead ownership receipt, not a rule dump.
"""
import fcntl
import ipaddress
import json
import os
import re
import signal
import stat
import subprocess
import sys
import tempfile
import threading

RUNTIME = '/run/dsh-ocean-route'
CONFIG = '/etc/dsh-ocean-remote/route.json'
PREF, PROTO = 8990, 193
LIMIT = 262144


class Unsafe(Exception):
    pass


def require(value):
    if not value:
        raise Unsafe('guard failed')


def decode(text):
    require(len(text) <= LIMIT)
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result)
            result[key] = value
        return result
    return json.loads(text, object_pairs_hook=unique)


def protected(path, directory=False):
    info = os.lstat(path)
    require(info.st_uid == 0 and not info.st_mode & 0o077)
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))


def load(path):
    protected(os.path.dirname(path), True)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        require(info.st_uid == 0 and stat.S_ISREG(info.st_mode) and not info.st_mode & 0o077)
        return decode(stream.read(LIMIT + 1))


def receipt(value):
    require(isinstance(value, dict) and set(value) == {'source', 'bridge', 'priority', 'protocol'})
    require(value['priority'] == PREF and value['protocol'] == PROTO)
    source = ipaddress.IPv4Address(value['source'])
    require(str(source) == value['source'] and source.is_private and not source.is_loopback
            and not source.is_link_local and not source.is_unspecified and not source.is_multicast)
    require(re.fullmatch(r'br-[0-9a-f]{12}', value['bridge']))
    return value


def config():
    value = load(CONFIG)
    require(set(value) == {'project', 'image'})
    require(re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,62}', value['project']))
    require(re.fullmatch(r'tailscale/tailscale@sha256:[0-9a-f]{64}', value['image']))
    return value


def run(args):
    env = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'DOCKER_CONFIG': RUNTIME + '/docker'}
    result = subprocess.run(args, env=env, capture_output=True, text=True, timeout=20)
    require(result.returncode == 0 and len(result.stdout) <= LIMIT)
    return result.stdout


def docker(*args):
    return run(['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock', *args])


def canonical(value):
    require(isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value))
    return value


def inspect(kind, ident, fields):
    # Explicit field allowlist: never retrieve entire container Config or Env.
    def expression(field):
        # OCI image Config may omit empty Cmd/Entrypoint keys. Map indexing
        # returns null, whereas a dotted template can fail before JSON output.
        if kind == 'image' and field in ('Config.Entrypoint', 'Config.Cmd'):
            return '(index .Config ' + json.dumps(field.split('.')[1]) + ')'
        return '.' + field
    template = '{' + ','.join(json.dumps(k) + ':{{json ' + expression(v) + '}}' for k, v in fields.items()) + '}'
    return decode(docker(kind, 'inspect', '--format', template, ident))


def discover(cfg):
    project = cfg['project']
    def service(name):
        ids = docker('ps', '-q', '--no-trunc', '--filter', 'label=com.docker.compose.project=' + project,
                     '--filter', 'label=com.docker.compose.service=' + name).split()
        require(len(ids) == 1)
        return canonical(ids[0])
    cid, app = service('tailscale'), service('server')
    fields = {'id': 'Id', 'image': 'Config.Image', 'imageID': 'Image', 'labels': 'Config.Labels',
              'entry': 'Config.Entrypoint', 'cmd': 'Config.Cmd', 'networks': 'NetworkSettings.Networks',
              'host': 'HostConfig', 'mounts': 'Mounts', 'running': 'State.Running'}
    c = inspect('container', cid, fields)
    require(c['id'] == cid and c['running'] is True and c['image'] == cfg['image'])
    require(c['labels']['com.docker.compose.project'] == project
            and c['labels']['com.docker.compose.service'] == 'tailscale')
    image = inspect('image', cfg['image'], {'id': 'Id', 'digests': 'RepoDigests',
                                         'entry': 'Config.Entrypoint', 'cmd': 'Config.Cmd'})
    require(cfg['image'] in image['digests'] and c['imageID'] == image['id'])
    require((c['entry'] or []) == (image['entry'] or []) and (c['cmd'] or []) == (image['cmd'] or []))
    host = c['host']
    require(host['NetworkMode'] not in ('host', 'none') and not host['NetworkMode'].startswith('container:'))
    require(not host.get('Privileged') and not host.get('CapAdd') and not host.get('Devices')
            and not host.get('PortBindings'))
    backend, transport = project + '_backend', project + '_transport'
    require(set(c['networks']) == {backend, transport})
    for other in docker('ps', '-aq', '--no-trunc').split():
        canonical(other)
        mode = inspect('container', other, {'mode': 'HostConfig.NetworkMode'})['mode']
        if mode.startswith('container:'):
            ref = mode[len('container:'):]
            require(re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*', ref))
            resolved = inspect('container', ref, {'id': 'Id'})['id']
            require(canonical(resolved) != cid)
    mounts = [m for m in c['mounts'] if m['Destination'] == '/var/lib/tailscale']
    require(len(mounts) == 1 and mounts[0]['Type'] == 'volume'
            and mounts[0]['Name'] == project + '_tailnet-state')
    volume = inspect('volume', mounts[0]['Name'], {'labels': 'Labels'})
    require(volume['labels']['com.docker.compose.project'] == project
            and volume['labels']['com.docker.compose.volume'] == 'tailnet-state')
    nets = {}
    for name, role, members in ((transport, 'transport', {cid}), (backend, 'backend', {cid, app})):
        nid = canonical(c['networks'][name]['NetworkID'])
        n = inspect('network', nid, {'id': 'Id', 'name': 'Name', 'driver': 'Driver', 'labels': 'Labels',
                                    'members': 'Containers', 'options': 'Options', 'internal': 'Internal',
                                    'ipv6': 'EnableIPv6'})
        require(n['id'] == nid and n['name'] == name and n['driver'] == 'bridge')
        require(n['labels']['com.docker.compose.project'] == project
                and n['labels']['com.docker.compose.network'] == role and set(n['members']) == members)
        nets[role] = n
    require(nets['backend']['internal'] is True and nets['backend']['ipv6'] is False
            and nets['backend']['options'].get('com.docker.network.bridge.gateway_mode_ipv4') == 'isolated')
    require(nets['transport']['internal'] is False and not (nets['transport']['options'] or {}).get('com.docker.network.bridge.name'))
    a = inspect('container', app, {'networks': 'NetworkSettings.Networks', 'ports': 'HostConfig.PortBindings',
                                  'mode': 'HostConfig.NetworkMode'})
    require(set(a['networks']) == {backend} and not a['ports'] and not a['mode'].startswith('container:'))
    require(a['networks'][backend]['NetworkID'] == nets['backend']['id'])
    value = receipt({'source': c['networks'][transport]['IPAddress'], 'bridge': 'br-' + nets['transport']['id'][:12],
                     'priority': PREF, 'protocol': PROTO})
    link = decode(run(['/usr/bin/ip', '-j', 'link', 'show', 'dev', value['bridge']]))
    require(len(link) == 1 and link[0]['ifname'] == value['bridge'])
    return value


def rules():
    value = decode(run(['/usr/bin/ip', '-N', '-d', '-4', '-j', 'rule', 'show']))
    require(isinstance(value, list))
    return value


def deletion_candidate(rule, own):
    """The kernel treats unspecified delete selectors as wildcards, not absence."""
    if (rule.get('priority') != PREF or rule.get('src') not in (own['source'], own['source'] + '/32')
            or rule.get('iif') != own['bridge']):
        return False
    # Unknown representations must retain the receipt, never silently forget it.
    for key, wanted in (('table', 254), ('protocol', PROTO), ('srclen', 32)):
        value = rule.get(key, 32 if key == 'srclen' else None)
        if type(value) is int:
            numeric = value
        elif isinstance(value, str) and value.isdecimal():
            numeric = int(value)
        else:
            continue
        if numeric != wanted:
            return False
    return True


def matches(rule, own):
    # Only known non-selector link-lifecycle metadata may differ from an active rule.
    allowed = {'priority', 'src', 'srclen', 'dst', 'iif', 'iif_detached', 'table', 'protocol', 'action', 'flags'}
    return (not set(rule) - allowed and rule.get('priority') == PREF
            and rule.get('src') in (own['source'], own['source'] + '/32')
            and rule.get('srclen', 32) == 32
            and rule.get('iif') == own['bridge'] and str(rule.get('table')) == '254'
            and str(rule.get('protocol')) == str(PROTO) and rule.get('dst', 'all') == 'all'
            and str(rule.get('action', 'to_tbl')) in ('to_tbl', '1')
            and (rule.get('iif_detached') is None or type(rule.get('iif_detached')) is bool)
            and rule.get('flags', []) in ([], ['iif_detached']))


def selector(own):
    return ['pref', str(PREF), 'from', own['source'] + '/32', 'iif', own['bridge'],
            'lookup', 'main', 'protocol', str(PROTO)]


class Manager:
    def __init__(self):
        self.path = RUNTIME + '/state.json'

    def state(self):
        try:
            return receipt(load(self.path))
        except FileNotFoundError:
            return None

    def save(self, own):
        fd, path = tempfile.mkstemp(prefix='.state-', dir=RUNTIME)
        try:
            with os.fdopen(fd, 'w') as stream:
                json.dump(own, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(path, self.path)
            directory = os.open(RUNTIME, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(path):
                os.unlink(path)

    def remove(self):
        own = self.state()
        if own is None:
            return
        candidates = [r for r in rules() if deletion_candidate(r, own)]
        # A marked/UID/destination-constrained foreign rule could be selected first
        # by the same netlink delete request. Refuse ambiguity BEFORE any deletion.
        require(len(candidates) <= 1 and all(matches(r, own) for r in candidates))
        if candidates:
            run(['/usr/bin/ip', '-4', 'rule', 'del', *selector(own)])
        require(not any(deletion_candidate(r, own) for r in rules()))
        os.unlink(self.path)

    def reconcile(self, desired):
        old = self.state()
        current = rules()
        if old == desired and len([r for r in current if r.get('priority') == PREF]) == 1:
            if any(matches(r, old) for r in current):
                policy(current)
                return
        self.remove()
        current = rules()
        policy(current)
        require(not any(r.get('priority') == PREF for r in current))
        self.save(desired)  # Persist before insertion, including crash-between-write-and-add.
        run(['/usr/bin/ip', '-4', 'rule', 'add', *selector(desired)])
        current = rules()
        require(len([r for r in current if r.get('priority') == PREF]) == 1
                and any(matches(r, desired) for r in current))


def policy(current):
    require(any(r.get('priority') == 5270 and str(r.get('table')) == '52' for r in current))
    require(any(r.get('priority') == 5210 and str(r.get('table')) == '254'
                and r.get('fwmark') == '0x80000' for r in current))
    vpn = [r['priority'] for r in current if str(r.get('table')) == '2022']
    require(vpn and 5270 < PREF < min(vpn))


def main():
    require(os.geteuid() == 0 and sys.argv[1:] in ([], ['--remove']))
    protected(RUNTIME, True)
    lock = os.open(RUNTIME + '/lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    with os.fdopen(lock, 'w') as stream:
        protected(RUNTIME + '/lock')
        fcntl.flock(stream, fcntl.LOCK_EX)
        manager = Manager()
        if sys.argv[1:]:
            manager.remove()  # Deliberately independent of config and Docker availability.
            return
        os.makedirs(RUNTIME + '/docker', mode=0o700, exist_ok=True)
        protected(RUNTIME + '/docker', True)
        stop = threading.Event()
        for sig in (signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, lambda *_: stop.set())
        try:
            while not stop.is_set():
                try:
                    manager.reconcile(discover(config()))
                except Exception:
                    manager.remove()
                    print('Ocean route guard unavailable; exception withdrawn.', file=sys.stderr, flush=True)
                stop.wait(5)
        finally:
            manager.remove()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Ocean route helper failed safely; check protected configuration/state.', file=sys.stderr)
        sys.exit(1)
