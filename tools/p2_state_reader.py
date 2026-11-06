"""Bounded, read-only Lua field lookup and validated connection state recovery."""
import struct


def u64(data, offset=0):
    return struct.unpack_from('<Q', data, offset)[0]


def u32(data, offset=0):
    return struct.unpack_from('<I', data, offset)[0]


class StateReadError(RuntimeError):
    def __init__(self, code, message, **details):
        super().__init__(message)
        self.code = code
        self.details = details


def require(condition, stage):
    if not condition:
        raise StateReadError('structure-mismatch', '连接结构校验未通过：' + stage, stage=stage)


def is_nil(value):
    # A deleted Lua hash entry can retain a nonzero payload. Its tag, not its
    # old pointer, determines whether it is safe to follow.
    return value is None or value[1] == 0


class StateReader:
    def __init__(self, read, base, profile):
        self.read, self.base, self.profile = read, base, profile
        self.seed = 0
        self.context = {}

    def lookup(self, table, key):
        read = self.read
        encoded = key.encode('utf-8')
        h = read(table, 40, 'Table header for exact key ' + key)
        require(h[8] in (5, 12), 'table type for ' + key)
        if h[8] == 12:
            h = read(u64(h, 32), 40, 'Custom instance dictionary for exact key ' + key)
            require(h[8] == 26, 'instance dictionary type for ' + key)
            lg, nodes = h[20], u64(h, 24)
        else:
            lg, nodes = h[17], u64(h, 32)
        require(lg <= 24, 'hash size for ' + key)
        count, hs = 1 << lg, self.seed ^ len(encoded)
        for c in encoded[::-1]:
            hs = (hs ^ (((hs << 5) + (hs >> 2) + c) & 0xffffffff)) & 0xffffffff
        index, seen = hs & (count - 1), set()
        for _ in range(64):
            require(0 <= index < count and index not in seen, 'hash chain for ' + key)
            seen.add(index)
            node = read(nodes + 24 * index, 24, 'Exact ' + key + ' hashchain node')
            if node[9] == 0x44:
                sp = u64(node, 16)
                st = read(sp, 32, 'Exact ' + key + ' candidate string header')
                if (st[8] == 4 and st[17] == len(encoded)
                        and read(sp + 32, len(encoded), 'Exact ' + key + ' string equality') == encoded):
                    return u64(node), node[8]
            delta = struct.unpack_from('<i', node, 12)[0]
            if not delta:
                return None
            index += delta
        raise StateReadError('structure-mismatch', 'Exact hashchain bound reached', field=key)

    def short_string(self, value, limit, purpose):
        if is_nil(value) or value[1] != 0x44:
            return None
        h = self.read(value[0], 32, purpose + ' string header')
        require(h[8] == 4 and 0 < h[17] <= limit, purpose + ' string length')
        return self.read(value[0] + 32, h[17], purpose + ' value').decode('ascii')

    def recover(self, check_connection=False):
        read, base, offsets = self.read, self.base, self.profile['stateOffsets']
        result = self.context
        for guard in self.profile.get('codeGuards', []):
            expected = bytes.fromhex(guard['bytes'])
            require(read(base + int(guard['rva'], 16), len(expected),
                         'Exact build code guard ' + guard['purpose']) == expected,
                    'build code: ' + guard['purpose'])
        root = read(base + int(offsets['luaRootRva'], 16), 16,
                    'Module-relative main Lua runtime root; state pointer offset8')
        state = read(u64(root, 8), 64, 'Known Lua state header, global_State offset0x20')
        g = read(u64(state, 32), 112, 'Known global_State registry TValue and string seed')
        self.seed = u32(g, 96)
        registry = u64(g, 64)
        require(g[72] == 0x45, 'registry type')
        h = read(registry, 40, 'Registry header for global integer2')
        require(h[8] == 5 and u32(h, 20) >= 2, 'registry globals array')
        gv = read(u64(h, 24) + 16, 16, 'Registry globals integer2 TValue')
        require(gv[8] == 0x45, 'globals type')
        game = self.lookup(u64(gv), 'G')
        if is_nil(game):
            loaded = self.lookup(registry, '_LOADED')
            require(not is_nil(loaded) and loaded[1] == 0x45, 'loaded modules type')
            game = self.lookup(loaded[0], 'hexm.client.G')
        require(not is_nil(game) and game[1] == 0x45, 'G type')
        net = self.lookup(game[0], 'net')
        require(not is_nil(net) and net[1] in (0x45, 0x4c), 'G.net type')
        protocol = self.short_string(self.lookup(net[0], 'cur_protocol'), 16,
                                     'Exact current transport protocol')
        if protocol in ('TCP', 'KCP'):
            result['transportProtocol'] = protocol
        asio = self.lookup(net[0], '_asio_gate_client')
        if is_nil(asio):
            raise StateReadError('connection-not-ready',
                                 '角色连接尚未建立；请进入角色，正在切换或重连时会自动等待',
                                 field='G.net._asio_gate_client', actualTag=None if asio is None else asio[1])
        require(asio[1] == 0x4c, 'G.net._asio_gate_client type (tag=' + hex(asio[1]) + ')')
        native_type = 19
        if 'rpcHandlerType' in self.profile:
            rule = self.profile['rpcHandlerType']
            native_type = rule['expected']
            rva = int(rule['registeredRva'], 16)
            require(4096 <= rva <= 0xffffffff, 'registered rpc_handler RVA')
            registered = struct.unpack('<H', read(base + rva, 2, 'Registered rpc_handler type'))[0]
            require(registered == native_type, 'Registered rpc_handler type mismatch')
        require(type(native_type) is int and 0 < native_type < 65536, 'profile rpc_handler type')
        obj = read(asio[0], 80, 'Asio engineobject rpc_handler type' + str(native_type) + ' and native pointer')
        require(obj[8] == 12 and u64(obj, 48) >= 16
                and struct.unpack_from('<H', obj, 64)[0] == native_type,
                'rpc_handler type' + str(native_type))
        require(protocol in (None, 'TCP', 'KCP'), 'unsupported transport protocol')
        if protocol == 'KCP':
            import ipaddress
            ip = self.short_string(self.lookup(asio[0], 'ip'), 64, 'Exact current KCP remote IP')
            port = self.lookup(asio[0], 'port')
            require(ip and not is_nil(port) and port[1] == 3 and 0 < port[0] < 65536,
                    'KCP remote endpoint')
            require(ipaddress.ip_address(ip).version == 4, 'KCP IPv4 endpoint')
            result['remoteEndpoint'] = {'address': ip, 'port': port[0]}
        if check_connection:
            result['status'] = 'connection-ready'
            return result
        handler = read(u64(obj, 72), 32, 'rpc_handler implementation pointer at+8')
        impl = read(u64(handler, 8), 144, 'Native connection implementation, transform at+0x50')
        trans = read(u64(impl, 80), 48, 'Connection cipher transform, inbound wrapper at+0x10')
        wrapper = read(u64(trans, 16), 16, 'Inbound cipher wrapper vtable and object pointer')
        require(u64(wrapper) == base + int(offsets['wrapperVtableRva'], 16), 'inbound wrapper vtable')
        cipher = read(u64(wrapper, 8), 1040, 'Exact inbound RC4 object snapshot for current captured stream alignment')
        require(u64(cipher) == base + int(offsets['rc4VtableRva'], 16), 'cipher vtable')
        require(sorted(u32(cipher, 16 + 4 * i) for i in range(256)) == list(range(256)), 'cipher permutation')
        result.update(status='snapshot-ready', expectedVtable=hex(base + int(offsets['rc4VtableRva'], 16)))
        return result
