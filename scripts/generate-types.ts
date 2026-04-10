import { readFile, writeFile } from 'fs/promises';

type GenerationTarget = {
  name: string
  schemaPath: string
  outputPath: string
}

const GENERATION_TARGETS: GenerationTarget[] = [
  {
    name: 'control',
    schemaPath: 'src/entrypoints/sdk/controlSchemas.ts',
    outputPath: 'src/entrypoints/sdk/controlTypes.generated.ts',
  },
  {
    name: 'core',
    schemaPath: 'src/entrypoints/sdk/coreSchemas.ts',
    outputPath: 'src/entrypoints/sdk/coreTypes.generated.ts',
  },
]

const SCHEMA_EXPORT_PATTERN = /^export const (\w+Schema)\s*=/gm

function buildGeneratedSource(target: GenerationTarget, schemaNames: string[]): string {
  const schemaModuleName = target.schemaPath
    .split('/')
    .pop()
    ?.replace(/\.ts$/, '')

  if (!schemaModuleName) {
    throw new Error(`Could not determine schema module name for ${target.schemaPath}`)
  }

  const imports = schemaNames.map(name => `  ${name},`).join('\n')
  const types = schemaNames
    .map(name => {
      const typeName = name.replace(/Schema$/, '')
      return `export type ${typeName} = z.infer<ReturnType<typeof ${name}>>`
    })
    .join('\n\n')

  return `// Generated from ${target.schemaPath}. Do not edit by hand.
// To update these types, edit ${schemaModuleName}.ts and run:
//   bun run scripts/generate-types.ts

import { z } from 'zod/v4'
import {
${imports}
} from './${schemaModuleName}.js'

${types}
`
}

async function generateTarget(target: GenerationTarget): Promise<number> {
  const source = await readFile(target.schemaPath, 'utf8')
  const schemaNames = [...source.matchAll(SCHEMA_EXPORT_PATTERN)].map(
    match => match[1],
  )

  if (schemaNames.length === 0) {
    throw new Error(`No exported schema factories found in ${target.schemaPath}`)
  }

  const generated = buildGeneratedSource(target, schemaNames)
  await writeFile(target.outputPath, generated, 'utf8')

  console.log(
    `Generated ${target.outputPath} with ${schemaNames.length} inferred ${target.name} types.`,
  )

  return schemaNames.length
}

async function main(): Promise<void> {
  await Promise.all(GENERATION_TARGETS.map(generateTarget))
}

await main()
