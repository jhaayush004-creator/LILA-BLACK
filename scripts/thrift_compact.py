"""
Minimal generic Thrift Compact Protocol reader.
Parses any compact-protocol-encoded struct into a nested Python dict:
    {field_id: value, ...}
Lists/sets become Python lists. Nested structs become nested dicts.
This is schema-agnostic: it just walks the byte stream using the type
tags embedded in the compact protocol, which is enough to inspect
(and eventually fully decode) a Parquet file footer without any
third-party dependency (no thrift, no pyarrow).
"""

# Compact protocol type ids
CT_BOOLEAN_TRUE = 1
CT_BOOLEAN_FALSE = 2
CT_BYTE = 3
CT_I16 = 4
CT_I32 = 5
CT_I64 = 6
CT_DOUBLE = 7
CT_BINARY = 8
CT_LIST = 9
CT_SET = 10
CT_MAP = 11
CT_STRUCT = 12


class Reader:
    __slots__ = ("buf", "pos")

    def __init__(self, buf, pos=0):
        self.buf = buf
        self.pos = pos

    def read_byte(self):
        b = self.buf[self.pos]
        self.pos += 1
        return b

    def read_bytes(self, n):
        b = self.buf[self.pos:self.pos + n]
        self.pos += n
        return b

    def read_varint(self):
        result = 0
        shift = 0
        while True:
            b = self.read_byte()
            result |= (b & 0x7F) << shift
            if not (b & 0x80):
                break
            shift += 7
        return result

    def read_zigzag(self):
        n = self.read_varint()
        return (n >> 1) ^ -(n & 1)

    def read_double(self):
        import struct
        b = self.read_bytes(8)
        return struct.unpack("<d", b)[0]

    def read_binary(self):
        length = self.read_varint()
        return bytes(self.read_bytes(length))

    def read_list_header(self):
        b = self.read_byte()
        size = (b >> 4) & 0x0F
        etype = b & 0x0F
        if size == 15:
            size = self.read_varint()
        return size, etype

    def read_value(self, ttype):
        if ttype == CT_BOOLEAN_TRUE:
            return True
        if ttype == CT_BOOLEAN_FALSE:
            return False
        if ttype == CT_BYTE:
            b = self.read_byte()
            return b - 256 if b > 127 else b
        if ttype in (CT_I16, CT_I32, CT_I64):
            return self.read_zigzag()
        if ttype == CT_DOUBLE:
            return self.read_double()
        if ttype == CT_BINARY:
            return self.read_binary()
        if ttype == CT_LIST or ttype == CT_SET:
            size, etype = self.read_list_header()
            out = []
            # booleans in collections are stored as separate full-byte values
            for _ in range(size):
                out.append(self.read_value(etype))
            return out
        if ttype == CT_MAP:
            size = self.read_varint()
            out = []
            if size == 0:
                return out
            kv_types = self.read_byte()
            ktype = (kv_types >> 4) & 0x0F
            vtype = kv_types & 0x0F
            for _ in range(size):
                k = self.read_value(ktype)
                v = self.read_value(vtype)
                out.append((k, v))
            return out
        if ttype == CT_STRUCT:
            return self.read_struct()
        raise ValueError(f"Unknown compact type {ttype} at pos {self.pos}")

    def read_struct(self):
        fields = {}
        last_fid = 0
        while True:
            b = self.read_byte()
            if b == 0:
                break
            delta = (b >> 4) & 0x0F
            ttype = b & 0x0F
            if ttype in (CT_BOOLEAN_TRUE, CT_BOOLEAN_FALSE):
                # bool value is encoded in the type nibble itself for struct fields
                pass
            if delta == 0:
                fid = self.read_zigzag()
            else:
                fid = last_fid + delta
            last_fid = fid
            val = self.read_value(ttype)
            # keep repeats as list
            if fid in fields:
                if isinstance(fields[fid], list) and fields.get(("__multi__", fid)):
                    fields[fid].append(val)
                else:
                    fields[fid] = [fields[fid], val]
                    fields[("__multi__", fid)] = True
            else:
                fields[fid] = val
        # strip helper markers
        return {k: v for k, v in fields.items() if not (isinstance(k, tuple))}


def parse_struct(buf, pos=0):
    r = Reader(buf, pos)
    return r.read_struct(), r.pos
