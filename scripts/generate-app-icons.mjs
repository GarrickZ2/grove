/** SVG masters + desktop PNGs. Requires sharp; see src-tauri/icons/README.md. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const { default: sharp } = await import(process.env.GROVE_SHARP_MODULE || 'sharp');
const root = fileURLToPath(new URL('../', import.meta.url));
const catalog = JSON.parse(await readFile(path.join(root, 'src-tauri/icons/variants/catalog.json'), 'utf8'));
const palette = {
  canopy: ['#fbf5e9', '#e5edda', '#102e2a', '#071b1b'],
  orbit: ['#f2f7ff', '#dfe9ff', '#182847', '#0c162b'],
  prism: ['#f8f5ff', '#e4e3fa', '#27233e', '#141522'],
  constellation: ['#f2f0ff', '#e4e6ff', '#202449', '#10152b'],
  moss: ['#e9f9ef', '#d2ecdf', '#163b35', '#0b2525'],
  terrarium: ['#f6f2ff', '#e6def5', '#292d4a', '#131b32'],
  origami: ['#fff6e8', '#eee1ca', '#39332d', '#201d1e'],
  pixel: ['#eff5ff', '#dce8ee', '#24394b', '#122433'],
  bamboo: ['#f2f6e7', '#dce9cf', '#233c30', '#10261e'],
  firefly: ['#f4f0ff', '#e2e8fa', '#252747', '#12182c'],
  treehouse: ['#fff5e8', '#e9e8d4', '#29392f', '#15251f'],
};
function glyph(id, dark) {
  const ink = dark ? '#bdffdc' : '#15654c';
  const mint = dark ? '#6ce7b0' : '#2fae79';
  const gold = dark ? '#ffe29b' : '#e6aa3b';
  switch(id) {
    case 'canopy': return `
      <ellipse cx="256" cy="391" rx="104" ry="13" fill="${ink}" opacity=".10"/>
      <path d="M256 370V228m0 75-79-62m79 43 79-73" stroke="${ink}" stroke-width="22" fill="none" stroke-linecap="round"/>
      <path d="M242 267C156 280 111 231 132 184c29-47 109-39 128 36" fill="url(#green)"/>
      <path d="M264 258c90 6 139-49 107-98-34-41-112-18-125 47" fill="${mint}"/>
      <path d="M255 240c-67-35-66-97-21-118 49-20 96 30 62 85Z" fill="${dark ? '#c9f7af' : '#a6d97c'}"/>
      <path d="m255 238 1-91M237 244l-74-43m111 33 66-44" stroke="${ink}" stroke-width="5" opacity=".25" fill="none" stroke-linecap="round"/>
      <circle cx="362" cy="300" r="13" fill="${gold}"/>`;
    case 'orbit': return `
      <circle cx="256" cy="256" r="72" fill="url(#green)"/>
      <circle cx="234" cy="233" r="17" fill="#e4ffe9" opacity=".65"/>
      <g fill="none" stroke="${dark ? '#9bbaff' : '#5d7ac3'}" stroke-width="10">
        <ellipse cx="256" cy="256" rx="150" ry="58" transform="rotate(-32 256 256)"/>
        <ellipse cx="256" cy="256" rx="148" ry="59" transform="rotate(51 256 256)" opacity=".52"/>
      </g>
      <path d="M196 202c-22 18-31 48-24 72" stroke="${ink}" stroke-width="7" stroke-linecap="round" opacity=".3" fill="none"/>
      <circle cx="383" cy="183" r="18" fill="${gold}"/>
      <circle cx="180" cy="133" r="12" fill="${dark ? '#bdaaff' : '#9164ca'}"/>
      <circle cx="157" cy="323" r="15" fill="${mint}"/>`;
    case 'prism': return `
      <path d="m126 311 130-74 130 74-130 78Z" fill="${dark ? '#9c89f2' : '#8572d8'}"/>
      <path d="m126 311 130 34 130-34-130 78Z" fill="#534e9c" opacity=".26"/>
      <path d="m126 249 130-75 130 75-130 77Z" fill="${dark ? '#81baff' : '#6596df'}"/>
      <path d="m126 249 130 34 130-34-130 77Z" fill="#325e9f" opacity=".25"/>
      <path d="m126 186 130-75 130 75-130 77Z" fill="url(#green)"/>
      <path d="m126 186 130 34 130-34-130 77Z" fill="#126f63" opacity=".24"/>
      <path d="m216 161 40-23 42 24" stroke="#effff6" stroke-width="7" opacity=".6" stroke-linecap="round" fill="none"/>
      <circle cx="384" cy="129" r="12" fill="${gold}"/>`;
    case 'constellation': return `
      <g stroke="${dark ? '#7789ba' : '#9ea9cf'}" stroke-width="7" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <path d="m256 375-3-110-98-55m98 55 100-55m-100 55 3-134m-101 79 40-67m158 67-39-66m-159 66-32 89m230-89 34 89"/>
        <path d="m195 143 61-12 58 13" opacity=".45"/>
      </g>
      <g fill="${mint}"><circle cx="155" cy="210" r="25"/><circle cx="353" cy="210" r="25"/><circle cx="256" cy="265" r="29"/></g>
      <g fill="${gold}"><circle cx="256" cy="131" r="19"/><circle cx="195" cy="143" r="10"/><circle cx="314" cy="144" r="10"/></g>
      <g fill="${dark ? '#b1baff' : '#7f80c4'}"><circle cx="123" cy="299" r="15"/><circle cx="387" cy="299" r="15"/><circle cx="256" cy="375" r="17"/></g>
      <path d="m392 122 4 12 12 4-12 4-4 12-4-12-12-4 12-4Z" fill="${gold}"/>`;
    case 'moss': return `
      <ellipse cx="256" cy="388" rx="101" ry="12" fill="${ink}" opacity=".1"/>
      <path d="M256 184v-35" stroke="${ink}" stroke-width="13" stroke-linecap="round"/>
      <path d="M256 154c-48 3-66-23-55-46 37-1 61 17 55 46" fill="${mint}"/>
      <path d="M257 148c-3-37 22-57 55-51 9 28-18 56-55 51" fill="${dark ? '#c5ed9c' : '#96c66f'}"/>
      <path d="M150 259h-17m246 0h-17" stroke="${mint}" stroke-width="23" stroke-linecap="round"/>
      <rect x="151" y="178" width="210" height="177" rx="58" fill="url(#green)"/>
      <rect x="175" y="211" width="162" height="102" rx="35" fill="${dark ? '#133930' : '#185a49'}"/>
      <g fill="#d1ffe6"><rect x="207" y="240" width="17" height="30" rx="8"/><rect x="288" y="240" width="17" height="30" rx="8"/></g>
      <path d="M247 285q9 8 18 0" stroke="#d1ffe6" stroke-width="5" stroke-linecap="round" fill="none"/>
      <path d="M211 355v15m90-15v15" stroke="${mint}" stroke-width="20" stroke-linecap="round"/>
      <circle cx="335" cy="337" r="9" fill="${gold}"/>`;
    case 'terrarium': return `
      <path d="M137 344V228a119 119 0 0 1 238 0v116Z" fill="${dark ? '#7da7a9' : '#fff'}" opacity="${dark ? '.16' : '.65'}"/>
      <path d="M137 344V228a119 119 0 0 1 238 0v116" stroke="${dark ? '#8bb4cc' : '#b0bdd3'}" stroke-width="10" fill="none"/>
      <circle cx="305" cy="189" r="25" fill="${gold}"/>
      <path d="M155 341q100-77 202 0Z" fill="${dark ? '#285b55' : '#a3c9a3'}"/>
      <path d="m191 233-39 77h78Z" fill="${mint}"/>
      <path d="m256 194-53 119h106Z" fill="url(#green)"/>
      <path d="m320 251-32 66h65Z" fill="${dark ? '#a8e0a8' : '#78b07c'}"/>
      <path d="M191 304v33m65-34v35m64-28v27" stroke="${ink}" stroke-width="9" stroke-linecap="round"/>
      <path d="M129 345h254v24a14 14 0 0 1-14 14H143a14 14 0 0 1-14-14Z" fill="${dark ? '#aca0d4' : '#a297c3'}"/>
      <path d="M161 219q2-44 35-66" stroke="#fff" opacity=".5" stroke-width="7" fill="none" stroke-linecap="round"/>`;
    case 'origami': return `
      <path d="m150 159 180-39 49 82-158-10-32 106 155 11-73 72-149-55Z" fill="url(#green)"/>
      <path d="m150 159 71 33-32 106-67 28Z" fill="${dark ? '#419683' : '#1d7f6c'}"/>
      <path d="m150 159 180-39-41 61-68 11Z" fill="${dark ? '#bcf4ad' : '#a1d582'}"/>
      <path d="m330 120 49 82-90-21Z" fill="${dark ? '#e5f9c5' : '#d7eab9'}"/>
      <path d="m189 298 155 11-73 72Z" fill="${dark ? '#5ccfa5' : '#3cba8c'}"/>
      <path d="m344 309-73 72 17-63Z" fill="${dark ? '#266e61' : '#1b7d67'}"/>
      <path d="m263 249 116-47-35 107-46-39Z" fill="${gold}"/>
      <path d="m298 270 81-68-35 107Z" fill="${dark ? '#c8974c' : '#cc9036'}"/>`;
    case 'bamboo': return `
      <ellipse cx="256" cy="386" rx="110" ry="13" fill="${ink}" opacity=".10"/>
      <g fill="none" stroke-linecap="round">
        <path d="m184 370-8-180m83 180V132m74 238 11-164" stroke="${mint}" stroke-width="24"/>
        <path d="m174 246 15-1m-12 66 15-1m59-113h16m-16 78h16m-16 64h16m64-81 16 1m-20 68 16 1" stroke="${ink}" stroke-width="6" opacity=".45"/>
      </g>
      <path d="M255 208c-57-5-91-38-91-77 50 1 83 28 91 77" fill="url(#green)"/>
      <path d="M262 251c12-56 44-83 88-81-6 48-34 76-88 81" fill="${dark ? '#c4eba3' : '#a0c878'}"/>
      <path d="M181 294c-49-5-73-27-76-60 38-1 64 20 76 60m151 38c5-42 26-67 60-70-1 36-22 61-60 70" fill="${mint}"/>
      <circle cx="350" cy="132" r="16" fill="${gold}"/>`;
    case 'firefly': return `
      <circle cx="258" cy="296" r="96" fill="${gold}" opacity=".09"/>
      <circle cx="258" cy="296" r="69" fill="${gold}" opacity=".12"/>
      <path d="M245 224c-75-86-130-51-105 2 18 34 61 45 105 32m25-34c75-86 130-51 105 2-18 34-61 45-105 32" fill="${dark ? '#9cb7f5' : '#94a9e1'}" opacity=".75"/>
      <path d="m243 183-17-27m44 27 17-27" fill="none" stroke="${ink}" stroke-width="9" stroke-linecap="round"/>
      <rect x="226" y="198" width="64" height="126" rx="32" fill="${ink}"/>
      <path d="M226 271h64v23a32 32 0 0 1-64 0Z" fill="${gold}"/>
      <path d="M216 354q40 26 84 0" fill="none" stroke="${gold}" stroke-width="7" stroke-linecap="round" opacity=".5"/>
      <g fill="${gold}"><circle cx="141" cy="318" r="10"/><circle cx="364" cy="144" r="9"/><path d="m159 126 4 13 13 4-13 4-4 13-4-13-13-4 13-4Z"/></g>`;
    case 'treehouse': return `
      <ellipse cx="256" cy="389" rx="111" ry="13" fill="${ink}" opacity=".10"/>
      <path d="M256 373V241m0 57-70-62m70 35 73-70" fill="none" stroke="${ink}" stroke-width="23" stroke-linecap="round"/>
      <path d="M173 260c-62-1-77-59-38-86-4-49 59-78 99-52 35-43 103-28 113 18 56 3 70 67 23 94-44 34-151 42-197 26" fill="url(#green)"/>
      <path d="M182 246h148v87H182Z" fill="${dark ? '#edc991' : '#e5bc7b'}"/>
      <path d="m164 249 92-79 92 79" fill="${dark ? '#a0c7bb' : '#528c7a'}" stroke="${ink}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
      <rect x="233" y="271" width="45" height="62" rx="8" fill="${ink}"/>
      <rect x="195" y="270" width="25" height="28" rx="5" fill="${gold}"/>
      <path d="M172 336h169m-47 9v36m24-36v36m-24-23h24m-24 15h24" fill="none" stroke="${ink}" stroke-width="8" stroke-linecap="round"/>
      <circle cx="366" cy="120" r="16" fill="${gold}"/>`;
    case 'pixel': return `
      <g shape-rendering="crispEdges">
        <path d="M136 348h240v32H136Z" fill="${dark ? '#56764f' : '#8aad78'}"/>
        <path d="M160 220h32v-32h32v-32h64v32h32v32h32v64h-48v32h-96v-32h-48Z" fill="${mint}"/>
        <path d="M160 252h48v32h96v-32h48v32h-48v32h-96v-32h-48Z" fill="${dark ? '#2d9d83' : '#168866'}"/>
        <path d="M240 284h32v64h-32Z" fill="${dark ? '#dba97a' : '#aa7b50'}"/>
        <path d="M208 188h32v-16h32v32h-32v16h-32Z" fill="${dark ? '#c0f5a0' : '#99d67a'}"/>
        <path d="M112 124h16v-16h16v16h16v16h-16v16h-16v-16h-16Z" fill="${gold}"/>
        <path d="M352 160h32v32h-32Zm-16 160h16v16h-16ZM176 332h16v16h-16Z" fill="${dark ? '#a4b8e1' : '#7298bf'}"/>
      </g>`;
  }
}
for (const design of catalog) {
  for (const mode of ['light', 'dark']) {
    const dark = mode === 'dark';
    let svg;
    if (design.id === 'classic') {
      const source = await readFile(path.join(root, `grove-web/public/favicon${dark ? '' : '-light'}.svg`), 'utf8');
      const body = source.replace(/^<svg\b[^>]*>/, '').replace(/<\/svg>\s*$/, '');
      svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 512 512" width="512" height="512"><g transform="translate(48 48) scale(${416 / 378}) translate(-322 -38)">${body}</g></svg>`;
    } else {
      const [l1,l2,d1,d2] = palette[design.id];
      svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
        <title>Grove · ${design.name} · ${mode}</title>
        <defs>
          <linearGradient id="bg" x2=".8" y2="1"><stop stop-color="${dark ? d1 : l1}"/><stop offset="1" stop-color="${dark ? d2 : l2}"/></linearGradient>
          <linearGradient id="green" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${dark ? '#b4f5b0' : '#78d29b'}"/><stop offset="1" stop-color="${dark ? '#3dbfa0' : '#199b7a'}"/></linearGradient>
        </defs>
        <rect x="48" y="52" width="416" height="416" rx="94" fill="#000" opacity="${dark ? '.3' : '.08'}"/>
        <rect x="48" y="48" width="416" height="416" rx="94" fill="url(#bg)"/>
        <rect x="49" y="49" width="414" height="414" rx="93" fill="none" stroke="${dark ? '#fff' : '#fff'}" stroke-opacity="${dark ? '.1' : '.85'}" stroke-width="2"/>
        ${glyph(design.id, dark)}
      </svg>`;
    }
    await writeFile(path.join(root, `grove-web/public/app-icons/${design.id}-${mode}.svg`), svg);
    await sharp(Buffer.from(svg)).resize(1024,1024).png().toFile(path.join(root, `src-tauri/icons/variants/${design.id}-${mode}.png`));
    // Menu-bar icons fill the status item's canvas, matching the original
    // 32px tray asset. Desktop/Dock padding belongs only to desktop assets.
    const traySvg = svg.replace('viewBox="0 0 512 512"', 'viewBox="48 48 416 416"');
    await sharp(Buffer.from(traySvg)).resize(64,64).png().toFile(path.join(root, `src-tauri/icons/variants/${design.id}-${mode}-tray.png`));
  }
}
// A reviewable contact sheet with both variants side by side.
const cell=150, width=catalog.length*cell, height=390;
const cells=[];
for (const [i,design] of catalog.entries()) {
  for (const [j,mode] of ['light','dark'].entries()) {
    const asset=await readFile(path.join(root,`grove-web/public/app-icons/${design.id}-${mode}.svg`));
    cells.push({input:await sharp(asset).resize(140,140).png().toBuffer(),left:i*cell+5,top:j*190+20});
  }
}
let labels='';
for (const [i,design] of catalog.entries()) for (const [j,mode] of ['Light','Dark'].entries()) labels+=`<text x="${i*cell+cell/2}" y="${j*190+169}" text-anchor="middle" font-family="sans-serif" font-weight="600" font-size="14" fill="${j ? '#edf4f1' : '#253b35'}">${design.name}</text><text x="${i*cell+cell/2}" y="${j*190+186}" text-anchor="middle" font-family="sans-serif" font-size="10" fill="${j ? '#9eafa9' : '#76877e'}">${mode}</text>`;
const board=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><path fill="#f2f4ef" d="M0 0h${width}v190H0Z"/><path fill="#131f22" d="M0 190h${width}v200H0Z"/>${labels}</svg>`);
await mkdir(path.join(root,'docs/app-icons'),{recursive:true});
await sharp(board).composite(cells).png().toFile(path.join(root,'docs/app-icons/collection.png'));
console.log(`Generated ${catalog.length} icon designs × light/dark, plus contact sheet.`);
