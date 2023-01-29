/*
 * binary json encoding, for fast ipc
 *
 * Copyright (C) 2022,2023 Andras Radics
 * Licensed under the Apache License, Version 2.0
 *
 * 2021-12-28 - AR.
 * 2023-01-21 - support all length encodings, speed up, start decode
 */

'use strict';

module.exports = {
    encode: encode,
    decode: decode,
}

var ieeeFloat = require('ieee-float');
var PushBuffer = require('./pushbuf');

/*
 * The typecodes are designed to simplify coding, and are divided into two categories:  fixed-length
 * types and variable-length types. Fixed-length types designate data whose extents are encoded in
 * the typecode.  Variable-length types are for data whose extents are stored separately as length
 * data.  As an optimization, the length of some variable-length data is packed into unused bits in
 * the typecode.  For transport, prefix the encoded bytes with a 4-byte length.
 *
 * Json types: null, true, false, number, string, array, object
 *
 * Fixed-length data:  null, undefined, true, false, number
 * Variable-length data:  string, rawbytes, array, object
 *
 * Loosely similar to msgpack, https://github.com/msgpack/msgpack/blob/master/spec.md
 */

var TYPE_MASK   = 0xC0;
var TYPE_SHIFT  = 6;

// 00: immediate integers -32..31
var TYPE_IMMEDIATETYPE = 0x00;
var MASK_IMMEDIATE = 0x3F;                      // 6 bits signed 2-s complement
var IMMED_RANGE = (MASK_IMMEDIATE >> 1) + 1;    // -32 .. 31
var T_INTC      = 0x00 + 0;     // 00xxxxxx     // 2-s complement signed 6-bit integer -32..31

// 01: fixed-length types (64 total)
// note that the integer types are arranged so that length-16 and -32 are 1 and 2 more than length-8 (mask 0x03)
var TYPE_FIXTYPE = 0x40;
var TYPE_FIXCODE = 0x3F;
var T_NULL      = 0x40;         // 01000000
var T_UNDEFINED = 0x41;         // 01000001
var T_FALSE     = 0x42;         // 01000010
var T_TRUE      = 0x43;         // 01000011 = T_FALSE | 1
var T_UINT8     = 0x44;         // 010001xx
var T_UINT16    = 0x44 + 1;
var T_UINT32    = 0x44 + 2;
var T_UINT64    = 0x44 + 3;
var T_NEGINT8   = 0x48;         // 010010xx
var T_NEGINT16  = 0x48 + 1;
var T_NEGINT32  = 0x48 + 2;
var T_NEGINT64  = 0x48 + 3;
var T_INTV      = 0x4C;         // 01001100 experimental positive variable-length int
var T_NEGINTV   = 0x4D;         // 01001101 experimental negative varint
var T_FLOAT32   = 0x4E;         // 01001110
var T_FLOAT64   = 0x4F;         // 01001111
// 48 other codes unassigned    // 01tttttt

// 10: indirectly specified length-counted types with length in the following bytes (16 total)
// note that the length-16 and -32 are always 1 and 2 more than length-8 (mask 0x03)
var TYPE_LENTYPE = 0x80;
var MASK_LENCODE = 0x03;
var T_STR8      = 0x80;         // 10<00>00xx
var T_STR16     = 0x80 + 1;
var T_STR32     = 0x80 + 2;
var T_BYTES8    = 0x90;         // 10<01>00xx
var T_BYTES16   = 0x90 + 1;
var T_BYTES32   = 0x90 + 2;
var T_ARRAY8    = 0xA0;         // 10<10>00xx
var T_ARRAY16   = 0xA0 + 1;
var T_ARRAY32   = 0xA0 + 2;
var T_OBJECT8   = 0xB0;         // 10<11>00xx
var T_OBJECT16  = 0xB0 + 1;
var T_OBJECT32  = 0xB0 + 2;
// 12 other codes unassigned    // 10<tttt>xx

