import path from 'node:path'
import fs from 'node:fs'
import { promisify } from 'node:util'
import { exec } from 'node:child_process'

import * as z from 'zod'
import OpenAI from 'openai'

// alias console.log to print
export const print = console.log
export const execAsync = promisify(exec)
export const readFile = (p: string) => fs.readFileSync(p, { encoding: 'utf-8' })
export const writeFile = (p: string, content: string) => {
  const dirpath = path.dirname(p)
  fs.mkdirSync(dirpath, { recursive: true })
  fs.writeFileSync(p, content)
}

export class Tool<T extends z.ZodObject = z.ZodObject> {
  schema: Pick<z.core.ZodStandardJSONSchemaPayload<T>, 'type' | 'properties' | 'required'>

  constructor(
    public name: string,
    public description: string,
    public parameters: T,
    private _echo: (name: string, args: z.infer<T>) => string,
    public handler: (args: z.infer<T>) => Promise<string>
  ) {
    const schema = z.toJSONSchema(this.parameters, { target: 'draft-04' })
    this.schema = {
      type: schema.type,
      properties: schema.properties,
      required: schema.required,
    }
  }

  echo(args: z.infer<T>): string {
    return this._echo(this.name, args)
  }
}

export const safePath = (cwd: string, p: string): string => {
  const realPath = path.resolve(cwd, p)
  const rel = path.relative(cwd, realPath)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${p}`)
  }
  return realPath
}

export const dumpHistory = (history: OpenAI.ChatCompletionMessageParam[]) => {
  if (process.env.DEBUG_MESSAGES !== 'true') return

  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const filename = `chat-${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.json`
  fs.writeFileSync(filename, JSON.stringify(history, null, 2))

  print(`\x1b[90m[debug] history saved to ${filename}\x1b[0m`)
}
