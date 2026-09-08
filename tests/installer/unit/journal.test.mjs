import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { journal, readJournal, openJournals } from '../../../installer/lib/journal.mjs';
import { safewrite } from '../../../installer/lib/safewrite.mjs';
import { sha256 } from '../../../installer/lib/manifest.mjs';

export default async function(test) {
  await test('all five durable records precede actions', async root => {
    const file=path.join(root,'one.jsonl'); let durable=false;
    const j=journal(file,{writer:async (...args) => { durable=false; await safewrite(...args); durable=true; }});
    const records=[{t:'begin',plan_sha256:sha256('plan')},{t:'backup',path:'target',backup:'preimage'},
      {t:'pre',path:'target',sha256_before:null,sha256_expected:sha256('new')},{t:'post',path:'target',sha256_after:sha256('new')},{t:'commit'}];
    for (const record of records) await j.before(record,async () => { assert.ok(durable); assert.deepEqual(readJournal(file).records.at(-1),record); });
    assert.deepEqual(readJournal(file).records,records); assert.deepEqual(openJournals(root),[]);
  });
  await test('open, partial, empty and malformed journals block', async root => {
    await journal(path.join(root,'open.jsonl')).before({t:'begin',plan_sha256:sha256('p')});
    await safewrite(path.join(root,'partial.jsonl'),'{"t":'); await safewrite(path.join(root,'empty.jsonl'),'');
    await safewrite(path.join(root,'bad.jsonl'),JSON.stringify({t:'mystery'})+'\n'); await safewrite(path.join(root,'ignore.txt'),'x');
    assert.equal(openJournals(root).length,4); assert.equal(openJournals(root).filter(j => j.corrupt).length,3);
    assert.deepEqual(openJournals(path.join(root,'absent')),[]);
  });
  await test('failure leaves pre record and poisons handle', async root => {
    const file=path.join(root,'one.jsonl'), j=journal(file); await j.before({t:'begin',plan_sha256:sha256('p')});
    await assert.rejects(j.before({t:'pre',path:'target',sha256_before:sha256('old'),sha256_expected:sha256('new')},() => { throw new Error('crash'); }),/crash/);
    await assert.rejects(j.before({t:'commit'}),/crash/); assert.equal(readJournal(file).open,true); assert.equal(readJournal(file).records.at(-1).t,'pre');
  });
  await test('failed persistence never executes action', async root => {
    let acted=false; const j=journal(path.join(root,'one.jsonl'),{writer:async () => { throw new Error('disk_error'); }});
    await assert.rejects(j.before({t:'begin',plan_sha256:sha256('p')},() => { acted=true; }),/disk_error/); assert.equal(acted,false);
  });
  await test('serial calls and invalid grammar', async root => {
    const file=path.join(root,'one.jsonl'), j=journal(file);
    await Promise.all([j.before({t:'begin',plan_sha256:sha256('p')}),j.before({t:'pre',path:'x',sha256_before:null,sha256_expected:sha256('x')}),j.before({t:'post',path:'x',sha256_after:sha256('x')})]);
    assert.deepEqual(readJournal(file).records.map(r=>r.t),['begin','pre','post']);
    await assert.rejects(j.before({t:'unknown'}),/invalid_journal_type/);
    await assert.rejects(journal(path.join(root,'missing.jsonl')).before({t:'commit'}));
    await assert.rejects(journal(file).before({t:'begin',plan_sha256:sha256('p')}),/not_appendable/);
  });
}
