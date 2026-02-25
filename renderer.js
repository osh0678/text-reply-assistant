// ── 전역 상태 ───────────────────────────────────────────────────────────────
const state = {
  rooms: {},       // { [roomId]: { id, name, createdAt } }
  profiles: {},    // { [roomId]: profileObject }
  settings: {},    // { apiKey }
  activeRoomId: null,
  currentMode: 'reply'
}

// ── 초기화 ──────────────────────────────────────────────────────────────────
async function init() {
  // 저장된 데이터 불러오기
  const [rooms, profiles, settings] = await Promise.all([
    window.electronAPI.loadData('rooms'),
    window.electronAPI.loadData('profiles'),
    window.electronAPI.loadData('settings')
  ])

  state.rooms    = rooms    || {}
  state.profiles = profiles || {}
  state.settings = settings || {}

  renderRoomList()
  updateApiStatus()
  bindEvents()
}

// ── 이벤트 바인딩 ────────────────────────────────────────────────────────────
function bindEvents() {
  // 사이드바
  document.getElementById('add-room-btn').addEventListener('click', () => openModal('add-room-modal'))
  document.getElementById('settings-btn').addEventListener('click', openSettings)

  // 채팅방 추가 확인
  document.getElementById('confirm-add-room').addEventListener('click', confirmAddRoom)
  document.getElementById('new-room-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') confirmAddRoom()
  })

  // 프로필 저장
  document.getElementById('save-profile-btn').addEventListener('click', saveProfile)

  // 설정 저장
  document.getElementById('save-settings-btn').addEventListener('click', saveSettings)
  document.getElementById('test-api-btn').addEventListener('click', testApiKey)
  document.getElementById('toggle-api-key').addEventListener('click', () => {
    const input = document.getElementById('api-key-input')
    input.type = input.type === 'password' ? 'text' : 'password'
  })
  document.getElementById('toggle-openai-key').addEventListener('click', () => {
    const input = document.getElementById('openai-key-input')
    input.type = input.type === 'password' ? 'text' : 'password'
  })

  // 프로바이더 드롭다운 전환
  document.getElementById('provider-select').addEventListener('change', (e) => {
    _activeProvider = e.target.value
    syncProviderSections()
    document.getElementById('api-test-result').className = 'test-result hidden'
  })

  // 토글: Gemini 키
  document.getElementById('toggle-gemini-key').addEventListener('click', () => {
    const input = document.getElementById('gemini-key-input')
    input.type = input.type === 'password' ? 'text' : 'password'
  })

  // Ollama 모델 불러오기
  document.getElementById('fetch-ollama-models-btn').addEventListener('click', fetchOllamaModels)

  // Ollama 모델 select 변경 시 hidden input 동기화
  document.getElementById('ollama-model-select').addEventListener('change', (e) => {
    document.getElementById('ollama-model-input').value = e.target.value
  })

  // 모드 탭
  document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.addEventListener('click', () => switchMode(tab.dataset.mode))
  })

  // 생성 버튼
  document.getElementById('generate-btn').addEventListener('click', handleGenerate)

  // 초기화 버튼
  document.getElementById('clear-results-btn').addEventListener('click', () => {
    document.getElementById('results-section').classList.add('hidden')
    document.getElementById('results-list').innerHTML = ''
    document.getElementById('chat-log').value = ''
    document.getElementById('user-goal').value = ''
  })

  // 프로필 버튼
  document.getElementById('profile-btn').addEventListener('click', openProfileModal)

  // 방 삭제
  document.getElementById('delete-room-btn').addEventListener('click', deleteCurrentRoom)

  // 모달 닫기 (data-close 속성)
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close))
  })

  // 모달 오버레이 클릭 시 닫기
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) closeModal(overlay.id)
    })
  })

  // ESC 닫기
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(m => closeModal(m.id))
    }
  })
}

