// ========== Notion API ベースURL（CORSプロキシ対応） ==========
function notionUrl(path) {
  const proxy = localStorage.getItem('ns_notionProxy') || '';
  const base = proxy.replace(/\/$/, '') || 'https://api.notion.com';
  return base + path;
}

// ========== ストレージ（localStorage wrapper） ==========
const storage = {
  async get(keys) {
    const arr = typeof keys === 'string' ? [keys] : keys;
    const result = {};
    arr.forEach(k => {
      const raw = localStorage.getItem('ns_' + k);
      result[k] = raw !== null ? JSON.parse(raw) : undefined;
    });
    return result;
  },
  async set(obj) {
    Object.entries(obj).forEach(([k, v]) => {
      localStorage.setItem('ns_' + k, JSON.stringify(v));
    });
  }
};

// ========== 状態 ==========
let currentDb = null;
let formValues = {};
let activePreset = null;
let currentHiddenFields = new Set();
let currentSortedProperties = [];
let currentUiState = { blank: {}, today: {} };
let allDatabases = [];
let allFetchedDbs = [];

const BODY_PSEUDO = { name: '__body', type: '__body' };
const DEFAULT_AI_PROMPT = '以下のページを要約してください。\n\nタイトル: {{title}}\nURL: {{url}}\n\n{{body}}';

// ========== 初期化 ==========
async function init() {
  const { apiKey, databases, lastDbId, lastPreset: lp, presets: rawPresets = {} } =
    await storage.get(['apiKey', 'databases', 'lastDbId', 'lastPreset', 'presets']);

  const main = document.getElementById('form-area');

  if (!apiKey || !databases || databases.length === 0) {
    main.innerHTML = `<div class="empty-state" style="padding:32px 16px;">
      設定が完了していません。<br>右上の⚙から設定してください。
    </div>`;
    return;
  }

  const enabledDbs = databases.filter(d => d.enabled !== false);
  if (enabledDbs.length === 0) {
    main.innerHTML = `<div class="empty-state" style="padding:32px 16px;">
      使用するDBが選択されていません。<br>⚙から設定してください。
    </div>`;
    return;
  }

  // プリセットマイグレーション（旧形式 → 新形式）
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  let presets = rawPresets;
  if (Object.keys(rawPresets).some(k => uuidPattern.test(k))) {
    const migrated = {};
    for (const [dbId, dbPresets] of Object.entries(rawPresets)) {
      if (uuidPattern.test(dbId) && typeof dbPresets === 'object') {
        for (const [pName, pData] of Object.entries(dbPresets)) {
          if (typeof pData === 'object') migrated[pName] = { ...pData, __dbId: dbId };
        }
      }
    }
    await storage.set({ presets: migrated, lastPreset: null });
    presets = migrated;
  }

  const sortedDbs = [...enabledDbs].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  allDatabases = sortedDbs;

  const dbSelect = document.getElementById('db-select');
  dbSelect.innerHTML = '';
  sortedDbs.forEach(db => {
    const opt = document.createElement('option');
    opt.value = db.id;
    opt.textContent = db.name;
    dbSelect.appendChild(opt);
  });

  // 最後に使ったDB / プリセットから初期DBを決定
  let initialDbId = lastDbId;
  let initialPreset = null;
  if (lp && presets[lp]) {
    const dbId = presets[lp].__dbId;
    if (dbId && sortedDbs.some(d => d.id === dbId)) {
      initialDbId = dbId;
      initialPreset = lp;
    }
  }
  if (initialDbId && sortedDbs.some(d => d.id === initialDbId)) {
    dbSelect.value = initialDbId;
  }

  dbSelect.addEventListener('change', () => { activePreset = null; loadDb(dbSelect.value); });
  await loadDb(dbSelect.value, initialPreset);
}

function showView(id) {
  document.getElementById('form-view').style.display = id === 'form' ? '' : 'none';
  document.getElementById('settings-view').style.display = id === 'settings' ? '' : 'none';
}

// ========== DBロード ==========
async function loadDb(dbId, presetName = null) {
  currentDb = allDatabases.find(d => d.id === dbId);
  if (!currentDb) return;

  await storage.set({ lastDbId: dbId });
  formValues = {};
  activePreset = null;
  currentUiState = { blank: {}, today: {} };

  const { hiddenFields = {}, propertyOrder = {}, presets = {} } =
    await storage.get(['hiddenFields', 'propertyOrder', 'presets']);

  if (hiddenFields[dbId] === undefined) {
    currentHiddenFields = new Set(currentDb.properties.map(p => p.name));
  } else {
    currentHiddenFields = new Set(hiddenFields[dbId]);
  }

  const allProps = [...currentDb.properties, BODY_PSEUDO];
  const order = propertyOrder[dbId];
  if (order && order.length > 0) {
    const sorted = order.map(name => allProps.find(p => p.name === name)).filter(Boolean);
    const remaining = allProps.filter(p => !order.includes(p.name));
    currentSortedProperties = [...sorted, ...remaining];
  } else {
    currentSortedProperties = allProps;
  }

  if (presetName && presets[presetName]) {
    activePreset = presetName;
    await applyPreset(presets[presetName]);
  } else {
    renderForm(currentSortedProperties);
  }
  renderPresets();
}

// ========== フォーム描画 ==========
function renderForm(properties, presetValues = {}, meta = {}) {
  const area = document.getElementById('form-area');
  area.innerHTML = '';
  formValues = {};

  const titleProp = properties.find(p => p.type === 'title');
  const otherProps = properties.filter(p => p.type !== 'title');
  const sorted = titleProp ? [titleProp, ...otherProps] : [...otherProps];
  currentSortedProperties = sorted;

  sorted.forEach(prop => {
    const val = presetValues[prop.name] ?? getDefaultValue(prop);
    formValues[prop.name] = val;
    const fieldMeta = {
      blank: meta.blank?.[prop.name] ?? false,
      today: meta.today?.[prop.name] ?? false,
    };
    area.appendChild(buildField(prop, val, fieldMeta));
  });

  setupDragAndDrop(area);
}

function getDefaultValue(prop) {
  if (prop.type === '__body') return '';
  if (prop.type === 'checkbox') return false;
  if (prop.type === 'multi_select') return [];
  return '';
}

