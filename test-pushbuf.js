var assert = require('assert');
var PushBuffer = require('./pushbuf');

describe('pushbuf', function() {
    describe('encode and decode', function() {
        it('numbers', function() {
            var buf = new PushBuffer();
            buf.push(1), buf.push(101), buf.push(0x27, 0x11);
            assert.deepEqual([buf.shiftBE(1), buf.shiftBE(1), buf.shiftBE(2)], [1, 101, 10001]);
            buf.pos = 0;
            assert.deepEqual([buf.shiftLE(1), buf.shiftLE(1), buf.shiftLE(2)], [1, 101, 4391]);
        })
    })
})