// ── 채팅방 관리 ─────────────────────────────────────────────────────────────
function confirmAddRoom() {
  const nameInput = document.getElementById('new-room-name')
  const name = nameInput.value.trim()
  if (!name) { showToast('채팅방 이름을 입력해주세요.', 'error'); return }

  const id = 'room_' + Date.now()
  state.rooms[id] = { id, name, createdAt: new Date().toISOString() }
  saveRooms()

  nameInput.value = ''
  closeModal('add-room-modal')
  renderRoomList()
  selectRoom(id)
  showToast(`"${name}" 채팅방이 추가되었습니다.`, 'success')
}

function selectRoom(roomId) {
  state.activeRoomId = roomId
  const room = state.rooms[roomId]
  if (!room) return

  // 사이드바 활성 표시
  document.querySelectorAll('.room-item').forEach(el => {
    el.classList.toggle('active', el.dataset.roomId === roomId)
  })

  // 빈 상태 → 채팅방 뷰 전환
  document.getElementById('empty-state').classList.add('hidden')
  document.getElementById('room-view').classList.remove('hidden')

  // 제목 / 언어 배지 업데이트
  document.getElementById('room-name-display').textContent = room.name
  updateLangBadge()

  // 결과 초기화
  document.getElementById('results-section').classList.add('hidden')
  document.getElementById('results-list').innerHTML = ''
  document.getElementById('chat-log').value = ''
  document.getElementById('user-goal').value = ''

  // 프로필 요약 바 업데이트
  renderProfileSummary()
}

function deleteCurrentRoom() {
  if (!state.activeRoomId) return
  const room = state.rooms[state.activeRoomId]
  if (!room) return

  if (!confirm(`"${room.name}" 채팅방을 삭제하시겠습니까?`)) return

  delete state.rooms[state.activeRoomId]
  delete state.profiles[state.activeRoomId]
  saveRooms()
  saveProfiles()

  state.activeRoomId = null
  document.getElementById('room-view').classList.add('hidden')
  document.getElementById('empty-state').classList.remove('hidden')

  renderRoomList()
  showToast('채팅방이 삭제되었습니다.')
}

function renderRoomList() {
  const list = document.getElementById('room-list')
  const rooms = Object.values(state.rooms).sort((a, b) =>
    new Date(b.createdAt) - new Date(a.createdAt)
  )

  if (rooms.length === 0) {
    list.innerHTML = `<div style="padding:16px 10px;color:var(--text-muted);font-size:12px;text-align:center">채팅방이 없습니다</div>`
    return
  }

  list.innerHTML = rooms.map(room => {
    const profile = state.profiles[room.id] || {}
    const lang = profile.theirLang ? `→ ${profile.theirLang.slice(0,2).toUpperCase()}` : ''
    const emoji = getRoomEmoji(profile.relationship)
    return `
      <div class="room-item ${room.id === state.activeRoomId ? 'active' : ''}"
           data-room-id="${room.id}"
           onclick="selectRoom('${room.id}')">
        <div class="room-avatar">${emoji}</div>
        <div class="room-info">
          <div class="room-info-name">${escHtml(room.name)}</div>
          <div class="room-info-meta">${[profile.relationship, lang].filter(Boolean).join(' · ') || '프로필 미설정'}</div>
        </div>
      </div>`
  }).join('')
}

function getRoomEmoji(relationship) {
  const map = { '연인': '💕', '썸': '💫', '친구': '👥', '업무': '💼', '가족': '🏠', '지인': '🤝' }
  return map[relationship] || '💬'
}

