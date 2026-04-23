#!/usr/bin/env bun
/*
Harness: compression -- keep the active context small enough to keep working.
s06_context_compact.py - Context Compact

This teaching version keeps the compact model intentionally small:

1. Large tool output is persisted to disk and replaced with a preview marker.
2. Older tool results are micro-compacted into short placeholders.
3. When the whole conversation gets too large, the agent summarizes it and
   continues from that summary.

The goal is not to model every production branch. The goal is to make the
active-context idea explicit and teachable.

Every tool call:
+------------------+
| Tool call result |
+------------------+
        |
        v
[Lever 0: persisted-output]     (at tool execution time)
  Large outputs (>50KB, bash >30KB) are written to disk
  and replaced with a <persisted-output> preview marker.
        |
        v
[Lever 1: micro_compact]        (silent, every turn)
  Replace tool_result > 3 turns old
  with "[Previous: used {tool_name}]"
  (preserves read_file results as reference material)
        |
        v
[Check: tokens > 50000?]
   |               |
   no              yes
   |               |
   v               v
continue    [Lever 2: auto_compact]
              Save transcript to .transcripts/
              LLM summarizes conversation.
              Replace all messages with [summary].
                    |
                    v
            [Lever 3: compact tool]
              Model calls compact explicitly.
              Same summarization as auto_compact.
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

import { print, execAsync, dumpHistory, safePath, readFile, writeFile } from './util'

type int = number
type Message = OpenAI.ChatCompletionMessageParam
type ToolMessage = OpenAI.ChatCompletionToolMessageParam
type UserMessage = OpenAI.ChatCompletionUserMessageParam
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
const THRESHOLD = 5000
const TRANSCRIPT_DIR = path.resolve(WORKDIR, '.transcripts')
const KEEP_RECENT = 3
const PRESERVE_RESULT_TOOLS = ['read_file']
const { API_KEY, BASE_URL, MODEL_NAME } = process.env
assert(API_KEY, 'API_KEY is not provided, please check the .env file')
assert(BASE_URL, 'BASE_URL is not provided, please check the .env file')
assert(MODEL_NAME, 'MODEL_NAME is not provided, please check the .env file')

const client = new OpenAI({
  apiKey: API_KEY,
  baseURL: BASE_URL,
})

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.`

const estimateTokens = (messages: Message[]): int => {
  /* Rough token count: ~4 chars per token. */
  const str = JSON.stringify(messages)
  return Math.floor(str.length / 4)
}

// -- Layer 1: micro_compact - replace old tool results with placeholders --
const microCompact = (messages: Message[]): Message[] => {
  // Collect (msg_index, tool_result_dict) for all tool_result entries
  const toolResults: { msgIdx: int; result: ToolMessage }[] = []
  messages.forEach((msg, msgIdx) => {
    if (msg.role === 'tool' && msg.content) {
      toolResults.push({ msgIdx, result: msg })
    }
  })
  if (toolResults.length <= KEEP_RECENT) {
    return messages
  }
  // Find tool_name for each result by matching tool_use_id in prior assistant messages
  const toolNameMap = new Map<string, string>()
  messages.forEach(msg => {
    if (msg.role !== 'assistant') return

    if (msg.tool_calls) {
      msg.tool_calls.forEach(toolCall => {
        toolNameMap.set(toolCall.id, toolCall.type)
      })
    }
  })
  // Clear old results (keep last KEEP_RECENT). Preserve read_file outputs because
  // they are reference material; compacting them forces the agent to re-read files.
  const toClear = toolResults.slice(0, -KEEP_RECENT)
  toClear.forEach(({ result }) => {
    if (typeof result.content !== 'string') return
    if (result.content.length <= 100) return

    const toolId = result.tool_call_id ?? ''
    const toolName = toolNameMap.get(toolId) ?? 'unknown'

    if (PRESERVE_RESULT_TOOLS.includes(toolName)) return

    result.content = `[Previous: used ${toolName}]`
  })
  return messages
}

// -- Layer 2: auto_compact - save transcript, summarize, replace messages --
const autoCompact = async (messages: Message[]): Promise<Message[]> => {
  // Save full transcript to disk
  const transcriptPath = path.join(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`)
  const content = messages.map(msg => JSON.stringify(msg)).join('\n')
  writeFile(transcriptPath, content)
  print(`[transcript saved: ${transcriptPath.toString()}]`)

  // Ask LLM to summarize
  const conversationText = JSON.stringify(messages).slice(-80000)
  const response = await client.chat.completions.create({
    model: MODEL_NAME,
    messages: [
      {
        role: 'user',
        content:
          'Summarize this conversation for continuity. Include: ' +
          '1) What was accomplished, 2) Current state, 3) Key decisions made. ' +
          'Be concise but preserve critical details.\n\n' +
          conversationText,
      },
    ],
    max_completion_tokens: 2000,
  })
  let summary = response.choices[0].message.content
  if (!summary) {
    summary = 'No summary generated.'
  }
  // Replace all messages with compressed summary
  return [
    {
      role: 'user',
      content: `[Conversation compressed. Transcript: ${transcriptPath}]\n\n${summary}`,
    },
  ]
}

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

const compactTool = new Tool(
  'compact',
  'Trigger manual conversation compression.',
  z.object({ focus: z.string().describe('What to preserve in the summary').optional() }),
  async name => {
    return 'Compressing...'
  }
)

const getToolsDeclaration = (tools: Tool[]): FunctionTool[] =>
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

const TOOLS: Tool[] = [bashTool, readFileTool, writeFileTool, editFileTool, compactTool]
const toolsDeclaration = getToolsDeclaration(TOOLS)
const toolsMap = registerTools(TOOLS)

const readline = createInterface({
  input: process.stdin,
  output: process.stdout,
})

const agentLoop = async (messages: Message[]) => {
  while (true) {
    // Layer 1: micro_compact before each LLM call
    microCompact(messages)

    // Layer 2: auto_compact if token estimate exceeds threshold
    if (estimateTokens(messages) > THRESHOLD) {
      print('[auto_compact triggered]')
      const compactedMessages = await autoCompact(messages)
      messages.length = 0
      messages.push(...compactedMessages)
    }

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

    const toolCalls = message.tool_calls as ToolCall[]

    // Execute each tool call, collect results
    const results: (ToolMessage | UserMessage)[] = []
    let manualCompact = false
    for (const toolCall of toolCalls) {
      let output = ''

      const tool = toolsMap.get(toolCall.function.name)
      if (tool == null) {
        output = `Unknown tool: ${toolCall.function.name}`
      } else {
        if (tool.name === 'compact') {
          manualCompact = true
        }

        const args = JSON.parse(toolCall.function.arguments)
        output = await tool.exec(args)
        print(`\x1b[32mtool:\x1b[0m ${output.slice(0, 200)}`)
      }
      results.push({ role: 'tool', tool_call_id: toolCall.id, content: output })
    }

    messages.push(...results)

    // Layer 3: manual compact triggered by the compact tool
    if (manualCompact) {
      print('[manual compact]')
      const compactedMessages = await autoCompact(messages)
      messages.length = 0
      messages.push(...compactedMessages)
      return
    }
  }
}

const history: Message[] = []

process.on('exit', () => dumpHistory(history))
process.on('SIGINT', () => process.exit(0))

while (true) {
  const userPrompt = await readline.question('\x1b[36ms06 >> \x1b[0m')

  if (['q', 'exit', ''].includes(userPrompt.trim().toLowerCase())) {
    process.exit(0)
  }

  history.push({ role: 'user', content: userPrompt })
  await agentLoop(history)
}
