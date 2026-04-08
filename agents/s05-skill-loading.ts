#!/usr/bin/env bun
/*
Harness: on-demand knowledge -- domain expertise, loaded when the model asks.
s05_skill_loading.py - Skills

Two-layer skill injection that avoids bloating the system prompt:

    Layer 1 (cheap): skill names in system prompt (~100 tokens/skill)
    Layer 2 (on demand): full skill body in tool_result

    skills/
      pdf/
        SKILL.md          <-- frontmatter (name, description) + body
      code-review/
        SKILL.md

    System prompt:
    +--------------------------------------+
    | You are a coding agent.              |
    | Skills available:                    |
    |   - pdf: Process PDF files...        |  <-- Layer 1: metadata only
    |   - code-review: Review code...      |
    +--------------------------------------+

    When model calls load_skill("pdf"):
    +--------------------------------------+
    | tool_result:                         |
    | <skill>                              |
    |   Full PDF processing instructions   |  <-- Layer 2: full body
    |   Step 1: ...                        |
    |   Step 2: ...                        |
    | </skill>                             |
    +--------------------------------------+

Key insight: "Don't put everything in the system prompt. Load on demand."
*/

// load env config
import 'dotenv/config'
import assert from 'node:assert'
import { cwd } from 'node:process'
import { createInterface } from 'node:readline/promises'
import fs from 'node:fs'

import * as z from 'zod'
import { parse as parseYAML } from 'yaml'
import OpenAI from 'openai'

import { print, execAsync, dumpHistory, safePath, readFile, writeFile, rglob } from './util'
import path from 'node:path'

class Tool<T extends z.ZodObject = z.ZodObject> {
  schema: Pick<z.core.ZodStandardJSONSchemaPayload<T>, 'type' | 'properties' | 'required'>

  constructor(
    public name: string,
    public description: string,
    public parameters: T,
    public _exec: (name: string, args: z.infer<T>) => Promise<string>
  ) {
    const schema = z.toJSONSchema(this.parameters, { target: 'draft-04' })
    this.schema = {
      type: schema.type,
      properties: schema.properties,
      required: schema.required,
    }
  }

  exec(args: z.infer<T>) {
    return this._exec(this.name, args)
  }
}

type Skill = {
  meta: {
    name: string
    description?: string
    [key: string]: string | number | undefined
  }
  body: string
  path: string
}

class SkillLoader {
  skills: Map<string, Skill> = new Map()

  constructor(private skillsDir: string) {
    this.loadAll()
  }

  loadAll() {
    if (!fs.existsSync(this.skillsDir)) {
      return
    }

    const files = rglob(this.skillsDir, 'SKILL.md')
    for (const filePath of files) {
      const content = fs.readFileSync(filePath, { encoding: 'utf-8' })
      const { meta, body, valid } = this.parseFormatter(content)
      if (valid) {
        const name = meta.name || path.dirname(filePath)
        this.skills.set(name, {
          meta,
          body,
          path: filePath,
        })
      }
    }
  }

  parseFormatter(text: string) {
    // Parse YAML frontmatter between --- delimiters.
    const match = text.match(/^---\n(.*?)\n---\n(.*)/s)
    if (!match) {
      return {
        meta: {},
        body: text,
        valid: false,
      }
    }

    const meta = parseYAML(match[1] ?? '') || {}
    const body = (match[2] ?? '').trim()
    return {
      meta,
      body,
      valid: true,
    }
  }

  getDescriptions() {
    // Layer 1: short descriptions for the system prompt.
    if (this.skills.size === 0) {
      return '(no skills available)'
    }
    const lines: string[] = []
    this.skills.forEach((skill, name) => {
      const desc = skill.meta.description || 'No description'
      const tags = skill.meta.tags
      let line = `  - ${name}: ${desc}`
      if (tags) {
        line += ` [${tags}]`
      }
      lines.push(line)
    })

    return lines.join('\n')
  }

  getContent(name: string) {
    // Layer 2: full skill body returned in tool_result.
    const skill = this.skills.get(name)
    if (!skill) {
      const validSkills = [...this.skills.keys()].join(', ')
      return `Error: Unknown skill '${name}'. Available: ${validSkills}`
    }
    return `<skill name=\"${name}\">\n${skill.body}\n</skill>`
  }
}

const registerTools = (tools: Tool[]): Map<string, Tool> => {
  const map = new Map()
  tools.forEach(tool => {
    map.set(tool.name, tool)
  })
  return map
}

const WORKDIR = cwd()
const SKILLS_DIR = safePath(WORKDIR, 'skills')
const { API_KEY, BASE_URL, MODEL_NAME } = process.env
assert(API_KEY, 'API_KEY is not provided, please check the .env file')
assert(BASE_URL, 'BASE_URL is not provided, please check the .env file')
assert(MODEL_NAME, 'MODEL_NAME is not provided, please check the .env file')

const SKILL_LOADER = new SkillLoader(SKILLS_DIR)
const client = new OpenAI({
  apiKey: API_KEY,
  baseURL: BASE_URL,
})

// Layer 1: skill metadata injected into system prompt
const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use load_skill to access specialized knowledge before tackling unfamiliar topics.

