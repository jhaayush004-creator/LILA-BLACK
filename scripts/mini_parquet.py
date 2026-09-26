"""
A minimal, dependency-free Parquet reader built specifically for the
LILA BLACK player-event dataset:
  - written by parquet-go
  - UNCOMPRESSED
  - flat schema (no nested/repeated fields)
  - all columns REQUIRED (no nulls -> no definition/repetition levels)
  - low-cardinality string columns (user_id, match_id, map_id) are
    dictionary-encoded; numeric + event columns are PLAIN-encoded.

This intentionally does NOT try to be a general Parquet reader -- it
covers exactly the encodings/physical types actually present in this
dataset (verified against the file footers), which keeps it small and
fast with zero third-party dependencies (no pyarrow/network needed).
"""
import struct
from thrift_compact import parse_struct, Reader as TReader


def snappy_decompress(data):
    """Pure-python decoder for the raw ('block') Snappy format used inside
    Parquet pages (NOT the framed streaming format)."""
    r = TReader(data, 0)
    uncompressed_len = r.read_varint()
    pos = r.pos
    out = bytearray()
    n = len(data)
    while pos < n and len(out) < uncompressed_len:
        tag = data[pos]
        pos += 1
        tagtype = tag & 0x3
        if tagtype == 0:  # literal
            length_field = tag >> 2
            if length_field <= 59:
                lit_len = length_field + 1
            else:
                nbytes = length_field - 59
                lit_len = int.from_bytes(data[pos:pos + nbytes], "little") + 1
                pos += nbytes
            out.extend(data[pos:pos + lit_len])
            pos += lit_len
        elif tagtype == 1:  # copy, 1-byte offset
            length = ((tag >> 2) & 0x7) + 4
            offset = ((tag & 0xE0) << 3) | data[pos]
            pos += 1
            start = len(out) - offset
            for i in range(length):
                out.append(out[start + i])
        elif tagtype == 2:  # copy, 2-byte offset
            length = (tag >> 2) + 1
            offset = int.from_bytes(data[pos:pos + 2], "little")
            pos += 2
            start = len(out) - offset
            for i in range(length):
                out.append(out[start + i])
        else:  # tagtype == 3, copy, 4-byte offset
            length = (tag >> 2) + 1
            offset = int.from_bytes(data[pos:pos + 4], "little")
            pos += 4
            start = len(out) - offset
            for i in range(length):
                out.append(out[start + i])
    return bytes(out)

PARQUET_TYPE_BOOLEAN = 0
PARQUET_TYPE_INT32 = 1
PARQUET_TYPE_INT64 = 2
PARQUET_TYPE_INT96 = 3
PARQUET_TYPE_FLOAT = 4
PARQUET_TYPE_DOUBLE = 5
PARQUET_TYPE_BYTE_ARRAY = 6
PARQUET_TYPE_FIXED_LEN_BYTE_ARRAY = 7

ENC_PLAIN = 0
ENC_PLAIN_DICTIONARY = 2
ENC_RLE = 3
ENC_RLE_DICTIONARY = 8

PAGE_DATA_PAGE = 0
PAGE_INDEX_PAGE = 1
PAGE_DICTIONARY_PAGE = 2
PAGE_DATA_PAGE_V2 = 3


def read_rle_bitpacked_hybrid(buf, pos, bit_width, num_values):
    """Decode a (length-prefix-less) RLE/bit-packing hybrid stream.
    Reads until num_values decoded or buffer exhausted. Returns (values, new_pos).
    """
    values = []
    n = len(buf)
    byte_width = (bit_width + 7) // 8
    while len(values) < num_values and pos < n:
        r = TReader(buf, pos)
        header = r.read_varint()
        pos = r.pos
        if header & 1 == 0:
            # RLE run
            run_len = header >> 1
            if byte_width == 0:
                val = 0
                pos_after = pos
            else:
                raw = buf[pos:pos + byte_width]
                val = int.from_bytes(raw, "little")
                pos_after = pos + byte_width
            pos = pos_after
            values.extend([val] * run_len)
        else:
            # bit-packed run
            num_groups = header >> 1
            count = num_groups * 8
            total_bits = count * bit_width
            total_bytes = (total_bits + 7) // 8
            packed = buf[pos:pos + total_bytes]
            pos += total_bytes
            # unpack bit_width-bit values, LSB-first packing
            bitbuf = 0
            bitcnt = 0
            idx = 0
            out = []
            for byte in packed:
                bitbuf |= byte << bitcnt
                bitcnt += 8
                while bitcnt >= bit_width and len(out) < count:
                    out.append(bitbuf & ((1 << bit_width) - 1))
                    bitbuf >>= bit_width
                    bitcnt -= bit_width
            values.extend(out)
    return values[:num_values], pos


