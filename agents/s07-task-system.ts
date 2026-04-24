#!/usr/bin/env bun
/*
Harness: persistent tasks -- goals that outlive any single conversation.
s07_task_system.py - Tasks

Tasks persist as JSON files in .tasks/ so they survive context compression.
Each task has a dependency graph (blockedBy).

    .tasks/
      task_1.json  {"id":1, "subject":"...", "status":"completed", ...}
      task_2.json  {"id":2, "blockedBy":[1], "status":"pending", ...}
      task_3.json  {"id":3, "blockedBy":[2], ...}

    Dependency resolution:
    +----------+     +----------+     +----------+
    | task 1   | --> | task 2   | --> | task 3   |
    | complete |     | blocked  |     | blocked  |
    +----------+     +----------+     +----------+
         |                ^
         +--- completing task 1 removes it from task 2's blockedBy

Key insight: "State that survives compression -- because it's outside the conversation."
*/

// load env config
import 'dotenv/config'
import assert from 'node:assert'
import { cwd } from 'node:process'
import { createInterface } from 'node:readline/promises'
import path from 'node:path'
import fs from 'node:fs'

import * as z from 'zod'
import OpenAI from 'openai'

import { print, execAsync, dumpHistory, safePath, readFile, writeFile, rglob, sortBy } from './util'

type int = number
type Message = OpenAI.ChatCompletionMessageParam
type ToolCall = OpenAI.ChatCompletionMessageFunctionToolCall
type FunctionTool = OpenAI.ChatCompletionFunctionTool

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

const WORKDIR = cwd()
const TASKS_DIR = path.join(WORKDIR, '.tasks')
const { API_KEY, BASE_URL, MODEL_NAME } = process.env
assert(API_KEY, 'API_KEY is not provided, please check the .env file')
assert(BASE_URL, 'BASE_URL is not provided, please check the .env file')
assert(MODEL_NAME, 'MODEL_NAME is not provided, please check the .env file')

const client = new OpenAI({
  apiKey: API_KEY,
  baseURL: BASE_URL,
})

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use task tools to plan and track work.`

type Task = {
  id: int
  subject: string
  description: string
  status: 'pending' | 'in_progress' | 'completed'
  blockedBy: int[]
  owner: string
}

// -- TaskManager: CRUD with dependency graph, persisted as JSON files --
class TaskManager {
  dir: string
  private nextId: int

  constructor(tasks_dir: string) {
    this.dir = tasks_dir
    fs.mkdirSync(this.dir, { recursive: true })
    this.nextId = this.maxId() + 1
  }

  private maxId(): int {
    const taskFiles = rglob(this.dir, 'task_\\d.json')
    const ids = taskFiles.map(item => parseInt(item.split('_')[1]))
    if (ids && ids.length > 0) {
      Math.max(...ids)
    }

    return 0
  }

  private load(taskId: int): Task {
    const p = path.join(this.dir, `task_${taskId}.json`)
    if (!fs.existsSync(p)) {
      throw `Task ${taskId} not found`
    }
    return JSON.parse(readFile(p))
  }

  private save(task: Task) {
    const p = path.join(this.dir, `task_${task.id}.json`)
    writeFile(p, JSON.stringify(task, null, 2))
  }

  create(subject: string, description: string = ''): string {
    const task: Task = {
      id: this.nextId,
      subject: subject,
      description: description,
      status: 'pending',
      blockedBy: [],
      owner: '',
    }
    this.save(task)
    this.nextId += 1
    return JSON.stringify(task, null, 2)
  }

  get(taskId: int): string {
    const task = this.load(taskId)
    return JSON.stringify(task, null, 2)
  }

  update(taskId: int, status?: string, addBlockedBy?: int[], removeBlokedBy?: int[]): string {
    const task = this.load(taskId)
    if (status) {
      if (!['pending', 'in_progress', 'completed'].includes(status)) {
        throw `Invalid status: ${status}`
      }
      task.status = status as Task['status']
      if (status === 'completed') {
        this.clearDependency(taskId)
      }
    }

    if (addBlockedBy) {
      task.blockedBy = [...new Set(task.blockedBy.concat(addBlockedBy))]
    }
    if (removeBlokedBy) {
      task.blockedBy = task.blockedBy.filter(item => !removeBlokedBy.includes(item))
    }
    this.save(task)
    return JSON.stringify(task, null, 2)
  }

  // Remove completed_id from all other tasks' blockedBy lists.
  private clearDependency(completed_id: int): void {
    const taskFiles = rglob(this.dir, 'task_\\d.json')
    taskFiles.forEach(f => {
      const task = JSON.parse(readFile(f)) as Task
      const index = task.blockedBy.indexOf(completed_id)
      if (index > -1) {
        task.blockedBy.splice(index, 1)
      }
      this.save(task)
    })
  }

  listAll(): string {
    const taskFiles = rglob(this.dir, 'task_\\d.json')
    const tasks: Task[] = sortBy(taskFiles, f => parseInt(f.split('_')[1])).map(f =>
      JSON.parse(readFile(f))
    )
    if (tasks.length === 0) {
      return 'No tasks.'
    }

    const lines: string[] = []
    tasks.forEach(task => {
      const marker = { pending: '[ ]', in_progress: '[>]', completed: '[x]' }[task.status] ?? '[?]'
      const blocked = task.blockedBy.length > 0 ? `(blocked by: ${task.blockedBy})` : ''
      lines.push(`${marker} #${task.id}: ${task.subject}${blocked}`)
    })

    return lines.join('\n')
  }
}

