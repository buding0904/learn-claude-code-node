#!/usr/bin/env bun
/*
s01_agent_loop.py - The Agent Loop
Harness: the loop -- the model's first connection to the real world.

The entire secret of an AI coding agent in one pattern:

    while stop_reason == "tool_use":
        response = LLM(messages, tools)
        execute tools
        append results

    +----------+      +-------+      +---------+
    |   User   | ---> |  LLM  | ---> |  Tool   |
    |  prompt  |      |       |      | execute |
    +----------+      +---+---+      +----+----+
                          ^               |
                          |   tool_result |
                          +---------------+
                          (loop continues)

This is the core loop: feed tool results back to the model
until the model decides to stop. Production agents layer
policy, hooks, and lifecycle controls on top.
*/

// load env config
import 'dotenv/config'
import assert from 'node:assert'
import { cwd } from 'node:process'
import { createInterface } from 'node:readline/promises'

import OpenAI from 'openai'

import { dumpHistory, print, execAsync } from './util'

const { API_KEY, BASE_URL, MODEL_NAME } = process.env
assert(API_KEY, 'API_KEY is not provided, please check the .env file')
assert(BASE_URL, 'BASE_URL is not provided, please check the .env file')
assert(MODEL_NAME, 'MODEL_NAME is not provided, please check the .env file')

const SYSTEM = `You are a coding agent at ${cwd()}. Use bash to solve tasks. Act, don't explain.`

const TOOLS: OpenAI.ChatCompletionFunctionTool[] = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
]

const client = new OpenAI({
  apiKey: API_KEY,
  baseURL: BASE_URL,
})

const readline = createInterface({
  input: process.stdin,
  output: process.stdout,
})

const runBash = async (command: string): Promise<string> => {
  const dangerous = ['rm -rf /', 'sudo', 'shutdown', 'reboot', '> /dev/']

  for (const dangerousCommand of dangerous) {
    if (command.includes(dangerousCommand)) {
      return 'Error: Dangerous command blocked'
    }
  }

  let result = ''
  try {
    const { stdout, stderr } = await execAsync(command, { cwd: process.cwd(), timeout: 120 * 1000 })
    result = stdout.trim() + stderr.trim()
  } catch (err) {
    result = `Error: ${err}`
  }

  result = result || '(no output)'
  return result.trim()
}

const agentLoop = async (messages: OpenAI.ChatCompletionMessageParam[]) => {
  while (true) {
    const response = await client.chat.completions.create({
      model: MODEL_NAME,
      tools: TOOLS,
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
    const results: OpenAI.ChatCompletionToolMessageParam[] = []
    for (const toolCall of toolCalls) {
      if (toolCall.function.name === 'bash') {
        const args = JSON.parse(toolCall.function.arguments)
        print(`\x1b[33m$ ${args.command}\x1b[0m`)

        const output = await runBash(args.command)
        print(output.slice(0, 200))

        results.push({ role: 'tool', tool_call_id: toolCall.id, content: output })
      }
    }
    messages.push(...results)
  }
}

const history: OpenAI.ChatCompletionMessageParam[] = []

process.on('exit', () => dumpHistory(history))
process.on('SIGINT', () => process.exit(0))

while (true) {
  const userPrompt = await readline.question('\x1b[36ms01 >> \x1b[0m')

  if (['q', 'exit', ''].includes(userPrompt.trim().toLowerCase())) {
    process.exit(0)
  }

  history.push({ role: 'user', content: userPrompt })
  await agentLoop(history)
}
