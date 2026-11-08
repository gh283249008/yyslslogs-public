'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const profiles = require('../../config/schema-profiles.json');
const root = path.resolve(__dirname, '../..');

function requiresSchemaRepair(capture) {
  const manifestFile = path.join(capture, 'manifest.json');
  if (!fs.existsSync(manifestFile)) return false;
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  const recorded = manifest.propertySchemaProfile;
  const id = profiles.byGameDataSha256?.[manifest.gameData?.manifestSha256]?.[recorded?.clientBuildSha256];
  return Boolean(id && profiles.profiles[id].count !== recorded.count);
}

async function replayCapture(capture, scratch) {
  if (!fs.existsSync(path.join(capture, 'completion.json'))) throw Error('请停止采集后再修复记录。');
  const configFile = path.join(capture, '..', 'session.private.json');
  if (!fs.existsSync(configFile) || !fs.existsSync(path.join(capture, 'transport.private.tsv'))) {
    throw Error('修复旧记录需要原始会话目录，须包含 session.private.json 和 transport.private.tsv。');
  }
  const config = JSON.parse(fs.readFileSync(configFile));
  config.python = path.join(root, 'runtime/python/python.exe');
  delete config.identityCacheFile;
  if (!fs.existsSync(config.python)) throw Error('请使用完整修正版采集器附带的上传器修复此记录。');
  const rewritten = path.join(scratch, 'replay.private.json');
  fs.writeFileSync(rewritten, JSON.stringify(config));
  const target = path.join(scratch, 'capture');
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  delete env.NODE_OPTIONS;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--max-old-space-size=1024', path.join(root, 'tools/p1-live-pipeline.cjs'),
      '--config', rewritten, '--out', target, '--replay', path.join(capture, 'transport.private.tsv')
    ], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let diagnostic = '';
    child.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-4096); });
    const timer = setTimeout(() => child.kill(), 15 * 60 * 1000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(Error('原始日志重解析失败，原记录已保留。' + diagnostic));
      try {
        const completion = JSON.parse(fs.readFileSync(path.join(target, 'completion.json')));
        if (completion.failed || !completion.drainComplete || !fs.existsSync(path.join(target, 'battles/index.jsonl'))) {
          throw Error('重解析尚未获得完整战斗索引。');
        }
        resolve();
      } catch (error) { reject(error); }
    });
  });
  return target;
}

module.exports = { requiresSchemaRepair, replayCapture };