const TASKS = new TaskManager(TASKS_DIR)

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

const taskCreateTool = new Tool(
  'task_create',
  'Create a new task.',
  z.object({ subject: z.string(), description: z.string().optional() }),
  async (name, args) => {
    print(`\x1b[33m${name}: ${args.subject} \x1b[0m`)

    return TASKS.create(args.subject, args.description)
  }
)

const taskUpdateTool = new Tool(
  'task_update',
  "Update a task's status or dependencies.",
  z.object({
    taskId: z.int(),
    status: z.enum(['pending', 'in_progress', 'completed']).optional(),
    addBlockedBy: z.array(z.int()),
    removeBlokedBy: z.array(z.int()),
  }),
  async (name, args) => {
    print(`\x1b[33m${name}: ${args.taskId} \x1b[0m`)

    return TASKS.update(args.taskId, args.status, args.addBlockedBy, args.removeBlokedBy)
  }
)

const taskListTool = new Tool(
  'task_list',
  'List all tasks with status summary.',
  z.object(),
  async name => {
    print(`\x1b[33m${name} \x1b[0m`)

    return TASKS.listAll()
  }
)

const taskGetTool = new Tool(
  'task_get',
  'Get full details of a task by ID.',
  z.object({ taskId: z.int() }),
  async (name, args) => {
    print(`\x1b[33m${name}: ${args.taskId} \x1b[0m`)

    return TASKS.get(args.taskId)
  }
)

const TOOLS = registerTools([
  bashTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  taskCreateTool,
  taskUpdateTool,
  taskListTool,
  taskGetTool,
])
const agentTools: FunctionTool[] = [...TOOLS.values()].map(tool => {
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

const agentLoop = async (messages: Message[]) => {
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

    const toolCalls = message.tool_calls as ToolCall[]

    // Execute each tool call, collect results
    const results: Message[] = []
    for (const toolCall of toolCalls) {
      let output = ''

      const tool = TOOLS.get(toolCall.function.name)
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

const history: Message[] = []

process.on('exit', () => dumpHistory(history))
process.on('SIGINT', () => process.exit(0))

while (true) {
  const userPrompt = await readline.question('\x1b[36ms07 >> \x1b[0m')

  if (['q', 'exit', ''].includes(userPrompt.trim().toLowerCase())) {
    process.exit(0)
  }

  history.push({ role: 'user', content: userPrompt })
  await agentLoop(history)
}
