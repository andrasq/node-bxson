var assert = require('assert');
var PushBuffer = require('./pushbuf');

var fromBuf = parseInt(process.versions.node) >= 7 ? Buffer.from : Buffer;
var allocBuf = parseInt(process.versions.node) >= 7 ? Buffer.alloc : Buffer;

describe('pushbuf', function() {
    var buf;
    beforeEach(function(done) {
        buf = new PushBuffer();
        done();
    })
    describe('encode', function() {
        describe('strings', function() {
            it('uses length hint', function() {
                buf.pushString('ABC', 1000);
                assert.ok(buf.buf.length >= 1000);
            })
            it('allows long strings', function() {
                var s = ''; for (var i=0; i<200; i++) s += 'x';
                buf.pushString(s);
                assert.equal(buf.shiftString(buf.end), s);
            })
        })
    })
    describe('encode and decode', function() {
        it('integers', function() {
            var buf = new PushBuffer();
            buf.push(1), buf.push(101), buf.push(0x27, 0x11);
            assert.deepEqual([buf.shiftBE(1), buf.shiftBE(1), buf.shiftBE(2)], [1, 101, 10001]);
            buf.pos = 0;
            assert.deepEqual([buf.shiftLE(1), buf.shiftLE(1), buf.shiftLE(2)], [1, 101, 4391]);
        })
        it('floats', function() {
            var buf = new PushBuffer();
            buf.reserve(10);
            buf.writeDoubleBE(1.5), buf.writeDoubleBE(1.5e10), buf.writeDoubleBE(1.5e100);
            assert.deepEqual([buf.shiftDoubleBE(), buf.shiftDoubleBE(), buf.shiftDoubleBE()], [1.5, 1.5e10, 1.5e100]);
            buf.end = buf.pos = 0;
            buf.writeDoubleBE(Infinity), buf.writeDoubleBE(-Infinity);
            assert.deepEqual([buf.shiftDoubleBE(), buf.shiftDoubleBE()], [Infinity, -Infinity]);
        })
        it('strings', function() {
            var buffer = allocBuf(20);
            buf.reserve(20);
            function testCode(code, code2) {
                var s = 'A' + String.fromCharCode(code) + 'B';
                if (code2 !== undefined) s = 'A' + String.fromCharCode(code) + String.fromCharCode(code2) + 'B';
                buf.pos = buf.end = 0;
                buf.pushString(s);
                var slen = buffer.write(s);
                assert.deepEqual(buf.buf.slice(0, buf.end), buffer.slice(0, slen), 'buf mismatch code ' + code);
                assert.equal(buf.shiftString(buf.end), buffer.toString('utf8', 0, slen), 'str mismatch code ' + code + ' ' + code2);
            }
            for (var code=0; code<0x10000; code++) testCode(code);
            for (var code1 = 0; code1 <= 0x3ff; code1 += 5) {
                for (var code2 = 0; code2 <= 0x3ff; code2 += 7) {
                    // valid codepoint is formed by a surrogate pair d800-dbff and dc00-dfff
                    testCode(0xd800 + code1, 0xdc00 + code2);
                }
            }
            // FIXME: also test invalid codepoints
            // FIXME: spot-check long strings longer than 100 chars
        })
    })
})
