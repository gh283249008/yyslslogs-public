export const SIDECARS = ['fight-outcome-events.jsonl', 'identities.json', 'attribution-revisions.json', 'damage-events.jsonl', 'buff-events.jsonl', 'settlement-details.jsonl', 'encounter-events.jsonl', 'attribute-events.jsonl', 'auxiliary-number-tips.jsonl', 'resource-states.jsonl'];
export const battleKey = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
export function analysisFile(name) {
  return SIDECARS.includes(name) || name === 'battles/index.jsonl' || /^battles\/[a-zA-Z0-9_-]{1,100}\/(battle\.json|statistics\.jsonl|snapshots\.jsonl)$/.test(name);
}
export function selectCapture(files) {
  const entries = [...files].map(file => ({ file, name: file.webkitRelativePath || file.name }));
  const indexes = entries.filter(x => x.name.endsWith('/battles/index.jsonl') || x.name === 'battles/index.jsonl');
  if (indexes.length !== 1) throw Error(indexes.length ? '一次请选择一个会话的 capture 文件夹。' : '没有找到 battles/index.jsonl。请选择采集器记录中的完整 capture 文件夹，压缩包请先解压。');
  const prefix = indexes[0].name.slice(0, -'battles/index.jsonl'.length);
  const selected = entries.filter(x => x.name.startsWith(prefix)).map(x => ({ ...x, path: x.name.slice(prefix.length) })).filter(x => analysisFile(x.path));
  if (!selected.some(x => /^battles\/[^/]+\/battle.json$/.test(x.path))) throw Error('这个目录还没有保存完整战斗，请先结束一场战斗再导入。');
  return { files: selected, skipped: entries.length - selected.length };
}

// Header checks are shared by browser, native uploader and server admission.
// Sizes describe uncompressed members; limits are supplied by JSON configuration.
export function assertMemberSizes(file, limits) {
  if (!file || typeof file.path !== 'string') throw Object.assign(Error('上传包文件路径无效。'), {status:400});
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.encoding === 'gzip' && file.size === 0) throw Object.assign(Error(file.path + '：压缩文件大小无效。'), {status:400});
  const raw = file.encoding === 'gzip' ? file.rawSize : file.size;
  if (!Number.isSafeInteger(raw) || raw < 0) throw Object.assign(Error(file.path + '：解压大小必须是非负安全整数。'), {status:400});
  if (!limits) return;
  const maximum = file.path.endsWith('.json') ? limits.jsonBytes : limits.expandedFileBytes;
  if (raw > maximum) throw Object.assign(Error(file.path + '：解压后 ' + raw + ' 字节，超过' + (file.path.endsWith('.json') ? ' JSON 元数据' : '单个日志') + '上限 ' + maximum + ' 字节。'), {status:413});
}
