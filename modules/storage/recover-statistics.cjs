'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { createUploadPackage } = require('./upload-package.cjs');
const { requiresSchemaRepair, replayCapture } = require('./repair-capture.cjs');

function findBattleCapture(capture) {
  return [capture, path.join(capture, 'statistics-only')].find(dir =>
    fs.existsSync(path.join(dir, 'battles/index.jsonl')));
}

function canRecover(capture) {
  return fs.existsSync(path.join(capture, 'completion.json')) &&
    fs.existsSync(path.join(capture, 'statistics.jsonl'));
}

async function packageSession(session, destination, options) {
  const original = session.originalCapture || session.capture;
  if (requiresSchemaRepair(original)) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'yylogs-reparse-'));
    try {
      options?.onProgress?.({ done: 0, total: 1, file: '正在从原始日志修复字段字典，请稍候' });
      const repaired = await replayCapture(original, scratch);
      return await createUploadPackage(repaired, destination, options);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
  if (!session.statisticsOnly) return createUploadPackage(session.capture, destination, options);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'yylogs-statistics-'));
  try {
    await writeRecoveredBattles(session.originalCapture || session.capture, scratch);
    return await createUploadPackage(scratch, destination, options);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function writeRecoveredBattles(capture, scratch) {
  const { SIDECARS } = await import('../contracts/import-format.mjs');
  const originals = [];
  for (const name of ['statistics.jsonl', ...SIDECARS]) {
    const file = path.join(capture, name);
    if (!fs.existsSync(file)) continue;
    const before = fs.statSync(file);
    originals.push({ file, size: before.size, mtimeMs: before.mtimeMs });
    if (name !== 'statistics.jsonl') fs.copyFileSync(file, path.join(scratch, name));
  }
    const input = path.join(capture, 'statistics.jsonl');
  const before = fs.statSync(input);
    const battles = path.join(scratch, 'battles');
    fs.mkdirSync(battles);
    const index = [];
    let pending;
    function save() {
      if (!pending) return;
      const { row, first } = pending;
      pending = undefined;
      const id = 'statistics-' + first.sequence;
      const source = row.source;
      const clock = {
        startObservedAt: new Date(Date.parse(first.observedAt) - first.timeCostSeconds * 1000).toISOString(),
        endObservedAt: null, npcNo: row.npcNo, timingBasis: 'estimated-from-settled-statistics'
      };
      const folder = path.join(battles, id);
      fs.mkdirSync(folder);
      const { observedAt, npcNo, timeCostSeconds, actors, sequence } = row;
      const statistics = { observedAt, npcNo, timeCostSeconds, actors, sequence };
      fs.writeFileSync(path.join(folder, 'battle.json'), JSON.stringify({
        schemaVersion: 1, id, source, clock, statistics, status: 'interrupted',
        scope: 'Recovered settlement counters only. Estimated start, no observed battle-state boundary.'
      }));
      fs.writeFileSync(path.join(folder, 'statistics.jsonl'), JSON.stringify(statistics) + '\n');
      index.push({ id, path: id, source, startObservedAt: clock.startObservedAt });
    }
    const lines = readline.createInterface({ input: fs.createReadStream(input), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      const valid = Number.isSafeInteger(row.sequence) && Number.isSafeInteger(row.npcNo) &&
        row.npcNo > 0 && Number.isFinite(Date.parse(row.observedAt)) &&
        Number.isFinite(row.timeCostSeconds) && row.timeCostSeconds > 0 &&
        row.source?.sessionId && Array.isArray(row.actors) && row.actors.some(a => a.damage > 0);
      if (!valid) { save(); continue; }
      if (pending && (row.source.sessionId !== pending.first.source.sessionId ||
          row.npcNo !== pending.first.npcNo || row.timeCostSeconds !== pending.first.timeCostSeconds ||
          row.sequence !== pending.row.sequence + 1)) save();
      pending = { first: pending?.first ?? row, row };
    }
    save();
    const after = fs.statSync(input);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Error('记录仍在变化，请停止采集后重试。');
    if (!index.length) throw Error('此会话没有可恢复的战斗结算统计。');
    fs.writeFileSync(path.join(battles, 'index.jsonl'), index.map(row => JSON.stringify(row)).join('\n') + '\n');
    for (const original of originals) {
      const current = fs.statSync(original.file);
      if (current.size !== original.size || current.mtimeMs !== original.mtimeMs) {
        throw Error('记录仍在变化，请停止采集后重试。');
      }
    }
    return index.length;
}

async function persistRecoveredBattles(capture) {
  const existing = findBattleCapture(capture);
  if (existing || !canRecover(capture)) return existing;
  const scratch = fs.mkdtempSync(path.join(capture, '.statistics-only-'));
  try {
    await writeRecoveredBattles(capture, scratch);
    const target = path.join(capture, 'statistics-only');
    fs.renameSync(scratch, target);
    return target;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

module.exports = { findBattleCapture, canRecover, packageSession, persistRecoveredBattles };
