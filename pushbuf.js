/*
 * Buffer that can automatically grow like an Array, to capture variable-length output.
 *
 * Copyright (C) 2022,2023 Andras Radics
 * Licensed under the Apache License, Version 2.0
 */

'use strict';

var allocBuf = eval('parseFloat(process.versions.node) > 6 ? Buffer.allocUnsafe : Buffer');
var fromBuf = eval('parseFloat(process.versions.node) > 6 ? Buffer.from : Buffer');

var ieeeFloat = require('ieee-float');

module.exports = PushBuffer;

function PushBuffer( bytes ) {
    this.capacity = 0;
    this.buf = bytes;
    this.pos = 0;
    this.end = bytes ? bytes.length : 0;
}

// Note that varargs is much much slower (6x) if a named arg is also declared.
// a switch() jump table is not as fast as a for loop
// FIXME: time vs passing single argument and having separate push1, push2, push3, push5 functions
PushBuffer.prototype.push = function push(/* byte, byte, ... */) {
    var len = arguments.length, buf;
    this._growBuf(len);
    buf = this.buf;
    for (var i = 0; i < len; i++) buf[this.end++] = arguments[i] & 0xff;
}
PushBuffer.prototype.append = function push(/* byte, byte, ... */) {
    var len = arguments.length, buf = this.buf;
    for (var i = 0; i < len; i++) buf[this.end++] = arguments[i] & 0xff;
}
PushBuffer.prototype.poke = function(/* ,varargs */) {
    var end = arguments[0], buf = this.buf;
    for (var i = 1; i < arguments.length; i++) buf[end++] = arguments[i] & 0xff;
}
// FIXME: tricky to recover a signed 64-bit integer because cannot use >> to sign-extend
PushBuffer.prototype.shiftBE = function shiftBE( n ) {
    var val = 0, buf = this.buf;
    switch (n) {
    case 4: return buf[this.pos++] * 256 * 256 * 256 + (buf[this.pos++] << 16 | buf[this.pos++] << 8 | buf[this.pos++]);
    case 2: return buf[this.pos++] <<  8 | buf[this.pos++];
    case 1: return buf[this.pos++];
    default:
        for (var i=0; i<n; i++) { val = val * 256 + buf[this.pos++] }
        return val;
    }
}
PushBuffer.prototype.shiftLE = function shiftLE( n ) {
    var val = 0, buf = this.buf;
    switch (n) {
    case 4: return (buf[this.pos++] | buf[this.pos++] << 8 | buf[this.pos++] << 16) + buf[this.pos++] * 256 * 256 * 256;
    case 2: return buf[this.pos++] | buf[this.pos++] << 8;
    case 1: return buf[this.pos++];
    default:
        var scale = 1;
        for (var i=0; i<n; i++) { val += buf[this.pos++] * scale; scale *= 256 }
        return val;
    }
}

// little-endian variable-length integer FIXME: stored in a temp hack storage format
PushBuffer.prototype.pushVarint = function pushVarint( v ) {
    this._growBuf(10);
    var buf = this.buf;
    while (v >= 128) { buf[this.end++] = v & 0x7f; v /= 128 }
    buf[this.end++] = v | 0x80;
}
PushBuffer.prototype.shiftVarint = function shiftVarint( ) {
    var ch, v = 0, buf = this.buf, scale = 1;
    while ((ch = buf[this.pos++]) < 128) { v += scale * ch; scale *= 128 }
    v += scale * (ch & 0x7f);
    return v;
}

/*
 * push*() methods grow the buffer, write the data, and update the end
 * append*() methods write the data and update the end, use reserve() to grow
 */

PushBuffer.prototype.appendFloatBE = function appendFloatBE( v ) {
    ieeeFloat.writeFloatBE(this.buf, v, (this.end += 4) - 4);
}
PushBuffer.prototype.appendDoubleBE = function appendDoubleBE( v ) {
    ieeeFloat.writeDoubleBE(this.buf, v, (this.end += 8) - 8);
}
PushBuffer.prototype.pushDoubleBE = function pushDoubleBE( v ) {
    this._growBuf(8);
    ieeeFloat.writeDoubleBE(this.buf, v, (this.end += 8) - 8);
}
PushBuffer.prototype.shiftFloatBE = function shiftFloatBE( ) {
    return ieeeFloat.readFloatBE(this.buf, (this.pos += 4) - 4);
}
PushBuffer.prototype.shiftDoubleBE = function shiftDoubleBE( v ) {
    return ieeeFloat.readDoubleBE(this.buf, (this.pos += 8) - 8);
}

