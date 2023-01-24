/*
 * binary json encoding, for fast ipc
 *
 * Copyright (C) 2022,2023 Andras Radics
 * Licensed under the Apache License, Version 2.0
 *
 * 2021-12-28 - AR.
 * 2023-01-21 - support all length encodings, speed up, start decode
 */

/**
----------------------------------------------------------------
README.md
----------------------------------------------------------------

bxjson -- compact json-like binary serialization

`bxjson` is a binary serialization format very in scope and intent to JSON.

`bxjson` serializes arrays and objects using a variable-length encoding, the end of the data
can only be determined by traversing the contained elements.

----------------------------------------------------------------
**/

'use strict';

module.exports = {
    encode: encode,
    decode: decode,
}

var qibl = require('../qibl');
var ieeeFloat = require('ieee-float');
var PushBuffer = require('./pushbuf');

/**
// cf Msgpack, https://github.com/msgpack/msgpack/blob/master/spec.md
// cf ../qbson/dev/qxpack, which is way too complicated and counts are not obvious
// null, true, false, int, float, binary, array, object, <pad>

simplifed:
  // ---- immediate values -32..+31
  intC                  00sxxxxx
  // ---- up to 64 fixed-length types:
* null                  01000000
* false                 01000010
* true                  01000011
* int8                  01000100
* int16                 01000101
* int32                 01000110
* float64               01001111
  // ---- up to 32 length-counted types:
* str8, str32           100000xx
* blob8, blob32         100100xx
* array8, array32       101000xx
* object8, object32     101100xx
  // ---- 4 immediate-length types:
* strC                  1100xxxx
* blobC                 1101xxxx
* arrayC                1110xxxx
* objectC               1111xxxx

Transport format: a blob32 length-counted blob containing the encoded argument.
The stored length is the size of the payload; the blob is length + 5 bytes total.

**/

var TYPE_MASK   = 0xC0;

// immediate integers -32..31
var TYPE_IMMEDIATE = 0x00;
var MASK_IMMEDIATE = 0x3F;                      // 6 bits
var MASK_IMMEDIATEYTPE = ~MASK_IMMEDIATE & 0xff;
var IMMED_RANGE = (MASK_IMMEDIATE >> 1) + 1;    // -32 .. 31
var T_INTC      = 0x00 + 0;     // 00Sxxxxx

// fixed-length types (up to 64)
// note that the integer types are arranged so that length-16 and -32 are 1 and 2 more than length-8 (mask 0x03)
var TYPE_FIXLEN = 0x40;
var T_NULL      = 0x40;         // 01000000
var T_UNDEFINED = 0x41;
var T_FALSE     = 0x42;
var T_TRUE      = 0x43;
var T_INT8      = 0x44;         // 010001xx
var T_INT16     = 0x45;
var T_INT32     = 0x46;
var T_INT64     = 0x47;
var T_FLOAT32   = 0x4E;
var T_FLOAT64   = 0x4F;

// length-counted types (up to 16)
// note that the length-16 and -32 are always 1 and 2 more than length-8 (mask 0x03)
var TYPE_BYTELEN = 0x80;
var MASK_BYTELEN = 0x03;
var MASK_BYTETYPE = 0xFC;
var T_STR8      = 0x90;         // 100100xx
var T_STR16     = 0x90 + 1;
var T_STR32     = 0x90 + 2;
var T_BYTES8    = 0x94;         // 100101xx
var T_BYTES16   = 0x94 + 1;
var T_BYTES32   = 0x94 + 2;
var T_ARRAY8    = 0x98;         // 100110xx
var T_ARRAY16   = 0x98 + 1;
var T_ARRAY32   = 0x98 + 2;
var T_OBJECT8   = 0x9C;         // 100111xx
var T_OBJECT16  = 0x9C + 1;
var T_OBJECT32  = 0x9C + 2;

