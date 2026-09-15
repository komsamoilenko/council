// Owns the human safety report's invariant tests; specification §7.3 D2.
import assert from 'node:assert/strict';
import version from '../../../src/version.js';
import { planReport, detectReport } from '../../../installer/lib/report.mjs';
export default async function(test) {
  const base={profile:'default',answers:{vault:'Notes'},steps:[],registrations:[],untouched:[],warnings:[],file:'plan.json',sha256:'example'};
  await test('zero destruction lines are unconditional',async()=>{
    const text=planReport(base);assert.ok(text.includes('\nWILL OVERWRITE (0)   WILL DELETE (0)   WILL MOVE OR RENAME (0)\n'));assert.ok(text.includes('WILL CREATE (0)'));assert.ok(text.includes('WILL APPEND A MARKED BLOCK TO (0)'));
  });
  await test('append reports byte delta and pre-image path',async()=>{
    const text=planReport({...base,steps:[{writes:[{action:'block',path:'AGENTS.md',beforeBytes:12,bytes:42,backup:'backup.md'}]}]});assert.ok(text.includes('AGENTS.md  12 → 42 bytes  backup → backup.md'));
  });
  await test('banners name the running installer version',async()=>{
    assert.equal(planReport(base).split('\n')[0], `council-setup ${version.APP_VERSION} · plan  (profile: default · vault: Notes)`);
    assert.equal(detectReport({profile:'default',blocks:[],warnings:[]}).split('\n')[0], `council-setup ${version.APP_VERSION} · detect (profile: default)`);
  });
}