// 11: directly specified "immediate-length" types (4 total)
// FIXME: fix the type/mask naming! type_lengthC vs mask_length_type vs mask_length_length
var MASK_SHORTLENTYPE = 0xF0;
var MASK_SHORTLEN = 0x0F;
// FIXME: no need for strC, unlikely to have short buffers
var T_STRC      = 0xC0 + 0;     // 11<00>xxxx
var T_BYTESC    = 0xD0 + 0;     // 11<01>xxxx
var T_ARRAYC    = 0xE0 + 0;     // 11<10>xxxx
var T_OBJECTC   = 0xF0 + 0;     // 11<11>xxxx


function encode( item ) {
    var buf = new PushBuffer();
    encodeItem(buf, item);
    return buf.slice();
}

function decode( bytes ) {
    var buf = new PushBuffer(bytes);
    return decodeItem(buf);
}

function encodeItem( buf, item ) {
    switch (typeof item) {
    case 'boolean':     buf.push(item ? T_TRUE : T_FALSE); break;
    case 'number':      encodeNumber(buf, item); break;
    case 'string':      encodeString(buf, item); break;
    case 'object':
        if (item === null) buf.push(T_NULL);
        else switch (item.constructor) {
        case Object:
            // it is faster to walk the keys twice than to call Object.keys
            var len = 0; for (var key in item) len += 1;
            encodeLength(buf, len, T_OBJECTC, T_OBJECT8);
            for (var key in item) encodeString(buf, key), encodeItem(buf, item[key]);
            break;
        case Array:     encodeArray(buf, item); break;
        case Date:      encodeString(buf, item.toISOString()); break;
        case Buffer:    encodeBytes(buf, item); break;
        case Boolean:
        case Number:
        case String:
                        encodeItem(buf, item.valueOf()); break;
        default:        item.toJSON ? encodeItem(buf, item.toJSON()) : encodeObject(buf, item); break;
        }
        break;
    default: // bigint (exception), symbol (undef), function (undef)
        // hack: convert any unrecognized types to null (sort of like JSON in arrays;
        // JSON converts unknowns to undefined, which are omitted from objects)
        // buf.push(T_NULL); break;
        // if (item === undefined) { buf.push(T_UNDEFINED); break; }
        buf.push(T_UNDEFINED); break;
    }
}

function decodeItem( buf ) {
    var type = buf.shiftBE(1);
    switch (type >>> 6) {
    case 0:     // 00 <xxxxxx>
        // inlined signed twos-complement integer
        return (type & 0x3F) << 26 >> 26;
    case 1:     // 01 00<tttt>, TYPE_FIXTYPE
        switch (type & 0x3f) {
        case 0: return null;
        case 1: return undefined;
        case 2: return false;
        case 3: return true;
        //case 4: return buf.shiftBE(1) << 24 >> 24;
        //case 5: return buf.shiftBE(2) << 16 >> 16;
        //case 6: return buf.shiftBE(4) >> 0;
        case 4: return buf.shiftBE(1);
        case 5: return buf.shiftBE(2);
        case 6: return buf.shiftBE(4);
        case 7: return buf.shiftBE(8);
        case 8: return -buf.shiftBE(1);
        case 9: return -buf.shiftBE(2);
        case 10: return -buf.shiftBE(4);
        case 11: return -buf.shiftBE(8);
        //case 12: return buf.shiftVarint();
        //case 13: return -buf.shiftVarint();
        case 14: return ieeeFloat.readFloatBE(buf.buf, (buf.pos += 4) - 4);
        case 15: return ieeeFloat.readDoubleBE(buf.buf, (buf.pos += 8) - 8);
        default:
            throw new Error(type + ': not supported');
        }
    case 2:     // 10 <tt>00<xx>, TYPE_LENTYPE
        var len = buf.shiftBE(1 << (type & 0x03)); // 0-3 meaning 1, 2, 4 or 8
        //var len = buf.shiftBE(1 << (type & 0x2)); // 0,2 meaning 1 or 4
        // fall through
    case 3:     // 11 <tt><xxxx>, TYPE_SHORTLENTYPE
        if (!len) len = type & 0xF; // length 0..15 in the type
        switch ((type & 0x30) >> 4) {
        case 0: return buf.shiftString(len);
        case 1: return buf.shiftBytes(len);
        case 2: return decodeArray(buf, len);
        case 3: return decodeObject(buf, len);
        }
    }
}

