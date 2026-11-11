import { catalog } from './catalog.ts'
import type { AchievementDefinition } from './types.ts'

// Category colorways and a shared optical weight keep all 400 editions cohesive.
const colors = [
  ['#2563eb', '#c5ed65'], ['#087e87', '#a7eee3'],
  ['#e05c27', '#ffe1ae'], ['#2563eb', '#a8ddff'],
  ['#6849bb', '#e3d6ff'], ['#087e87', '#c5ed65'],
  ['#3159c9', '#bdd8ff'], ['#24735d', '#d3edb3'],
  ['#a84335', '#ffd3a6'], ['#86520f', '#ffe099'],
]
// Original symbols on a 64-unit grid; the center mark stays legible at card size.
const symbols = {
  ball: '<circle cx="32" cy="32" r="25"/><path d="M17 12c20 11 20 29 0 40M47 12C27 23 27 41 47 52M20 20l-6 5m12 5-7 2m7 10-6-2m24-20 6 5m-12 5 7 2m-7 10 6-2"/>',
  pitch: '<path d="m7 46 24-24m-17 3 12-12M6 34l10-10m16 31 12-12"/><circle cx="43" cy="21" r="14"/><path d="M37 9c10 7 10 17 0 24"/>',
  calendar: '<rect x="9" y="13" width="46" height="43" rx="5"/><path d="M9 26h46M22 7v13M42 7v13m-23 22 8 8 17-17"/>',
  season: '<path d="m32 5 23 13v28L32 59 9 46V18Z"/><path d="m20 33 8 8 17-18"/>',
  book: '<path d="M32 17C20 10 13 11 6 14v36c9-3 17-3 26 4 9-7 17-7 26-4V14c-7-3-14-4-26 3v37M16 24l8 2m-8 9 8 2m16-11 8-2m-8 13 8-2"/>',
  trophy: '<path d="M18 8h28v18c0 12-6 18-14 18s-14-6-14-18ZM18 15H7v9c0 10 6 15 15 15m24-24h11v9c0 10-6 15-15 15M32 44v12M20 57h24"/>',
  stack: '<path d="m6 22 26-14 26 14-26 14ZM6 33l26 14 26-14M6 44l26 14 26-14"/>',
  target: '<circle cx="32" cy="32" r="25"/><circle cx="32" cy="32" r="14"/><circle cx="32" cy="32" r="3" fill="currentColor" stroke="none"/><path d="M32 2v9m0 42v9M2 32h9m42 0h9"/>',
  check: '<path d="m8 33 15 15 33-33" stroke-width="9"/>',
  plan: '<rect x="13" y="10" width="38" height="47" rx="4"/><path d="M24 7h16v10H24Zm0 23h15M24 40h7m6 6 7 7 14-17"/>',
  balance: '<path d="M32 8v46M20 56h24M10 18h44M14 18 4 39h20Zm36 0L40 39h20Z"/>',
  bolt: '<path d="M36 5 12 36h17l-2 23 25-34H35Z" fill="currentColor" stroke="none"/>',
  flag: '<path d="M14 58V8m0 2h36l-8 12 8 12H14"/>',
  shield: '<path d="m32 5 23 9v20c0 12-10 20-23 26C19 54 9 46 9 34V14Z"/><path d="m21 31 8 8 15-17"/>',
  sequence: '<path d="m7 18 12 14L7 46m19-28 12 14-12 14m19-28 12 14-12 14"/>',
  climb: '<path d="M6 52h13V39h13V26h13V13h13M12 21 27 6m-15 0h15v15"/>',
  rise: '<path d="m6 47 17-17 12 9 23-27M41 12h17v17M7 58h51"/>',
  record: '<path d="m32 5 8 16 18 3-13 13 3 19-16-9-16 9 3-19L6 24l18-3Z" fill="currentColor" stroke="none"/>',
  reset: '<path d="M11 22A23 23 0 1 1 9 42M10 7v17h17M32 19v15l10 6"/>',
  combo: '<path d="m17 10 15 8v18l-15 8-15-8V18Zm30 10 15 8v18l-15 8-15-8V28Z"/>',
  flask: '<path d="M24 7h16M27 7v18L10 49q-4 8 6 8h32q10 0 6-8L37 25V7M19 38h26"/><path d="m27 48 5-5 5 5"/>',
  stance: '<circle cx="32" cy="12" r="7"/><path d="M32 23v16M15 29l17-6 17 6M32 39 17 56m15-17 15 17"/>',
  finish: '<path d="M13 57V7m0 1h42v28H13"/><path d="M14 9h13v13H14Zm26 0h13v13H40ZM27 22h13v13H27Z" fill="currentColor" stroke="none"/>',
  glove: '<path d="M18 34V15q0-7 7-7v22-19q0-7 7-7t7 7v19-15q0-7 7-7v26l5-10q4-6 9 0l-5 23q-4 12-20 12T14 47L5 34q-2-6 4-7Z"/>',
  left: '<path d="M55 32H9m17-18L8 32l18 18" stroke-width="7"/>',
  right: '<path d="M9 32h46M38 14l18 18-18 18" stroke-width="7"/>',
  sun: '<circle cx="32" cy="32" r="14"/><path d="M32 3v7m0 44v7M3 32h7m44 0h7M11 11l5 5m32 32 5 5M11 53l5-5m32-32 5-5"/>',
  moon: '<path d="M48 42A25 25 0 0 1 23 8 25 25 0 1 0 56 41Z"/><path d="M45 7v12m-6-6h12"/>',
  heart: '<path d="M32 55 9 33C-6 16 15 0 32 18 49 0 70 16 55 33Z"/><path d="M12 32h12l5-10 7 20 5-10h11"/>',
  rest: '<path d="M12 11h13v42H12Zm27 0h13v42H39Z" fill="currentColor" stroke="none"/>',
  adapt: '<path d="M13 54V37q0-10 10-10h26M37 15l13 12-13 12M13 10v8m0-8-7 7m7-7 7 7"/>',
  gear: '<path d="M11 20h42v37H11Zm10 0v-8h22v8M11 32h42M26 29h12v8H26Z"/>',
  focus: '<path d="M8 23V8h15m18 0h15v15M8 41v15h15m18 0h15V41"/><circle cx="32" cy="32" r="10"/><circle cx="32" cy="32" r="2" fill="currentColor"/>',
  journal: '<path d="M13 7h37v50H13Zm-5 9h10m-10 12h10M8 40h10m8-22h15m-15 12h15m-15 12h10"/>',
  light: '<path d="M22 44c0-9-9-10-9-22a19 19 0 0 1 38 0c0 12-9 13-9 22ZM23 51h18m-16 7h14M32 20v16m-7-9 7 9 7-9"/>',
  eye: '<path d="M3 32Q32-7 61 32 32 71 3 32Z"/><circle cx="32" cy="32" r="11"/>',
  chat: '<path d="M8 9h48v33H29L14 55V42H8Z"/><path d="M19 21h26M19 31h17"/>',
  team: '<circle cx="32" cy="15" r="9"/><path d="M17 57V43c0-19 30-19 30 0v14M9 21a7 7 0 1 0 0 14m46-14a7 7 0 1 1 0 14M4 56V44m56 12V44"/>',
  hands: '<path d="m4 29 12-14 14 9-12 22Zm56 0L48 15 34 24l12 22ZM23 23l8-6 10 6M20 43l14 12 12-13M27 36l14 12"/>',
  diamond: '<path d="M32 4 60 32 32 60 4 32Z"/><path d="m24 29 8-8 8 8v14H24Z" fill="currentColor" stroke="none"/>',
}
const familySymbols: (keyof typeof symbols)[] = [
  'ball','pitch','calendar','calendar','season','book','trophy','stack',
  'pitch','pitch','check','check','plan','plan','target','balance',
  'target','target','target','target','bolt','bolt','bolt','bolt',
  'shield','shield','ball','trophy','sequence','flag','target','target',
  'rise','rise','shield','climb','sequence','climb','record','reset',
  'target','bolt','shield','target','calendar','check','journal','combo',
  'flask','bolt','plan','stance','finish','glove','left','right',
  'sun','moon','heart','rest','adapt','climb','gear','plan',
  'focus','journal','light','rise','eye','reset','chat','check',
  'team','hands','hands','chat','shield','flag','book','diamond',
]
const silhouettes = [
  'M64 22H192L226 56V176L192 218H64L30 176V56Z',
  'M128 18A110 110 0 1 1 127.99 18Z',
  'M128 16L226 72V168L128 224 30 168V72Z',
  'M42 24H214V142Q214 192 128 226 42 192 42 142Z',
]
const ranks = ['I', 'II', 'III', 'IV', 'V']

