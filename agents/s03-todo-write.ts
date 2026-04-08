#!/usr/bin/env bun
/*
s03_todo_write.py - TodoWrite
Harness: planning -- keeping the model on course without scripting the route.

The model tracks its own progress via a TodoManager. A nag reminder
forces it to keep updating when it forgets.

    +----------+      +-------+      +---------+
    |   User   | ---> |  LLM  | ---> | Tools   |
    |  prompt  |      |       |      | + todo  |
    +----------+      +---+---+      +----+----+
                          ^               |
                          |   tool_result |
                          +---------------+
                                |
                    +-----------+-----------+
                    | TodoManager state     |
                    | [ ] task A            |
                    | [>] task B <- doing   |
                    | [x] task C            |
                    +-----------------------+
                                |
                    if rounds_since_todo >= 3:
                      inject <reminder>

Key insight: "The agent can track its own progress -- and I can see it."
*/

// load env config
import 'dotenv/config'
import assert from 'node:assert'
import { cwd } from 'node:process'
import { createInterface } from 'node:readline/promises'

import * as z from 'zod'
import OpenAI from 'openai'

import { print, execAsync, dumpHistory, safePath, readFile, writeFile } from './util'

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

const registerTools = (tools: Tool[]): Map<string, Tool> => {
  const map = new Map()
  tools.forEach(tool => {
    map.set(tool.name, tool)
  })
  return map
}

// -- TodoManager: structured state the LLM writes to --
const todoItem = z.object({
  id: z.string(),
  text: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
})

type TodoItem = z.infer<typeof todoItem>

class TodoManager {
  items: TodoItem[] = []

  update(items: TodoItem[]) {
    if (items.length > 20) {
      throw 'Max 20 todos allowed'
    }
    const validated: TodoItem[] = []
    let inProgressCount = 0

    items.forEach((item, i) => {
      const todo = {
        text: item.text.trim() || '',
        status: item.status.toLocaleLowerCase() || 'pending',
        id: item.id || (i + 1).toString(),
      }

      const result = todoItem.safeParse(todo)
      if (!result.success) {
        throw `Item ${todo.id}: ${result.error.message}`
      }

      if (result.data.status === 'in_progress') {
        inProgressCount++
      }
      validated.push(result.data)
    })

    if (inProgressCount > 1) {
      throw 'Only one task can be in_progress at a time'
    }
    this.items = validated

    return this.render()
  }

  render() {
    if (this.items.length === 0) {
      return 'No todos.'
    }

    const lines = []
    for (const item of this.items) {
      const marker = {
        pending: '[ ]',
        in_progress: '[>]',
        completed: '[x]',
      }[item.status]
      lines.push(`${marker} #${item.id}: ${item.text}`)
    }
    return lines.join('\n')
  }
}

const TODO = new TodoManager()

const WORKDIR = cwd()
const { API_KEY, BASE_URL, MODEL_NAME } = process.env
assert(API_KEY, 'API_KEY is not provided, please check the .env file')
assert(BASE_URL, 'BASE_URL is not provided, please check the .env file')
assert(MODEL_NAME, 'MODEL_NAME is not provided, please check the .env file')

const client = new OpenAI({
  apiKey: API_KEY,
  baseURL: BASE_URL,
})

const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use the todo tool to plan multi-step tasks. Mark in_progress before starting, completed when done.
Prefer tools over prose.`

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

const todoTool = new Tool(
  'todo',
  'Update task list. Track progress on multi-step tasks.',
  z.object({ items: z.array(todoItem) }),
  async (name, args) => {
    print(`\x1b[33m${name}: update todos \x1b[0m`)
    return TODO.update(args.items)
  }
)

const TOOLS = registerTools([bashTool, readFileTool, writeFileTool, editFileTool, todoTool])
const agentTools: OpenAI.ChatCompletionFunctionTool[] = [...TOOLS.values()].map(tool => {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.schema,
    },
  }
})

const readline = createInterface({
  input: process.stdin,
  output: process.stdout,
})

const agentLoop = async (messages: OpenAI.ChatCompletionMessageParam[]) => {
  let roundsSinceTodo = 0

  while (true) {
    const response = await client.chat.completions.create({
      model: MODEL_NAME,
      tools: agentTools,
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
    let usedTodo = false
    for (const toolCall of toolCalls) {
      let output = ''

      const tool = TOOLS.get(toolCall.function.name)
      if (tool == null) {
        output = `Unknown tool: ${toolCall.function.name}`
      } else {
        const args = JSON.parse(toolCall.function.arguments)
        output = await tool.exec(args)
        print(`\x1b[32mtool:\x1b[0m ${output.slice(0, 200)}`)

        if (tool.name === 'todo') {
          usedTodo = true
        }
      }
      results.push({ role: 'tool', tool_call_id: toolCall.id, content: output })
    }

    roundsSinceTodo = usedTodo ? 0 : roundsSinceTodo + 1
    if (roundsSinceTodo >= 3) {
      results.push({ role: 'user', content: '<reminder>Update your todos.</reminder>' })
    }
    messages.push(...results)
  }
}

const history: OpenAI.ChatCompletionMessageParam[] = []

process.on('exit', () => dumpHistory(history))
process.on('SIGINT', () => process.exit(0))

while (true) {
  const userPrompt = await readline.question('\x1b[36ms03 >> \x1b[0m')

  if (['q', 'exit', ''].includes(userPrompt.trim().toLowerCase())) {
    process.exit(0)
  }

  history.push({ role: 'user', content: userPrompt })
  await agentLoop(history)
}