// ── 프로필 관리 ─────────────────────────────────────────────────────────────
function openProfileModal() {
  const profile = state.profiles[state.activeRoomId] || {}

  // 성별
  const genderVal = profile.gender || '미지정'
  document.querySelectorAll('input[name="gender"]').forEach(r => {
    r.checked = r.value === genderVal
  })

  // 나머지 필드
  document.getElementById('profile-relationship').value = profile.relationship || ''
  document.getElementById('profile-mbti').value          = profile.mbti || ''
  document.getElementById('profile-tone').value          = profile.tone || ''
  document.getElementById('profile-personality').value   = profile.personality || ''
  document.getElementById('profile-my-lang').value       = profile.myLang || 'Korean'
  document.getElementById('profile-their-lang').value    = profile.theirLang || 'English'
  document.getElementById('profile-forbidden').value     = profile.forbidden || ''

  openModal('profile-modal')
}

function saveProfile() {
  const gender = document.querySelector('input[name="gender"]:checked')?.value || '미지정'

  const profile = {
    gender,
    relationship: document.getElementById('profile-relationship').value,
    mbti:         document.getElementById('profile-mbti').value.toUpperCase(),
    tone:         document.getElementById('profile-tone').value,
    personality:  document.getElementById('profile-personality').value,
    myLang:       document.getElementById('profile-my-lang').value,
    theirLang:    document.getElementById('profile-their-lang').value,
    forbidden:    document.getElementById('profile-forbidden').value
  }

  state.profiles[state.activeRoomId] = profile
  saveProfiles()
  closeModal('profile-modal')

  renderProfileSummary()
  updateLangBadge()
  renderRoomList()
  showToast('프로필이 저장되었습니다.', 'success')
}

function renderProfileSummary() {
  const bar = document.getElementById('profile-summary-bar')
  const profile = state.profiles[state.activeRoomId]

  if (!profile || Object.values(profile).every(v => !v)) {
    bar.classList.add('hidden')
    return
  }

  const tags = []
  if (profile.gender && profile.gender !== '미지정') tags.push(profile.gender)
  if (profile.mbti)         tags.push(profile.mbti)
  if (profile.relationship) tags.push(profile.relationship)
  if (profile.tone)         tags.push(profile.tone)
  if (profile.personality) {
    profile.personality.split(',').slice(0, 3).forEach(k => {
      const t = k.trim()
      if (t) tags.push(t)
    })
  }

  const forbiddenTag = profile.forbidden
    ? `<span class="profile-tag warning">⚠️ 금기어 설정됨</span>`
    : ''

  bar.innerHTML = tags.map(t => `<span class="profile-tag">${escHtml(t)}</span>`).join('') + forbiddenTag
  bar.classList.remove('hidden')
}

function updateLangBadge() {
  const badge = document.getElementById('room-lang-badge')
  const profile = state.profiles[state.activeRoomId]
  if (profile?.myLang && profile?.theirLang) {
    const from = langCode(profile.myLang)
    const to   = langCode(profile.theirLang)
    badge.textContent = `${from} ↔ ${to}`
    badge.classList.remove('hidden')
  } else {
    badge.textContent = ''
    badge.classList.add('hidden')
  }
}

function langCode(lang) {
  const map = { Korean: 'KO', English: 'EN', Japanese: 'JP', Chinese: 'CN' }
  return map[lang] || lang.slice(0, 2).toUpperCase()
}

// ── 설정 ─────────────────────────────────────────────────────────────────────
let _activeProvider = 'claude'

const PROVIDER_LABELS = {
  claude: 'Claude',
  openai: 'OpenAI',
  gemini: 'Gemini (무료)',
  ollama: 'Ollama (로컬)'
}

