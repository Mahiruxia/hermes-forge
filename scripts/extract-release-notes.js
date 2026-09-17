const fs = require('fs');
const path = require('path');

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
const version = pkg.version;
const releaseNotesPath = 'RELEASE_NOTES.md';
const outputPath = 'release/release-notes-generated.md';

if (!fs.existsSync(releaseNotesPath)) {
  console.error('RELEASE_NOTES.md not found');
  process.exit(1);
}

const content = fs.readFileSync(releaseNotesPath, 'utf-8');

// Find the section for current version
const versionHeader = `## Hermes Forge v${version}`;
const startIdx = content.indexOf(versionHeader);
if (startIdx === -1) {
  console.error(`Version ${version} not found in RELEASE_NOTES.md`);
  process.exit(1);
}

// Find the next version section or end of file
const nextVersionRegex = /\n## Hermes Forge v\d+\.\d+\.\d+/;
const nextMatch = content.slice(startIdx + versionHeader.length).match(nextVersionRegex);
const endIdx = nextMatch ? startIdx + versionHeader.length + nextMatch.index : content.length;

let section = content.slice(startIdx, endIdx).trim();

// Remove the header line
section = section.replace(/^## Hermes Forge v[\d.]+\s*\n/, '');

// Remove "发布日期" line
section = section.replace(/^发布日期：\d{4}-\d{2}-\d{2}\s*\n/m, '');

// Remove "验证" section and everything after it
const verifyMatch = section.match(/\n### 验证[\s\S]*$/);
if (verifyMatch) {
  section = section.slice(0, verifyMatch.index).trim();
}

// Remove "已知限制" section
const limitMatch = section.match(/\n### 已知限制[\s\S]*$/);
if (limitMatch) {
  section = section.slice(0, limitMatch.index).trim();
}

// Remove intro paragraph (lines before first ###)
const firstHeading = section.search(/^### /m);
if (firstHeading !== -1) {
  section = section.slice(firstHeading).trim();
}

// Simplify: keep only ### 核心修复, ### 新增功能, ### 体验优化/调整, ### 性能优化
const allowedHeadings = ['核心修复', '新增功能', '体验优化', '体验调整', '性能优化', '重点修复'];
const lines = section.split('\n');
const result = [];
let keep = false;

for (const line of lines) {
  const headingMatch = line.match(/^### (.+)$/);
  if (headingMatch) {
    keep = allowedHeadings.some(h => headingMatch[1].includes(h));
    if (keep) {
      // Simplify heading
      result.push(`**${headingMatch[1]}：**`);
    }
  } else if (keep) {
    // Clean up bullet points
    let cleaned = line
      .replace(/^[-*]\s+/, '- ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (cleaned) {
      result.push(cleaned);
    }
  }
}

const output = result.join('\n').trim();

if (!output) {
  console.error('No release notes content extracted');
  process.exit(1);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, output, 'utf-8');
console.log(`Release notes extracted to ${outputPath}`);
console.log('---');
console.log(output);
console.log('---');
