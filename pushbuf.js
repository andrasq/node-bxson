/*
 * Buffer that can automatically grow like an Array, to capture variable-length output.
 *
 * Copyright (C) 2022,2023 Andras Radics
 * Licensed under the Apache License, Version 2.0
 */

'use strict';

var allocBuf = eval('parseFloat(process.versions.node) > 6 ? Buffer.allocUnsafe : Buffer');
var fromBuf = eval('parseFloat(process.versions.node) > 6 ? Buffer.from : Buffer');

module.exports = PushBuffer;

// var xutf8 = require('utf8'); // generates wrong code for 'abc\u1234'
var qutf8 = require('../q-utf8/utf8');

/*
 * Automatically growing buffers, like arrays.  Utf8 encoding and byteLength from q-utf8.
 * Note that varargs is much much slower (6x) if a named arg is also declared.
 */
function PushBuffer( bytes ) {
    this.capacity = 0;
    this.buf = bytes || null;
    this.end = bytes ? bytes.length : 0;
    this.pos = 0;
    this._allocBuf = allocBuf;
}
PushBuffer.prototype.push = function push(/* byte, byte, ... */) {
    this._growBuf(arguments.length);
    var si = 0, buf = this.buf;
    switch (arguments.length) {
    case 5: buf[this.end++] = arguments[si++] & 0xff;
    case 4: buf[this.end++] = arguments[si++] & 0xff;
    case 3: buf[this.end++] = arguments[si++] & 0xff;
    case 2: buf[this.end++] = arguments[si++] & 0xff;
    case 1: buf[this.end++] = arguments[si++] & 0xff;
        break;
    default:
        for (var i = 0; i < arguments.length; i++) buf[this.end++] = arguments[i] & 0xff;
        break;
    }
}
// FIXME: use n = (n * 256) + buf[this.pos++] for integers > 32 bits
// FIXME: tricky to recover a signed 64-bit integer because cannot use >> to sign-extend
PushBuffer.prototype.shift = function shift( n ) {
    var val = 0, buf = this.buf;
    switch (n) {
    default: throw new Error('cannot shift ' + n);
    case 4: val = (val << 8) | buf[this.pos++];
    case 3: val = (val << 8) | buf[this.pos++];
    case 2: val = (val << 8) | buf[this.pos++];
    case 1: val = (val << 8) | buf[this.pos++];
    }
    return val;
}
PushBuffer.prototype.pushString = function pushString(str) {
    if (this.end + 3 * str.length > this.capacity) this._growBuf(PushBuffer.byteLength(str));
    if (str.length <= 100 || !Buffer.isBuffer(this.buf)) {
        // utf8 encoding extracted from q-utf8
        var buf = this.buf, ix = this.end;
        for (var len = str.length, i = 0; i < len; i++) {
            var code = str.charCodeAt(i);
            if (code <= 0x7F) {
                buf[ix++] = code;
            } else if (code <= 0x7FF) {
                buf[ix++] = 0xC0 | (code >> 6); buf[ix++] = 0x80 | code & 0x3f;
            } else if (code <= 0xD7FF || code >= 0xC000) {
                buf[ix++] = 0xE0 | (code >> 12) & 0x0f; buf[ix++] = 0x80 | (code >> 6) & 0x3f; buf[ix++] = 0x80 | code & 0x3f;
            } else if (code >= 0xD800 && code <= 0xDFFF) {
                var code2 = string.charCodeAt(i + 1);
                if (i + 1 < len && code <= 0xDBFF && code2 >= 0xDC00 && code2 <= 0xDFFF) {
                    // valid leading,trailing surrogate pair containing a 20-bit code point
                    var codepoint = 0x10000 + ((code - 0xD800) << 10) + (code2 - 0xDC00);
                    buf[ix++] = 0xF0 | (codepoint >> 18) & 0x07;
                    buf[ix++] = 0x80 | (codepoint >> 12) & 0x3F;
                    buf[ix++] = 0x80 | (codepoint >>  6) & 0x3F;
                    buf[ix++] = 0x80 | (codepoint      ) & 0x3F;
                    i += 1;
                } else {
                    // lone leading surrogate or bare trailing surrogate are invalid, become FFFD
                    buf[ix++] = 0xEF; buf[ix++] = 0xBF; buf[ix++] = 0xBD;
                }
            }
        }
        this.end = ix;
    }
    else {
        this.end += this.buf.write(str, this.end, 'utf8');
    }
}
PushBuffer.prototype.shiftString = function shiftString( len ) {
    return qutf8.decodeUtf8(this.buf, this.pos, this.pos += len);
}
PushBuffer.prototype.pushBlob = function pushBlob( bytes ) {
    var len = bytes.length;
    this._growBuf(len);
    for (var buf = this.buf, base = this.end, i = 0; i < len; i++) buf[base + i] = bytes[i];
    this.end += i;
console.log("AR: buf", buf);
}
PushBuffer.prototype.shiftBlob = function shiftBlob( len ) {
    return this.buf.slice(this.pos, this.pos += len);
}
PushBuffer.prototype.slice = function slice(base, bound) {
//    var buf = this._allocBuf(this.end);
//    for (var i=0; i<this.end; i++) buf[i] = this.buf[i];
//    return buf;
    return this.buf.slice(base || 0, bound || this.end);
}
// string byte length
// valid surrogate pair encodes 2 chars into 4 bytes (two codes, D800-DBFF followed by DC00-DFFF)
// lone surrogate (not part of a valid pair) is encoded into 3 bytes as codepoint FFFD, handled by the (> 0x7FF) case
// TODO: back-port this version into q-utf8 -- but NOTE: this inlined version is 6% faster than q-utf8
// return qutf8.byteLength(s); 1.8m/s
PushBuffer.byteLength = function byteLength(s) {
    var len = s.length;
    for (var code, code2, i = 0; i < s.length; i++) {
        if ((code = s.charCodeAt(i)) > 0x7F) len += 1 + +(code > 0x7FF);
        if (code >= 0xD800 && code < 0xDC00) {
            if ((code2 = s.charCodeAt(i + 1)) >= 0xDC00 && code2 <= 0xDFFF) { len += 1; i++ }
        }
    }
    return len;
}
PushBuffer.prototype._poke = function(/* ,varargs */) {
    var end = arguments[0], buf = this.buf;
    for (var i = 1; i < arguments.length; i++) buf[end++] = arguments[i] & 0xff;
}
PushBuffer.prototype._push = function(/* varargs */) {
    for (var i = 0; i < arguments.length; i++) this.buf[this.end++] = arguments[i] & 0xff;
}
PushBuffer.prototype._growBuf = function(n) {
    if ((this.end + n) > this.capacity) {
        var oldbuf = this.buf;
        this.capacity = (2 * this.capacity + 256 + 1.25 * n) >>> 0;
        this.buf = this._allocBuf(this.capacity);
        if (oldbuf) for (var i = 0; i < oldbuf.length; i++) this.buf[i] = oldbuf[i];
    }
}


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