export function awardSvg(def: AchievementDefinition, uniqueId = def.artwork): string {
  const id = uniqueId.replace(/[^a-zA-Z0-9_-]/g, '')
  const [accent, highlight] = colors[def.category]
  const shape = silhouettes[(def.family - 1) % silhouettes.length]
  const marks = Array.from({length: 5}, (_, i) =>
    `<path d="M${83+i*19} 185h14l-4 9H${79+i*19}Z" fill="${i < def.tier ? highlight : '#ffffff'}" opacity="${i < def.tier ? 1 : .18}"/>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img">
    <defs><linearGradient id="surface-${id}" x1="0" y1="0" x2="0.8" y2="1"><stop stop-color="#23344c"/><stop offset="1" stop-color="#0f1928"/></linearGradient></defs>
    <path d="${shape}" fill="#0f1928" stroke="#0f1928" stroke-width="10" stroke-linejoin="round"/>
    <path d="${shape}" fill="${accent}" stroke="#f6f7f2" stroke-width="3" stroke-linejoin="round"/>
    <path d="${shape}" transform="translate(128 122) scale(.87) translate(-128 -122)" fill="url(#surface-${id})"/>
    <path d="M105 51h13l-7 12H98Zm21 0h30l-7 12h-30Z" fill="${highlight}"/>
    <g transform="translate(83 77) scale(1.4)" fill="none" stroke="${highlight}" color="${highlight}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">${symbols[familySymbols[def.family - 1]]}</g>
    <path d="M91 174h74" stroke="${accent}" stroke-width="2"/>
    ${marks}
    <text x="128" y="213" text-anchor="middle" fill="#f6f7f2" font-family="Arial,sans-serif" font-size="10" font-weight="700" letter-spacing="2">${ranks[def.tier-1]}</text>
    <text x="53" y="126" text-anchor="middle" fill="#fff" opacity=".6" font-family="Arial,sans-serif" font-size="7" font-weight="700" transform="rotate(-90 53 126)" letter-spacing="1.5">PW / ${String(def.family).padStart(2, '0')}</text>
  </svg>`
}
export const awardArtManifest = Object.fromEntries(catalog.map(def => [def.artwork, () => awardSvg(def)]))