// type16 and type32 can be computed from type8 by adding 1 and 2
// faster to encode to immediate-length types than length-bytes types
function encodeLength( buf, len, typeC, type8 ) {
    if (len < 256) {
        (len <= MASK_SHORTLEN) ? buf.push(typeC + len) :
        buf.push(type8, len);
    } else {
        if (len < 65536) buf.push(type8 + 1, len >> 8, len);
        else buf.push(type8 + 2, len >> 24, len >> 16, len >> 8, len);
        // for little-endian lengths:
        //if (len < 65536) buf.push(type8 + 1, len, len >> 8);
        //else buf.push(type8 + 2, len, len >>= 8, len >>= 8, len >>= 8);
    }
}

// predefined-length ints are faster to encode and to decode that varints
function encodeNumber( buf, item ) {
    if ((item | 0) !== item || 1/item === -Infinity) {
        buf.push(T_FLOAT64);
        ieeeFloat.writeDoubleBE(buf.buf, item, buf.end);
        buf.end += 8;
    }
    else if (item >= -IMMED_RANGE && item < IMMED_RANGE) {
        // encode as an immediate twos-complement integer
        buf.push(T_INTC + item);
    }
    else {
        // encode sign and magnitude separately
        var msb, type8 = (item < 0) ? (item = -item, T_NEGINT8) : T_UINT8;
        if (item <= 0xffff) {
            ((item & 0xff00) === 0) ? buf.push(type8, item) : buf.push(type8 + 1, item >> 8, item);
        } else {
            var msb = item / 0x100000000;
            (msb === 0) ? buf.push(type8 + 2, item >> 24, item >> 16, item >> 8, item) :
            (buf.push(type8 + 3, msb >> 24, msb >> 16, msb >> 8, msb), buf.push(item >> 24, item >> 16, item >> item, item));
        }
/**
        if (item >= -128 && item < 128) {
            // (item >= -IMMED_RANGE && item < IMMED_RANGE) ? buf.push(T_INTC + item) :
            buf.push(T_INT8, item);
        } else {
            if (item >= -32768 && item < 32768) buf.push(T_INT16, item >> 8, item);
            else buf.push(T_INT32, item >> 24, item >> 16, item >> 8, item);
            //if (item >= -32768 && item < 32768) buf.push(T_INT16, item, item >> 8);
            //else buf.push(T_INT32, item, item >>= 8, item >>= 8, item >>= 8);
        }
**/
    }
}

function encodeString( buf, item ) {
    var len = PushBuffer.byteLength(item);
    encodeLength(buf, len, T_STRC, T_STR8);
    buf.pushString(item, len);
}

function encodeArray( buf, item ) {
    var len = item.length;
    encodeLength(buf, len, T_ARRAYC, T_ARRAY8);
    for (var i = 0; i < len; i++) {
        encodeItem(buf, item[i]);
    }
}

function decodeArray( buf, len ) {
    var arr = new Array(len);
    for (var i = 0; i < len; i++) arr[i] = decodeItem(buf);
    return arr;
}

function encodeObject( buf, item ) {
/**
    if (item.toJSON) { item = item.toJSON(); delete item.toJSON; return encodeItem(buf, item) }
    if (item.constructor === Object) {
        var len = 0;
        // it is faster to walk the keys twice than to call Object.keys
        // but not faster to encodeString() the key
        for (var key in item) len += 1;
        encodeLength(buf, len, T_OBJECTC, T_OBJECT8);
        for (var key in item) {
            encodeItem(buf, key), encodeItem(buf, item[key]);
        }
    }
    else {
**/
        // Object.keys runs slow on older node
        var keys = Object.keys(item), len = keys.length;
        encodeLength(buf, len, T_OBJECTC, T_OBJECT8);
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            encodeItem(buf, key);
            encodeItem(buf, item[key]);
        }
