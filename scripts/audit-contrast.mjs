import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function parseColor(value) {
  const s = value.trim().toLowerCase();
  if (s === 'white') return [255,255,255,1];
  if (s === 'black') return [0,0,0,1];
  if (s === 'transparent') return [0,0,0,0];
  if (/^#[\da-f]{3,4}$/.test(s)) return parseColor('#' + [...s.slice(1)].map(c => c+c).join(''));
  if (/^#[\da-f]{6}([\da-f]{2})?$/.test(s)) return [1,3,5].map(i => parseInt(s.slice(i,i+2),16)).concat(s.length === 9 ? parseInt(s.slice(7),16)/255 : 1);
  const match = s.match(/^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/);
  if (match) return [Number(match[1]),Number(match[2]),Number(match[3]),match[4] === undefined ? 1 : Number(match[4])];
  throw new Error(`Unresolved color: ${value}`);
}
export function composite(fg, bg) {
  const a = fg[3] + bg[3]*(1-fg[3]);
  return [...fg.slice(0,3).map((v,i) => a ? (v*fg[3]+bg[i]*bg[3]*(1-fg[3]))/a : 0), a];
}
function luminance(color) {
  return color.slice(0,3).map(v => { const c=v/255; return c<=0.04045 ? c/12.92 : ((c+0.055)/1.055)**2.4; }).reduce((n,v,i) => n+v*[0.2126,0.7152,0.0722][i],0);
}
export function contrast(foreground, background, underlay = '#fff') {
  const bg = composite(parseColor(background),parseColor(underlay));
  const fg = composite(parseColor(foreground),bg);
  const [a,b] = [luminance(fg),luminance(bg)].sort((a,b)=>b-a);
  return (a+0.05)/(b+0.05);
}
export function readThemes() {
  const css=readFileSync(new URL('../src/renderer/tokens.css',import.meta.url),'utf8');
  const blocks=[...css.matchAll(/:root(?:\[data-theme="dark"\])?\s*\{([^}]+)\}/g)].map(m => Object.fromEntries([...m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(x=>[x[1],x[2].trim()])));
  if(blocks.length!==2) throw new Error('Expected light and dark token blocks');
  return { light:blocks[0], dark:{...blocks[0],...blocks[1]} };
}
const surfaces=['--bg-app','--bg-sidebar','--bg-subtle','--bg-tint','--bg-surface','--accent-soft'];
// Explicit usage families from style.css. All small UI text requires 4.5.
export const pairs = [
  ...['--text-primary','--text-secondary','--text-muted','--accent-text','--reader-text','--success','--warn','--danger'].flatMap(fg => surfaces.map(bg=>({name:`${fg} / ${bg}`,fg,bg,min:4.5}))),
  ...['success','warn','danger'].map(s=>({name:`${s} status`,fg:`--${s}`,bg:`--${s}-bg`,min:4.5})),
  ...['--accent','--accent-hover'].map(bg=>({name:`primary button ${bg}`,fg:'white',bg,min:4.5})),
  ...['--text-primary','--text-secondary','--text-muted','--reader-text'].map(fg=>({name:`selection ${fg}`,fg,bg:'--selection',min:4.5})),
  ...['--diff-add-bg','--diff-remove-bg'].flatMap(bg=>['--text-primary','--text-muted'].map(fg=>({name:`diff ${fg} / ${bg}`,fg,bg,min:4.5}))),
  {name:'book cover title',fg:'--cover-text',bg:'--cover-bg',min:4.5},
  ...surfaces.map(bg=>({name:`necessary control boundary / ${bg}`,fg:'--border-strong',bg,min:3})),
  ...surfaces.map(bg=>({name:`necessary focus / ${bg}`,fg:'--focus-ring',bg,min:3})),
];
export const exclusions = ['Disabled controls: inactive, opacity 0.5', 'Decorative marks: mark-welcome, mark-empty, cover-spine', 'Decorative separators, quotes and diff borders; text also labels their meaning', 'Scrim and modal shadow: no text rendered on these layers'];
export function validateTextUsage(css) {
  const known = new Set(pairs.map(p => p.fg).concat(['--mark-welcome','--mark-empty']));
  for (const match of css.matchAll(/(?:^|[;{])\s*color\s*:\s*([^;}]+)/g)) {
    const value=match[1].trim();
    const variable=value.match(/^var\((--[\w-]+)\)$/)?.[1];
    if (variable ? !known.has(variable) : !['white','black','inherit','currentColor'].includes(value)) {
      throw new Error(`Unclassified text color: ${value}`);
    }
  }
}
export function audit(themes) {
  return Object.entries(themes).flatMap(([theme,tokens])=>pairs.map(pair=>{
    const value = name => name.startsWith('--') ? tokens[name] ?? (()=>{throw new Error(`Missing ${name}`);})() : name;
    const ratio=contrast(value(pair.fg),value(pair.bg),tokens['--bg-app']);
    return {theme,...pair,ratio,pass:ratio>=pair.min};
  }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  validateTextUsage(readFileSync(new URL('../src/renderer/style.css',import.meta.url),'utf8'));
  const rows=audit(readThemes()), failures=rows.filter(r=>!r.pass);
  for(const row of failures) console.error(`${row.theme}: ${row.name}: ${row.ratio.toFixed(3)} < ${row.min}`);
  console.log(`${rows.length-failures.length}/${rows.length} contrast pairs passed (light/dark).`);
  console.log(`Excluded: ${exclusions.join('; ')}`);
  if(failures.length) process.exitCode=1;
}