// ========== フィールドUI構築 ==========
function buildField(prop, currentVal, fieldMeta = {}) {
  const isHidden = prop.type !== 'title' && currentHiddenFields.has(prop.name);

  const div = document.createElement('div');
  div.className = 'field' + (isHidden ? ' field-hidden' : '');
  div.dataset.propName = prop.name;

  // ヘッダー
  const header = document.createElement('div');
  header.className = 'field-header';

  const dragHandle = document.createElement('div');
  dragHandle.className = 'drag-handle';
  dragHandle.textContent = '≡';
  if (prop.type === 'title') {
    dragHandle.style.opacity = '0.2';
    dragHandle.style.cursor = 'default';
  } else {
    dragHandle.title = 'ドラッグして並び替え';
  }
  header.appendChild(dragHandle);

  const label = document.createElement('label');
  const displayName = prop.type === '__body' ? '本文' : escapeHtml(prop.name);
  const badgeText = prop.type === '__body' ? 'body' : prop.type;
  label.innerHTML = `${displayName} <span class="type-badge">${badgeText}</span>`;
  header.appendChild(label);

  if (prop.type !== 'title') {
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'field-toggle-btn';
    toggleBtn.title = isHidden ? '展開' : '折りたたむ';
    toggleBtn.textContent = isHidden ? '⊕' : '−';
    toggleBtn.addEventListener('click', () => toggleFieldVisibility(prop.name, div, toggleBtn));
    header.appendChild(toggleBtn);
  }
  div.appendChild(header);

  // ボディ
  const body = document.createElement('div');
  body.className = 'field-body';

  switch (prop.type) {
    case '__body': {
      const textarea = document.createElement('textarea');
      textarea.value = currentVal || '';
      textarea.style.width = '100%';
      textarea.placeholder = 'Notionページの本文として追加されます';
      textarea.addEventListener('input', () => { formValues[prop.name] = textarea.value; });
      body.appendChild(textarea);

      const aiBtn = document.createElement('button');
      aiBtn.className = 'ai-btn';
      aiBtn.textContent = 'AI生成';
      aiBtn.addEventListener('click', async () => {
        aiBtn.disabled = true;
        aiBtn.textContent = '生成中...';
        try {
          const { databases: dbs = [] } = await storage.get('databases');
          const dbEntry = dbs.find(d => d.id === currentDb.id);
          const prompt = dbEntry?.aiPrompt?.trim() || DEFAULT_AI_PROMPT;
          const result = await callGemini(fillAiTemplate(prompt));
          textarea.value = result;
          formValues[prop.name] = result;
        } catch (e) {
          showStatus(`AI生成エラー: ${e.message}`, 'error');
        } finally {
          aiBtn.disabled = false;
          aiBtn.textContent = 'AI生成';
        }
      });
      body.appendChild(aiBtn);
      break;
    }
    case 'title': {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = currentVal || '';
      input.addEventListener('input', () => { formValues[prop.name] = input.value; });
      body.appendChild(input);
      break;
    }
    case 'rich_text':
    case 'email':
    case 'phone_number': {
      const input = document.createElement(prop.type === 'rich_text' ? 'textarea' : 'input');
      if (input.tagName === 'INPUT') {
        input.type = prop.type === 'email' ? 'email' : prop.type === 'phone_number' ? 'tel' : 'text';
      }
      input.value = currentVal || '';
      input.addEventListener('input', () => { formValues[prop.name] = input.value; });
      body.appendChild(input);
      break;
    }
    case 'url': {
      const row = document.createElement('div');
      row.className = 'url-input-row';
      const input = document.createElement('input');
      input.type = 'url';
      input.value = currentVal || '';
      input.addEventListener('input', () => { formValues[prop.name] = input.value; });
      const blankCheck = document.createElement('input');
      blankCheck.type = 'checkbox';
      blankCheck.className = 'clip-check';
      blankCheck.id = `blank-${prop.name}`;
      const blankLabel = document.createElement('label');
      blankLabel.htmlFor = `blank-${prop.name}`;
      blankLabel.className = 'url-blank-label';
      blankLabel.textContent = '空欄';
      blankCheck.addEventListener('change', () => {
        currentUiState.blank[prop.name] = blankCheck.checked;
        if (blankCheck.checked) { input.disabled = true; input.value = ''; formValues[prop.name] = ''; }
        else { input.disabled = false; }
      });
      if (fieldMeta.blank) {
        blankCheck.checked = true; input.disabled = true; input.value = '';
        formValues[prop.name] = ''; currentUiState.blank[prop.name] = true;
      }
      row.appendChild(input); row.appendChild(blankCheck); row.appendChild(blankLabel);
      body.appendChild(row);
      break;
    }
    case 'number': {
      const input = document.createElement('input');
      input.type = 'number';
      input.value = currentVal ?? '';
      input.addEventListener('input', () => { formValues[prop.name] = input.value === '' ? '' : Number(input.value); });
      body.appendChild(input);
      break;
    }
    case 'date': {
      const dateRow = document.createElement('div');
      dateRow.className = 'date-row';
      const input = document.createElement('input');
      input.type = 'date';
      input.value = currentVal || '';
      input.addEventListener('change', () => { formValues[prop.name] = input.value; });
      const todayCheck = document.createElement('input');
      todayCheck.type = 'checkbox';
      todayCheck.className = 'clip-check';
      todayCheck.id = `today-${prop.name}`;
      const todayLabel = document.createElement('label');
      todayLabel.htmlFor = `today-${prop.name}`;
      todayLabel.className = 'date-today-label';
      todayLabel.textContent = '今日';
      const applyToday = () => {
        const today = new Date().toISOString().slice(0, 10);
        input.value = today; formValues[prop.name] = today;
        input.disabled = true; currentUiState.today[prop.name] = true;
      };
      const unapplyToday = () => { input.disabled = false; currentUiState.today[prop.name] = false; };
      todayCheck.addEventListener('change', () => { if (todayCheck.checked) applyToday(); else unapplyToday(); });
      if (fieldMeta.today) { todayCheck.checked = true; applyToday(); }
      dateRow.appendChild(input); dateRow.appendChild(todayCheck); dateRow.appendChild(todayLabel);
      body.appendChild(dateRow);
      break;
    }
    case 'checkbox': {
      const row = document.createElement('div');
      row.className = 'checkbox-field';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!currentVal;
      const span = document.createElement('span');
      span.textContent = prop.name;
      input.addEventListener('change', () => { formValues[prop.name] = input.checked; });
      row.appendChild(input); row.appendChild(span);
      body.appendChild(row);
      break;
    }
    case 'select': {
      const optContainer = document.createElement('div');
      optContainer.className = 'select-options';
      prop.options.forEach(opt => {
        const chip = document.createElement('button');
        chip.className = `opt-chip color-${opt.color}`;
        chip.textContent = opt.name;
        if (currentVal === opt.name) chip.classList.add('selected');
        chip.addEventListener('click', () => {
          if (formValues[prop.name] === opt.name) {
            formValues[prop.name] = '';
            optContainer.querySelectorAll('.opt-chip').forEach(c => c.classList.remove('selected'));
          } else {
            formValues[prop.name] = opt.name;
            optContainer.querySelectorAll('.opt-chip').forEach(c => c.classList.remove('selected'));
            chip.classList.add('selected');
          }
        });
        optContainer.appendChild(chip);
      });
      body.appendChild(optContainer);
      // AI提案ボタン
      const aiBtn = document.createElement('button');
      aiBtn.className = 'ai-btn';
      aiBtn.textContent = 'AI提案';
      aiBtn.addEventListener('click', async () => {
        aiBtn.disabled = true; aiBtn.textContent = '提案中...';
        try {
          const existingNames = prop.options.map(o => o.name).join('、');
          const prompt = `以下のページから「${prop.name}」フィールドに最も適した値を1つ選んでください。まず既存の選択肢から選び、どれも合わない場合のみ新しい値を提案してください。\n既存の選択肢: ${existingNames}\n返答は値のみ（余計な説明・引用符不要）。\n\n${getPageContext()}`;
          const result = await callGemini(prompt);
          const suggested = result.trim().replace(/^["'「」\s]+|["'「」\s]+$/g, '');
          if (!suggested) throw new Error('提案が取得できませんでした');
          const existingOpt = prop.options.find(o => o.name.toLowerCase() === suggested.toLowerCase());
          const name = existingOpt ? existingOpt.name : suggested;
          formValues[prop.name] = name;
          optContainer.querySelectorAll('.opt-chip').forEach(c => c.classList.remove('selected'));
          let found = false;
          optContainer.querySelectorAll('.opt-chip').forEach(chip => {
            if (chip.textContent === name) { chip.classList.add('selected'); found = true; }
          });
          if (!found) {
            const newChip = document.createElement('button');
            newChip.className = 'opt-chip color-default selected';
            newChip.textContent = name;
            newChip.addEventListener('click', () => {
              if (formValues[prop.name] === name) {
                formValues[prop.name] = ''; optContainer.querySelectorAll('.opt-chip').forEach(c => c.classList.remove('selected'));
              } else {
                formValues[prop.name] = name; optContainer.querySelectorAll('.opt-chip').forEach(c => c.classList.remove('selected'));
                newChip.classList.add('selected');
              }
            });
            optContainer.appendChild(newChip);
          }
        } catch (e) { showStatus(`AI提案エラー: ${e.message}`, 'error'); }
        finally { aiBtn.disabled = false; aiBtn.textContent = 'AI提案'; }
      });
      body.appendChild(aiBtn);
      break;
    }
    case 'multi_select': {
      const selected = Array.isArray(currentVal) ? currentVal : [];
      formValues[prop.name] = [...selected];
      const optContainer = document.createElement('div');
      optContainer.className = 'select-options';

      const addChip = (name, color = 'default') => {
        const chip = document.createElement('button');
        chip.className = `opt-chip color-${color}`;
        chip.textContent = name;
        if (formValues[prop.name].includes(name)) chip.classList.add('selected');
        chip.addEventListener('click', () => {
          const arr = formValues[prop.name];
          const idx = arr.indexOf(name);
          if (idx >= 0) { arr.splice(idx, 1); chip.classList.remove('selected'); }
          else { arr.push(name); chip.classList.add('selected'); }
        });
        optContainer.appendChild(chip);
        return chip;
      };
      prop.options.forEach(opt => addChip(opt.name, opt.color));

      // 手動タグ入力
      const tagInputRow = document.createElement('div');
      tagInputRow.style.cssText = 'display:flex;gap:4px;margin-top:6px;';
      const tagInput = document.createElement('input');
      tagInput.type = 'text';
      tagInput.placeholder = 'タグを追加...';
      tagInput.style.cssText = 'flex:1;padding:6px 8px;font-size:14px;border:1px solid #e9e9e7;border-radius:5px;outline:none;';
      const tagAddBtn = document.createElement('button');
      tagAddBtn.className = 'ai-btn';
      tagAddBtn.textContent = '追加';
      const doAddTag = () => {
        const strVal = tagInput.value.trim();
        if (!strVal) return;
        const existingOpt = prop.options.find(o => o.name.toLowerCase() === strVal.toLowerCase());
        const name = existingOpt ? existingOpt.name : strVal;
        const arr = formValues[prop.name];
        if (!arr.includes(name)) {
          arr.push(name);
          let found = false;
          optContainer.querySelectorAll('.opt-chip').forEach(chip => {
            if (chip.textContent === name) { chip.classList.add('selected'); found = true; }
          });
          if (!found) addChip(name).classList.add('selected');
        }
        tagInput.value = '';
        tagInput.focus();
      };
      tagAddBtn.addEventListener('click', doAddTag);
      tagInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doAddTag(); } });
      tagInputRow.appendChild(tagInput);
      tagInputRow.appendChild(tagAddBtn);

      // AI抽出ボタン
      const aiExtractBtn = document.createElement('button');
      aiExtractBtn.className = 'ai-btn';
      aiExtractBtn.style.marginTop = '4px';
      aiExtractBtn.textContent = 'AI抽出';
      aiExtractBtn.addEventListener('click', async () => {
        aiExtractBtn.disabled = true; aiExtractBtn.textContent = '抽出中...';
        try {
          const existingNames = prop.options.map(o => o.name).join('、');
          const prompt = `以下のページから「${prop.name}」フィールドに設定する値をJSON配列のみで返してください。重複なし、余計な説明不要。まず既存の選択肢から選び、該当するものがない場合のみ新しい値を追加してください。\n既存の選択肢: ${existingNames}\n返答例: ["値1", "値2"]\n\n${getPageContext()}`;
          const result = await callGemini(prompt);
          const match = result.match(/\[[\s\S]*\]/);
          if (!match) throw new Error('結果を解析できませんでした');
          let extracted;
          try { extracted = JSON.parse(match[0]); } catch { throw new Error('結果を解析できませんでした'); }
          if (!Array.isArray(extracted)) throw new Error('配列ではありません');
          extracted.forEach(val => {
            const strVal = String(val).trim();
            if (!strVal) return;
            const existingOpt = prop.options.find(o => o.name.toLowerCase() === strVal.toLowerCase());
            const name = existingOpt ? existingOpt.name : strVal;
            const arr = formValues[prop.name];
            if (arr.includes(name)) return;
            arr.push(name);
            let found = false;
            optContainer.querySelectorAll('.opt-chip').forEach(chip => {
              if (chip.textContent === name) { chip.classList.add('selected'); found = true; }
            });
            if (!found) addChip(name).classList.add('selected');
          });
        } catch (e) { showStatus(`AI抽出エラー: ${e.message}`, 'error'); }
        finally { aiExtractBtn.disabled = false; aiExtractBtn.textContent = 'AI抽出'; }
      });

      body.appendChild(optContainer);
      body.appendChild(tagInputRow);
      body.appendChild(aiExtractBtn);
      break;
    }
    default:
      break;
  }

  div.appendChild(body);
  return div;
}

