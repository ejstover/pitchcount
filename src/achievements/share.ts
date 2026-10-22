import type { AchievementDefinition } from './types'
import { awardSvg } from './art'
// This API deliberately accepts no player, award instance, date, note or account.
export function shareCardContent(def: AchievementDefinition) {
  return {title:def.title,requirement:def.requirement,tier:`TIER ${['I','II','III','IV','V'][def.tier-1]}`,brand:'PITCHWORK'}
}
export async function renderShareCard(def: AchievementDefinition, portrait=false): Promise<Blob> {
  const canvas=document.createElement('canvas');canvas.width=1080;canvas.height=portrait?1920:1080
  const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Image export is unavailable on this device.')
  const c=shareCardContent(def), h=canvas.height
  ctx.fillStyle='#101c2c';ctx.fillRect(0,0,1080,h)
  ctx.strokeStyle='#29404f';ctx.lineWidth=1
  for(let x=-h;x<1080;x+=48){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x+h,h);ctx.stroke()}
  ctx.strokeStyle='#5cffe0';ctx.lineWidth=3;ctx.strokeRect(35,35,1010,h-70)
  const url=URL.createObjectURL(new Blob([awardSvg(def)],{type:'image/svg+xml'}))
  try {
    const img=new Image();await new Promise<void>((resolve,reject)=>{img.onload=()=>resolve();img.onerror=()=>reject(new Error('Could not render award artwork.'));img.src=url})
    const y=portrait?340:90;ctx.drawImage(img,240,y,600,600)
    ctx.textAlign='center';ctx.fillStyle='#5cffe0';ctx.font='700 22px sans-serif';ctx.fillText(c.brand,540,portrait?200:85)
    ctx.fillStyle='#ff70b6';ctx.font='700 22px sans-serif';ctx.fillText(c.tier,540,y+640)
    ctx.fillStyle='#ffffff';ctx.font='700 38px sans-serif'
    wrap(ctx,c.title,540,y+710,920,48)
    ctx.fillStyle='#c9d6e2';ctx.font='26px sans-serif';wrap(ctx,c.requirement,540,y+810,900,40)
    ctx.fillStyle='#90a9ba';ctx.font='20px sans-serif';ctx.fillText('MAKE EVERY PITCH COUNT',540,h-80)
    return await new Promise<Blob>((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Could not export award.')),'image/png'))
  }finally{URL.revokeObjectURL(url)}
}
function wrap(ctx: CanvasRenderingContext2D,text:string,x:number,y:number,width:number,lineHeight:number){let line='';for(const word of text.split(' ')){const next=line?`${line} ${word}`:word;if(ctx.measureText(next).width>width && line){ctx.fillText(line,x,y);line=word;y+=lineHeight}else line=next}if(line)ctx.fillText(line,x,y)}
export async function shareAward(def: AchievementDefinition, portrait=false) {
  const blob=await renderShareCard(def,portrait), file=new File([blob],`pitchwork-award-${def.id}.png`,{type:'image/png'})
  if(navigator.canShare?.({files:[file]})){try{await navigator.share({files:[file]});return}catch(error){if(error instanceof DOMException && error.name==='AbortError')return;throw error}}
  downloadAward(blob,def.id)
}
export function downloadAward(blob:Blob,id:string){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`pitchwork-award-${id}.png`;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000)}