function openSettings() {
  _activeProvider = state.settings.provider || 'claude'

  document.getElementById('provider-select').value    = _activeProvider
  document.getElementById('api-key-input').value      = state.settings.apiKey        || ''
  document.getElementById('claude-model').value       = state.settings.claudeModel   || 'claude-sonnet-4-5-20250929'
  document.getElementById('openai-key-input').value   = state.settings.openaiApiKey  || ''
  document.getElementById('openai-model').value       = state.settings.openaiModel   || 'gpt-4o'
  document.getElementById('gemini-key-input').value   = state.settings.geminiApiKey  || ''
  document.getElementById('gemini-model').value       = state.settings.geminiModel   || 'gemini-2.5-flash'
  document.getElementById('ollama-endpoint').value    = state.settings.ollamaEndpoint|| 'http://localhost:11434'
  document.getElementById('ollama-model-input').value = state.settings.ollamaModel   || 'llama3.2'
  document.getElementById('api-test-result').className = 'test-result hidden'

  syncProviderSections()

  // Ollama 설정 모달을 열 때 모델 목록 자동 로딩
  if (_activeProvider === 'ollama') {
    fetchOllamaModels()
  }

  openModal('settings-modal')
}

function syncProviderSections() {
  const providers = ['claude', 'openai', 'gemini', 'ollama']
  providers.forEach(p => {
    document.getElementById(`provider-${p}`).classList.toggle('hidden', p !== _activeProvider)
  })
}

async function saveSettings() {
  state.settings.provider       = _activeProvider
  state.settings.apiKey         = document.getElementById('api-key-input').value.trim()
  state.settings.claudeModel    = document.getElementById('claude-model').value
  state.settings.openaiApiKey   = document.getElementById('openai-key-input').value.trim()
  state.settings.openaiModel    = document.getElementById('openai-model').value
  state.settings.geminiApiKey   = document.getElementById('gemini-key-input').value.trim()
  state.settings.geminiModel    = document.getElementById('gemini-model').value
  state.settings.ollamaEndpoint = document.getElementById('ollama-endpoint').value.trim()
  // select가 보이면 select 값 우선, 아니면 text input
  const ollamaSelect = document.getElementById('ollama-model-select')
  state.settings.ollamaModel = (!ollamaSelect.classList.contains('hidden') && ollamaSelect.value)
    ? ollamaSelect.value
    : document.getElementById('ollama-model-input').value.trim() || 'llama3.2'

  await window.electronAPI.saveData('settings', state.settings)
  closeModal('settings-modal')
  updateApiStatus()
  showToast('설정이 저장되었습니다.', 'success')
}

async function testApiKey() {
  const resultEl = document.getElementById('api-test-result')

  // Ollama는 키 없어도 됨 — 서버 연결만 확인
  const keyMap = {
    claude: document.getElementById('api-key-input').value.trim(),
    openai: document.getElementById('openai-key-input').value.trim(),
    gemini: document.getElementById('gemini-key-input').value.trim(),
    ollama: 'no-key-needed'
  }
  const key = keyMap[_activeProvider]
  if (!key) {
    resultEl.textContent = '⚠️ API 키를 먼저 입력해주세요.'
    resultEl.className = 'test-result error'
    return
  }

  resultEl.textContent = `${PROVIDER_LABELS[_activeProvider]} 연결 테스트 중...`
  resultEl.className = 'test-result'

  // 임시 저장 후 테스트
  const backup = { ...state.settings }
  Object.assign(state.settings, {
    provider:       _activeProvider,
    apiKey:         document.getElementById('api-key-input').value.trim(),
    claudeModel:    document.getElementById('claude-model').value,
    openaiApiKey:   document.getElementById('openai-key-input').value.trim(),
    openaiModel:    document.getElementById('openai-model').value,
    geminiApiKey:   document.getElementById('gemini-key-input').value.trim(),
    geminiModel:    document.getElementById('gemini-model').value,
    ollamaEndpoint: document.getElementById('ollama-endpoint').value.trim(),
    ollamaModel: (() => {
      const sel = document.getElementById('ollama-model-select')
      return (!sel.classList.contains('hidden') && sel.value)
        ? sel.value
        : document.getElementById('ollama-model-input').value.trim() || 'llama3.2'
    })()
  })
  await window.electronAPI.saveData('settings', state.settings)

  try {
    const res = await window.electronAPI.translateText({
      text: '안녕하세요',
      fromLang: 'Korean',
      toLang: 'English',
      style: ''
    })
    const label = PROVIDER_LABELS[_activeProvider]
    resultEl.textContent = `✅ ${label} 연결 성공! 번역: "${res.translation}"`
    resultEl.className = 'test-result ok'
    updateApiStatus(true)
  } catch (e) {
    resultEl.textContent = `❌ 연결 실패: ${e.message}`
    resultEl.className = 'test-result error'
    Object.assign(state.settings, backup)
    await window.electronAPI.saveData('settings', backup)
    updateApiStatus(false)
  }
}