// Utf8 encoding and byteLength from q-utf8.
PushBuffer.prototype.pushString = function pushString(str, len) {
    if (!len) len = PushBuffer.guessByteLength(str);
    if (this.end + len > this.capacity) this._growBuf(len);
    if (len > 100) {
        this.end += this.buf.write(str, this.end, 'utf8');
    } else {
        // utf8 encoding extracted from q-utf8
        var buf = this.buf, ix = this.end;
        for (var len = str.length, i = 0; i < len; i++) {
            var code = str.charCodeAt(i);
            if (code <= 0x7F) {
                buf[ix++] = code;
            } else if (code <= 0x7FF) {
                buf[ix++] = 0xC0 | (code >> 6); buf[ix++] = 0x80 | code & 0x3f;
            } else if (code <= 0xD7FF || code >= 0xE000) {
                buf[ix++] = 0xE0 | (code >> 12) & 0x0f; buf[ix++] = 0x80 | (code >> 6) & 0x3f; buf[ix++] = 0x80 | code & 0x3f;
            } else /* (code >= 0xD800 && code <= 0xDFFF) */ {
                var code2 = str.charCodeAt(i + 1);
                if (i + 1 < len && code <= 0xDBFF && code2 >= 0xDC00 && code2 <= 0xDFFF) {
                    // valid leading,trailing surrogate pair containing a 20-bit code point
                    var codepoint = 0x10000 + ((code - 0xD800) << 10) + (code2 - 0xDC00);
                    buf[ix++] = 0xF0 | (codepoint >> 18) & 0x07;
                    buf[ix++] = 0x80 | (codepoint >> 12) & 0x3F;
                    buf[ix++] = 0x80 | (codepoint >>  6) & 0x3F;
                    buf[ix++] = 0x80 | (codepoint      ) & 0x3F;
                    i += 1;
                } else {
                    // lone leading surrogate or bare trailing surrogate are invalid, become \uFFFD
                    buf[ix++] = 0xEF; buf[ix++] = 0xBF; buf[ix++] = 0xBD;
                }
            }
        }
        this.end = ix;
    }
}

