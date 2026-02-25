const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const http = require('http')
const https = require('https')

// ─── Node.js http/https 헬퍼 (Electron 메인 프로세스에서 fetch 대신 사용) ───
// Electron main process에서 fetch()로 localhost 연결 시 'fetch failed' 오류가
// 발생하는 알려진 문제를 우회하기 위해 Node.js 내장 모듈을 직접 사용합니다.
function nodeRequest(url, { method = 'GET', headers = {}, body = null, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed
    try { parsed = new URL(url) } catch (e) { return reject(new Error(`잘못된 URL: ${url}`)) }

    const lib = parsed.protocol === 'https:' ? https : http
    const reqOptions = {
      hostname: parsed.hostname,
      port:     parseInt(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + (parsed.search || ''),
      method,
      headers,
      family:   4  // IPv4 강제 — localhost가 ::1(IPv6)로 해석되는 문제 방지
    }

    const req = lib.request(reqOptions, (res) => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8')
        resolve({
          ok:     res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json:   () => { try { return Promise.resolve(JSON.parse(text)) } catch { return Promise.reject(new Error('JSON 파싱 실패: ' + text.slice(0, 120))) } },
          text:   () => Promise.resolve(text)
        })
      })
    })

    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('TimeoutError'), { name: 'TimeoutError' })))
    req.on('error', reject)
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body))
    req.end()
  })
}

let mainWindow

// ─── 데이터 파일 경로 ───────────────────────────────────────────────────────
function getDataPath(filename) {
  const dir = path.join(app.getPath('userData'), 'kakao-reply-data')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, filename)
}

// ─── 창 생성 ────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    backgroundColor: '#16213e',
    show: false,
    title: '카카오톡 답장 어시스턴트'
  })

  mainWindow.loadFile('index.html')

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })

// ─── IPC: 프로필/설정 관리 ──────────────────────────────────────────────────
ipcMain.handle('load-data', (_, key) => {
  try {
    const filePath = getDataPath(`${key}.json`)
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    }
  } catch (e) {
    console.error('load-data error:', e)
  }
  return null
})

ipcMain.handle('save-data', (_, key, value) => {
  try {
    fs.writeFileSync(getDataPath(`${key}.json`), JSON.stringify(value, null, 2), 'utf-8')
    return true
  } catch (e) {
    console.error('save-data error:', e)
    return false
  }
})

// ─── IPC: Ollama 모델 목록 조회 ──────────────────────────────────────────────
ipcMain.handle('get-ollama-models', async (_, endpoint) => {
  const base = (endpoint || 'http://localhost:11434').replace(/\/$/, '')
  try {
    const res = await nodeRequest(`${base}/api/tags`, { timeoutMs: 5000 })
    if (!res.ok) return { ok: false, error: `서버 응답 오류 (HTTP ${res.status})` }
    const data = await res.json()
    const models = (data.models || []).map(m => m.name)
    return { ok: true, models }
  } catch (e) {
    if (e.name === 'TimeoutError' || e.message === 'TimeoutError') {
      return { ok: false, error: 'Ollama 서버 응답 없음 (5초 초과). 실행 중인지 확인하세요.' }
    }
    return { ok: false, error: `연결 실패: ${e.message}` }
  }
})

// ─── IPC: 답장 생성 ─────────────────────────────────────────────────────────
ipcMain.handle('generate-replies', async (_, params) => {
  const { chatLog, profile, userGoal, mode } = params
  const settings = await loadSettings()
  const systemPrompt = buildSystemPrompt(mode, profile)
  const userMessage  = buildUserMessage(chatLog, profile, userGoal, mode)

  return callAIWithJsonRetry({
    settings,
    systemPrompt,
    userMessage,
    maxTokens: 2500,
    validator: isValidRepliesPayload,
    schemaHint: '{"replies":[{"label":"...","text":"...","reason":"...","risk":null}]}'
  })
})

