import { catalog } from './catalog.ts'
import type { AchievementDefinition } from './types.ts'
const motifs = [
  '<circle cx="128" cy="120" r="33"/><path d="M110 90q35 30 0 61m36-61q-35 30 0 61"/>',
  '<path d="M98 149l60-60 13 13-60 60zM104 143l12 12m30-56 13 13"/>',
  '<circle cx="128" cy="123" r="34"/><circle cx="128" cy="123" r="19"/><circle cx="128" cy="123" r="4"/>',
  '<path d="M103 91h50v29q0 26-25 30-25-4-25-30zM103 99H89v13q0 18 22 18m42-31h14v13q0 18-22 18m-17 20v15m-21 0h42"/>',
  '<path d="M99 151V91l64 13-64 20m0 27h37"/>',
  '<path d="M128 85l12 24 27 4-20 19 5 27-24-13-24 13 5-27-20-19 27-4z"/>',
  '<path d="M101 98h54v49h-54zM101 112h54m-41-23v17m28-17v17m-27 18h3m12 0h3m-18 12h3m12 0h3"/>',
  '<path d="M97 142l20-20 18 13 26-41m-21 0h21v22M97 154h66"/>',
  '<path d="M108 156h40l12-39-19-8-13-28-13 28-19 8zM112 137h32m-16-27v30"/>',
  '<path d="M95 104q18-12 33 1 15-13 33-1v46q-18-12-33 1-15-13-33-1zM128 105v46"/>',
  '<path d="M94 124q34-51 68 0-34 51-68 0z"/><circle cx="128" cy="124" r="12"/>',
  '<path d="M97 136l22 19 41-52-13-10-29 38-10-9z"/>',
  '<path d="M99 153V98h58v55zM109 113h37m-37 13h30m-30 13h21"/>',
  '<path d="M99 143q-3-21 15-25V96q0-9 8-9t8 9v16l9-21q7-11 13-3t0 14l-7 17q21 3 18 20-9 22-35 22-17 0-29-18z"/>',
  '<path d="M94 144l34-56 34 56zM105 144h46M128 111v19m0 8v2"/>',
  '<path d="M96 119q0-23 20-23 12 0 12 12 0-12 12-12 20 0 20 23 0 18-32 39-32-21-32-39z"/>',
  '<path d="M100 145q-13-33 17-49l11 26 11-26q30 16 17 49l-28 17zM112 147l16-25 16 25"/>',
  '<path d="M102 157V92l53 17-53 17m0 16 53-16v26z"/>',
  '<circle cx="112" cy="105" r="11"/><circle cx="145" cy="105" r="11"/><path d="M92 151v-17q20-25 40 0v17m-8-21q23-21 40 4v17"/>',
  '<path d="M99 153l15-64h28l15 64-29-15zM114 109h28m-33 22 19-9 19 9"/>',
]
const shields = [ 'M128 23L215 60 204 166 128 229 52 166 41 60Z', 'M128 22L211 69 211 167 128 228 45 167 45 69Z', 'M128 23C193 23 218 59 212 126S165 213 128 229C91 213 50 193 44 126S63 23 128 23Z', 'M78 29H178L220 100 198 185 128 229 58 185 36 100Z' ]
export function awardSvg(def: AchievementDefinition, uniqueId=def.artwork): string {
  const f=def.family-1, t=def.tier, pink=def.category%2===0, accent=pink?'#ff4ca4':'#b899ff', mint='#5cffe0', foil=['#d0b3a1','#d9e2f5','#ffd780','#c6fff3','#ffffff'][t-1]
  const ring=Array.from({length:8+f%9},(_,i)=>{const a=i*Math.PI*2/(8+f%9);return `<path d="M${128+75*Math.cos(a)} ${124+75*Math.sin(a)}l${4*Math.cos(a)} ${4*Math.sin(a)}"/>`}).join('')
  const marks=Array.from({length:t},(_,i)=>`<path d="M${128+(i-(t-1)/2)*15} 180l4 6-4 6-4-6Z"/>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img"><defs><linearGradient id="foil-${uniqueId}" x2="1" y2="1"><stop stop-color="${foil}"/><stop offset=".35" stop-color="${accent}"/><stop offset=".55" stop-color="${foil}"/><stop offset="1" stop-color="${mint}"/></linearGradient><pattern id="weave-${uniqueId}" width="4" height="4" patternUnits="userSpaceOnUse"><path d="M0 0l4 4" stroke="#fff" stroke-opacity=".06"/></pattern></defs><path d="${shields[f%4]}" fill="#101c2c" stroke="url(#foil-${uniqueId})" stroke-width="${5+t}"/><path d="${shields[f%4]}" fill="url(#weave-${uniqueId})" transform="translate(128 126) scale(.88) translate(-128 -126)" stroke="${accent}" stroke-width="2" stroke-dasharray="3 4"/><g fill="none" stroke="${mint}" stroke-width="2" opacity=".65">${ring}</g><circle cx="128" cy="123" r="${48+f%4}" fill="${accent}" fill-opacity=".12" stroke="${accent}" stroke-width="1"/><g fill="none" stroke="${foil}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" transform="rotate(${(Math.floor(f/20)-1)*4} 128 123)">${motifs[f%20]}</g><g fill="${mint}" stroke="#101c2c" stroke-width="1">${marks}</g><path d="M77 71l5-8 5 8-5 8zM169 71l5-8 5 8-5 8z" fill="${accent}"/>${t>=4?'<path d="M65 168l20 16m106-16-20 16" stroke="'+foil+'" stroke-width="4"/>':''}${t===5?'<path d="M128 38l7 10-7 10-7-10z" fill="'+mint+'"/>':''}</svg>`
}
export const awardArtManifest = Object.fromEntries(catalog.map(def=>[def.artwork,()=>awardSvg(def)]))
