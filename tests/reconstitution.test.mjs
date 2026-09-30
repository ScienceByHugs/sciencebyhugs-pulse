import test from 'node:test'
import assert from 'node:assert/strict'
import {calculateReconstitution as calc} from '../src/reconstitution.ts'
test('10 mg in 2 mL with 1 mg target gives 0.2 mL and 20 U-100 units',()=>{
  assert.deepEqual(calc(10,2,1,'mg',1),{concentration:5,drawMl:0.2,units:20,doses:10,exceedsSyringe:false})
})
test('mg and mcg targets produce identical measurements',()=>assert.deepEqual(calc(5,2,250,'mcg',0.3),calc(5,2,0.25,'mg',0.3)))
test('capacity boundary fits; larger draw is flagged',()=>{
  assert.equal(calc(10,1,3,'mg',0.3).exceedsSyringe,false)
  assert.equal(calc(10,2,3,'mg',0.5).exceedsSyringe,true)
})
test('reject invalid, nonfinite, over-vial targets and unsupported units',()=>{
  for(const value of [0,-1,NaN,Infinity]) {
    assert.throws(()=>calc(value,2,1,'mg',1))
    assert.throws(()=>calc(10,value,1,'mg',1))
    assert.throws(()=>calc(10,2,value,'mg',1))
  }
  assert.throws(()=>calc(5,2,6,'mg',1))
  assert.throws(()=>calc(5,2,1,'IU',1))
  assert.throws(()=>calc(5,2,1,'mg',2))
})
test('whole-vial target and fractional target preserve arithmetic',()=>{
  assert.equal(calc(5,2,5,'mg',1).doses,1)
  assert.equal(calc(10,3,0.7,'mg',1).drawMl,0.7/(10/3))
})