// ─── IPC: 번역 ──────────────────────────────────────────────────────────────
ipcMain.handle('translate-text', async (_, params) => {
  const { text, fromLang, toLang, style } = params
  const settings = await loadSettings()

  const stylePart = style ? ` 스타일은 "${style}"로 해주세요.` : ''
  const system = `당신은 전문 번역가입니다. 정확하고 자연스러운 번역을 제공합니다.`
  const prompt = `아래 텍스트를 ${fromLang}에서 ${toLang}로 번역해주세요.${stylePart}

번역할 텍스트:
"""
${text}
"""

순수 JSON만 반환 (마크다운 없이):
{"translation": "번역 결과", "backTranslation": "역번역 결과 (한국어로)", "notes": "번역 참고사항 또는 null"}`

  return callAIWithJsonRetry({
    settings,
    systemPrompt: system,
    userMessage: prompt,
    maxTokens: 1000,
    validator: isValidTranslatePayload,
    schemaHint: '{"translation":"...","backTranslation":"...","notes":null}'
  })
})

// ─── AI 호출 헬퍼 ─────────────────────────────────────────────────────────────
async function callClaude(settings, systemPrompt, userMessage, maxTokens) {
  if (!settings.apiKey) {
    throw new Error('Claude API 키가 설정되지 않았습니다. ⚙️ 설정에서 API 키를 입력해주세요.')
  }
  const Anthropic = require('@anthropic-ai/sdk')
  const client = new Anthropic.default({ apiKey: settings.apiKey })
  const model  = settings.claudeModel || 'claude-sonnet-4-5-20250929'
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }]
  })
  return response.content[0].text.trim()
}

async function callOpenAI(settings, systemPrompt, userMessage, maxTokens) {
  if (!settings.openaiApiKey) {
    throw new Error('OpenAI API 키가 설정되지 않았습니다. ⚙️ 설정에서 API 키를 입력해주세요.')
  }
  const OpenAI = require('openai')
  const client = new OpenAI.default({ apiKey: settings.openaiApiKey })
  const model  = settings.openaiModel || 'gpt-4o'
  const response = await client.chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userMessage  }
    ]
  })
  return response.choices[0].message.content.trim()
}

// ─── 무료: Google Gemini ─────────────────────────────────────────────────────
async function callGemini(settings, systemPrompt, userMessage, maxTokens) {
  if (!settings.geminiApiKey) {
    throw new Error('Gemini API 키가 설정되지 않았습니다. ⚙️ 설정에서 API 키를 입력해주세요.')
  }
  const model = normalizeGeminiModel(settings.geminiModel)
  const url   = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.geminiApiKey}`

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // Gemini는 system instruction을 별도 필드로 받음
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      generationConfig: { maxOutputTokens: maxTokens }
    })
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error?.message || `Gemini API 오류 (${res.status})`)
  }

  const data = await res.json()
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('Gemini 응답이 비어있습니다.')
  return text.trim()
}

// ─── 무료: Ollama (로컬) ─────────────────────────────────────────────────────
async function callOllama(settings, systemPrompt, userMessage, maxTokens) {
  const endpoint = (settings.ollamaEndpoint || 'http://localhost:11434').replace(/\/$/, '')
  const model    = settings.ollamaModel || 'llama3.2'

  let res
  try {
    res = await nodeRequest(`${endpoint}/api/chat`, {
      method:    'POST',
      headers:   { 'Content-Type': 'application/json' },
      body:      JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userMessage  }
        ],
        stream:  false,
        options: { num_predict: maxTokens }
      }),
      timeoutMs: 120000  // 로컬 모델은 응답이 느릴 수 있어 2분 허용
    })
  } catch (e) {
    if (e.name === 'TimeoutError' || e.message === 'TimeoutError') {
      throw new Error(`Ollama 응답 시간 초과 (2분). 더 가벼운 모델을 사용해보세요.`)
    }
    throw new Error(`Ollama 서버에 연결할 수 없습니다 (${endpoint}).\nOllama가 실행 중인지 확인하세요. 설치: https://ollama.com`)
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `Ollama 오류 (HTTP ${res.status}) — 모델 "${model}"이 설치되어 있는지 확인하세요.\n터미널: ollama pull ${model}`)
  }

  const data = await res.json()
  const text = data.message?.content
  if (!text) throw new Error('Ollama 응답이 비어있습니다.')
  return text.trim()
}

