"""Unprivileged tests: no actual Docker, ip, or protected-file operations."""
import copy
import importlib.util
import pathlib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('helper', pathlib.Path(__file__).with_name('ocean-route-helper.py'))
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
OWN = {'source': '172.20.0.2', 'bridge': 'br-aaaaaaaaaaaa', 'priority': 8990, 'protocol': 193}
BASE = [{'priority': 5210, 'table': 254, 'fwmark': '0x80000'},
        {'priority': 5270, 'table': 52}, {'priority': 9000, 'table': 2022}]


def rule(own):
    return {'priority': 8990, 'table': 254, 'protocol': 193, 'src': own['source'], 'iif': own['bridge']}


class MemoryManager(h.Manager):
    def __init__(self):
        self.owned = None
        self.current = copy.deepcopy(BASE)
        self.operations = []
        self.path = '/mock/state'

    def state(self):
        return self.owned

    def save(self, value):
        self.owned = value.copy()
        self.operations.append('save')

    def run(self, args):
        self.operations.append(args[3])
        if args[3] == 'add':
            self.current.append(rule(self.owned))
        else:
            # Model the kernel's broad selector: omitted fwmark/dst/UID fields
            # do not mean that those selectors must be absent.
            for index, candidate in enumerate(self.current):
                if h.deletion_candidate(candidate, self.owned):
                    self.current.pop(index)
                    break
        return ''

    def unlink(self, path):
        self.owned = None


