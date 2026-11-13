import {it,expect} from 'vitest'
import {readFileSync,existsSync} from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

it('keeps the complete Edge Function module graph resolvable by Deno, including type imports',()=>{
 const queue=['supabase/functions/accounts/index.ts','supabase/functions/achievements/index.ts'].map(f=>path.resolve(f)),seen=new Set<string>()
 while(queue.length){
  const file=queue.pop()!;if(seen.has(file))continue;seen.add(file)
  const ast=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true)
  for(const node of ast.statements){
   if(!ts.isImportDeclaration(node)&&!ts.isExportDeclaration(node))continue
   const specifier=node.moduleSpecifier
   if(!specifier||!ts.isStringLiteral(specifier)||!specifier.text.startsWith('.'))continue
   const target=path.resolve(path.dirname(file),specifier.text)
   expect(path.extname(target),`${file}: ${specifier.text} needs an explicit module extension`).toMatch(/^\.(ts|tsx|js|json)$/)
   expect(existsSync(target),`${file}: ${specifier.text} must exist`).toBe(true)
   if(/\.(ts|tsx|js)$/.test(target))queue.push(target)
  }
 }
})
