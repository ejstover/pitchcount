import { writeFileSync } from 'node:fs'
import { catalog, categories } from '../src/achievements/catalog.ts'
import { awardSvg } from '../src/achievements/art.ts'
const rows=catalog.map(d=>`| ${d.id} | ${d.title} | ${categories[d.category]} | ${d.tier} | ${d.requirement} | ${d.scope} | ${d.evidence} |`)
writeFileSync(new URL('../docs/ACHIEVEMENT-CATALOG.md',import.meta.url),`# Pitchwork achievement catalog\n\nGenerated from the executable catalog. 400 definitions, 80 families, five tiers per family. Recurring editions retain these IDs.\n\n| ID | Award | Category | Tier | Requirement | Collection | Evidence |\n|---|---|---|---|---|---|---|\n${rows.join('\n')}\n`)
const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
const art=[]
const familyIds=[1,9,41]
for(let row=0;row<3;row++){
  const defs=catalog.filter(d=>d.family===familyIds[row]), y=220+row*270
  art.push(`<text x="60" y="${y}" fill="#d8e3ea" font-size="20" font-weight="700">${escape(defs[0].name)}</text>`)
  defs.forEach((d,col)=>{const x=55+col*218;art.push(awardSvg(d,'preview-'+d.artwork).replace('<svg ',`<svg x="${x}" y="${y+12}" width="200" height="200" `));art.push(`<text x="${x+100}" y="${y+239}" text-anchor="middle" fill="#a9bfc9" font-size="14">${d.threshold}${d.requirement.includes('%')?'%':''} · TIER ${['I','II','III','IV','V'][d.tier-1]}</text>`)})
}
writeFileSync(new URL('../docs/achievement-awards-preview.svg',import.meta.url),`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1080" viewBox="0 0 1200 1080"><rect width="1200" height="1080" fill="#101c2c"/><path d="M60 163h1080" stroke="#34505b"/><g font-family="Segoe UI, sans-serif"><text x="60" y="62" fill="#5cffe0" font-size="16" font-weight="700" letter-spacing="4">PITCHWORK / THE COLLECTION</text><text x="60" y="120" fill="#fff" font-size="42" font-weight="700" letter-spacing="-1">Your work. Worth collecting.</text><text x="60" y="1042" fill="#92aab8" font-size="14">80 original family emblems · 400 tier designs · private, collectible, shareable</text>${art.join('')}</g></svg>`)
console.log('Generated the 400-award reference catalog and 15-design visual preview.')
