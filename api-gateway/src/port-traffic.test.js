import test from 'node:test'
import assert from 'node:assert/strict'
import {counterRate,buildTraffic,trafficWindow,downsample} from './port-traffic.js'
test('64-bit differences remain exact above Number safe integers',()=>{
  assert.equal(counterRate('18000000000000000100','18000000000000000000',{seconds:10}).value,80)
})
test('reset, gap, unsafe 32-bit intervals and safe wrap are distinguished',()=>{
 assert.equal(counterRate('1','999',{seconds:60}).quality,'reset')
 assert.equal(counterRate('1000','0',{seconds:600}).quality,'gap')
 assert.equal(counterRate('1000','0',{seconds:60,bits:32,speed:1e9}).quality,'ambiguous32')
 assert.equal(counterRate('10','4294967290',{seconds:1,bits:32,speed:1e8}).value,128)
 assert.equal(counterRate('2000','1000',{seconds:60,discontinuity:true}).quality,'reset')
})
test('missing direction is null; source changes and discontinuities break curves',()=>{
 const t=Date.parse('2026-10-07T00:00:00Z'),window={start:t,end:t+180000}
 const rows=[{time:new Date(t),values:{ifHCInOctets:'100',ifHighSpeed:'1000',ifCounterDiscontinuityTime:'0'}},
 {time:new Date(t+60000),values:{ifHCInOctets:'700',ifCounterDiscontinuityTime:'0'}},
 {time:new Date(t+120000),values:{ifHCInOctets:'1300',ifCounterDiscontinuityTime:'99'}}]
 const result=buildTraffic(rows,{},window,t+120000)
 assert.equal(result.points[1].in_bps,80);assert.equal(result.points[1].out_bps,null)
 assert.equal(result.points[2].in_quality,'reset');assert.equal(result.stats.in.peak_bps,80)
 assert.equal(buildTraffic(rows,{},window,t+600000).summary.in_bps,null)
 assert.equal(buildTraffic(rows,{},window,t+600000).summary.data_status,'stale')
})
test('range validation and downsampling preserve gaps',()=>{
 assert.throws(()=>trafficWindow({start:'bad'}))
 assert.throws(()=>trafficWindow({start:'2026-01-01',end:'2026-02-01'}))
 const rows=Array.from({length:601},(_,i)=>({time:String(i),in_bps:i===0?null:10,out_bps:20,in_seconds:60,out_seconds:60,speed_bps:100}))
 assert.equal(downsample(rows)[0].in_bps,null)
})
test('statistics clip coverage to query boundary and time-weight averages',()=>{
 const t=Date.parse('2026-10-07T00:00:00Z'),window={start:t+30000,end:t+90000}
 const rows=[{time:new Date(t),values:{ifHCInOctets:'0'}},{time:new Date(t+60000),values:{ifHCInOctets:'600'}},{time:new Date(t+90000),values:{ifHCInOctets:'1200'}}]
 const result=buildTraffic(rows,{},window,t+90000)
 assert.equal(result.stats.in.coverage_seconds,60)
 assert.equal(result.stats.in.average_bps,120)
 assert.equal(result.stats.in.peak_bps,160)
})
test('source changes and device uptime rollback invalidate the affected interval',()=>{
 const t=Date.parse('2026-10-07T00:00:00Z'),window={start:t,end:t+120000}
 const rows=[{time:new Date(t),uptime:'10000',values:{ifInOctets:'100',ifHighSpeed:'10'}},{time:new Date(t+60000),uptime:'16000',values:{ifHCInOctets:'200'}},{time:new Date(t+120000),uptime:'100',values:{ifHCInOctets:'999'}}]
 const result=buildTraffic(rows,{},window,t+120000)
 assert.equal(result.points[1].in_quality,'source_changed')
 assert.equal(result.points[2].in_quality,'reset')
})