// ページコンテキスト（AI用）
function getPageContext() {
  const titleProp = currentDb?.properties.find(p => p.type === 'title');
  const urlProp = currentDb?.properties.find(p => p.type === 'url');
  const title = (titleProp && formValues[titleProp.name]) || '';
  const url = (urlProp && formValues[urlProp.name]) || '';
  const body = formValues['__body'] || '';
  return `タイトル: ${title}\nURL: ${url}\n\n${body}`;
}

// ========== フィールドD&D（Pointer Events で touch 対応） ==========
function setupDragAndDrop(area) {
  let dragSrcEl = null;
  let dragHandle = null;
  let placeholder = null;
  let startY = 0;

  area.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.drag-handle');
    if (!handle) return;
    const field = handle.closest('.field');
    if (!field || field.querySelector('.drag-handle').style.cursor === 'default') return;

    dragHandle = handle;
    dragSrcEl = field;
    startY = e.clientY;

    e.preventDefault();
    dragSrcEl.setPointerCapture(e.pointerId);

    placeholder = document.createElement('div');
    placeholder.style.cssText = `height:${dragSrcEl.offsetHeight}px;border:2px dashed #2383e2;border-radius:6px;margin-bottom:10px;`;
    dragSrcEl.classList.add('dragging');
    dragSrcEl.after(placeholder);
    dragSrcEl.style.cssText = `position:fixed;width:${dragSrcEl.offsetWidth}px;z-index:50;opacity:0.9;left:${dragSrcEl.getBoundingClientRect().left}px;top:${dragSrcEl.getBoundingClientRect().top}px;`;
  });

  area.addEventListener('pointermove', (e) => {
    if (!dragSrcEl) return;
    e.preventDefault();
    const dy = e.clientY - startY;
    const rect = dragSrcEl.getBoundingClientRect();
    dragSrcEl.style.top = (rect.top + dy) + 'px';
    startY = e.clientY;

    // placeholderの位置更新
    const fields = [...area.querySelectorAll('.field:not(.dragging)')];
    let inserted = false;
    for (const field of fields) {
      const r = field.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) {
        area.insertBefore(placeholder, field);
        inserted = true;
        break;
      }
    }
    if (!inserted) area.appendChild(placeholder);
  });

  area.addEventListener('pointerup', async (e) => {
    if (!dragSrcEl) return;

    // 元のスタイルに戻す
    dragSrcEl.style.cssText = '';
    dragSrcEl.classList.remove('dragging');

    // placeholderの位置に挿入
    area.insertBefore(dragSrcEl, placeholder);
    placeholder.remove();
    placeholder = null;

    // 新しい順序を保存
    const fields = [...area.querySelectorAll('.field')];
    const newProps = fields.map(f => currentSortedProperties.find(p => p.name === f.dataset.propName)).filter(Boolean);

    // タイトルを先頭に固定
    const tIdx = newProps.findIndex(p => p.type === 'title');
    if (tIdx > 0) { const [t] = newProps.splice(tIdx, 1); newProps.unshift(t); }

    currentSortedProperties = newProps;
    const { propertyOrder = {} } = await storage.get('propertyOrder');
    propertyOrder[currentDb.id] = newProps.map(p => p.name);
    await storage.set({ propertyOrder });

    renderForm(newProps, { ...formValues }, { blank: { ...currentUiState.blank }, today: { ...currentUiState.today } });

    dragSrcEl = null;
    dragHandle = null;
  });
}

