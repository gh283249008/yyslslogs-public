'use strict';
const isClear = e => /clear|leave|aoi|gap/.test(e.kind || '');
const target = e => e.targetActorHash ?? e.actorHash;
const key = e => [e.bag, e.buffInstanceHash].join(':');
const ordinal = e => e.transportRecordOrdinal;
const allowed = new Set(['apply_candidate', 'snapshot', 'update', 'field_patch']);

// Bounded context for delayed-output models. These events establish model
// eligibility and start cause, not server execution timestamps.
class RecordedWindowContext {
 constructor(policy) {
  this.events = []; this.overflow = false;
  this.limit = policy?.maxContextEvents ?? 100000;
  this.ids = new Set();
  for (const [id, rule] of Object.entries(policy?.models ?? {})) {
   for (const no of rule.requiredSourceBuffs ?? []) this.ids.add(no);
   for (const start of rule.starts ?? []) {
    this.ids.add(start.buffNo);
    if (start.requireParentRemoval) this.ids.add(Number(id));
   }
  }
 }
 observe(e) {
  if (!this.ids.has(e.buffNo) && !isClear(e)) return;
  if (!Number.isSafeInteger(ordinal(e)) || ordinal(e) < 0) { this.overflow = true; return; }
  if (this.events.length >= this.limit) { this.overflow = true; return; }
  this.events.push(e);
 }
 sourceConditions(apply, remove, required) {
  if (!required?.length) return true;
  const active = new Map(), actor = apply.sourceActorHash;
  const relevant = this.events.filter(e => ordinal(e) <= ordinal(remove) &&
   ((!target(e) || target(e) === actor) && isClear(e) || target(e) === actor && required.includes(e.buffNo)));
  const update = e => {
   if (isClear(e)) { active.clear(); return; }
   if (!e.buffInstanceHash || !Number.isSafeInteger(ordinal(e))) { active.clear(); return; }
   if (e.kind === 'remove_candidate' || !allowed.has(e.kind)) { active.delete(key(e)); return; }
   const old = active.get(key(e));
   const expiry = e.durationSeconds === -1 ? Infinity : old && old.rawStart === e.rawStartTimestamp && old.duration === e.durationSeconds ? old.expiry : Date.parse(e.observedAt) + e.durationSeconds * 1000;
   if (!(e.durationSeconds === -1 || e.durationSeconds > 0) || !Number.isFinite(Date.parse(e.observedAt))) active.delete(key(e));
   else active.set(key(e), { no: e.buffNo, expiry, rawStart: e.rawStartTimestamp, duration: e.durationSeconds });
  };
  const present = time => required.every(no => [...active.values()].some(v => v.no === no && v.expiry > time));
  for (const e of relevant.filter(e => ordinal(e) < ordinal(apply))) update(e);
  if (!present(Date.parse(apply.observedAt))) return false;
  for (const e of relevant.filter(e => ordinal(e) >= ordinal(apply))) {
   update(e); if (!present(Date.parse(e.observedAt))) return false;
  }
  return present(Date.parse(remove.observedAt));
 }
 describe(apply, remove, rule) {
  if (this.overflow || !this.sourceConditions(apply, remove, rule.requiredSourceBuffs)) return null;
  if (!rule.starts) return { includeApply: false, includeRemove: !!rule.includeRemove, cause: 'direct-window' };
  if (!Number.isSafeInteger(apply.sequence)) return null;
  const candidates = [];
  for (const start of rule.starts) {
   const same = e => target(e) === apply.targetActorHash && e.sourceActorHash === apply.sourceActorHash;
   const removals = this.events.filter(e => e.buffNo === start.buffNo && e.kind === 'remove_candidate' && same(e) &&
    ordinal(e) === ordinal(apply) && Number.isSafeInteger(e.sequence) &&
    (start.order === 'before' ? e.sequence < apply.sequence : e.sequence > apply.sequence));
   for (const end of removals) {
    if (start.removalStacks !== undefined && end.charge_level !== start.removalStacks) continue;
    const begin = this.events.filter(e => e.buffNo === start.buffNo && same(e) && key(e) === key(end) &&
     e.kind === 'apply_candidate' && !e.initial && e.sequence < end.sequence).at(-1);
    if (!begin || ordinal(begin) > ordinal(end) || Date.parse(begin.observedAt) > Date.parse(end.observedAt) || start.durationSeconds !== undefined && begin.durationSeconds !== start.durationSeconds) continue;
    const interrupted = this.events.some(e => e.sequence > begin.sequence && e.sequence < end.sequence &&
     ((isClear(e) && (!target(e) || target(e) === apply.targetActorHash)) ||
      (target(e) === apply.targetActorHash && key(e) === key(begin) &&
       (e.sourceChanged || e.sourceActorHash !== begin.sourceActorHash || !allowed.has(e.kind) || e.kind === 'snapshot'))));
    if (interrupted) continue;
    if (start.requireParentRemoval) {
     // The destroy and successor-add can be split across adjacent transport
     // records. Require the last parent lifecycle to be its matching removal.
     const parent = this.events.filter(e => e.buffNo === apply.buffNo && same(e) &&
      ['apply_candidate', 'snapshot', 'remove_candidate'].includes(e.kind) && e.sequence < begin.sequence).at(-1);
     if (!parent || parent.kind !== 'remove_candidate' || key(parent) !== key(apply)) continue;
    }
    candidates.push({ includeApply: start.includeApply, includeRemove: !!rule.includeRemove, cause: start.cause,
     predecessorBuff: start.buffNo, predecessorApplyRecord: ordinal(begin), predecessorRemoveRecord: ordinal(end) });
   }
  }
  return candidates.length === 1 ? candidates[0] : null;
 }
}
module.exports = { RecordedWindowContext };