// ─── 프로바이더 라우터 ────────────────────────────────────────────────────────
async function callAI(settings, systemPrompt, userMessage, maxTokens) {
  switch (settings.provider) {
    case 'openai':  return callOpenAI(settings, systemPrompt, userMessage, maxTokens)
    case 'gemini':  return callGemini(settings, systemPrompt, userMessage, maxTokens)
    case 'ollama':  return callOllama(settings, systemPrompt, userMessage, maxTokens)
    default:        return callClaude(settings, systemPrompt, userMessage, maxTokens)
  }
}

function parseJsonBlock(raw) {
  if (typeof raw !== 'string') return ''
  const cleaned = raw.replace(/^\uFEFF/, '').trim()
  const fencedMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fencedMatch) return fencedMatch[1].trim()
  return cleaned
}

function extractCandidateJson(raw) {
  const fromBlock = parseJsonBlock(raw)
  if (fromBlock) return fromBlock

  const src = (raw || '').trim()
  const firstObj = src.indexOf('{')
  const firstArr = src.indexOf('[')
  const starts = [firstObj, firstArr].filter(i => i >= 0)
  if (starts.length === 0) return src
  const start = Math.min(...starts)
  const endObj = src.lastIndexOf('}')
  const endArr = src.lastIndexOf(']')
  const end = Math.max(endObj, endArr)
  if (end <= start) return src
  return src.slice(start, end + 1).trim()
}

function safeJsonParse(raw) {
  const candidate = extractCandidateJson(raw)
  try {
    return { ok: true, value: JSON.parse(candidate), candidate }
  } catch (error) {
    return { ok: false, error, candidate }
  }
}

function isValidRepliesPayload(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.replies)) return false
  if (value.replies.length < 1) return false

  return value.replies.every((item) => {
    if (!item || typeof item !== 'object') return false
    if (typeof item.label !== 'string' || !item.label.trim()) return false
    if (typeof item.text !== 'string' || !item.text.trim()) return false
    if (!(item.reason == null || typeof item.reason === 'string')) return false
    if (!(item.risk == null || typeof item.risk === 'string')) return false
    return true
  })
}

function isValidTranslatePayload(value) {
  if (!value || typeof value !== 'object') return false
  if (typeof value.translation !== 'string' || !value.translation.trim()) return false
  if (typeof value.backTranslation !== 'string' || !value.backTranslation.trim()) return false
  if (!(value.notes == null || typeof value.notes === 'string')) return false
  return true
}

function buildJsonRetryMessage(userMessage, raw, parseError, schemaHint) {
  const trimmedRaw = (raw || '').slice(0, 1200)
  const errMsg = parseError?.message || 'JSON parse error'

  return `${userMessage}

[중요 재지시]
- 직전 응답이 JSON 파싱에 실패했습니다.
- 반드시 마크다운 코드블록 없이 순수 JSON만 반환하세요.
- 설명 문장/머리말/꼬리말을 절대 넣지 마세요.
- JSON 스키마 예시: ${schemaHint}

[직전 파싱 오류]
${errMsg}

[직전 원본 일부]
${trimmedRaw}`
}

async function callAIWithJsonRetry({ settings, systemPrompt, userMessage, maxTokens, validator, schemaHint }) {
  const maxAttempts = 3
  let nextUserMessage = userMessage
  let lastError = null
  let lastRaw = ''

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const raw = await callAI(settings, systemPrompt, nextUserMessage, maxTokens)
    lastRaw = raw

    const parsed = safeJsonParse(raw)
    if (parsed.ok && validator(parsed.value)) {
      return parsed.value
    }

    lastError = parsed.ok
      ? new Error('JSON 형식은 맞지만 필수 필드 검증에 실패했습니다.')
      : parsed.error

    if (attempt < maxAttempts) {
      nextUserMessage = buildJsonRetryMessage(userMessage, raw, lastError, schemaHint)
    }
  }

  const sample = (lastRaw || '').slice(0, 300).replace(/\s+/g, ' ')
  throw new Error(`AI 응답 JSON 파싱/검증 실패: ${lastError?.message || 'unknown error'} | 원본 샘플: ${sample}`)
}