// ========== フィールド表示切り替え ==========
async function toggleFieldVisibility(propName, fieldDiv, toggleBtn) {
  if (currentHiddenFields.has(propName)) {
    currentHiddenFields.delete(propName);
    fieldDiv.classList.remove('field-hidden');
    toggleBtn.textContent = '−'; toggleBtn.title = '折りたたむ';
  } else {
    currentHiddenFields.add(propName);
    fieldDiv.classList.add('field-hidden');
    toggleBtn.textContent = '⊕'; toggleBtn.title = '展開';
  }
  const { hiddenFields = {} } = await storage.get('hiddenFields');
  hiddenFields[currentDb.id] = [...currentHiddenFields];
  await storage.set({ hiddenFields });
}

// ========== プリセット ==========
async function renderPresets() {
  const { presets = {}, presetOrder = [] } = await storage.get(['presets', 'presetOrder']);
  const chips = document.getElementById('preset-chips');
  chips.innerHTML = '';

  const allNames = Object.keys(presets);
  const ordered = [
    ...presetOrder.filter(n => allNames.includes(n)),
    ...allNames.filter(n => !presetOrder.includes(n))
  ];

  ordered.forEach(name => {
    const dbName = allDatabases.find(d => d.id === presets[name].__dbId)?.name || '';
    const chip = document.createElement('button');
    chip.className = 'preset-chip' + (activePreset === name ? ' active' : '');
    chip.dataset.name = name;
    chip.innerHTML = `
      <span class="preset-drag-handle">≡</span>
      <span class="preset-chip-inner">
        <span class="preset-chip-name">${escapeHtml(name)}</span>
        ${dbName ? `<span class="preset-db-badge">${escapeHtml(dbName)}</span>` : ''}
      </span>
      <span class="del-chip">×</span>`;

    chip.addEventListener('click', (e) => {
      if (e.target.closest('.del-chip') || e.target.closest('.preset-drag-handle')) return;
      applyPresetByName(name);
    });
    chip.querySelector('.del-chip').addEventListener('click', async (e) => {
      e.stopPropagation();
      const { presets: p = {}, lastPreset: lp, presetOrder: po = [] } =
        await storage.get(['presets', 'lastPreset', 'presetOrder']);
      delete p[name];
      const updates = { presets: p, presetOrder: po.filter(n => n !== name) };
      if (lp === name) updates.lastPreset = null;
      await storage.set(updates);
      if (activePreset === name) activePreset = null;
      renderPresets();
    });
    chips.appendChild(chip);
  });

  setupPresetDragDrop(chips);
}

function setupPresetDragDrop(container) {
  let dragSrc = null;
  let placeholder = null;
  let startY = 0;

  container.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.preset-drag-handle');
    if (!handle) return;
    dragSrc = handle.closest('.preset-chip');
    if (!dragSrc) return;
    e.preventDefault();
    startY = e.clientY;
    dragSrc.setPointerCapture(e.pointerId);
    placeholder = document.createElement('div');
    placeholder.style.cssText = `height:${dragSrc.offsetHeight}px;border:2px dashed #2383e2;border-radius:5px;`;
    dragSrc.classList.add('dragging');
    dragSrc.after(placeholder);
    dragSrc.style.cssText = `position:fixed;width:${dragSrc.offsetWidth}px;z-index:50;opacity:0.9;left:${dragSrc.getBoundingClientRect().left}px;top:${dragSrc.getBoundingClientRect().top}px;`;
  });

  container.addEventListener('pointermove', (e) => {
    if (!dragSrc) return;
    e.preventDefault();
    const dy = e.clientY - startY;
    dragSrc.style.top = (parseFloat(dragSrc.style.top) + dy) + 'px';
    startY = e.clientY;
    const chips = [...container.querySelectorAll('.preset-chip:not(.dragging)')];
    let inserted = false;
    for (const chip of chips) {
      const r = chip.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) {
        container.insertBefore(placeholder, chip);
        inserted = true; break;
      }
    }
    if (!inserted) container.appendChild(placeholder);
  });

  container.addEventListener('pointerup', async () => {
    if (!dragSrc) return;
    dragSrc.style.cssText = '';
    dragSrc.classList.remove('dragging');
    container.insertBefore(dragSrc, placeholder);
    placeholder.remove(); placeholder = null;
    const newOrder = [...container.querySelectorAll('.preset-chip')].map(c => c.dataset.name);
    await storage.set({ presetOrder: newOrder });
    dragSrc = null;
  });
}

async function applyPresetByName(name) {
  const { presets = {} } = await storage.get('presets');
  const presetData = presets[name];
  if (!presetData) return;

  activePreset = name;
  await storage.set({ lastPreset: name });

  const dbId = presetData.__dbId;
  if (dbId && dbId !== currentDb?.id) {
    const dbSelect = document.getElementById('db-select');
    if (dbSelect && allDatabases.some(d => d.id === dbId)) {
      dbSelect.value = dbId;
      await loadDb(dbId, name);
      return;
    }
  }
  await applyPreset(presetData);
  renderPresets();
}

async function applyPreset(presetData) {
  const values = {};
  const blank = {};
  const today = {};
  let hidden = null;
  let order = null;

  Object.entries(presetData).forEach(([k, v]) => {
    if (k === '__hidden') { hidden = v; return; }
    if (k === '__order') { order = v; return; }
    if (k.startsWith('__')) return; // その他のメタ（clipMode等）は無視
    if (k.startsWith('__blank_')) { blank[k.slice(8)] = v; return; }
    if (k.startsWith('__today_')) { today[k.slice(8)] = v; return; }
    values[k] = v;
  });

  if (hidden !== null) {
    currentHiddenFields = new Set(hidden);
    const { hiddenFields = {} } = await storage.get('hiddenFields');
    hiddenFields[currentDb.id] = hidden;
    await storage.set({ hiddenFields });
  }

  if (order !== null) {
    const allProps = [...currentDb.properties, BODY_PSEUDO];
    const reordered = order
      .map(name => allProps.find(p => p.name === name))
      .filter(Boolean)
      .concat(allProps.filter(p => !order.includes(p.name)));
    currentSortedProperties = reordered;
    const { propertyOrder = {} } = await storage.get('propertyOrder');
    propertyOrder[currentDb.id] = order;
    await storage.set({ propertyOrder });
  }

  currentUiState = { blank: {}, today: {} };
  renderForm(currentSortedProperties, values, { blank, today });
}

