/**
 * Syntax highlighting utility for diff view.
 *
 * Strategy: highlight each hunk as a contiguous block (preserving multi-line
 * context like strings and comments), then split the resulting HTML back into
 * individual lines that can be rendered inside <td> cells.
 */

import hljs from 'highlight.js/lib/core';

// Register languages — import only the ones we need to keep the bundle small.
// Each import is ~2-8 KB gzipped.
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import cpp from 'highlight.js/lib/languages/cpp';
import c from 'highlight.js/lib/languages/c';
import csharp from 'highlight.js/lib/languages/csharp';
import ruby from 'highlight.js/lib/languages/ruby';
import php from 'highlight.js/lib/languages/php';
import swift from 'highlight.js/lib/languages/swift';
import kotlin from 'highlight.js/lib/languages/kotlin';
import scala from 'highlight.js/lib/languages/scala';
import bash from 'highlight.js/lib/languages/bash';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import scss from 'highlight.js/lib/languages/scss';
import less from 'highlight.js/lib/languages/less';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';
import toml from 'highlight.js/lib/languages/ini'; // hljs uses 'ini' for TOML-like
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import makefile from 'highlight.js/lib/languages/makefile';
import lua from 'highlight.js/lib/languages/lua';
import perl from 'highlight.js/lib/languages/perl';
import r from 'highlight.js/lib/languages/r';
import dart from 'highlight.js/lib/languages/dart';
import elixir from 'highlight.js/lib/languages/elixir';
import haskell from 'highlight.js/lib/languages/haskell';
import protobuf from 'highlight.js/lib/languages/protobuf';
import graphql from 'highlight.js/lib/languages/graphql';
import diff from 'highlight.js/lib/languages/diff';
import nginx from 'highlight.js/lib/languages/nginx';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('go', go);
hljs.registerLanguage('java', java);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('c', c);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('ruby', ruby);
hljs.registerLanguage('php', php);
hljs.registerLanguage('swift', swift);
hljs.registerLanguage('kotlin', kotlin);
hljs.registerLanguage('scala', scala);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('shell', shell);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('json', json);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('scss', scss);
hljs.registerLanguage('less', less);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('toml', toml);
hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('makefile', makefile);
hljs.registerLanguage('lua', lua);
hljs.registerLanguage('perl', perl);
hljs.registerLanguage('r', r);
hljs.registerLanguage('dart', dart);
hljs.registerLanguage('elixir', elixir);
hljs.registerLanguage('haskell', haskell);
hljs.registerLanguage('protobuf', protobuf);
hljs.registerLanguage('graphql', graphql);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('nginx', nginx);

// Aliases
hljs.registerLanguage('jsx', javascript);
hljs.registerLanguage('tsx', typescript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('py', python);
hljs.registerLanguage('rs', rust);
hljs.registerLanguage('rb', ruby);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('zsh', bash);
hljs.registerLanguage('yml', yaml);
hljs.registerLanguage('htm', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('svelte', xml);
hljs.registerLanguage('vue', xml);

/** Map file extension → hljs language name */
const EXT_MAP: Record<string, string> = {
  // JavaScript / TypeScript
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  // Systems
  rs: 'rust', go: 'go', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp',
  cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  // JVM
  java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala',
  // .NET
  cs: 'csharp',
  // Scripting
  py: 'python', rb: 'ruby', php: 'php', lua: 'lua', pl: 'perl',
  pm: 'perl', r: 'r', R: 'r',
  // Mobile
  swift: 'swift', dart: 'dart',
  // Functional
  ex: 'elixir', exs: 'elixir', hs: 'haskell',
  // Shell
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  // Data / Config
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  ini: 'toml', cfg: 'toml',
  // Markup / Style
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', xsl: 'xml',
  vue: 'xml', svelte: 'xml',
  css: 'css', scss: 'scss', less: 'less', sass: 'scss',
  // Query / Schema
  sql: 'sql', graphql: 'graphql', gql: 'graphql',
  proto: 'protobuf',
  // Build / Infra
  dockerfile: 'dockerfile', makefile: 'makefile',
  mk: 'makefile', cmake: 'makefile',
  // Doc
  md: 'markdown', mdx: 'markdown',
  // Misc
  diff: 'diff', patch: 'diff',
  conf: 'nginx', nginx: 'nginx',
};

/** Resolve hljs language from a file path. Returns undefined for unknown types. */
export function detectLanguage(filePath: string): string | undefined {
  // Check special filenames first
  const fileName = filePath.split('/').pop()?.toLowerCase() || '';
  if (fileName === 'dockerfile' || fileName.startsWith('dockerfile.')) return 'dockerfile';
  if (fileName === 'makefile' || fileName === 'gnumakefile') return 'makefile';
  if (fileName === 'cmakelists.txt') return 'makefile';
  if (fileName === '.bashrc' || fileName === '.zshrc' || fileName === '.profile') return 'bash';
  if (fileName === 'nginx.conf') return 'nginx';

  // Extension lookup
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (!ext) return undefined;
  return EXT_MAP[ext];
}

/**
 * Split highlighted HTML by newlines, correctly handling tags that span
 * multiple lines.
 *
 * For example, given:
 *   `<span class="hljs-string">"line1\nline2"</span>`
 * returns:
 *   [`<span class="hljs-string">"line1`, `line2"</span>`]
 *
 * with proper open/close tag insertion so each line fragment is valid HTML.
 */
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  let currentLine = '';
  // Stack of currently open <span ...> tags (just the full opening tag string)
  const openTags: string[] = [];

  let i = 0;
  while (i < html.length) {
    if (html[i] === '\n') {
      // Close all open tags for this line
      for (let t = openTags.length - 1; t >= 0; t--) {
        currentLine += '</span>';
      }
      lines.push(currentLine);
      // Reopen all tags for the next line
      currentLine = openTags.join('');
      i++;
    } else if (html[i] === '<') {
      // Find end of tag
      const tagEnd = html.indexOf('>', i);
      if (tagEnd === -1) {
        // Malformed — just append rest
        currentLine += html.slice(i);
        break;
      }
      const tag = html.slice(i, tagEnd + 1);
      if (tag.startsWith('</')) {
        // Closing tag
        openTags.pop();
        currentLine += tag;
      } else if (tag.endsWith('/>')) {
        // Self-closing tag (shouldn't happen with hljs, but handle it)
        currentLine += tag;
      } else {
        // Opening tag
        openTags.push(tag);
        currentLine += tag;
      }
      i = tagEnd + 1;
    } else {
      currentLine += html[i];
      i++;
    }
  }

  // Push the last line
  if (currentLine || lines.length > 0) {
    lines.push(currentLine);
  }

  return lines;
}

/**
 * Highlight an array of code lines as a contiguous block, returning
 * an array of HTML strings (one per input line).
 *
 * If the language is unknown or highlighting fails, returns the original
 * lines HTML-escaped.
 */
export function highlightLines(lines: string[], language: string | undefined): string[] {
  if (!language || lines.length === 0) {
    return lines.map(escapeHtml);
  }

  try {
    const code = lines.join('\n');
    const result = hljs.highlight(code, { language, ignoreIllegals: true });
    return splitHighlightedLines(result.value);
  } catch {
    return lines.map(escapeHtml);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