// immediate-length types (up to 4)
// FIXME: fix the type/mask naming! type_lengthC vs mask_length_type vs mask_length_length
var TYPE_IMMILEN = 0xC0;
var MASK_IMMILEN = 0x0F;
var MASK_IMMITYPE = 0xF0;
var T_STRC      = 0xC0 + 0;     // 1100xxxx
var T_BYTESC    = 0xD0 + 0;     // 1101xxxx
var T_ARRAYC    = 0xE0 + 0;     // 1110xxxx
var T_OBJECTC   = 0xF0 + 0;     // 1111xxxx


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
        case Array:     encodeArray(buf, item); break;
        case Date:      encodeItem(buf, item.toISOString()); break;
        case Buffer:    encodeBytes(buf, item); break;
        case Boolean: case Number: case String:
                        encodeItem(buf, item.valueOf()); break;
        default:        encodeObject(buf, item); break;
        }
        break;
    default: // bigint (exception), symbol (undef), function (undef)
        // hack: convert any unrecognized types to null (sort of like JSON in arrays;
        // JSON converts unknowns to undefined, which are omitted from objects)
        // buf.push(T_NULL); break;
        if (item === undefined) buf.push(T_UNDEFINED); break;
        buf.push(T_UNDEFINED); break;
    }
}

function decodeItem( buf ) {
    var type = buf.shift(1);
    switch (type & TYPE_MASK) {
    case TYPE_IMMEDIATE:
        return (type & MASK_IMMEDIATE) << 26 >> 26;
    case TYPE_FIXLEN:
        switch (type) {
        case T_NULL: return null;
        case T_UNDEFINED: return undefined;
        case T_FALSE: return false;
        case T_TRUE: return true;
        case T_INT8: case T_INT16: case T_INT32: case T_INT64:
        case T_FLOAT32: case T_FLOAT64:
            return decodeNumber(buf, type);
        }
/**/
    case TYPE_BYTELEN:
        var len = buf.shift(1 << (type & MASK_BYTELEN)); // 0..3 meaning 1, 2, 4 or 8
        switch (type & MASK_BYTETYPE) {
        case T_STR8: return decodeString(buf, len);
        case T_BYTES8: return decodeBytes(buf, len);
        case T_ARRAY8: return decodeArray(buf, len);
        case T_OBJECT8: return decodeObject(buf, len);
        }
    case TYPE_IMMILEN:
        var len = type & MASK_IMMILEN; // 0..15 embedded into the type code
        switch (type & MASK_IMMITYPE) {
        case T_STRC: return decodeString(buf, len);
        case T_BYTESC: return decodeBytes(buf, len);
        case T_ARRAYC: return decodeArray(buf, len);
        case T_OBJECTC: return decodeObject(buf, len);
        }
    }
}

// we arranged the type ids so that type16 and type32 can be computed from type8
function encodeLength( buf, len, typeC, type8 ) {
    if (len <= MASK_IMMILEN) buf.push(typeC + len);
    else if (len < 256) buf.push(type8, len);
    else if (len < 65536) buf.push(type8 + 1, len >> 8, len);
    else buf.push(type8 + 2, len >> 24, len >> 16, len >> 8, len);
}

function decodeLength( buf, type ) {
    if ((type & TYPE_MASK) === TYPE_IMMILEN) return type & MASK_IMMILEN;
    else return buf.shift(1 << (type & MASK_BYTELEN));
}

function encodeNumber( buf, item ) {
    if ((item | 0) !== item) {
        buf.push(T_FLOAT64);
        ieeeFloat.writeDoubleBE(buf.buf, item, buf.end);
        buf.end += 8;
    }
    else if (item >= -IMMED_RANGE && item < IMMED_RANGE) buf.push(T_INTC + (item & MASK_IMMEDIATE));
    else if (item >= -128 && item < 128) buf.push(T_INT8, item);
    else if (item >= -32768 && item < 32768) buf.push(T_INT16, item >> 8, item);
    else buf.push(T_INT32, item >> 24, item >> 16, item >> 8, item);
}