// ========== フォームクリア ==========
async function clearForm() {
  activePreset = null;
  currentUiState = { blank: {}, today: {} };
  await storage.set({ lastPreset: null });
  renderForm(currentSortedProperties);
  renderPresets();
}

// ========== Notionに送信 ==========
async function submitToNotion() {
  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  showStatus('送信中...', 'loading');

  const { apiKey } = await storage.get('apiKey');
  const properties = buildNotionProperties(currentDb.properties, formValues);
  const pageBody = { parent: { database_id: currentDb.id }, properties };

  const bodyText = (formValues['__body'] || '').trim();
  if (bodyText) pageBody.children = markdownToNotionBlocks(bodyText);

  try {
    const response = await fetch(notionUrl('/v1/pages'), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(pageBody)
    });

    if (!response.ok) {
      const err = await response.json();
      showStatus(`エラー: ${err.message || response.status}`, 'error');
    } else {
      const data = await response.json();
      const tp = currentDb.properties.find(p => p.type === 'title');
      const savedTitle = (tp && formValues[tp.name]) ? String(formValues[tp.name]) : '';
      const { saveHistory: hist = [] } = await storage.get('saveHistory');
      hist.unshift({ title: savedTitle, pageUrl: data.url, dbId: currentDb.id, dbName: currentDb.name, savedAt: Date.now() });
      if (hist.length > 50) hist.splice(50);
      await storage.set({ saveHistory: hist });
      showStatus('Notionに追加しました！', 'success');
    }
  } catch (e) {
    showStatus(`通信エラー: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

function buildNotionProperties(propDefs, values) {
  const result = {};
  propDefs.forEach(prop => {
    if (prop.type === '__body') return;
    const val = values[prop.name];
    if (val === '' || val === null || val === undefined) return;
    if (Array.isArray(val) && val.length === 0) return;
    switch (prop.type) {
      case 'title': result[prop.name] = { title: [{ text: { content: String(val) } }] }; break;
      case 'rich_text': result[prop.name] = { rich_text: [{ text: { content: String(val) } }] }; break;
      case 'number': if (val !== '') result[prop.name] = { number: Number(val) }; break;
      case 'select': result[prop.name] = { select: { name: val } }; break;
      case 'multi_select': result[prop.name] = { multi_select: val.map(name => ({ name })) }; break;
      case 'date': result[prop.name] = { date: { start: val } }; break;
      case 'checkbox': result[prop.name] = { checkbox: !!val }; break;
      case 'url': result[prop.name] = { url: val }; break;
      case 'email': result[prop.name] = { email: val }; break;
      case 'phone_number': result[prop.name] = { phone_number: val }; break;
    }
  });
  return result;
}

// ========== ステータス ==========
function showStatus(message, type) {
  const bar = document.getElementById('status-bar');
  bar.textContent = message;
  bar.className = `status-bar ${type}`;
  if (type === 'success') setTimeout(() => { bar.className = 'status-bar'; }, 3000);
}

// ========== 設定ビュー ==========
async function renderSettings() {
  const content = document.getElementById('settings-content');
  const { apiKey = '', geminiApiKey = '', databases = [], historyCount = 5, saveHistory = [] } =
    await storage.get(['apiKey', 'geminiApiKey', 'databases', 'historyCount', 'saveHistory']);

  content.innerHTML = `
    <!-- CORSプロキシ -->
    <div class="section">
      <h2>CORSプロキシURL</h2>
      <label>Cloudflare Worker URL（ブラウザからNotionにアクセスするために必要）</label>
      <input type="text" id="s-proxy-url" placeholder="https://xxx.workers.dev" value="${escapeHtml(localStorage.getItem('ns_notionProxy') || '')}">
      <p class="hint">未設定の場合は直接アクセス（CORSエラーになる場合があります）</p>
      <div class="save-row"><button class="btn btn-primary btn-sm" id="s-save-proxy-btn">保存</button></div>
      <div id="s-proxy-status" class="status-msg"></div>
    </div>

    <!-- Notion APIキー -->
    <div class="section">
      <h2>Notion APIキー</h2>
      <label>Integration Token</label>
      <input type="password" id="s-api-key" placeholder="secret_xxxxxxxxxxxx" value="${escapeHtml(apiKey)}">
      <p class="hint">notion.so/my-integrations から取得できます</p>
      <div class="save-row"><button class="btn btn-primary btn-sm" id="s-save-key-btn">保存</button></div>
      <div id="s-key-status" class="status-msg"></div>
    </div>

    <!-- Gemini APIキー -->
    <div class="section">
      <h2>Gemini APIキー <span style="font-size:12px;font-weight:normal;color:#787774;">（AI生成・任意）</span></h2>
      <label>APIキー</label>
      <input type="password" id="s-gemini-key" placeholder="AIza..." value="${escapeHtml(geminiApiKey)}">
      <p class="hint">aistudio.google.com で無料取得できます</p>
      <div class="save-row"><button class="btn btn-primary btn-sm" id="s-save-gemini-btn">保存</button></div>
      <div id="s-gemini-status" class="status-msg"></div>
    </div>

    <!-- Database -->
    <div class="section">
      <h2>Database</h2>
      <label>APIキーでDatabaseを検索して追加</label>
      <div class="fetch-row">
        <button class="btn btn-secondary btn-sm" id="s-fetch-dbs-btn">全DBを取得</button>
      </div>
      <div id="s-fetch-status" class="status-msg"></div>
      <div id="s-api-db-panel">
        <input type="text" class="search-input" id="s-api-db-search" placeholder="DB名で絞り込み...">
        <div id="s-api-db-list"></div>
        <div class="panel-actions">
          <span class="select-all-row" id="s-select-all-btn">すべて選択 / 解除</span>
          <button class="btn btn-primary btn-sm" id="s-add-selected-btn">選択したDBを追加</button>
        </div>
      </div>
      <details>
        <summary>手動でIDを入力して追加</summary>
        <div class="manual-body">
          <label>Database ID</label>
          <div class="input-row">
            <input type="text" id="s-db-id-input" placeholder="xxxxxxxx...">
            <button class="btn btn-secondary btn-sm" id="s-load-db-btn">読み込み</button>
          </div>
          <p class="hint">NotionページURLの末尾32文字</p>
          <div id="s-db-status" class="status-msg"></div>
        </div>
      </details>
      <div id="s-db-list" style="margin-top:12px;"></div>
    </div>

    <!-- 表示設定 -->
    <div class="section">
      <h2>表示設定</h2>
      <label>保存履歴の表示件数</label>
      <div class="input-row">
        <input type="number" id="s-history-count" min="0" max="20" value="${Number(historyCount) || 5}" style="max-width:100px;">
        <button class="btn btn-primary btn-sm" id="s-save-history-count-btn">保存</button>
      </div>
      <p class="hint">0 で非表示（最大20件）</p>
      <div id="s-history-count-status" class="status-msg"></div>
    </div>

    <!-- 保存履歴 -->
    <div class="section">
      <h2>保存履歴</h2>
      <div id="s-history-list"></div>
    </div>
  `;

  renderSettingsDbList(databases);
  renderSettingsHistory(saveHistory, Number(historyCount) || 5);
  setupSettingsListeners();
}

function showSettingsStatus(elId, message, type) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = message;
  el.className = `status-msg ${type}`;
}

function setupSettingsListeners() {
  // CORSプロキシURL保存
  document.getElementById('s-save-proxy-btn').addEventListener('click', () => {
    const url = document.getElementById('s-proxy-url').value.trim();
    if (url) localStorage.setItem('ns_notionProxy', url);
    else localStorage.removeItem('ns_notionProxy');
    showSettingsStatus('s-proxy-status', '保存しました', 'success');
  });

  // Notion APIキー保存
  document.getElementById('s-save-key-btn').addEventListener('click', async () => {
    const key = document.getElementById('s-api-key').value.trim();
    if (!key) { showSettingsStatus('s-key-status', 'APIキーを入力してください', 'error'); return; }
    await storage.set({ apiKey: key });
    showSettingsStatus('s-key-status', '保存しました', 'success');
  });

  // Gemini APIキー保存
  document.getElementById('s-save-gemini-btn').addEventListener('click', async () => {
    const key = document.getElementById('s-gemini-key').value.trim();
    if (!key) { showSettingsStatus('s-gemini-status', 'APIキーを入力してください', 'error'); return; }
    await storage.set({ geminiApiKey: key });
    showSettingsStatus('s-gemini-status', '保存しました', 'success');
  });

  // 履歴件数保存
  document.getElementById('s-save-history-count-btn').addEventListener('click', async () => {
    const val = Math.min(20, Math.max(0, parseInt(document.getElementById('s-history-count').value, 10) || 0));
    document.getElementById('s-history-count').value = val;
    await storage.set({ historyCount: val });
    showSettingsStatus('s-history-count-status', '保存しました', 'success');
  });

  // 全DB取得
  document.getElementById('s-fetch-dbs-btn').addEventListener('click', async () => {
    const { apiKey } = await storage.get('apiKey');
    if (!apiKey) { showSettingsStatus('s-fetch-status', '先にAPIキーを保存してください', 'error'); return; }
    const btn = document.getElementById('s-fetch-dbs-btn');
    btn.disabled = true;
    showSettingsStatus('s-fetch-status', '取得中...', 'info');
    try {
      allFetchedDbs = await fetchAllDatabases(apiKey);
      showSettingsStatus('s-fetch-status', `${allFetchedDbs.length} 件のDatabaseが見つかりました`, 'success');
      document.getElementById('s-api-db-panel').style.display = 'block';
      document.getElementById('s-api-db-search').value = '';
      renderApiDbList(allFetchedDbs, '');
    } catch (e) {
      showSettingsStatus('s-fetch-status', `取得エラー: ${e.message}`, 'error');
    } finally { btn.disabled = false; }
  });

  document.getElementById('s-api-db-search').addEventListener('input', e => {
    renderApiDbList(allFetchedDbs, e.target.value);
  });

  document.getElementById('s-select-all-btn').addEventListener('click', () => {
    const checks = document.querySelectorAll('.api-db-check');
    const allChecked = [...checks].every(c => c.checked);
    checks.forEach(c => { c.checked = !allChecked; });
  });

  document.getElementById('s-add-selected-btn').addEventListener('click', async () => {
    const { apiKey } = await storage.get('apiKey');
    const checks = [...document.querySelectorAll('.api-db-check:checked')];
    if (checks.length === 0) { showSettingsStatus('s-fetch-status', 'DBを選択してください', 'error'); return; }
    const btn = document.getElementById('s-add-selected-btn');
    btn.disabled = true;
    showSettingsStatus('s-fetch-status', '追加中...', 'info');
    try {
      const { databases: dbs = [] } = await storage.get('databases');
      let added = 0, skipped = 0;
      for (const check of checks) {
        const rawId = check.value.replace(/-/g, '');
        const fId = `${rawId.slice(0,8)}-${rawId.slice(8,12)}-${rawId.slice(12,16)}-${rawId.slice(16,20)}-${rawId.slice(20)}`;
        if (dbs.some(d => d.id === fId)) { skipped++; continue; }
        const res = await fetch(`${notionUrl(`/v1/databases/${fId}`)}`, {
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Notion-Version': '2022-06-28' }
        });
        if (!res.ok) continue;
        const data = await res.json();
        dbs.push({ id: fId, name: check.dataset.name, properties: parseProperties(data.properties), enabled: true });
        added++;
      }
      await storage.set({ databases: dbs });
      renderSettingsDbList(dbs);
      let msg = `${added} 件追加しました`;
      if (skipped > 0) msg += `（${skipped} 件は重複のためスキップ）`;
      showSettingsStatus('s-fetch-status', msg, 'success');
    } catch (e) {
      showSettingsStatus('s-fetch-status', `エラー: ${e.message}`, 'error');
    } finally { btn.disabled = false; }
  });

  // 手動DB追加
  document.getElementById('s-load-db-btn').addEventListener('click', async () => {
    const rawId = document.getElementById('s-db-id-input').value.trim();
    if (!rawId) { showSettingsStatus('s-db-status', 'Database IDを入力してください', 'error'); return; }
    const dbId = rawId.replace(/-/g, '');
    if (dbId.length !== 32) { showSettingsStatus('s-db-status', 'IDは32文字で入力してください', 'error'); return; }
    const fId = `${dbId.slice(0,8)}-${dbId.slice(8,12)}-${dbId.slice(12,16)}-${dbId.slice(16,20)}-${dbId.slice(20)}`;
    const { apiKey } = await storage.get('apiKey');
    if (!apiKey) { showSettingsStatus('s-db-status', '先にAPIキーを保存してください', 'error'); return; }
    showSettingsStatus('s-db-status', '読み込み中...', 'info');
    try {
      const res = await fetch(`${notionUrl(`/v1/databases/${fId}`)}`, {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Notion-Version': '2022-06-28' }
      });
      if (!res.ok) { const err = await res.json(); showSettingsStatus('s-db-status', `エラー: ${err.message || res.status}`, 'error'); return; }
      const data = await res.json();
      const dbName = extractPlainText(data.title) || '(タイトルなし)';
      const { databases: dbs = [] } = await storage.get('databases');
      if (dbs.some(d => d.id === fId)) { showSettingsStatus('s-db-status', 'すでに追加されています', 'error'); return; }
      dbs.push({ id: fId, name: dbName, properties: parseProperties(data.properties), enabled: true });
      await storage.set({ databases: dbs });
      document.getElementById('s-db-id-input').value = '';
      showSettingsStatus('s-db-status', `「${dbName}」を追加しました`, 'success');
      renderSettingsDbList(dbs);
    } catch (e) { showSettingsStatus('s-db-status', `通信エラー: ${e.message}`, 'error'); }
  });
}

function renderApiDbList(dbs, query) {
  const list = document.getElementById('s-api-db-list');
  const filtered = query ? dbs.filter(db => db.name.toLowerCase().includes(query.toLowerCase())) : dbs;
  if (filtered.length === 0) { list.innerHTML = '<div class="empty-state">該当するDBがありません</div>'; return; }
  list.innerHTML = filtered.map(db => `
    <div class="api-db-item">
      <input type="checkbox" class="api-db-check" id="api-${db.id}" value="${db.id}" data-name="${escapeHtml(db.name)}">
      <label for="api-${db.id}">${escapeHtml(db.name)} <span class="api-db-id">${db.id}</span></label>
    </div>
  `).join('');
}

async function renderSettingsDbList(databases) {
  const list = document.getElementById('s-db-list');
  if (!databases || databases.length === 0) {
    list.innerHTML = '<div class="empty-state">Databaseがまだ追加されていません</div>';
    return;
  }
  const { propertyOrder = {} } = await storage.get('propertyOrder');
  const sorted = [...databases].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  list.innerHTML = sorted.map(db => {
    const allProps = [...(db.properties || []), BODY_PSEUDO];
    const order = propertyOrder[db.id] || [];
    const sortedProps = order.length > 0
      ? [...order.map(n => allProps.find(p => p.name === n)).filter(Boolean),
         ...allProps.filter(p => !order.includes(p.name))]
      : allProps;
    const propOrderHtml = sortedProps.length > 0 ? `
      <details class="prop-order-section">
        <summary class="prop-order-summary">プロパティの順序（${sortedProps.length}件）</summary>
        <div class="prop-order-list" data-db-id="${db.id}">
          ${sortedProps.map(p => `
            <div class="prop-order-item" data-name="${escapeHtml(p.name)}">
              <span class="prop-order-handle">≡</span>
              <span class="prop-order-name">${escapeHtml(p.name)}</span>
              <span class="type-badge">${escapeHtml(p.type)}</span>
            </div>
          `).join('')}
        </div>
      </details>
    ` : '';
    return `
    <div class="db-card">
      <div class="db-item">
        <label class="db-enable">
          <input type="checkbox" class="db-enable-check" data-id="${db.id}" ${db.enabled !== false ? 'checked' : ''}>
          <span class="db-enable-label">使用する</span>
        </label>
        <div class="db-info">
          <div class="db-name">${escapeHtml(db.name)}</div>
          <div class="db-id">${db.id}</div>
        </div>
        <div class="db-actions">
          <button class="btn btn-secondary btn-sm" data-id="${db.id}" data-action="refresh">更新</button>
          <button class="btn btn-secondary btn-sm" style="color:#eb5757;" data-id="${db.id}" data-action="delete">削除</button>
        </div>
      </div>
      <div class="db-ai-row">
        <label class="db-ai-label">AIプロンプト <span class="db-ai-hint">（{{title}} {{url}} {{body}} が使えます）</span></label>
        <textarea class="db-ai-textarea" data-id="${db.id}" placeholder="${escapeHtml(DEFAULT_AI_PROMPT)}">${escapeHtml(db.aiPrompt || '')}</textarea>
      </div>
      ${propOrderHtml}
    </div>
  `;
  }).join('');

  list.querySelectorAll('.db-enable-check').forEach(check => {
    check.addEventListener('change', async () => {
      const { databases: dbs = [] } = await storage.get('databases');
      const db = dbs.find(d => d.id === check.dataset.id);
      if (db) db.enabled = check.checked;
      await storage.set({ databases: dbs });
    });
  });

  list.querySelectorAll('[data-action="refresh"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { apiKey } = await storage.get('apiKey');
      if (!apiKey) { showSettingsStatus('s-fetch-status', '先にAPIキーを保存してください', 'error'); return; }
      btn.disabled = true;
      try {
        const res = await fetch(`${notionUrl(`/v1/databases/${btn.dataset.id}`)}`, {
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Notion-Version': '2022-06-28' }
        });
        if (!res.ok) { const err = await res.json(); throw new Error(err.message || res.status); }
        const data = await res.json();
        const { databases: dbs = [] } = await storage.get('databases');
        const db = dbs.find(d => d.id === btn.dataset.id);
        if (db) { db.properties = parseProperties(data.properties); db.name = extractPlainText(data.title) || db.name; }
        await storage.set({ databases: dbs });
        renderSettingsDbList(dbs);
      } catch (e) { showSettingsStatus('s-fetch-status', `更新エラー: ${e.message}`, 'error'); }
      finally { btn.disabled = false; }
    });
  });

  list.querySelectorAll('.db-ai-textarea').forEach(ta => {
    let saveTimer;
    ta.addEventListener('input', () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        const { databases: dbs = [] } = await storage.get('databases');
        const db = dbs.find(d => d.id === ta.dataset.id);
        if (db) db.aiPrompt = ta.value;
        await storage.set({ databases: dbs });
      }, 500);
    });
  });

  list.querySelectorAll('[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { databases: dbs = [] } = await storage.get('databases');
      const idx = dbs.findIndex(d => d.id === btn.dataset.id);
      if (idx >= 0) dbs.splice(idx, 1);
      await storage.set({ databases: dbs });
      renderSettingsDbList(dbs);
    });
  });

  list.querySelectorAll('.prop-order-list').forEach(setupPropOrderDrag);
}

function setupPropOrderDrag(listEl) {
  const dbId = listEl.dataset.dbId;
  let dragSrc = null, placeholder = null, startY = 0;

  listEl.addEventListener('pointerdown', e => {
    const handle = e.target.closest('.prop-order-handle');
    if (!handle) return;
    dragSrc = handle.closest('.prop-order-item');
    if (!dragSrc) return;
    startY = e.clientY;
    e.preventDefault();
    listEl.setPointerCapture(e.pointerId);
    dragSrc.classList.add('dragging');
    placeholder = document.createElement('div');
    placeholder.className = 'prop-order-placeholder';
    dragSrc.after(placeholder);
    const rect = dragSrc.getBoundingClientRect();
    dragSrc.style.cssText = `position:fixed;width:${dragSrc.offsetWidth}px;z-index:50;opacity:0.9;left:${rect.left}px;top:${rect.top}px;background:#fff;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,0.15);padding:8px 12px;`;
  });

  listEl.addEventListener('pointermove', e => {
    if (!dragSrc) return;
    e.preventDefault();
    const dy = e.clientY - startY;
    dragSrc.style.top = (parseFloat(dragSrc.style.top) + dy) + 'px';
    startY = e.clientY;
    const items = [...listEl.querySelectorAll('.prop-order-item:not(.dragging)')];
    let inserted = false;
    for (const item of items) {
      const r = item.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { listEl.insertBefore(placeholder, item); inserted = true; break; }
    }
    if (!inserted) listEl.appendChild(placeholder);
  });

  listEl.addEventListener('pointerup', async () => {
    if (!dragSrc) return;
    dragSrc.style.cssText = '';
    dragSrc.classList.remove('dragging');
    listEl.insertBefore(dragSrc, placeholder);
    placeholder.remove();
    placeholder = null;
    const newOrder = [...listEl.querySelectorAll('.prop-order-item')].map(el => el.dataset.name);
    const { propertyOrder = {} } = await storage.get('propertyOrder');
    propertyOrder[dbId] = newOrder;
    await storage.set({ propertyOrder });
    dragSrc = null;
  });
}