def decode_plain(buf, pos, ptype, num_values, type_length=None):
    out = []
    if ptype == PARQUET_TYPE_FLOAT:
        for _ in range(num_values):
            out.append(struct.unpack_from("<f", buf, pos)[0])
            pos += 4
    elif ptype == PARQUET_TYPE_DOUBLE:
        for _ in range(num_values):
            out.append(struct.unpack_from("<d", buf, pos)[0])
            pos += 8
    elif ptype == PARQUET_TYPE_INT32:
        for _ in range(num_values):
            out.append(struct.unpack_from("<i", buf, pos)[0])
            pos += 4
    elif ptype == PARQUET_TYPE_INT64:
        for _ in range(num_values):
            out.append(struct.unpack_from("<q", buf, pos)[0])
            pos += 8
    elif ptype == PARQUET_TYPE_BOOLEAN:
        # bit-packed LSB first
        bit = 0
        cur = 0
        for i in range(num_values):
            if bit == 0:
                cur = buf[pos]
                pos += 1
            out.append(bool((cur >> bit) & 1))
            bit = (bit + 1) % 8
    elif ptype == PARQUET_TYPE_BYTE_ARRAY:
        for _ in range(num_values):
            ln = struct.unpack_from("<I", buf, pos)[0]
            pos += 4
            out.append(bytes(buf[pos:pos + ln]))
            pos += ln
    elif ptype == PARQUET_TYPE_FIXED_LEN_BYTE_ARRAY:
        for _ in range(num_values):
            out.append(bytes(buf[pos:pos + type_length]))
            pos += type_length
    else:
        raise ValueError(f"Unsupported physical type {ptype}")
    return out, pos


def read_page_header(buf, pos):
    hdr, newpos = parse_struct(buf, pos)
    return hdr, newpos


def read_column_chunk_values(buf, col_meta):
    """
    col_meta: dict decoded from ColumnMetaData (field ids as in parquet.thrift)
      1: type, 2: encodings, 4: codec(optional/absent->uncompressed),
      5: num_values, 9: data_page_offset, 11: dictionary_page_offset(optional)
    Returns list of decoded python values (already dictionary-resolved), in row order.
    """
    ptype = col_meta[1]
    total_num_values = col_meta[5]
    dict_offset = col_meta.get(11)
    data_offset = col_meta[9]
    codec = col_meta.get(4, 0)  # 0=UNCOMPRESSED, 1=SNAPPY (others unsupported here)

    dictionary = None
    pos = dict_offset if dict_offset is not None else data_offset

    values = []
    while len(values) < total_num_values:
        page_hdr, pos = read_page_header(buf, pos)
        page_type = page_hdr[1]
        uncompressed_size = page_hdr[2]
        compressed_size = page_hdr[3]
        page_data = buf[pos:pos + compressed_size]
        pos += compressed_size

        if codec == 1:  # SNAPPY
            page_data = snappy_decompress(page_data)
        elif codec == 0:
            pass
        else:
            raise ValueError(f"Unsupported codec {codec}")

        if page_type == PAGE_DICTIONARY_PAGE:
            dph = page_hdr[7]
            dnum = dph[1]
            dvals, _ = decode_plain(page_data, 0, ptype, dnum)
            dictionary = dvals
            continue

        if page_type == PAGE_DATA_PAGE:
            dp = page_hdr[5]
            num_values = dp[1]
            encoding = dp[2]
            # Since all columns in this dataset are REQUIRED (max def level 0)
            # there are no definition/repetition levels stored in the page.
            ppos = 0
            if encoding in (ENC_PLAIN_DICTIONARY, ENC_RLE_DICTIONARY):
                bit_width = page_data[ppos]
                ppos += 1
                idxs, ppos = read_rle_bitpacked_hybrid(
                    page_data, ppos, bit_width, num_values
                )
                values.extend(dictionary[i] for i in idxs)
            elif encoding == ENC_PLAIN:
                vals, ppos = decode_plain(page_data, ppos, ptype, num_values)
                values.extend(vals)
            else:
                raise ValueError(f"Unsupported data page encoding {encoding}")
            continue

        raise ValueError(f"Unsupported page type {page_type}")

    return values[:total_num_values]


def read_parquet_rows(path):
    """Read a LILA BLACK .nakama-0 parquet file and return a list of dict rows
    with columns: user_id, match_id, map_id, x, y, z, ts, event (decoded str)."""
    with open(path, "rb") as f:
        data = f.read()

    assert data[:4] == b"PAR1", f"bad magic in {path}"
    assert data[-4:] == b"PAR1", f"bad footer magic in {path}"
    footer_len = struct.unpack("<I", data[-8:-4])[0]
    footer = data[-8 - footer_len:-8]
    meta, _ = parse_struct(footer)

    schema = meta[2]
    # Build ordered column name list: skip the root element (no physical
    # `type`, field 1 -- only leaf columns have it).
    col_names = []
    for s in schema:
        if 1 in s:  # has a physical `type` -> it's a leaf column, not the root
            name = s[4]
            if isinstance(name, (bytes, bytearray)):
                name = name.decode("utf-8")
            col_names.append(name)

    row_groups = meta[4]
    columns_data = {name: [] for name in col_names}

    for rg in row_groups:
        chunks = rg[1]
        for chunk, name in zip(chunks, col_names):
            col_meta = chunk[3]
            vals = read_column_chunk_values(data, col_meta)
            columns_data[name].extend(vals)

    n = len(columns_data[col_names[0]])
    rows = []
    for i in range(n):
        row = {}
        for name in col_names:
            v = columns_data[name][i]
            row[name] = v
        # decode event bytes -> str, user_id/match_id/map_id bytes -> str
        for k in ("user_id", "match_id", "map_id", "event"):
            if isinstance(row.get(k), (bytes, bytearray)):
                row[k] = row[k].decode("utf-8")
        rows.append(row)
    return rows
