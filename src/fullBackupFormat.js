const LEGACY_EMPTY_CONTENT_BLOCK = /^([ \t]+)content:[ \t]*\|-[ \t]*\r?\n[ \t]*\r?\n(?=  "(?:[^"\\]|\\.)+":[ \t]*\r?$)/gm;

function normalizeLegacyEmptyBase64Blocks(text) {
  return String(text || '').replace(LEGACY_EMPTY_CONTENT_BLOCK, '$1content: ""\n');
}

function fullBackupContentHeader(size) {
  return Number(size) === 0 ? '    content: ""\n' : '    content: |-\n';
}

module.exports = { normalizeLegacyEmptyBase64Blocks, fullBackupContentHeader };