function renderSettingsHistory(saveHistory, count) {
  const list = document.getElementById('s-history-list');
  const items = saveHistory.slice(0, Math.max(count, 0));
  if (items.length === 0) { list.innerHTML = '<div class="history-empty">保存履歴はまだありません</div>'; return; }
  list.innerHTML = '';
  items.forEach(item => {
    const wrapper = document.createElement('div');
    wrapper.className = 'history-item-wrapper';
    const a = document.createElement('a');
    a.href = item.pageUrl;
    a.target = '_blank';
    a.rel = 'noopener';
    a.className = 'history-item';
    a.innerHTML = `<span class="history-item-title">${escapeHtml(item.title || '(タイトルなし)')}</span>
      <span class="history-item-db">${escapeHtml(item.dbName || '')}</span>`;
    const delBtn = document.createElement('button');
    delBtn.className = 'history-del-btn';
    delBtn.textContent = '×';
    delBtn.title = '削除';
    delBtn.addEventListener('click', async () => {
      const { saveHistory: h = [], historyCount: hc = 5 } = await storage.get(['saveHistory', 'historyCount']);
      await storage.set({ saveHistory: h.filter(i => i.savedAt !== item.savedAt) });
      const updated = await storage.get('saveHistory');
      renderSettingsHistory(updated.saveHistory || [], Number(hc) || 5);
    });
    wrapper.appendChild(a);
    wrapper.appendChild(delBtn);
    list.appendChild(wrapper);
  });
}

