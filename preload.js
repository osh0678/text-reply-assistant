const { contextBridge, ipcRenderer } = require('electron')

// 렌더러 프로세스에 안전하게 API 노출
contextBridge.exposeInMainWorld('electronAPI', {
  // 데이터 저장/불러오기 (profiles, settings, rooms 등)
  loadData: (key) => ipcRenderer.invoke('load-data', key),
  saveData: (key, value) => ipcRenderer.invoke('save-data', key, value),

  // Claude API - 답장 생성
  generateReplies: (params) => ipcRenderer.invoke('generate-replies', params),

  // Claude API - 번역
  translateText: (params) => ipcRenderer.invoke('translate-text', params),

  // Ollama - 설치된 모델 목록 조회
  getOllamaModels: (endpoint) => ipcRenderer.invoke('get-ollama-models', endpoint),
})