//    }
}

function decodeObject( buf, len ) {
    var obj = {};
    for (var i = 0; i < len; i++) {
        var key = decodeItem(buf);
        obj[key] = decodeItem(buf);
    }
    return obj;
}

function encodeBytes( buf, item ) {
    var len = item.length;
    encodeLength(buf, len, T_BYTESC, T_BYTES8);
    buf.pushBytes(item);
}


/** quicktest:

var fromBuf = parseFloat(process.versions.node) > '7' ? Buffer.from : Buffer;

var qibl = require('../qibl');
var utf8 = require('utf8');
var qutf8 = require('q-utf8');
var qutf8b = require('../qbson/lib/utf8-2');
var qibl = require('../qibl');
var timeit = require('qtimeit');
var qbson = require('../qbson');
var msgpackjs = require('msgpackjs') // but fix to return buffers
var msgpackjs_pack = msgpackjs.pack; msgpackjs.pack = function(v){ return fromBuf(msgpackjs_pack(v)) }

var x = encode({aaa: [1,2,3], b: "ABC"});
// console.log("AR: got", x);
console.log("AR: decoded to", x.length, decode(x));

var data = {a: 1.5, b: "foo", c: [1,2], d: true, e: {}};
//var data = {a: 1.5, b: "foo", c: [1,2], d: true, e: {}};
var data = {a: 1, bee: 2, ceeeeeeeeeeee: 3};
var data = 123;
var data = 1.5;
var data = true;
var data = [1,2];
var data = {a:1};
var data = "foobar";
var data = {a:1, b:2, c:3, d:4, e:5};
var data = {a: 1.5, b: "foo", c: [-1,2e5,3e10], d: true, e: {f: {}}, g: "barbarbarbarbarbarbarbarbarbar"};
var data = require('./logline.json');
//var data = qibl.populate({}, data , { keys: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] });
//var data = qibl.populate(new Array(100), data);

//console.log("AR: data", data);
var x = encode(data);
console.log("AR: encoded as", x);
//console.log("AR: decoded as", decode(x));
for (var i=0; i<3; i++) {
    var x1, x2, x3, x4;
    var s = qibl.str_repeat("foo", 100);
    var slen = s.length;
    var target = [];
if (0) {
    timeit(.15, function() { x = utf8.encode(s) });
    timeit(.15, function() { x = qutf8.encode(s, 0, slen, [], 0) });
    timeit(.15, function() { x = qutf8b.write([], 0, s, 0, slen, false) });
console.log("AR:", x);
}

    timeit(.15, function() { x1 = encode(data)         });
    timeit(.15, function() { x2 = qbson.encode(data)   });
    timeit(.15, function() { x3 = msgpackjs.pack(data) });
    timeit(.15, function() { x4 = JSON.stringify(data) });
console.log("AR: encoded", x1.length, x2.length, x3.length, x4.length);

    timeit(.15, function() { x = decode(x1)           });
    timeit(.15, function() { x = qbson.decode(x2)     });
    timeit(.15, function() { x = msgpackjs.unpack(x3) });
    timeit(.15, function() { x = JSON.parse(x4)       });
console.log("AR: decoded");
}

var assert = require('assert');
//assert.deepEqual(qibl.toArray(encode(123)), [T_UINT8, 123]);
//assert.deepEqual(qibl.toArray(encode(-123)), [T_NEGINT8, 123]);
//// assert.deepEqual(qibl.toArray(encode([1,2,3])), [T_ARRAYC + 3, T_UINT8, 1, T_UINT8, 2, T_UINT8, 3]);
//assert.deepEqual(qibl.toArray(encode([1,-2,3])), [T_ARRAYC + 3, T_UINTC + 1, T_INTC + 0x3e, T_UINTC + 3]);

//
// 2023-01-21: 55% faster and 25% smaller than JSON.stringify (node-v13.8.0)
//

/**/
