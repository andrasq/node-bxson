var assert = require('qassert');
var ieeeFloat = require('ieee-float');
var PushBuffer = require('./pushbuf');

var fromBuf = parseInt(process.versions.node) >= 7 ? Buffer.from : Buffer;
var allocBuf = parseInt(process.versions.node) >= 7 ? Buffer.alloc : Buffer;

describe('pushbuf', function() {
    var buf;
    beforeEach(function(done) {
        buf = new PushBuffer();
        done();
    })

    describe('constructor', function() {
        it('can create', function() {
            var buf = new PushBuffer();
            assert.equal(buf.end, 0);
            assert.equal(buf.pos, 0);
            assert.equal(buf.buf, null);
        })
        it('can create for existing', function() {
            var arr = [1, 2, 3];
            var buf = new PushBuffer(arr);
            assert.equal(buf.pos, 0);
            assert.equal(buf.end, arr.length);
            assert.equal(buf.buf, arr);
        })
        it('can reseve', function() {
            var buf = new PushBuffer();
            buf.reserve(10);
            assert.equal(typeof buf.buf, 'object');
            assert.ok(buf.buf.length >= 10 && buf.buf.length < 1000);
            buf.reserve(1000);
            assert.ok(buf.buf.length >= 1000);
        })
    })

    describe('encode', function() {
        it('push', function() {
            buf.push(1);
            buf.push(2, 3);
            assert.equal(buf.end, 3);
            assert.deepEqual(buf.slice(), fromBuf([1, 2, 3]));
        })
        it('append', function() {
            // append does not grow the buffer
            buf.reserve(10);
            buf.append(1);
            buf.append(2, 3);
            assert.equal(buf.end, 3);
            assert.deepEqual(buf.slice(), fromBuf([1, 2, 3]));
        })
        it('poke', function() {
            // poke does not grow the buffer
            buf.reserve(10);
            buf.poke(0, 0, 0, 0, 0);
            buf.poke(2, 2, 3);
            buf.poke(1, 1);
            assert.equal(buf.end, 0);
            assert.deepEqual(buf.slice(), fromBuf([]));
            assert.deepEqual(buf.slice(0, 4), fromBuf([0, 1, 2, 3]));
        })
        it('varint', function() {
            // varint is stored in little-endian order, each byte holding bits
            // 100.0000100.0000011.0000010.0000001.0100000.1100000
            buf.pushVarint(0x102030405060);
            assert.deepEqual(buf.slice(), fromBuf([0x60, 0x20, 1, 2, 3, 4, 4 + 0x80]));
        })
        it('float, double', function() {
            buf.reserve(10);
            buf.writeFloatBE(1234.5);
            assert.equal(buf.end, 4);
            assert.equal(ieeeFloat.readFloatBE(buf.buf, 0), 1234.5);

            buf.end = 0;
            buf.writeDoubleBE(1234.5);
            assert.equal(buf.end, 8);
            assert.equal(ieeeFloat.readDoubleBE(buf.buf, 0), 1234.5);
        })
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
            var lengthStrings = [
                '', 'abc', 'abc\xFF', 'abc\u4567',
                'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' +
                    'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' +
                    'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
                // valid surrogate pairs
                '(\ud800\udc00)', '(\udbff\udc00)', '(\udbff\udfff)', '(\ud800\udfff)',
                // invalid surrogate pairs
                '(\ud800)', '(\udc00)', '(\ud800\ud800)', '(\ud800\ud8ff)', '(\udc00\udfff)', '(\udc00\ud800)',
                // bit-length transitions
                '\u0000\u0007\u000f \u001f\u007f\u00ff \u01ff\u07ff\u0fff \u1fff\u7fff\uffff',
                '\u0001\u0003\u0007\u000f \u001f\u003f\u007f\u00ff \u01ff\u03ff\u07ff\u0fff \u1fff\u3fff\u7fff\uffff',
            ];
            it('byteLength returns utf8 length', function() {
                for (var i = 0; i < lengthStrings.length; i++) {
                    var s = lengthStrings[i];
                    assert.equal(PushBuffer.byteLength(s), Buffer.byteLength(s), 'string ' + i + s);
                }
            })
            it('guessByteLength returns approximate utf8 length', function() {
                for (var i = 0; i < lengthStrings.length; i++) {
                    var s = lengthStrings[i];
                    assert.ok(PushBuffer.guessByteLength(s) >= Buffer.byteLength(s), 'string ' + i + ' ' + s);
                }
            })
        })
        it('bytes', function() {
            buf.pushBytes([]);
            assert.equal(buf.end, 0);
            assert.deepEqual(buf.slice(), fromBuf([]));
            buf.pushBytes([1, 2, 3, 4, 5]);
            assert.equal(buf.end, 5);
            assert.deepEqual(buf.slice(), fromBuf([1, 2, 3, 4, 5]));
        })
    })

    describe('decode', function() {
        it('shift', function() {
            buf.push(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15);

            buf.pos = 0;
            assert.equal(buf.shiftBE(1), 0x01);
            assert.equal(buf.shiftBE(2), 0x0203);
            assert.equal(buf.shiftBE(3), 0x040506);
            assert.equal(buf.shiftBE(4), 0x0708090A);
            assert.equal(buf.shiftBE(5), 0x0B0C0D0E0F);

            buf.pos = 0;
            assert.equal(buf.shiftLE(1), 0x01);
            assert.equal(buf.shiftLE(2), 0x0302);
            assert.equal(buf.shiftLE(3), 0x060504);
            assert.equal(buf.shiftLE(4), 0x0A090807);
            assert.equal(buf.shiftLE(5), 0x0F0E0D0C0B);
        })
        it('shiftVarint', function() {
            buf.push(1, 2, 3, 128);
            assert.equal(buf.shiftVarint(), 1 + 128 * 2 + 128 * 128 * 3);
            buf.poke(0, 1, 2, 128 + 3);
            buf.pos = 0;
            assert.equal(buf.shiftVarint(), 1 + 128 * 2 + 128 * 128 * 3);
        })
        it('float, double', function() {
            buf.reserve(10);
            ieeeFloat.writeFloatBE(buf.buf, 1234.5, 0);
            assert.equal(buf.shiftFloatBE(), 1234.5);
            buf.pos = 0;
            ieeeFloat.writeDoubleBE(buf.buf, 1234.5, 0);
            assert.equal(buf.shiftDoubleBE(), 1234.5);
        })
        it('strings', function() {
            buf = new PushBuffer([0x41, 0x42, 0x43]);
            assert.equal(buf.shiftString(3), 'ABC');
            buf = new PushBuffer([0x41, 0x8F, 0x43]);
            assert.equal(buf.shiftString(3), 'A\uFFFDC');

            buf = new PushBuffer([0x41, 0xC1, 0x82, 0x43]);
            assert.equal(buf.shiftString(4), 'A\u0042C');
            buf = new PushBuffer([0x41, 0xC0, 0x43]);
            assert.equal(buf.shiftString(3), 'A\uFFFDC');
            buf = new PushBuffer([0x41, 0xC0, 0xC0, 0x43]);
            assert.equal(buf.shiftString(4), 'A\uFFFD\uFFFDC');

            buf = new PushBuffer([0x41, 0xE1, 0x82, 0x83, 0x43]); // 0001000010000011
            assert.equal(buf.shiftString(5), 'A\u1083C');
            buf = new PushBuffer([0x41, 0xE1, 0x82, 0x43]);
            assert.equal(buf.shiftString(4), 'A\uFFFD\uFFFDC');
            buf = new PushBuffer([0x41, 0xE1, 0xC0, 0x43]);
            assert.equal(buf.shiftString(4), 'A\uFFFD\uFFFDC');
            buf = new PushBuffer([0x41, 0xE1, 0x82, 0xE0, 0x43]);
            assert.equal(buf.shiftString(5), 'A\uFFFD\uFFFD\uFFFDC');
            buf = new PushBuffer([0x41, 0xE1, 0xE0, 0x83, 0x43]);
            assert.equal(buf.shiftString(5), 'A\uFFFD\uFFFD\uFFFDC');

            buf = new PushBuffer([0x41, 0xF1, 0x82, 0x83, 0x84, 0x43]); // 001000010000011000100 = 270532
            // code = 270532, code1 = 0xd800 + 0011001000, code2 = 0xdc00 + 0011000100
            assert.equal(buf.shiftString(6), 'A\ud8c8\udcc4C');
            buf = new PushBuffer([0x41, 0xF1, 0xF2, 0x83, 0x84, 0x43]);
            assert.equal(buf.shiftString(6), 'A\uFFFD\uFFFD\uFFFD\uFFFDC');
            buf = new PushBuffer([0x41, 0xF1, 0x82, 0xF3, 0x84, 0x43]);
            assert.equal(buf.shiftString(6), 'A\uFFFD\uFFFD\uFFFD\uFFFDC');
            buf = new PushBuffer([0x41, 0xF1, 0x82, 0x83, 0xF4, 0x43]);
            assert.equal(buf.shiftString(6), 'A\uFFFD\uFFFD\uFFFD\uFFFDC');

            buf = new PushBuffer([0x41, 0xFC, 0x43]);
            assert.equal(buf.shiftString(3), 'A\uFFFDC');
            buf = new PushBuffer([0x41, 0xFE, 0x43]);
            assert.equal(buf.shiftString(3), 'A\uFFFDC');
        })
        it('bytes', function() {
            buf.push(1, 2, 3, 4, 5, 6);
            assert.deepEqual(buf.shiftBytes(5), fromBuf([1, 2, 3, 4, 5]));
            assert.deepEqual(buf.shiftBytes(0), fromBuf([]));
        })
    })

    describe('encode and decode', function() {
        it('bytes', function() {
            var buf = new PushBuffer();
            buf.push(1, 2, 3);
            assert.deepEqual(buf.slice(0, 3), fromBuf([1, 2, 3]));
            assert.equal(buf.shiftBE(1), 1);
            assert.equal(buf.shiftBE(2), 0x0203);
            buf.pos = 1;
            assert.equal(buf.shiftLE(2), 0x0302);
            buf.pos = 0;
            assert.equal(buf.shiftBE(3), 0x010203);
        })
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
            for (var code = 0; code < 0x10000; code += 3) testCode(code);
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