class Tests(unittest.TestCase):
    def setUp(self):
        self.m = MemoryManager()
        for name, value in [('rules', lambda: self.m.current.copy()), ('run', self.m.run),
                            ('os.unlink', self.m.unlink)]:
            p = patch.object(h, name, value) if '.' not in name else patch.object(h.os, 'unlink', value)
            p.start()
            self.addCleanup(p.stop)

    def test_add_idempotent_and_exact_cleanup(self):
        self.m.reconcile(OWN)
        self.m.reconcile(OWN)
        self.assertEqual(self.m.operations, ['save', 'add'])
        self.m.current.append({'priority': 8990, 'table': 42})
        self.m.remove()
        self.m.remove()
        self.assertEqual(self.m.current, BASE + [{'priority': 8990, 'table': 42}])

    def test_foreign_priority_preserved(self):
        self.m.current.append({'priority': 8990, 'table': 42})
        with self.assertRaises(h.Unsafe):
            self.m.reconcile(OWN)
        self.assertEqual(self.m.operations, [])

    def test_ip_change_removes_before_add(self):
        self.m.reconcile(OWN)
        new = dict(OWN, source='172.20.0.3', bridge='br-bbbbbbbbbbbb')
        self.m.reconcile(new)
        self.assertEqual(self.m.operations, ['save', 'add', 'del', 'save', 'add'])
        self.assertEqual(self.m.current[-1], rule(new))

    def test_unknown_protocol_or_selectors_keep_receipt_and_never_delete(self):
        for delta in ({'protocol': 'unknown'}, {'fwmark': '0x1'}, {'flags': ['not']},
                      {'future_metadata': True}, {'srclen': True}):
            with self.subTest(delta=delta):
                self.m.owned = OWN.copy()
                self.m.current = copy.deepcopy(BASE) + [dict(rule(OWN), **delta)]
                before = copy.deepcopy(self.m.current)
                with self.assertRaises(h.Unsafe):
                    self.m.remove()
                self.assertEqual(self.m.current, before)
                self.assertEqual(self.m.owned, OWN)
        self.assertEqual(self.m.operations, [])

    def test_known_host_prefix_and_detached_metadata_cleanup(self):
        for delta in ({'srclen': 32}, {'iif_detached': None},
                      {'iif_detached': True, 'flags': ['iif_detached']}, {'action': '1'}):
            with self.subTest(delta=delta):
                self.m.owned = OWN.copy()
                self.m.current = copy.deepcopy(BASE) + [dict(rule(OWN), **delta)]
                self.m.remove()
                self.assertEqual(self.m.current, BASE)
                self.assertIsNone(self.m.owned)

    def test_foreign_broad_selector_ambiguity_refused_before_delete(self):
        for extra in ({'fwmark': '0x1'}, {'dst': '10.0.0.1'},
                      {'uidrange': {'start': 1000, 'end': 1000}}):
            for foreign_first in (True, False):
                with self.subTest(extra=extra, foreign_first=foreign_first):
                    foreign = dict(rule(OWN), **extra)
                    candidates = [foreign, rule(OWN)] if foreign_first else [rule(OWN), foreign]
                    self.m.owned = OWN.copy()
                    self.m.current = copy.deepcopy(BASE) + candidates
                    before = copy.deepcopy(self.m.current)
                    with self.assertRaises(h.Unsafe):
                        self.m.remove()
                    self.assertEqual(self.m.current, before)
                    self.assertEqual(self.m.owned, OWN)
        self.assertEqual(self.m.operations, [])

    def test_known_different_protocol_preserved_while_owned_removed(self):
        self.m.owned = OWN.copy()
        foreign = dict(rule(OWN), protocol=194)
        self.m.current = copy.deepcopy(BASE) + [foreign, rule(OWN)]
        self.m.remove()
        self.assertEqual(self.m.current, BASE + [foreign])
        self.assertIsNone(self.m.owned)

    def test_cleanup_without_docker_or_config(self):
        self.m.owned = OWN
        self.m.current.append(rule(OWN))
        with patch.object(h, 'docker', side_effect=AssertionError), patch.object(h, 'config', side_effect=AssertionError):
            self.m.remove()
        self.assertEqual(self.m.current, BASE)

    def test_policy_order(self):
        for bad in (BASE[:2], [dict(r, priority=8000) if r['table'] == 2022 else r for r in BASE], BASE[1:]):
            with self.assertRaises(h.Unsafe):
                h.policy(bad)

    def test_state_validation_and_injection(self):
        for delta in ({'source': '172.20.0.2/32'}, {'bridge': 'br-a;reboot'}, {'source': '127.0.0.1'},
                      {'priority': 1}, {'protocol': 1}, {'source': '0.0.0.0'}):
            with self.assertRaises((h.Unsafe, ValueError)):
                h.receipt(dict(OWN, **delta))
        with self.assertRaises(h.Unsafe):
            h.receipt(dict(OWN, extra=True))

    def test_json_bounds_duplicates_and_syntax(self):
        for value in ('x' * (h.LIMIT + 1), '{"a":1,"a":2}', '{bad'):
            with self.assertRaises((h.Unsafe, ValueError)):
                h.decode(value)

    def test_config_bad_image_and_project(self):
        for project, image in [('ok', ''), ('-bad', 'tailscale/tailscale@sha256:' + 'a' * 64),
                               ('ok', 'evil@sha256:' + 'a' * 64)]:
            with patch.object(h, 'load', return_value={'project': project, 'image': image}):
                with self.assertRaises(h.Unsafe):
                    h.config()

    def test_canonical_ids(self):
        self.assertEqual(h.canonical('a' * 64), 'a' * 64)
        for value in ('a' * 12, '--help', 'g' * 64):
            with self.assertRaises(h.Unsafe):
                h.canonical(value)

    def test_optional_oci_fields_use_null_safe_indexing(self):
        with patch.object(h, 'docker', return_value='{"entry":null,"cmd":null}') as call:
            result = h.inspect('image', 'approved-image', {'entry': 'Config.Entrypoint', 'cmd': 'Config.Cmd'})
        self.assertEqual(result, {'entry': None, 'cmd': None})
        template = call.call_args.args[3]
        self.assertIn('(index .Config "Entrypoint")', template)
        self.assertIn('(index .Config "Cmd")', template)

    def test_discovery_guards_and_short_namespace_joiner(self):
        cid, app, other = 'a' * 64, 'b' * 64, 'c' * 64
        p = 'own'
        cfg = {'project': p, 'image': 'tailscale/tailscale@sha256:' + 'd' * 64}
        networks = {p + '_backend': {'NetworkID': 'e' * 64},
                    p + '_transport': {'NetworkID': 'f' * 64, 'IPAddress': OWN['source']}}
        c = {'id': cid, 'running': True, 'image': cfg['image'], 'imageID': 'sha256:abc',
             'labels': {'com.docker.compose.project': p, 'com.docker.compose.service': 'tailscale'},
             'entry': None, 'cmd': None, 'host': {'NetworkMode': p + '_backend'},
             'networks': networks, 'mounts': [{'Destination': '/var/lib/tailscale', 'Type': 'volume',
                                            'Name': p + '_tailnet-state'}]}
        image = {'id': 'sha256:abc', 'digests': [cfg['image']], 'entry': [], 'cmd': []}
        join = [False]
        shared = [False]
        def dock(*args):
            if args[:2] == ('ps', '-q'):
                return cid if args[-1].endswith('=tailscale') else app
            return '\n'.join([cid, app, other])
        def inspect(kind, ident, fields):
            if kind == 'image':
                return image
            if kind == 'volume':
                return {'labels': {'com.docker.compose.project': p, 'com.docker.compose.volume': 'tailnet-state'}}
            if kind == 'network':
                backend = ident == 'e' * 64
                role = 'backend' if backend else 'transport'
                return {'id': ident, 'name': p + '_' + role, 'driver': 'bridge',
                        'labels': {'com.docker.compose.project': p, 'com.docker.compose.network': role},
                        'members': dict.fromkeys([cid, app] if backend or shared[0] else [cid]),
                        'internal': backend, 'ipv6': False,
                        'options': {'com.docker.network.bridge.gateway_mode_ipv4': 'isolated'} if backend else {}}
            if set(fields) == {'id'}:
                self.assertEqual(ident, cid[:12])
                return {'id': cid}
            if set(fields) == {'mode'}:
                return {'mode': 'container:' + cid[:12] if join[0] and ident == other else p + '_backend'}
            if ident == cid:
                return c
            return {'networks': {p + '_backend': networks[p + '_backend']}, 'ports': {}, 'mode': p + '_backend'}
        with patch.object(h, 'docker', side_effect=dock), patch.object(h, 'inspect', side_effect=inspect), \
                patch.object(h, 'run', return_value='[{"ifname":"br-ffffffffffff"}]'):
            self.assertEqual(h.discover(cfg)['source'], OWN['source'])
            image['digests'] = []
            with self.assertRaises(h.Unsafe):
                h.discover(cfg)
            image['digests'] = [cfg['image']]
            shared[0] = True
            with self.assertRaises(h.Unsafe):
                h.discover(cfg)
            shared[0] = False
            join[0] = True
            with self.assertRaises(h.Unsafe):
                h.discover(cfg)

    def test_protected_permissions(self):
        import stat
        from types import SimpleNamespace
        for uid, mode in ((1000, stat.S_IFREG | 0o600), (0, stat.S_IFREG | 0o644), (0, stat.S_IFLNK | 0o600)):
            with patch.object(h.os, 'lstat', return_value=SimpleNamespace(st_uid=uid, st_mode=mode)):
                with self.assertRaises(h.Unsafe):
                    h.protected('/mock')


if __name__ == '__main__':
    unittest.main()