function updateApiStatus(status) {
  const dot      = document.getElementById('api-status')
  const text     = document.getElementById('api-status-text')
  const provider = state.settings.provider || 'claude'
  const label    = PROVIDER_LABELS[provider] || 'Claude'

  const hasKey = {
    claude: !!state.settings.apiKey,
    openai: !!state.settings.openaiApiKey,
    gemini: !!state.settings.geminiApiKey,
    ollama: true  // 키 불필요
  }[provider]

  if (status === true) {
    dot.className = 'status-dot status-ok'
    text.textContent = `${label} 연결됨`
  } else if (status === false) {
    dot.className = 'status-dot status-error'
    text.textContent = `${label} 오류`
  } else if (hasKey) {
    dot.className = 'status-dot status-unknown'
    text.textContent = `${label} 설정됨`
  } else {
    dot.className = 'status-dot status-unknown'
    text.textContent = 'API 미설정'
  }
}

// ── Ollama 모델 목록 불러오기 ─────────────────────────────────────────────────
async function fetchOllamaModels() {
  const btn      = document.getElementById('fetch-ollama-models-btn')
  const status   = document.getElementById('ollama-model-status')
  const select   = document.getElementById('ollama-model-select')
  const input    = document.getElementById('ollama-model-input')
  const endpoint = document.getElementById('ollama-endpoint').value.trim() || 'http://localhost:11434'
  const saved    = state.settings.ollamaModel || 'llama3.2'

  btn.textContent = '불러오는 중...'
  btn.disabled = true
  status.textContent = '연결 중...'
  status.className = 'ollama-model-status loading'

  try {
    const result = await window.electronAPI.getOllamaModels(endpoint)

    if (!result.ok) {
      status.innerHTML = `❌ ${escHtml(result.error)}`
      status.className = 'ollama-model-status error'
      // 연결 실패 시 수동 입력 폼으로 fallback
      select.classList.add('hidden')
      input.classList.remove('hidden')
      return
    }

    if (result.models.length === 0) {
      status.innerHTML = `⚠️ 설치된 모델 없음 — 터미널에서 <code>ollama pull llama3.2</code> 실행 후 다시 시도`
      status.className = 'ollama-model-status warn'
      select.classList.add('hidden')
      input.classList.remove('hidden')
      return
    }

    // 성공: select 채우기
    select.innerHTML = result.models.map(m =>
      `<option value="${escHtml(m)}" ${m === saved ? 'selected' : ''}>${escHtml(m)}</option>`
    ).join('')

    // 저장된 모델이 목록에 없으면 첫 번째 선택
    if (!result.models.includes(saved)) {
      select.value = result.models[0]
    }

    // hidden input도 동기화
    input.value = select.value

    status.innerHTML = `✅ ${result.models.length}개 모델 발견`
    status.className = 'ollama-model-status ok'
    select.classList.remove('hidden')
    input.classList.add('hidden')

  } catch (e) {
    status.innerHTML = `❌ 오류: ${escHtml(e.message)}`
    status.className = 'ollama-model-status error'
    select.classList.add('hidden')
    input.classList.remove('hidden')
  } finally {
    btn.textContent = '🔄 모델 불러오기'
    btn.disabled = false
  }
}

