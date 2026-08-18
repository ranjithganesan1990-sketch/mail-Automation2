// =============================================================
//  AI REPLY SUGGESTIONS (Groq)
//
//  Groq exposes an OpenAI-compatible chat-completions endpoint, so this
//  talks to it over plain fetch rather than pulling in another SDK.
//
//  The key lives in env.groq.apiKey and is read here, on the server, only.
//  Nothing in web/ ever sees it: the browser calls our own /api/inbox routes.
// =============================================================

import { env } from '../env.js'
import { AppError } from './errors.js'
import { htmlToText } from './merge.js'

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'

/** The three suggestions offered before the user picks a tone. */
export const DEFAULT_TONES = ['professional', 'short', 'friendly'] as const

/** Everything the regenerate control may ask for. */
export const ALL_TONES = [
  'professional',
  'short',
  'friendly',
  'concise',
  'persuasive',
  'formal',
] as const

export type Tone = (typeof ALL_TONES)[number]

const TONE_GUIDE: Record<Tone, string> = {
  professional: 'Polite and businesslike. Complete sentences, warm but not casual.',
  short: 'Two or three sentences at most. Say only what answers the question.',
  friendly: 'Warm and conversational. Contractions are fine; stay professional.',
  concise: 'As brief as possible while still answering fully. No preamble.',
  persuasive: 'Confident and specific about value, without overselling or inventing claims.',
  formal: 'Formal register. No contractions, no idiom, conventional salutation and sign-off.',
}

export interface AiMessage {
  from: string
  date: Date
  subject: string
  html: string
}

export interface Suggestion {
  tone: Tone
  body: string
}

export function isAiConfigured(): boolean {
  return Boolean(env.groq.apiKey)
}

function requireAi(): string {
  if (!env.groq.apiKey) {
    throw new AppError(
      503,
      'AI replies are not configured on this server. Add a GROQ_API_KEY and restart.',
      'ai_not_configured',
    )
  }
  return env.groq.apiKey
}

const SYSTEM_PROMPT = `You are an AI email assistant drafting a reply on behalf of the mailbox owner.

Requirements:
- Do not invent facts, figures, dates, prices or commitments.
- Do not promise anything the mailbox owner has not already offered.
- Use the whole conversation for context, but reply to the latest message.
- Answer the sender's actual question.
- Keep it concise.
- Match the requested tone exactly.
- Write the reply body only: no subject line, no "Here is your reply", no commentary.
- Never state that you are an AI.

Return plain text. Use blank lines between paragraphs. Do not use markdown or HTML.`

/** Keeps the prompt inside a sane token budget on long threads. */
const MAX_MESSAGES = 8
const MAX_CHARS_PER_MESSAGE = 2_000
const MAX_TOTAL_CHARS = 12_000

function renderConversation(messages: AiMessage[]): string {
  const recent = messages.slice(-MAX_MESSAGES)
  const rendered: string[] = []
  let budget = MAX_TOTAL_CHARS

  // Newest first while spending the budget, so the most relevant message
  // survives truncation on a very long thread.
  for (let i = recent.length - 1; i >= 0; i--) {
    const message = recent[i]
    const text = htmlToText(message.html).trim().slice(0, MAX_CHARS_PER_MESSAGE)
    const block = `From: ${message.from}\nDate: ${message.date.toISOString()}\n\n${text}`
    if (block.length > budget) break
    budget -= block.length
    rendered.unshift(block)
  }

  return rendered.join('\n\n---\n\n')
}

