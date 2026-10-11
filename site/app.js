(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const STORAGE = 'crazy-ai-chats-v1';
  const MODEL_STORAGE = 'crazy-ai-model';
  const THEME_STORAGE = 'crazy-ai-theme';
  const PACE_STORAGE = 'gist-gpt-pace';
  const MAX_FILE = 1024 * 1024;
  const MAX_IMPORT = 8 * 1024 * 1024;
  const chatNotice = '当前尚未接入 AI 模型。你的消息已保存在此浏览器，接入模型服务后才能获得真正的回复。';
  const publicApi = window.GIST_API_CONFIG || {};
  const apiBase = (() => {
    try {
      const url = new URL(publicApi.baseUrl || '');
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) return '';
      return url.origin;
    } catch (_) { return ''; }
  })();
  const turnstileSiteKey = typeof publicApi.turnstileSiteKey === 'string' ? publicApi.turnstileSiteKey.trim() : '';
  const apiEnabled = Boolean(apiBase && turnstileSiteKey);
  let chatBusy = false;
  let imageBusy = false;
  let apiStatus = null;
  let turnstileScriptPromise = null;
  let turnstileWidgetId = null;
  let turnstilePending = null;

  let chats = loadChats();
  let currentId = null;
  let currentView = 'home';
  let currentMode = 'chat';
  let files = [];
  const modelIds = { 'DeepSeek V4.1 Flash': 'deepseek-v4.1-flash', 'GLM 5.3 Flash': 'glm-5.3-flash' };
  const allowedModels = Object.keys(modelIds);
  let selectedModel = localStorage.getItem(MODEL_STORAGE) || 'DeepSeek V4.1 Flash';
  if (!allowedModels.includes(selectedModel)) selectedModel = 'DeepSeek V4.1 Flash';
  let selectedPace = localStorage.getItem(PACE_STORAGE) === '推理' ? '推理' : '快速';
  let searchMode = false;
  let toastTimer;
  let imageSessions = [];
  let currentImageId = null;
  let currentImageVersion = 0;
  const imageDb = openImageDb();

  function openImageDb() {
    return new Promise((resolve) => {
      if (!('indexedDB' in window)) return resolve(null);
      const req = indexedDB.open('crazy-ai-images-v1', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('sessions', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  }
  async function loadImageSessions() {
    const db = await imageDb;
    if (!db) return;
    const sessions = await new Promise((resolve) => {
      const req = db.transaction('sessions', 'readonly').objectStore('sessions').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
    imageSessions = sessions.filter((s) => s && typeof s.id === 'string' && Array.isArray(s.versions));
    renderHistory();
  }
  async function saveImageSession(session) {
    const db = await imageDb;
    if (!db) return toast('当前浏览器不能持久保存图片；本次编辑仍可使用。');
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('sessions', 'readwrite');
        tx.objectStore('sessions').put(session);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch (_) { toast('图片保存失败，可能是浏览器存储空间不足。'); }
  }
  async function deleteImageSession(sessionId) {
    const db = await imageDb;
    if (!db) return;
    await new Promise((resolve) => {
      const tx = db.transaction('sessions', 'readwrite');
      tx.objectStore('sessions').delete(sessionId);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  }

  function loadChats() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE) || '[]');
      return Array.isArray(value) ? value.filter(validChat).slice(0, 100) : [];
    } catch (_) { return []; }
  }
  function validChat(chat) {
    return chat && typeof chat.id === 'string' && typeof chat.title === 'string' && Array.isArray(chat.messages);
  }
  function persist() {
    try { localStorage.setItem(STORAGE, JSON.stringify(chats)); }
    catch (_) { toast('本地空间不足，记录未能保存。请导出并清理旧聊天。'); }
  }
  function id() { return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2); }
  function now() { return new Date().toISOString(); }
  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3900);
  }
  function updateConnectionLabel(ready) {
    const footnote = document.querySelector('.side-footnote');
    if (footnote?.lastChild) footnote.lastChild.textContent = ready ? ' 本地保存 · 服务已连接' : ' 本地保存 · 服务待连接';
    const topPill = document.querySelector('.local-pill');
    if (topPill?.lastChild) topPill.lastChild.textContent = ready ? ' 服务已连接' : ' 服务待连接';
  }
  async function refreshApiStatus() {
    if (!apiEnabled) {
      apiStatus = null;
      renderMode();
      updateConnectionLabel(false);
      return;
    }
    try {
      const response = await fetch(apiBase + '/api/status', { signal: AbortSignal.timeout(8000), cache: 'no-store' });
      if (!response.ok) throw new Error('status_' + response.status);
      const data = await response.json();
      apiStatus = data;
      renderMode();
      updateConnectionLabel(data.ready);
    } catch (_) {
      apiStatus = null;
      renderMode();
      updateConnectionLabel(false);
    }
  }
  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    if (!turnstileScriptPromise) {
      turnstileScriptPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true;
        script.onload = () => window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile 未加载'));
        script.onerror = () => reject(new Error('Turnstile 加载失败'));
        document.head.append(script);
      });
    }
    return turnstileScriptPromise;
  }
  async function freshTurnstileToken() {
    const turnstile = await loadTurnstile();
    if (turnstileWidgetId === null) {
      turnstileWidgetId = turnstile.render('#turnstileWidget', {
        sitekey: turnstileSiteKey,
        action: 'gist_chat',
        execution: 'execute',
        appearance: 'interaction-only',
        callback: (token) => { if (turnstilePending) turnstilePending.resolve(token); },
        'error-callback': () => { if (turnstilePending) turnstilePending.reject(new Error('访客验证失败')); },
        'expired-callback': () => { if (turnstilePending) turnstilePending.reject(new Error('验证已过期')); },
      });
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (turnstilePending) turnstilePending.reject(new Error('访客验证超时'));
      }, 120_000);
      turnstilePending = {
        resolve: (token) => { clearTimeout(timer); turnstilePending = null; resolve(token); },
        reject: (error) => { clearTimeout(timer); turnstilePending = null; reject(error); },
      };
      try {
        turnstile.reset(turnstileWidgetId);
        turnstile.execute(turnstileWidgetId);
      } catch (error) { turnstilePending.reject(error); }
    });
  }
  function apiMessages(chat) {
    const messages = chat.messages
      .filter((message) => (message.role === 'user' || message.role === 'assistant') && !message.pending && typeof message.content === 'string' && message.content.trim())
      .slice(-24)
      .map((message) => ({ role: message.role, content: message.content.slice(0, 16_000) }));
    const encoder = new TextEncoder();
    while (messages.length > 1 && (messages.reduce((sum, message) => sum + message.content.length, 0) > 48_000 || encoder.encode(JSON.stringify(messages)).length > 56_000)) messages.shift();
    return messages;
  }
  async function requestApiReply(chat) {
    chatBusy = true;
    $('sendBtn').disabled = true;
    const pace = chat.messages.at(-1)?.pace === '推理' ? 'reason' : 'fast';
    const model = modelIds[chat.model] || modelIds[selectedModel];
    const pending = { role: 'assistant', content: '正在思考…', pending: true, at: now() };
    const messages = apiMessages(chat);
    chat.messages.push(pending);
    persist();
    if (currentId === chat.id) renderMessages();
    try {
      const turnstileToken = await freshTurnstileToken();
      const response = await fetch(apiBase + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, turnstileToken, pace, model }),
        signal: AbortSignal.timeout(130_000),
      });
      const data = await response.json();
      if (!response.ok) {
        const reasons = {
          actor_limit: '你今天的 100 次聊天额度已用完。',
          global_limit: '今天全站 1000 次聊天额度已用完。',
          token_limit: '今天全站 5000 万 Token 额度已用完。',
          rate_limited: '发送太快，请稍后重试。',
          verification_failed: '访客验证未通过，请重试。',
          configuration_incomplete: '聊天服务尚未完成配置。',
          credential_unavailable: 'CodeArts 登录凭据已失效，需要站长重新登录并更新服务端凭据。',
          upstream_unavailable: '模型服务暂时不可用，请稍后重试。',
        };
        throw new Error(reasons[data.error] || `聊天请求失败（HTTP ${response.status}）。`);
      }
      if (typeof data.reply !== 'string' || !data.reply) throw new Error('模型返回了空回复。');
      pending.role = 'assistant';
      pending.content = data.reply;
      if (Number.isSafeInteger(data.usage?.total_tokens)) pending.usedTokens = data.usage.total_tokens;
    } catch (error) {
      pending.role = 'notice';
      pending.content = error?.message || '聊天请求失败，请重试。';
    } finally {
      delete pending.pending;
      chat.updated = now();
      persist();
      if (currentId === chat.id) renderMessages();
      chatBusy = false;
      $('sendBtn').disabled = false;
    }
  }
  function download(name, value, type) {
    const blob = new Blob([value], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function closeMenus() { $('toolsMenu').hidden = true; $('modelMenu').hidden = true; }
  function closeSidebar() { $('sidebar').classList.remove('open'); $('mobileScrim').hidden = true; }

  function renderHistory() {
    const list = $('historyList');
    list.replaceChildren();
    const query = $('historySearch').value.trim().toLocaleLowerCase();
    const ordered = [...chats].sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
    const filtered = ordered.filter((c) => !query || c.title.toLocaleLowerCase().includes(query) || c.messages.some((m) => String(m.content || '').toLocaleLowerCase().includes(query)));
    const imageResults = [...imageSessions].sort((a, b) => String(b.updated).localeCompare(String(a.updated))).filter((s) => !query || s.title.toLocaleLowerCase().includes(query) || s.versions.some((v) => String(v.prompt || '').toLocaleLowerCase().includes(query)));
    if (!filtered.length && !imageResults.length) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = query ? '没有找到匹配的聊天。' : '还没有聊天记录，开始第一条吧。';
      list.append(empty);
      return;
    }
    for (const chat of filtered) {
      const row = document.createElement('div');
      row.className = 'history-item' + (chat.id === currentId ? ' active' : '');
      const open = document.createElement('button');
      open.className = 'history-open';
      open.title = chat.title;
      open.setAttribute('aria-label', `打开聊天：${chat.title}`);
      open.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 5h14v11H9l-4 3V5z"/></svg><span></span>';
      open.querySelector('span').textContent = chat.title;
      open.addEventListener('click', () => openChat(chat.id));
      const del = document.createElement('button');
      del.className = 'history-delete';
      del.title = '删除聊天';
      del.setAttribute('aria-label', `删除聊天：${chat.title}`);
      del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13M10 11v5m4-5v5"/></svg>';
      del.addEventListener('click', () => {
        if (!confirm(`删除「${chat.title}」？此操作不可撤销。`)) return;
        chats = chats.filter((c) => c.id !== chat.id);
        persist();
        if (currentId === chat.id) newChat();
        else renderHistory();
        toast('聊天已删除。');
      });
      row.append(open, del);
      list.append(row);
    }
    if (imageResults.length) {
      const heading = document.createElement('div');
      heading.className = 'history-subheading';
      heading.textContent = '图片项目';
      list.append(heading);
      for (const session of imageResults) {
        const row = document.createElement('div');
        row.className = 'history-item' + (session.id === currentImageId && currentMode === 'image' ? ' active' : '');
        const open = document.createElement('button');
        open.className = 'history-open';
        open.title = session.title;
        open.setAttribute('aria-label', `打开图片项目：${session.title}`);
        open.innerHTML = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 17 5-5 4 4 3-3 4 4"/></svg><span></span>';
        open.querySelector('span').textContent = session.title;
        open.addEventListener('click', () => openImageSession(session.id));
        const del = document.createElement('button');
        del.className = 'history-delete';
        del.title = '删除图片项目';
        del.setAttribute('aria-label', `删除图片项目：${session.title}`);
        del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13M10 11v5m4-5v5"/></svg>';
        del.addEventListener('click', async () => {
          if (imageBusy) return toast('图片正在处理中，请完成后再删除。');
          if (!confirm(`删除图片项目「${session.title}」？所有版本都将删除。`)) return;
          imageSessions = imageSessions.filter((s) => s.id !== session.id);
          await deleteImageSession(session.id);
          if (currentImageId === session.id) newImageProject();
          else renderHistory();
          toast('图片项目已删除。');
        });
        row.append(open, del);
        list.append(row);
      }
    }
  }

  function renderMode() {
    const image = currentMode === 'image';
    $('modeChip').hidden = !image;
    $('searchModeChip').hidden = image || !searchMode;
    $('toolsBtn').hidden = image;
    $('toolsBtn').classList.toggle('active-tool', searchMode && !image);
    $('toolsMenu').querySelector('[data-tool="webSearch"]').setAttribute('aria-checked', String(searchMode && !image));
    $('modelBtn').hidden = image;
    $('attachBtn').hidden = image;
    $('sendBtn').querySelector('svg').toggleAttribute('hidden', image);
    $('sendLabel').hidden = !image;
    $('sendBtn').classList.toggle('image-send', image);
    $('sendBtn').title = image ? '创建图像' : searchMode ? '联网搜索' : '发送';
    $('sendBtn').setAttribute('aria-label', image ? '创建图像' : searchMode ? '联网搜索' : '发送消息');
    $('promptInput').placeholder = image ? '描述想创建的图片…' : searchMode ? '输入要联网搜索的内容…' : '私密地提问任何问题…';
    $('composerNotice').textContent = image ? (apiStatus?.images?.ready ? '输入描述即可生成图片；作品保存在当前浏览器。' : '配置图片 API 后即可根据文字生成图片。') : searchMode ? '搜索结果将在新标签页打开；当前不生成 AI 摘要。' : (apiStatus?.ready ? '聊天由站点 API 提供；记录保存在当前浏览器。' : '聊天记录保存在当前浏览器；聊天 API 尚未就绪。');
    $('paceBtn').hidden = image;
    $('paceIcon').textContent = selectedPace === '推理' ? '✦' : '⚡';
    $('paceLabel').textContent = selectedPace;
    $('paceBtn').setAttribute('aria-pressed', String(selectedPace === '推理'));
    $('paceBtn').title = `当前为${selectedPace}模式，点击切换`;
    renderAttachments();
  }
  function showView(view) {
    currentView = view;
    $('homeView').hidden = view !== 'home';
    $('chatView').hidden = view !== 'chat';
    if (view === 'home') $('homeComposerMount').append($('composer'));
    if (view === 'chat') $('chatComposerMount').append($('composer'));
    $('topbarTitle').textContent = currentMode === 'image' ? (imageSessions.find((s) => s.id === currentImageId)?.title || '新图像') : view === 'chat' ? (chats.find((c) => c.id === currentId)?.title || '聊天') : '新聊天';
    closeMenus();
    closeSidebar();
    renderMode();
    renderHistory();
  }
  function newChat() {
    if (imageBusy) return toast('图片正在处理中，请完成后再切换。');
    currentMode = 'chat';
    searchMode = false;
    currentId = null;
    currentImageId = null;
    files = [];
    $('promptInput').value = '';
    renderAttachments();
    autoSize();
    showView('home');
    $('promptInput').focus();
  }
  function openChat(chatId) {
    if (imageBusy) return toast('图片正在处理中，请完成后再切换。');
    if (!chats.some((c) => c.id === chatId)) return;
    currentMode = 'chat';
    searchMode = false;
    currentId = chatId;
    currentImageId = null;
    files = [];
    $('promptInput').value = '';
    renderAttachments();
    autoSize();
    showView('chat');
    renderMessages();
  }
  function renderMessages() {
    const chat = chats.find((c) => c.id === currentId);
    const list = $('messages');
    list.replaceChildren();
    if (!chat) return;
    for (const message of chat.messages) {
      const article = document.createElement('article');
      article.className = 'message ' + (message.role === 'user' ? 'user' : 'system');
      const avatar = document.createElement('div');
      avatar.className = 'message-avatar';
      avatar.textContent = message.role === 'user' ? '我' : 'C.';
      const body = document.createElement('div');
      body.className = 'message-body';
      const bubble = document.createElement('div');
      bubble.className = 'message-bubble';
      bubble.textContent = message.content || '已添加附件';
      body.append(bubble);
      if (message.role === 'search' && typeof message.url === 'string' && message.url.startsWith('https://duckduckgo.com/?q=')) {
        const link = document.createElement('a');
        link.className = 'search-result-link';
        link.href = message.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = '查看联网搜索结果 ↗';
        body.append(link);
      }
      if (Array.isArray(message.files) && message.files.length) {
        const attachments = document.createElement('div');
        attachments.className = 'message-attachments';
        for (const file of message.files) {
          const a = document.createElement('button');
          a.className = 'message-attachment';
          a.textContent = '📎 ' + file.name;
          a.title = file.data ? '下载附件' : '附件内容不可用';
          a.addEventListener('click', () => {
            if (!file.data) return toast('此附件未保存内容。');
            const link = document.createElement('a');
            link.href = file.data;
            link.download = file.name;
            link.click();
          });
          attachments.append(a);
        }
        body.append(attachments);
      }
      const meta = document.createElement('div');
      meta.className = 'message-meta';
      const time = document.createElement('span');
      const date = new Date(message.at);
      time.textContent = isNaN(date) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      if (message.role === 'user' && message.pace) {
        const pace = document.createElement('span');
        pace.textContent = message.pace;
        meta.append(pace);
      }
      meta.append(time);
      if (message.content) {
        const copy = document.createElement('button');
        copy.textContent = '复制';
        copy.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(message.content); toast('已复制到剪贴板。'); }
          catch (_) { toast('复制失败，请手动选择文本。'); }
        });
        meta.append(copy);
      }
      body.append(meta);
      article.append(avatar, body);
      list.append(article);
    }
    requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }
  function sendMessage() {
    if (chatBusy || imageBusy) return toast('上一条请求还在处理中。');
    if (currentMode === 'image') return generateImage();
    if (chatBusy) return toast('上一条消息还在处理中。');
    const input = $('promptInput');
    const content = input.value.trim();
    if (!content && !files.length) return;
    if (searchMode && !content) return toast('先输入要搜索的内容。');
    const hadFiles = files.length > 0;
    const searchUrl = searchMode ? `https://duckduckgo.com/?q=${encodeURIComponent(content)}` : null;
    let chat = chats.find((c) => c.id === currentId);
    if (!chat) {
      chat = { id: id(), title: (content || '附件聊天').slice(0, 28), created: now(), updated: now(), model: selectedModel, messages: [] };
      chats.unshift(chat);
      currentId = chat.id;
    }
    chat.messages.push({ role: 'user', content, files: files.map((f) => ({ ...f })), pace: selectedPace, at: now() });
    if (searchUrl) chat.messages.push({ role: 'search', content: '已打开联网搜索结果。当前版本不会生成 AI 摘要。', url: searchUrl, at: now() });
    else if (apiEnabled && hadFiles) chat.messages.push({ role: 'notice', content: '当前聊天 API 只处理文字，附件已保存在这条本地记录中。', at: now() });
    else if (!apiEnabled && !chat.messages.some((m) => m.role === 'notice')) chat.messages.push({ role: 'notice', content: chatNotice, at: now() });
    chat.updated = now();
    chat.model = selectedModel;
    persist();
    input.value = '';
    files = [];
    renderAttachments();
    autoSize();
    showView('chat');
    renderMessages();
    if (searchUrl) window.open(searchUrl, '_blank', 'noopener,noreferrer');
    else if (apiEnabled && !hadFiles && content) requestApiReply(chat);
  }

  function autoSize() {
    const input = $('promptInput');
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 180) + 'px';
  }
  function renderAttachments() {
    const wrap = $('attachments');
    wrap.replaceChildren();
    wrap.hidden = !files.length;
    for (const [index, file] of files.entries()) {
      const chip = document.createElement('span');
      chip.className = 'attachment-chip';
      const label = document.createElement('span');
      label.textContent = file.name;
      const remove = document.createElement('button');
      remove.title = `移除 ${file.name}`;
      remove.setAttribute('aria-label', `移除 ${file.name}`);
      remove.innerHTML = '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>';
      remove.addEventListener('click', () => { files.splice(index, 1); renderAttachments(); });
      chip.append(label, remove);
      wrap.append(chip);
    }
  }
  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name, type: file.type, size: file.size, data: String(reader.result) });
      reader.onerror = () => reject(new Error('读取失败'));
      reader.readAsDataURL(file);
    });
  }
  async function addFiles(fileList) {
    for (const file of Array.from(fileList).slice(0, 5)) {
      if (file.size > MAX_FILE) { toast(`${file.name} 超过 1 MB，本地存储暂不支持。`); continue; }
      if (!(file.type.startsWith('image/') || /\.(txt|md|csv|json|log)$/i.test(file.name))) { toast(`${file.name} 的格式暂不支持。`); continue; }
      try { files.push(await readFile(file)); }
      catch (_) { toast(`${file.name} 读取失败。`); }
    }
    renderAttachments();
    $('fileInput').value = '';
  }

  function exportCurrent() {
    if (currentMode === 'image' && currentImageId) {
      const session = imageSessions.find((s) => s.id === currentImageId);
      if (session) return downloadImage(session, session.versions.length - 1);
    }
    const chat = chats.find((c) => c.id === currentId);
    if (!chat) return toast('当前还没有聊天可导出。');
    const lines = [`# ${chat.title}`, '', `模型：${chat.model || 'DeepSeek V4.1 Flash'}`, ''];
    for (const m of chat.messages) {
      lines.push(`## ${m.role === 'user' ? '我' : '系统提示'}`, '', m.content || '', '');
      if (m.files?.length) lines.push('附件：' + m.files.map((f) => f.name).join('、'), '');
    }
    download(`crazy-ai-${chat.id.slice(0, 8)}.md`, lines.join('\n'), 'text/markdown;charset=utf-8');
    toast('已导出当前聊天。');
  }
  function exportAll() {
    download('crazy-ai-chats.json', JSON.stringify({ app: 'crazy-ai', version: 1, exportedAt: now(), chats }, null, 2), 'application/json;charset=utf-8');
    toast('聊天记录已导出。');
  }
  async function importAll(file) {
    if (!file || file.size > MAX_IMPORT) return toast('请选择不超过 8 MB 的 JSON 文件。');
    try {
      const parsed = JSON.parse(await file.text());
      if (parsed.app !== 'crazy-ai' || !Array.isArray(parsed.chats)) throw new Error('格式不符');
      const incoming = parsed.chats.filter(validChat).slice(0, 100);
      const existingIds = new Set(chats.map((c) => c.id));
      chats = [...incoming.filter((c) => !existingIds.has(c.id)), ...chats].slice(0, 100);
      persist();
      renderHistory();
      toast(`已导入 ${incoming.length} 条聊天。`);
    } catch (_) { toast('导入失败：文件格式不正确。'); }
    $('importFileInput').value = '';
  }
  function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_STORAGE, next); } catch (_) {}
    document.querySelector('meta[name="theme-color"]').content = next === 'dark' ? '#17141c' : '#fdfbf9';
  }
  function newImageProject() {
    if (imageBusy) return toast('图片正在处理中，请完成后再切换。');
    currentMode = 'image';
    searchMode = false;
    currentId = null;
    currentImageId = null;
    currentImageVersion = 0;
    files = [];
    $('promptInput').value = '';
    autoSize();
    showView('home');
    $('promptInput').focus();
  }
  function openImageSession(sessionId) {
    if (imageBusy) return toast('图片正在处理中，请完成后再切换。');
    const session = imageSessions.find((s) => s.id === sessionId);
    if (!session) return;
    currentMode = 'image';
    searchMode = false;
    currentId = null;
    currentImageId = session.id;
    currentImageVersion = session.versions.length - 1;
    $('promptInput').value = '';
    autoSize();
    showView('chat');
    renderImageView();
    requestAnimationFrame(() => { $('messages').scrollTop = $('messages').scrollHeight; });
  }
  function decodeImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片无法读取'));
      img.src = src;
    });
  }
  function imageFileName(session, index) {
    const extension = session.versions[index].data.startsWith('data:image/png;') ? 'png' : 'jpg';
    return `crazy-ai-${session.title.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '-')}-${index + 1}.${extension}`;
  }
  function downloadImage(session, index) {
    const a = document.createElement('a');
    a.href = session.versions[index].data;
    a.download = imageFileName(session, index);
    a.click();
  }
  async function copyImage(session, index) {
    if (!navigator.clipboard?.write || !window.ClipboardItem) return toast('此浏览器不支持复制图片，请使用下载。');
    try {
      const img = await decodeImage(session.versions[index].data);
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('复制失败');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('图片已复制到剪贴板。');
    } catch (_) { toast('复制失败，请使用下载。'); }
  }
  function renderImageView() {
    const session = imageSessions.find((s) => s.id === currentImageId);
    const list = $('messages');
    list.replaceChildren();
    if (!session) return;
    currentImageVersion = Math.min(currentImageVersion, session.versions.length - 1);
    session.versions.forEach((version, index) => {
      if (version.prompt) {
        const promptRow = document.createElement('div');
        promptRow.className = 'image-prompt-row';
        const bubble = document.createElement('div');
        bubble.className = 'image-prompt-bubble';
        bubble.textContent = version.prompt;
        promptRow.append(bubble);
        list.append(promptRow);
      }
      const entry = document.createElement('article');
      entry.className = 'image-entry' + (index === currentImageVersion ? ' active' : '');
      entry.dataset.imageVersion = String(index);
      const label = document.createElement('div');
      label.className = 'image-entry-label';
      const icon = document.createElement('span');
      icon.className = 'image-entry-icon';
      icon.textContent = '✦';
      const title = document.createElement('span');
      title.textContent = version.kind === 'generated' ? 'AI 生成 · SenseNova U1.5 Lite' : '历史图片';
      const time = document.createElement('small');
      time.textContent = new Date(version.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      label.append(icon, title, time);
      const card = document.createElement('div');
      card.className = 'image-card';
      const img = document.createElement('img');
      img.src = version.data;
      img.alt = version.kind === 'generated' ? `第 ${index + 1} 张 AI 生成的图片` : `第 ${index + 1} 张历史图片`;
      const actions = document.createElement('div');
      actions.className = 'image-actions';
      const action = (text, titleText, fn) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = text;
        button.title = titleText;
        button.addEventListener('click', fn);
        actions.append(button);
      };
      action('⧉ 复制', '复制图片', () => copyImage(session, index));
      action('↓ 下载', '下载图片', () => downloadImage(session, index));
      card.append(img, actions);
      entry.append(label, card);
      list.append(entry);
    });
    requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }
  async function requestApiImage(prompt) {
    const turnstileToken = await freshTurnstileToken();
    const response = await fetch(apiBase + '/api/images', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, turnstileToken }),
      signal: AbortSignal.timeout(130_000),
    });
    const data = await response.json();
    if (!response.ok) {
      const reasons = {
        image_actor_limit: '你今天的图片额度已用完。', image_global_limit: '全站今天的图片额度已用完。',
        actor_limit: '你今天的请求额度已用完。', global_limit: '全站今天的请求额度已用完。',
        token_limit: '全站今天的 Token 额度已用完。', rate_limited: '发送太快，请稍后重试。',
        verification_failed: '访客验证未通过，请重试。', configuration_incomplete: '生图服务尚未完成配置。',
        image_rate_limited: '生图服务繁忙，请稍后重试。', image_upstream_unavailable: '生图服务未返回有效图片，请稍后检查。',
        invalid_request: '图片或提示词不符合要求；提示词最多 4000 字符。', body_too_large: '图片过大，请压缩后再试。',
      };
      throw new Error(reasons[data.error] || `图片请求失败（HTTP ${response.status}）。`);
    }
    if (typeof data.image !== 'string' || data.image.length > 5_600_000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(data.image)) throw new Error('接口未返回有效图片。');
    await decodeImage(data.image);
    return data.image;
  }
  async function generateImage() {
    if (imageBusy || chatBusy) return toast('上一条请求还在处理中。');
    const prompt = $('promptInput').value.trim();
    if (!prompt) return toast('先写下想生成的图片描述。');
    if (!apiEnabled) return toast('请先配置图片 API。');
    if (prompt.length > 4000) return toast('图片提示词最多 4000 字符。');
    imageBusy = true;
    $('sendBtn').disabled = true;
    $('sendLabel').textContent = '处理中';
    $('imageProgress').hidden = false;
    $('imageProgress').textContent = '正在生成图片…';
    try {
      const result = await requestApiImage(prompt);
      let session = imageSessions.find((s) => s.id === currentImageId);
      if (!session) {
        session = { id: id(), title: prompt.slice(0, 28), created: now(), updated: now(), versions: [] };
        imageSessions.unshift(session);
        currentImageId = session.id;
      }
      session.versions.push({ id: id(), kind: 'generated', prompt, label: 'SenseNova U1.5 Lite', data: result, at: now() });
      currentImageVersion = session.versions.length - 1;
      session.updated = now();
      await saveImageSession(session);
      if ($('promptInput').value.trim() === prompt) $('promptInput').value = '';
      autoSize();
      showView('chat');
      renderImageView();
      toast('图片已生成。可以继续输入描述，生成下一张。');
    } catch (error) {
      toast(error?.name === 'TimeoutError' ? '等待超时，结果尚未确认；请勿立即重复提交。' : error?.message || '图片生成失败。');
    } finally {
      imageBusy = false;
      $('sendBtn').disabled = chatBusy;
      $('sendLabel').textContent = '创建';
      $('imageProgress').hidden = true;
    }
  }

  $('newChatBtn').addEventListener('click', newChat);
  $('brandLink').addEventListener('click', (e) => { e.preventDefault(); newChat(); });
  $('imageModeBtn').addEventListener('click', newImageProject);
  $('collapseBtn').addEventListener('click', () => {
    const collapsed = $('appShell').classList.toggle('sidebar-collapsed');
    $('collapseBtn').setAttribute('aria-label', collapsed ? '展开侧边栏' : '收起侧边栏');
    $('collapseBtn').title = collapsed ? '展开侧边栏' : '收起侧边栏';
  });
  $('modeChip').addEventListener('click', newChat);
  $('menuBtn').addEventListener('click', () => { $('sidebar').classList.add('open'); $('mobileScrim').hidden = false; });
  $('sideClose').addEventListener('click', closeSidebar);
  $('mobileScrim').addEventListener('click', closeSidebar);
  $('searchBtn').addEventListener('click', () => { const wrap = $('historySearchWrap'); wrap.hidden = !wrap.hidden; if (!wrap.hidden) $('historySearch').focus(); });
  $('historySearch').addEventListener('input', renderHistory);
  $('themeBtn').addEventListener('click', toggleTheme);
  $('dialogThemeBtn').addEventListener('click', toggleTheme);
  $('sendBtn').addEventListener('click', sendMessage);
  $('promptInput').addEventListener('input', autoSize);
  $('promptInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); } });
  $('attachBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => addFiles(e.target.files));
  $('paceBtn').addEventListener('click', () => {
    selectedPace = selectedPace === '快速' ? '推理' : '快速';
    try { localStorage.setItem(PACE_STORAGE, selectedPace); } catch (_) {}
    renderMode();
  });
  $('searchModeChip').addEventListener('click', () => { searchMode = false; renderMode(); $('promptInput').focus(); });
  $('toolsBtn').addEventListener('click', () => { const wasHidden = $('toolsMenu').hidden; closeMenus(); $('toolsMenu').hidden = !wasHidden; });
  $('modelBtn').addEventListener('click', () => { const wasHidden = $('modelMenu').hidden; closeMenus(); $('modelMenu').hidden = !wasHidden; });
  $('toolsMenu').addEventListener('click', (e) => {
    const action = e.target.closest('[data-tool]')?.dataset.tool;
    closeMenus();
    if (action === 'webSearch') {
      if (currentMode === 'image') return toast('先退出创建图像模式，再使用联网搜索。');
      searchMode = !searchMode;
      renderMode();
      $('promptInput').focus();
    }
  });
  $('modelMenu').addEventListener('click', (e) => {
    const model = e.target.closest('[data-model]')?.dataset.model;
    if (!modelIds[model]) return;
    selectedModel = model;
    $('modelBtn').firstChild.textContent = model + ' ';
    try { localStorage.setItem(MODEL_STORAGE, model); } catch (_) {}
    closeMenus();
    toast(`已选择 ${model}。`);
  });
  $('settingsBtn').addEventListener('click', () => { closeSidebar(); $('settingsDialog').showModal(); refreshApiStatus(); });
  $('settingsClose').addEventListener('click', () => $('settingsDialog').close());
  $('settingsDialog').addEventListener('click', (e) => { if (e.target === $('settingsDialog')) $('settingsDialog').close(); });
  for (const suggestion of document.querySelectorAll('.suggestion')) suggestion.addEventListener('click', () => {
    if (suggestion.dataset.imageMode) return newImageProject();
    $('promptInput').value = suggestion.dataset.prompt;
    autoSize();
    $('promptInput').focus();
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#toolsBtn,#modelBtn,#toolsMenu,#modelMenu')) closeMenus(); });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); newChat(); }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'i') { e.preventDefault(); newImageProject(); }
    if (e.key === 'Escape') { closeMenus(); closeSidebar(); }
  });
  const composer = $('composer');
  composer.addEventListener('dragover', (e) => { e.preventDefault(); });
  composer.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!e.dataTransfer.files.length) return;
    if (currentMode === 'image') return toast('图片模式只支持文字生图。');
    addFiles(e.dataTransfer.files);
  });

  $('modelBtn').firstChild.textContent = selectedModel + ' ';
  showView('home');
  autoSize();
  loadImageSessions();
  refreshApiStatus();
})();