// ── 모드 전환 ─────────────────────────────────────────────────────────────────
function switchMode(mode) {
  state.currentMode = mode

  document.querySelectorAll('.mode-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.mode === mode)
  })

  const goalSection    = document.getElementById('goal-section')
  const translateOpts  = document.getElementById('translate-options')

  if (mode === 'translate') {
    goalSection.classList.add('hidden')
    translateOpts.classList.remove('hidden')
  } else {
    goalSection.classList.remove('hidden')
    translateOpts.classList.add('hidden')
  }

  // 결과 초기화
  document.getElementById('results-section').classList.add('hidden')
  document.getElementById('results-list').innerHTML = ''
}

// ── 생성 핸들러 ───────────────────────────────────────────────────────────────
async function handleGenerate() {
  const chatLog = document.getElementById('chat-log').value.trim()
  if (!chatLog) {
    showToast('대화 로그를 붙여넣기 해주세요.', 'error')
    return
  }

  // 선택된 프로바이더에 맞는 키 검사
  const provider = state.settings.provider || 'claude'
  const missingKey = {
    claude: !state.settings.apiKey       && 'Claude API 키',
    openai: !state.settings.openaiApiKey && 'OpenAI API 키',
    gemini: !state.settings.geminiApiKey && 'Gemini API 키',
    ollama: false  // 키 불필요
  }[provider]
  if (missingKey) {
    showToast(`⚙️ 설정에서 ${missingKey}를 먼저 입력해주세요.`, 'error')
    return
  }

  setGenerating(true)

  try {
    if (state.currentMode === 'translate') {
      await handleTranslate(chatLog)
    } else {
      await handleReplyGeneration(chatLog)
    }
  } catch (err) {
    showToast(`오류: ${err.message}`, 'error')
    console.error(err)
  } finally {
    setGenerating(false)
  }
}

async function handleReplyGeneration(chatLog) {
  const userGoal = document.getElementById('user-goal').value.trim()
  const profile  = state.profiles[state.activeRoomId] || {}

  const result = await window.electronAPI.generateReplies({
    chatLog,
    profile,
    userGoal,
    mode: state.currentMode
  })

  renderReplies(result.replies || [])
}

async function handleTranslate(text) {
  const fromLang = document.getElementById('from-lang').value
  const toLang   = document.getElementById('to-lang').value
  const style    = document.getElementById('translate-style').value

  if (fromLang === toLang) {
    showToast('출발 언어와 도착 언어가 같습니다.', 'error')
    return
  }

  const result = await window.electronAPI.translateText({ text, fromLang, toLang, style })
  renderTranslation(result, fromLang, toLang)
}