// ========== Notion API ヘルパー ==========
async function fetchAllDatabases(apiKey) {
  const results = [];
  let cursor;
  do {
    const body = { filter: { value: 'database', property: 'object' }, page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await fetch(notionUrl('/v1/search'), {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) { const err = await res.json(); throw new Error(err.message || res.status); }
    const data = await res.json();
    data.results.forEach(db => results.push({ id: db.id, name: extractPlainText(db.title) || '(タイトルなし)' }));
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return results.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
}

function parseProperties(props) {
  const supported = ['title', 'rich_text', 'number', 'select', 'multi_select', 'date', 'checkbox', 'url', 'email', 'phone_number'];
  return Object.entries(props)
    .filter(([, v]) => supported.includes(v.type))
    .map(([name, v]) => {
      const prop = { name, type: v.type };
      if (v.type === 'select') prop.options = v.select.options.map(o => ({ id: o.id, name: o.name, color: o.color }));
      if (v.type === 'multi_select') prop.options = v.multi_select.options.map(o => ({ id: o.id, name: o.name, color: o.color }));
      return prop;
    });
}

function extractPlainText(richTexts) {
  if (!Array.isArray(richTexts)) return '';
  return richTexts.map(t => t.plain_text || '').join('');
}

// ========== Gemini AI ==========
async function callGemini(prompt) {
  const { geminiApiKey } = await storage.get('geminiApiKey');
  if (!geminiApiKey) throw new Error('設定でGemini APIキーを登録してください');
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
  );
  if (!res.ok) { const err = await res.json(); throw new Error(err.error?.message || res.status); }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

function fillAiTemplate(template) {
  const titleProp = currentDb?.properties.find(p => p.type === 'title');
  const urlProp = currentDb?.properties.find(p => p.type === 'url');
  return template
    .replace(/\{\{title\}\}/g, (titleProp && formValues[titleProp.name]) || '')
    .replace(/\{\{url\}\}/g, (urlProp && formValues[urlProp.name]) || '')
    .replace(/\{\{body\}\}/g, formValues['__body'] || '');
}

// ========== Markdown → Notionブロック ==========
function parseInline(text) {
  const parts = [];
  const regex = /\*\*\*(.*?)\*\*\*|\*\*(.*?)\*\*|\*(.*?)\*/g;
  let last = 0, m;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) parts.push({ type: 'text', text: { content: text.slice(last, m.index) } });
    if (m[1] != null) parts.push({ type: 'text', text: { content: m[1] }, annotations: { bold: true, italic: true } });
    else if (m[2] != null) parts.push({ type: 'text', text: { content: m[2] }, annotations: { bold: true } });
    else if (m[3] != null) parts.push({ type: 'text', text: { content: m[3] }, annotations: { italic: true } });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ type: 'text', text: { content: text.slice(last) } });
  return parts.length > 0 ? parts : [{ type: 'text', text: { content: text } }];
}