function buildUserPrompt(messages: AiMessage[], tones: Tone[], signature: string | null): string {
  const latest = messages[messages.length - 1]
  const conversation = renderConversation(messages.slice(0, -1))

  const toneSpec = tones.map((t) => `- ${t}: ${TONE_GUIDE[t]}`).join('\n')

  return [
    conversation ? `CONVERSATION SO FAR:\n${conversation}` : 'CONVERSATION SO FAR:\n(none — this is the first message)',
    '',
    `LATEST EMAIL (reply to this one):\nFrom: ${latest.from}\nSubject: ${latest.subject}\n\n${htmlToText(latest.html).trim().slice(0, MAX_CHARS_PER_MESSAGE)}`,
    '',
    signature ? `SIGN OFF AS: ${signature}` : '',
    '',
    `Write ${tones.length} reply option${tones.length === 1 ? '' : 's'}, one per requested tone:`,
    toneSpec,
    '',
    'Respond with JSON only, in exactly this shape:',
    '{"suggestions":[{"tone":"<tone>","body":"<reply text>"}]}',
  ]
    .filter(Boolean)
    .join('\n')
}

interface GroqChoice {
  message?: { content?: string }
}

async function callGroq(prompt: string): Promise<string> {
  const apiKey = requireAi()

  let response: Response
  try {
    response = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: env.groq.model,
        temperature: 0.6,
        max_tokens: 1600,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
      }),
    })
  } catch (err) {
    // Network-level failure: DNS, TLS, no outbound access.
    throw new AppError(502, 'Could not reach the AI service. Please try again.', 'ai_unreachable', {
      cause: (err as Error).message,
    })
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    // Rate limits are worth naming, because retrying immediately will not help.
    if (response.status === 429) {
      throw new AppError(429, 'The AI service is rate limited right now. Try again in a moment.', 'ai_rate_limited')
    }
    if (response.status === 401 || response.status === 403) {
      throw new AppError(502, 'The AI service rejected this server’s key. Check GROQ_API_KEY.', 'ai_unauthorized')
    }
    console.error('[ai] groq error', response.status, detail.slice(0, 500))
    throw new AppError(502, 'The AI service could not generate a reply. Please try again.', 'ai_failed')
  }

  const payload = (await response.json()) as { choices?: GroqChoice[] }
  const content = payload.choices?.[0]?.message?.content
  if (!content) throw new AppError(502, 'The AI service returned an empty reply.', 'ai_empty')
  return content
}

/** Models occasionally wrap JSON in prose or a code fence despite instructions. */
function parseSuggestions(raw: string, requested: Tone[]): Suggestion[] {
  const jsonStart = raw.indexOf('{')
  const jsonEnd = raw.lastIndexOf('}')
  const slice = jsonStart >= 0 && jsonEnd > jsonStart ? raw.slice(jsonStart, jsonEnd + 1) : raw

  let parsed: unknown
  try {
    parsed = JSON.parse(slice)
  } catch {
    // Salvage the text rather than failing the request outright.
    return [{ tone: requested[0], body: raw.trim() }]
  }

  const list = (parsed as { suggestions?: unknown }).suggestions
  if (!Array.isArray(list)) return [{ tone: requested[0], body: raw.trim() }]

  const suggestions: Suggestion[] = []
  for (const item of list) {
    const body = String((item as { body?: unknown }).body ?? '').trim()
    if (!body) continue
    const rawTone = String((item as { tone?: unknown }).tone ?? '').toLowerCase()
    const tone = (ALL_TONES as readonly string[]).includes(rawTone) ? (rawTone as Tone) : requested[suggestions.length] ?? requested[0]
    suggestions.push({ tone, body })
  }

  return suggestions.length ? suggestions : [{ tone: requested[0], body: raw.trim() }]
}

export async function generateSuggestions(params: {
  messages: AiMessage[]
  tones?: Tone[]
  signature?: string | null
}): Promise<Suggestion[]> {
  if (!params.messages.length) {
    throw new AppError(400, 'There is nothing in this conversation to reply to.', 'empty_thread')
  }

  const tones = params.tones?.length ? params.tones : [...DEFAULT_TONES]
  const raw = await callGroq(buildUserPrompt(params.messages, tones, params.signature ?? null))
  return parseSuggestions(raw, tones)
}

/**
 * Turns the model's plain text into the HTML the composer and Gmail expect.
 * Escaping first is what stops a reply body from injecting markup.
 */
export function suggestionToHtml(body: string): string {
  const escaped = body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  return escaped
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, '<br>')}</p>`)
    .join('')
}