function decodeNumber( buf, type ) {
    // immediates are handled in decodeItem
    if (type === T_FLOAT64) return ieeeFloat.readDoubleBE(buf.buf, (buf.pos += 8) - 8);
    else if (type === T_FLOAT32) return ieeeFloat.readFloatBE(buf.buf, (buf.pos += 4) - 4);
    else switch (type & MASK_BYTELEN) {
    case 0: return buf.shift(1) << 24 >> 24; break;
    case 1: return buf.shift(2) << 16 >> 16; break;
    case 2: return buf.shift(4) >> 0;
    case 3: throw new Error('int64 not supported');
    }
}

function encodeString( buf, item ) {
    var len = PushBuffer.byteLength(item);
    encodeLength(buf, len, T_STRC, T_STR8);
    buf.pushString(item);
}

function decodeString( buf, len ) {
    return buf.shiftString(len);
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
        // Object.keys runs slow on older node
        var keys = Object.keys(item), len = keys.length;
        for (var i = 0; i < keys.length; i++) if (keys[i] === undefined) len -= 1;
        encodeLength(buf, len, T_OBJECTC, T_OBJECT8);
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            encodeItem(buf, key);
            encodeItem(buf, item[key]);
        }
    }
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
    var mark = buf.end, len = item.length;
    encodeLength(buf, len, T_BYTESC, T_BYTES8);
    buf.pushBytes(item);
}

function decodeBytes( buf, len ) {
    return buf.shiftBytes(len);
}

// /** quicktest:

var fromBuf = parseFloat(process.versions.node) > '7' ? Buffer.from : Buffer;

var assert = require('assert');
var utf8 = require('utf8');
var qutf8 = require('q-utf8');
var qutf8b = require('../qbson/lib/utf8-2');
var qibl = require('../qibl');
var timeit = require('qtimeit');
var qbson = require('../qbson');
var msgpackjs = require('msgpackjs') // but fix to return buffers
var msgpackjs_pack = msgpackjs.pack; msgpackjs.pack = function(v){ return fromBuf(msgpackjs_pack(v)) }

// var x = encode({aaa: [1,2,3], b: "ABC"});
// console.log("AR: got", x);

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
var data = {a: 1.5, b: "foo", c: [1,2e5,3e10], d: true, e: {f: {}}, g: "barbarbarbarbarbarbarbarbarbar"};
var data = require('../ell/test/logline.json');
// var data = qibl.populate({}, data , { keys: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] });

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
    timeit(100000, function() { x = utf8.encode(s) });
    timeit(100000, function() { x = qutf8.encode(s, 0, slen, [], 0) });
    timeit(100000, function() { x = qutf8b.write([], 0, s, 0, slen, false) });
console.log("AR:", x);
}

    timeit(100000, function() { x1 = encode(data)         });
    timeit(100000, function() { x2 = qbson.encode(data)   });
    timeit(100000, function() { x3 = msgpackjs.pack(data) });
    timeit(100000, function() { x4 = JSON.stringify(data) });
console.log("AR: encoded", x1.length, x2.length, x3.length, x4.length);

    timeit(100000, function() { x = decode(x1)           });
    timeit(100000, function() { x = qbson.decode(x2)     });
    timeit(100000, function() { x = msgpackjs.unpack(x3) });
    timeit(100000, function() { x = JSON.parse(x4)       });
console.log("AR: decoded");
}

assert.deepEqual(qibl.toArray(encode(123)), [T_INT8, 123]);
assert.deepEqual(qibl.toArray(encode(-123)), [T_INT8, -123 & 0xff]);
// assert.deepEqual(qibl.toArray(encode([1,2,3])), [T_ARRAYC + 3, T_INT8, 1, T_INT8, 2, T_INT8, 3]);
assert.deepEqual(qibl.toArray(encode([1,-2,3])), [T_ARRAYC + 3, T_INTC + 1, T_INTC + 0x3e, T_INTC + 3]);

//
// 2023-01-21: 55% faster and 25% smaller than JSON.stringify (node-v13.8.0)
//

/**/