// ── 결과 렌더링 ────────────────────────────────────────────────────────────────
function renderReplies(replies) {
  const section = document.getElementById('results-section')
  const list    = document.getElementById('results-list')
  const title   = document.getElementById('results-title')
  const count   = document.getElementById('results-count')

  const modeLabel = { reply: '추천 답장', 'translate-reply': '번역 답장 추천' }
  title.textContent = modeLabel[state.currentMode] || '결과'
  count.textContent = `${replies.length}개`

  list.innerHTML = replies.map((r, i) => {
    const labelClass = `label-${r.label}` in getComputedStyleVars() ? `label-${r.label}` : 'label-default'
    return `
      <div class="reply-card" id="reply-${i}">
        <div class="reply-card-header">
          <span class="reply-label ${getLabelClass(r.label)}">${escHtml(r.label)}</span>
        </div>
        <div class="reply-text" id="reply-text-${i}">${escHtml(r.text)}</div>
        ${r.reason ? `<div class="reply-reason">${escHtml(r.reason)}</div>` : ''}
        ${r.risk   ? `<div class="reply-risk">${escHtml(r.risk)}</div>` : ''}
        <div class="reply-actions">
          <button class="copy-btn" onclick="copyReply(${i})">📋 복사</button>
        </div>
      </div>`
  }).join('')

  section.classList.remove('hidden')
  section.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function renderTranslation(result, fromLang, toLang) {
  const section = document.getElementById('results-section')
  const list    = document.getElementById('results-list')
  const title   = document.getElementById('results-title')
  const count   = document.getElementById('results-count')

  title.textContent = `번역 결과`
  count.textContent = `${langCode(fromLang)} → ${langCode(toLang)}`

  list.innerHTML = `
    <div class="translate-card">
      <div>
        <div class="translate-section-label">번역 결과 (${toLang})</div>
        <div class="translate-text" id="translate-main">${escHtml(result.translation)}</div>
      </div>
      ${result.backTranslation ? `
      <div>
        <div class="translate-section-label">역번역 (한국어 확인용)</div>
        <div class="back-translation">${escHtml(result.backTranslation)}</div>
      </div>` : ''}
      ${result.notes ? `<div class="translate-notes">📝 ${escHtml(result.notes)}</div>` : ''}
      <div class="reply-actions">
        <button class="copy-btn" onclick="copyText('translate-main')">📋 번역문 복사</button>
      </div>
    </div>`

  section.classList.remove('hidden')
  section.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// ── 복사 기능 ─────────────────────────────────────────────────────────────────
function copyReply(index) {
  const el  = document.getElementById(`reply-text-${index}`)
  const btn = document.querySelector(`#reply-${index} .copy-btn`)
  if (!el) return

  navigator.clipboard.writeText(el.textContent).then(() => {
    btn.textContent = '✅ 복사됨'
    btn.classList.add('copied')
    setTimeout(() => {
      btn.textContent = '📋 복사'
      btn.classList.remove('copied')
    }, 2000)
  })
}

function copyText(elId) {
  const el = document.getElementById(elId)
  if (!el) return
  navigator.clipboard.writeText(el.textContent).then(() => {
    showToast('클립보드에 복사되었습니다.', 'success')
  })
}

// ── UI 유틸 ─────────────────────────────────────────────────────────────────
function openModal(id) {
  document.getElementById(id).classList.remove('hidden')
}
function closeModal(id) {
  document.getElementById(id).classList.add('hidden')
}

function setGenerating(loading) {
  const btn     = document.getElementById('generate-btn')
  const text    = document.getElementById('generate-btn-text')
  const spinner = document.getElementById('generate-spinner')

  btn.disabled = loading
  if (loading) {
    text.textContent = '생성 중...'
    spinner.classList.remove('hidden')
    // 로딩 스켈레톤 표시
    const section = document.getElementById('results-section')
    const list    = document.getElementById('results-list')
    list.innerHTML = `
      <div class="loading-placeholder">
        <div class="skeleton" style="height:120px"></div>
        <div class="skeleton" style="height:120px"></div>
        <div class="skeleton" style="height:120px"></div>
      </div>`
    section.classList.remove('hidden')
  } else {
    text.textContent = '✨ 생성하기'
    spinner.classList.add('hidden')
  }
}

function showToast(message, type = '') {
  const container = document.getElementById('toast-container')
  const toast = document.createElement('div')
  toast.className = `toast ${type}`
  toast.textContent = message
  container.appendChild(toast)
  setTimeout(() => {
    toast.style.opacity = '0'
    toast.style.transition = 'opacity 0.3s'
    setTimeout(() => toast.remove(), 300)
  }, 3000)
}

function getLabelClass(label) {
  const valid = ['안정형', '다정형', '장난형', '단호형', '짧게']
  return valid.includes(label) ? `label-${label}` : 'label-default'
}

function getComputedStyleVars() {
  // CSS 변수 존재 여부 체크용 더미 함수
  return {}
}

function escHtml(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ── 데이터 저장 헬퍼 ─────────────────────────────────────────────────────────
async function saveRooms() {
  await window.electronAPI.saveData('rooms', state.rooms)
}
async function saveProfiles() {
  await window.electronAPI.saveData('profiles', state.profiles)
}

// ── 앱 시작 ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init)
