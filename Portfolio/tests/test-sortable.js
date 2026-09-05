'use strict';

const assert = require('node:assert/strict');
const KjrSortable = require('../Worker/kjr-sortable.js');
let passed = 0;
function eq(label, actual, expected) {
  assert.strictEqual(actual, expected, label);
  passed++;
}
function ok(label, condition) {
  assert.ok(condition, label);
  passed++;
}

const ifp = KjrSortable.indexForPointer;
eq('empty list', ifp(100, []), 0);
eq('single item above mid', ifp(10, [{top:0, height:60}]), 0);
eq('single item below mid', ifp(50, [{top:0, height:60}]), 1);
eq('single item at mid (goes after)', ifp(30, [{top:0, height:60}]), 1);
eq('3 items: before first', ifp(5, [{top:0, height:60}, {top:60, height:60}, {top:120,height:60}]), 0);
eq('3 items: between 1st and 2nd', ifp(55, [{top:0, height:60}, {top:60, height:60}, {top:120,height:60}]), 1);
eq('3 items: between 2nd and 3rd', ifp(115, [{top:0, height:60}, {top:60, height:60}, {top:120,height:60}]), 2);
eq('3 items: after last', ifp(200, [{top:0, height:60}, {top:60, height:60}, {top:120,height:60}]), 3);
eq('pointer above first item', ifp(-10, [{top:0, height:60}]), 0);
eq('pointer below last item', ifp(9999, [{top:0,height:40},{top:40,height:40}]), 2);
eq('variable heights: first half', ifp(19, [{top:0,height:40},{top:40,height:80}]), 0);
eq('variable heights: second slot', ifp(25, [{top:0,height:40},{top:40,height:80}]), 1);
eq('variable heights: after last', ifp(90, [{top:0,height:40},{top:40,height:80}]), 2);

ok('create with null returns null', KjrSortable.create(null) === null);
ok('VERSION is string', typeof KjrSortable.VERSION === 'string');
ok('VERSION is 1.5', KjrSortable.VERSION === '1.5');

console.log(passed + '/' + passed + ' passed');
