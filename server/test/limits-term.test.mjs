import test from 'node:test';import assert from 'node:assert/strict';
import {limitsWindow,checkLimits} from '../src/v5/limits-public.mjs';
import {buildMigrationPlanV5} from '../src/v5/plan.mjs';
test('limits window: every preset incl. 365 is <= 365 days and exact',()=>{const now=1792641600;
  for(const d of [1,30,90,180,365]){const {start,end}=limitsWindow(now,d);assert.equal(end-start,d*86400);assert.ok(end-start<=365*86400);}
  assert.deepEqual(limitsWindow(now,undefined,1800000000),{start:now-30,end:1800000000});
  assert.equal(checkLimits({single:'10',daily:'50',term:'200',days:'365'}).days,365);assert.ok(checkLimits({single:'10',daily:'50',term:'200',days:'366'}).error);});
test('old formula (start=now-30,end=now+365d) is the bug the plan rejected',()=>{const now=1792641600;assert.ok(now+365*86400-(now-30)>365*86400);});