function markdownToNotionBlocks(md, maxBlocks = 100) {
  const lines = md.split('\n');
  const blocks = [];
  let lastBullet = null;
  for (const line of lines) {
    if (blocks.length >= maxBlocks) break;
    if (!line.trim()) { lastBullet = null; continue; }
    if (/^-{3,}$/.test(line.trim())) { blocks.push({ object: 'block', type: 'divider', divider: {} }); lastBullet = null; continue; }
    const h3 = line.match(/^### (.+)/); if (h3) { blocks.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: parseInline(h3[1]) } }); lastBullet = null; continue; }
    const h2 = line.match(/^## (.+)/); if (h2) { blocks.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: parseInline(h2[1]) } }); lastBullet = null; continue; }
    const h1 = line.match(/^# (.+)/); if (h1) { blocks.push({ object: 'block', type: 'heading_1', heading_1: { rich_text: parseInline(h1[1]) } }); lastBullet = null; continue; }
    const nested = line.match(/^ {2,}[-*]\s+(.+)/);
    if (nested && lastBullet) { if (!lastBullet.bulleted_list_item.children) lastBullet.bulleted_list_item.children = []; lastBullet.bulleted_list_item.children.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: parseInline(nested[1]) } }); continue; }
    const bullet = line.match(/^[-*]\s+(.+)/); if (bullet) { const b = { object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: parseInline(bullet[1]) } }; blocks.push(b); lastBullet = b; continue; }
    const numbered = line.match(/^\d+\.\s+(.+)/); if (numbered) { blocks.push({ object: 'block', type: 'numbered_list_item', numbered_list_item: { rich_text: parseInline(numbered[1]) } }); lastBullet = null; continue; }
    blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: parseInline(line) } });
    lastBullet = null;
  }
  return blocks;
}

// ========== ユーティリティ ==========
function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ========== イベント登録 ==========
document.getElementById('settings-btn').addEventListener('click', async () => {
  showView('settings');
  await renderSettings();
});
document.getElementById('back-btn').addEventListener('click', async () => {
  showView('form');
  // DBリストが変わっている可能性があるので再初期化
  const { databases } = await storage.get('databases');
  const enabled = (databases || []).filter(d => d.enabled !== false);
  allDatabases = [...enabled].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  const dbSelect = document.getElementById('db-select');
  const prevId = dbSelect.value;
  dbSelect.innerHTML = '';
  allDatabases.forEach(db => {
    const opt = document.createElement('option');
    opt.value = db.id; opt.textContent = db.name;
    dbSelect.appendChild(opt);
  });
  if (prevId && allDatabases.some(d => d.id === prevId)) dbSelect.value = prevId;
  if (currentDb) await loadDb(dbSelect.value);
});
document.getElementById('submit-btn').addEventListener('click', submitToNotion);
document.getElementById('clear-btn').addEventListener('click', clearForm);
document.getElementById('save-preset-btn').addEventListener('click', () => {
  document.getElementById('preset-dialog').classList.remove('hidden');
  document.getElementById('preset-name-input').value = activePreset || '';
  document.getElementById('preset-name-input').focus();
});
document.getElementById('cancel-preset').addEventListener('click', () => {
  document.getElementById('preset-dialog').classList.add('hidden');
});
document.getElementById('confirm-preset').addEventListener('click', async () => {
  const name = document.getElementById('preset-name-input').value.trim();
  if (!name) return;
  const presetData = {
    __dbId: currentDb.id,
    ...formValues,
    __hidden: [...currentHiddenFields],
    __order: currentSortedProperties.map(p => p.name),
  };
  Object.entries(currentUiState.blank).forEach(([k, v]) => { presetData[`__blank_${k}`] = v; });
  Object.entries(currentUiState.today).forEach(([k, v]) => { presetData[`__today_${k}`] = v; });
  const { presets = {}, presetOrder = [] } = await storage.get(['presets', 'presetOrder']);
  presets[name] = presetData;
  const newOrder = presetOrder.includes(name) ? presetOrder : [...presetOrder, name];
  await storage.set({ presets, presetOrder: newOrder, lastPreset: name });
  activePreset = name;
  document.getElementById('preset-dialog').classList.add('hidden');
  renderPresets();
  showStatus(`プリセット「${name}」を保存しました`, 'success');
});

init();