Skills available:
${SKILL_LOADER.getDescriptions()}`

/* -- Tool implementations shared by parent and child -- */
const bashTool = new Tool(
  'bash',
  'Run a shell command.',
  z.object({ command: z.string() }),
  async (name, args) => {
    print(`\x1b[33m${name}: ${args.command} \x1b[0m`)

    const dangerous = ['rm -rf /', 'sudo', 'shutdown', 'reboot', '> /dev/']

    for (const dangerousCommand of dangerous) {
      if (args.command.includes(dangerousCommand)) {
        return 'Error: Dangerous command blocked'
      }
    }

    let result = ''
    try {
      const { stdout, stderr } = await execAsync(args.command, {
        cwd: WORKDIR,
        timeout: 120 * 1000,
      })
      result = stdout.trim() + stderr.trim()
    } catch (err) {
      result = `Error: ${err}`
    }

    result = result || '(no output)'
    return result.trim()
  }
)

const readFileTool = new Tool(
  'read_file',
  'Read file contents.',
  z.object({ path: z.string(), limit: z.int().optional() }),
  async (name, args) => {
    print(`\x1b[33m${name}: ${args.path} \x1b[0m`)

    try {
      const text = readFile(safePath(WORKDIR, args.path))
      let lines = text.split('\n')

      if (args.limit && args.limit < lines.length) {
        lines = lines.slice(0, args.limit)
      }

      return lines.join('\n').slice(0, 50000)
    } catch (e) {
      return `read_file error: ${e}`
    }
  }
)
const writeFileTool = new Tool(
  'write_file',
  'Write content to file.',
  z.object({ path: z.string(), content: z.string() }),
  async (name, args) => {
    print(`\x1b[33m${name}: ${args.path} \x1b[0m`)

    try {
      writeFile(safePath(WORKDIR, args.path), args.content)
      return `Wrote ${args.content.length} lines to ${args.path}`
    } catch (e) {
      return `write_file error: ${e}`
    }
  }
)
const editFileTool = new Tool(
  'edit_file',
  'Replace exact text in file.',
  z.object({ path: z.string(), old_text: z.string(), new_text: z.string() }),
  async (name, args) => {
    print(`\x1b[33m${name}: ${args.path} \x1b[0m`)

    try {
      const fp = safePath(WORKDIR, args.path)
      const text = readFile(fp)
      if (!text.includes(args.old_text)) {
        return `Error: Text not found in ${args.path}`
      }
      writeFile(fp, text.replace(args.old_text, args.new_text))
      return `Edited ${args.path}`
    } catch (e) {
      return `edit_file error: ${e}`
    }
  }
)

const skillTool = new Tool(
  'load_skill',
  'Load specialized knowledge by name.',
  z.object({ name: z.string().describe('Skill name to load') }),
  async (name, args) => {
    print(`\x1b[33m${name}: ${args.name} \x1b[0m`)
    return SKILL_LOADER.getContent(args.name)
  }
)

const getToolsDeclaration = (tools: Tool[]): OpenAI.ChatCompletionFunctionTool[] =>
  tools.map(tool => {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.schema,
      },
    }
  })

const TOOLS: Tool[] = [bashTool, readFileTool, writeFileTool, editFileTool, skillTool]
const toolsDeclaration = getToolsDeclaration(TOOLS)
const toolsMap = registerTools(TOOLS)

const readline = createInterface({
  input: process.stdin,
  output: process.stdout,
})

const agentLoop = async (messages: OpenAI.ChatCompletionMessageParam[]) => {
  while (true) {
    const response = await client.chat.completions.create({
      model: MODEL_NAME,
      tools: toolsDeclaration,
      messages: [{ role: 'system', content: SYSTEM }, ...messages],
    })

    const { message, finish_reason } = response.choices[0]
    // Append assistant turn
    messages.push({ role: message.role, content: message.content, tool_calls: message.tool_calls })

    if (message.content) {
      print(message.content.trim())
    }
    // If the model didn't call a tool, we're done
    if (finish_reason !== 'tool_calls' || message.tool_calls == null) {
      return
    }

    const toolCalls = message.tool_calls as OpenAI.ChatCompletionMessageFunctionToolCall[]

    // Execute each tool call, collect results
    const results: (
      | OpenAI.ChatCompletionToolMessageParam
      | OpenAI.ChatCompletionUserMessageParam
    )[] = []
    for (const toolCall of toolCalls) {
      let output = ''

      const tool = toolsMap.get(toolCall.function.name)
      if (tool == null) {
        output = `Unknown tool: ${toolCall.function.name}`
      } else {
        const args = JSON.parse(toolCall.function.arguments)
        output = await tool.exec(args)
        print(`\x1b[32mtool:\x1b[0m ${output.slice(0, 200)}`)
      }
      results.push({ role: 'tool', tool_call_id: toolCall.id, content: output })
    }

    messages.push(...results)
  }
}

const history: OpenAI.ChatCompletionMessageParam[] = []

process.on('exit', () => dumpHistory(history))
process.on('SIGINT', () => process.exit(0))

while (true) {
  const userPrompt = await readline.question('\x1b[36ms05 >> \x1b[0m')

  if (['q', 'exit', ''].includes(userPrompt.trim().toLowerCase())) {
    process.exit(0)
  }

  history.push({ role: 'user', content: userPrompt })
  await agentLoop(history)
}