PushBuffer.prototype.shiftString = function shiftString( len ) {
    if (len > 100) {
        return this.buf.toString(undefined, this.pos, this.pos += len)
    } else {
        // return decodeUtf8(this.buf, this.pos, this.pos += len);
        // decode utf8 adapted from q-utf8 0.1.4
        var ch, ch2, ch3, ch4, str = "", code, buf = this.buf, base = this.pos, bound = this.pos += len;
        for (var i=base; i<bound; i++) {
            ch = buf[i];
            if (ch < 0x80) {
                str += String.fromCharCode(ch);
            } else if (ch < 0xC0) {
                str += '\uFFFD'; // invalid multi-byte start (continuation byte)
            } else if (ch < 0xE0) {
                ch2 = buf[i+1];
                str += (i+1 < bound && (ch2 & 0xC0) === 0x80)
                    ? (i += 1, String.fromCharCode(((ch & 0x1F) <<  6) + (ch2 & 0x3F))) : '\uFFFD';
            } else if (ch < 0xF0) {
                ch2 = buf[i+1], ch3 = buf[i+2];
                str += (i+2 < bound && (ch2 & 0xC0) === 0x80 && (ch3 & 0xC0) === 0x80)
                    ? (i += 2, String.fromCharCode(((ch & 0x0F) << 12) + ((ch2 & 0x3F) << 6) + (ch3 & 0x3F))) : '\uFFFD';
            } else if (ch < 0xF8) {
                ch2 = buf[i+1], ch3 = buf[i+2], ch4 = buf[i+3];
                var codepoint = ((ch & 0x07) << 18) + ((ch2 & 0x3f) << 12) + ((ch3 & 0x3f) << 6) + (ch4 & 0x3f);
                str += (i+3 < bound && (ch2 & 0xC0) === 0x80 && (ch3 & 0xC0) === 0x80 && (ch4 & 0xC0) === 0x80)
                    ? (i += 3, String.fromCharCode(0xD800 + ((codepoint - 0x10000) >> 10)) +
                               String.fromCharCode(0xDC00 + ((codepoint - 0x10000) & 0x3FF))) : '\uFFFD';
            }
            else {
                str += '\uFFFD'; // invalid multi-byte start character (5-, 6-byte utf8 not supported)
            }
        }
        return str;
    }
}
PushBuffer.guessByteLength = function guessByteLength(s) {
    var len = s.length;
    if (len > 100) return Buffer.byteLength(s);
    for (var i=0; i<s.length; i++) s.charCodeAt(i) > 0x7F ? len += 2 : 0;
    return len;
}
// string byte length
// valid surrogate pair encodes 2 chars into 4 bytes (two codes, D800-DBFF followed by DC00-DFFF)
// lone surrogate (not part of a valid pair) is encoded into 3 bytes as codepoint FFFD, handled by the (> 0x7FF) case
// TODO: back-port this version into q-utf8 -- but NOTE: this inlined version is 6% faster than q-utf8
// return qutf8.byteLength(s); 1.8m/s
PushBuffer.byteLength = function byteLength( s ) {
    var len = s.length;
    if (len > 100) return Buffer.byteLength(s);
    for (var code, code2, i = 0; i < s.length; i++) {
        if ((code = s.charCodeAt(i)) > 0x7F) len += 1 + +(code > 0x7FF);
        if (code >= 0xD800 && code < 0xDC00) {
            if ((code2 = s.charCodeAt(i + 1)) >= 0xDC00 && code2 <= 0xDFFF) { len += 0; i++ }
        }
    }
    return len;
}

PushBuffer.prototype.pushBytes = function pushBytes( bytes ) {
    var len = bytes.length;
    this._growBuf(len + 1);
    for (var buf = this.buf, base = this.end, i = 0; i < len; i++) buf[base + i] = bytes[i];
    this.end += i;
}
PushBuffer.prototype.shiftBytes = function shiftBytes( len ) {
    return this.buf.slice(this.pos, this.pos += len);
}

PushBuffer.prototype.slice = function slice(base, bound) {
    return this.buf.slice(base || 0, bound || this.end);
}

PushBuffer.prototype._growBuf = function _growBuf( n ) {
    if ((this.end + n) > this.capacity) {
        var oldbuf = this.buf;
        this.capacity = (2 * this.capacity + 256 + 1.00 * n) >>> 0;
        this.buf = allocBuf(this.capacity);
        if (oldbuf) for (var i = 0; i < oldbuf.length; i++) this.buf[i] = oldbuf[i];
    }
}
PushBuffer.prototype.reserve = PushBuffer.prototype._growBuf;


/** quicktest:

var qtimeit = require('qtimeit');

var x, buf = new PushBuffer();
buf.pushString("foobar");
console.log("AR: buf", buf);
buf.push(0, 1, 2, 3, 4, 5, 6, 7, 8, 9);
qtimeit(.05, function() { buf.push(99) }); // 370m/s pushes
var z = 0x12345678;
qtimeit(.02, function() { buf.pushString("foobar blurblexy") }); // 24m/s
//qtimeit(.05, function() { buf.push("foobar blurblexy"); x = buf.slice() }); // 28m/s
//qtimeit(.05, function() { x = PushBuffer.byteLength("foobar \u1234lurblexy") }); // 51m/s
qtimeit(.15, function() { buf.push(4, (z >> 24), (z >> 16), (z >> 8), z) }); // 90m/s pushes of 5 (w/o strings)
//qtimeit(.15, function() { buf._poke(-1, 4, (z >> 24), (z >> 16), (z >> 8), z) }); // 185m/s
qtimeit(.02, function() { buf.pushString("foobar \u1234lurblexy") }); // 24m/s (but sometimes 5m/s)
//qtimeit(.12, function() { buf.pushString("\u1234\u1234\u1234\u1234") }); // 38m/s
console.log("AR: buf", buf);
//for (var i=10; i<60; i++) buf.push(i);
//console.log("AR: buf", buf);

/**/