// ─── 헬퍼 함수들 ─────────────────────────────────────────────────────────────
const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash'
const GEMINI_DEPRECATED = [
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-1.5-pro',
  'gemini-1.5-flash-latest',
  'gemini-1.5-pro-latest',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-2.5-pro-exp-03-25',
  'models/gemini-1.5-flash',
  'models/gemini-1.5-flash-8b',
  'models/gemini-1.5-pro',
  'models/gemini-1.5-flash-latest',
  'models/gemini-1.5-pro-latest',
  'models/gemini-2.0-flash',
  'models/gemini-2.0-flash-lite',
  'models/gemini-2.5-pro-exp-03-25'
]

function normalizeGeminiModel(model) {
  const normalized = (model || '').replace(/^models\//, '').trim()
  if (!normalized || GEMINI_DEPRECATED.includes(model) || GEMINI_DEPRECATED.includes(normalized)) {
    return GEMINI_DEFAULT_MODEL
  }
  return normalized
}

async function loadSettings() {
  try {
    const filePath = getDataPath('settings.json')
    if (fs.existsSync(filePath)) {
      const s = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      const normalizedModel = normalizeGeminiModel(s.geminiModel)
      if (s.geminiModel !== normalizedModel) {
        s.geminiModel = normalizedModel
        fs.writeFileSync(filePath, JSON.stringify(s, null, 2), 'utf-8')
      }
      return s
    }
  } catch (e) {
    console.error('load-settings error:', e)
  }
  return {}
}

function buildSystemPrompt(mode, profile) {
  const targetLang = profile?.theirLang || 'Korean'

  if (mode === 'translate') {
    return `당신은 전문 번역가입니다. 정확하고 자연스러운 번역을 제공합니다.`
  }

  const langNote = mode === 'translate-reply'
    ? `답장 text 필드는 반드시 ${targetLang}로 작성하세요. reason은 한국어로 작성하세요.`
    : `답장 text 필드는 한국어로 작성하세요.`

  return `당신은 개인용 카카오톡 답장 어시스턴트입니다.
대화 맥락, 상대방 성격, 관계 유형을 분석해 최적의 답장을 3~5개 추천합니다.

${langNote}

반드시 아래 순수 JSON 형식으로만 반환하세요 (마크다운 코드블록 금지):
{
  "replies": [
    {
      "label": "라벨 (안정형/다정형/장난형/단호형/짧게 중 하나)",
      "text": "실제 답장 텍스트",
      "reason": "이 답장을 추천하는 이유 1~2줄 (한국어)",
      "risk": "위험 문구·오해 가능 포인트 (없으면 null)"
    }
  ]
}

규칙:
- 민감 주제(폭력/자해/불법)가 포함된 답장은 생성하지 않습니다
- 금기 표현이 지정된 경우 해당 표현을 절대 사용하지 않습니다
- 각 답장은 명확히 다른 톤/스타일을 가져야 합니다`
}

function buildUserMessage(chatLog, profile, userGoal, mode) {
  let msg = ''

  if (profile && Object.keys(profile).length > 0) {
    msg += `[상대방 프로필]\n`
    if (profile.gender)       msg += `- 성별: ${profile.gender}\n`
    if (profile.mbti)         msg += `- MBTI: ${profile.mbti}\n`
    if (profile.personality)  msg += `- 성격 키워드: ${profile.personality}\n`
    if (profile.tone)         msg += `- 선호 커뮤니케이션 톤: ${profile.tone}\n`
    if (profile.relationship) msg += `- 관계 유형: ${profile.relationship}\n`
    if (profile.forbidden)    msg += `- ⚠️ 금기 표현/주제: ${profile.forbidden}\n`
    if (profile.myLang)       msg += `- 내 언어: ${profile.myLang}\n`
    if (profile.theirLang)    msg += `- 상대 언어: ${profile.theirLang}\n`
    msg += '\n'
  }

  msg += `[최근 대화 로그]\n${chatLog}\n\n`

  if (userGoal) {
    msg += `[이번 답장 목표]\n${userGoal}\n\n`
  }

  if (mode === 'reply') {
    msg += `위 대화에 이어 보낼 답장 3~5개를 각기 다른 톤으로 추천해주세요.`
  } else if (mode === 'translate-reply') {
    const lang = profile?.theirLang || 'English'
    msg += `위 대화에 이어 보낼 답장을 ${lang}로 생성해주세요. 3~5개, 각기 다른 톤으로.`
  }

  return msg
}
