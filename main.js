(async () => {
  // ---------- Cấu hình ----------
  const AUTO_SKIP = true;
  const AUTO_SUBMIT = true;
  const AUTO_SUBMIT_FINAL_EXAM = true; // Tự tích confirm-exam & nộp bài ở trang cuối
  const AUTO_RETRY_ON_RESULT = false;  // Đổi thành true nếu đang ở 0% muốn tự bấm "Thiết lập lại"
  const RELOAD_COMPONENTS = false;     // false: tái sử dụng cache trong tab
  const FAST_CLICK_MS = 45;
  const POLL_MS = 45;
  const MAX_WAIT_READY_MS = 3500;
  const MAX_WAIT_ADVANCE_MS = 4500;

  window.stopAutofill?.();
  let stopped = false;
  window.stopAutofill = () => {
    stopped = true;
    console.log("[AutoFill] Đã dừng.");
  };

  console.log(`[AutoFill] Khởi động tại ngữ cảnh: ${location.pathname}`);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0All = performance.now();

  const NAMED_ENTITIES = {
    nbsp: " ", amp: "&", quot: '"', apos: "'", lt: "<", gt: ">",
    lsquo: "'", rsquo: "'", sbquo: "'",
    ldquo: '"', rdquo: '"', bdquo: '"',
    ndash: "-", mdash: "-", minus: "-",
    hellip: "...", copy: "©", reg: "®", trade: "™",
    deg: "°", plusmn: "±", times: "×", divide: "÷",
    bull: "•", middot: "·", laquo: "«", raquo: "»",
    prime: "'", Prime: '"', thinsp: " ", ensp: " ", emsp: " ",
    zwnj: "", zwj: "", shy: "", comma: ","
  };

  let htmlDecoderEl = null;
  const decodeHtmlEntities = (str) => {
    let out = String(str ?? "");
    for (let pass = 0; pass < 2; pass++) {
      const prev = out;
      try {
        if (!htmlDecoderEl && typeof document !== "undefined") {
          htmlDecoderEl = document.createElement("textarea");
        }
        if (htmlDecoderEl) {
          htmlDecoderEl.innerHTML = out;
          out = htmlDecoderEl.value;
        }
      } catch {}

      out = out
        .replace(/&#(\d+);?/g, (_, dec) => {
          const cp = Number(dec);
          return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : _;
        })
        .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => {
          const cp = parseInt(hex, 16);
          return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : _;
        })
        .replace(/&([a-z0-9]+);/gi, (m, name) => {
          if (name in NAMED_ENTITIES) return NAMED_ENTITIES[name];
          const lower = name.toLowerCase();
          return lower in NAMED_ENTITIES ? NAMED_ENTITIES[lower] : m;
        });

      if (out === prev) break;
    }
    return out;
  };

  const normalize = (value) => {
    const stripped = String(value ?? "")
      .replace(/```[\w-]*\s*([\s\S]*?)```/g, " $1 ")
      .replace(/<br\s*\/?\s*>/gi, " ")
      .replace(/<[^>]*>/g, " ");

    return decodeHtmlEntities(stripped)
      .replace(/[\u00a0\u200b-\u200d\ufeff]/g, " ")
      .replace(/[‘’‚‛′]/g, "'")
      .replace(/[“”„‟″]/g, '"')
      .replace(/[–—−]/g, "-")
      .replace(/`+/g, "")
      .replace(/\*+/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  };

  const normalizeLoose = (value) =>
    normalize(value)
      .replace(/[^\p{L}\p{N}\s]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();

  const stripOuterParens = (s) => {
    const m = String(s || "").trim().match(/^\((.*)\)$/);
    return m ? m[1].trim() : String(s || "").trim();
  };

  const tokenize = (normText) =>
    new Set(normText.split(/[^\p{L}\p{N}]+/u).filter(Boolean));

  // ---------- DOM & Shadow DOM Cache ----------
  let domCacheVersion = 0;
  const domElementsCache = new WeakMap();
  const invalidateDomCache = () => { domCacheVersion++; };

  const deepElements = (root) => {
    if (!root || typeof root !== "object") return [];
    const cached = domElementsCache.get(root);
    if (cached?.version === domCacheVersion) return cached.elements;

    const result = [];
    const roots = [root];
    const visited = new Set();

    for (let i = 0; i < roots.length; i++) {
      const cur = roots[i];
      if (!cur || visited.has(cur)) continue;
      visited.add(cur);

      if (cur.nodeType === 1 && cur.shadowRoot) roots.push(cur.shadowRoot);
      let els;
      try { els = cur.querySelectorAll("*"); } catch { continue; }

      for (const el of els) {
        result.push(el);
        if (el.shadowRoot) roots.push(el.shadowRoot);
        if (el.tagName === "IFRAME") {
          try {
            if (el.contentDocument?.documentElement) roots.push(el.contentDocument);
          } catch {}
        }
      }
    }

    domElementsCache.set(root, { version: domCacheVersion, elements: result });
    return result;
  };

  const deepFind = (root, selector) =>
    deepElements(root).filter((el) => {
      try { return el.matches(selector); } catch { return false; }
    });

  const elementText = (el) =>
    el ? (el.innerText || el.textContent || "").trim() : "";

  const visible = (el) => {
    if (!el) return false;
    if (el.offsetWidth || el.offsetHeight) return true;
    const r = el.getBoundingClientRect?.();
    return Boolean(r && r.width > 0 && r.height > 0);
  };

  const closestAcrossShadow = (el, selector) => {
    let cur = el;
    while (cur) {
      if (cur.nodeType === 1 && cur.matches?.(selector)) return cur;
      cur = cur.parentNode || cur.host || null;
    }
    return null;
  };

  const ensureInViewAndClick = (el) => {
    if (!el) return;
    try {
      const rect = el.getBoundingClientRect?.();
      const win = el.ownerDocument?.defaultView || window;
      if (
        rect &&
        (rect.top < 0 || rect.left < 0 || rect.bottom > win.innerHeight || rect.right > win.innerWidth)
      ) {
        el.scrollIntoView({ block: "center", inline: "center" });
      }
    } catch {}
    el.click();
    invalidateDomCache();
  };

  const findByText = (items, wanted, getText = elementText) => {
    const target = normalize(wanted);
    const targetBare = normalize(stripOuterParens(wanted));
    const targetLoose = normalizeLoose(stripOuterParens(wanted));
    return (
      items.find((el) => normalize(getText(el)) === target) ||
      items.find((el) => normalize(stripOuterParens(getText(el))) === targetBare) ||
      items.find((el) => normalize(getText(el)).startsWith(target)) ||
      (targetLoose ? items.find((el) => normalizeLoose(stripOuterParens(getText(el))) === targetLoose) : undefined)
    );
  };

  // ---------- 1. Tìm Document chứa bài ----------
  const hasContent = (doc) =>
    deepElements(doc).some((el) =>
      el.matches?.(".component__inner.is-question, button.block-button, .start-button, input#confirm-exam, button.assessmentResults__retry-btn")
    );

  const getFrameDocument = async () => {
    let blockedCrossOrigin = false;
    for (let i = 0; i < 15; i++) {
      invalidateDomCache();
      if (hasContent(document)) return document;

      blockedCrossOrigin = false;
      for (const frame of deepFind(document, "iframe")) {
        try {
          if (frame.contentDocument?.body && hasContent(frame.contentDocument)) {
            return frame.contentDocument;
          }
        } catch {
          blockedCrossOrigin = true;
        }
      }

      if (blockedCrossOrigin && i >= 2) break;
      await sleep(120);
    }

    throw new Error(
      "Đang chạy ở ngữ cảnh 'top' và không truy cập được iframe bài học!\n" +
      "Hãy mở tab Console -> đổi dropdown 'top' sang 'index.html' -> bấm Ctrl+P -> gõ !Tự làm mọi thứ -> Enter."
    );
  };

  const doc = await getFrameDocument();

  // ---------- 2. Lấy & Index toàn bộ components.json MỘT LẦN song song ----------
  const extractCourseAnswer = (comp) => {
    const compType = String(comp._component || comp.component || "").toLowerCase();
    const items = Array.isArray(comp._items) ? comp._items : [];
    if (!items.length && !comp._feedback?.correct) return null;

    if (compType === "objectmatching" || items.some((it) => it && "question" in it && "answer" in it)) {
      const pairs = items
        .filter((it) => it?.question && it?.answer)
        .map((it) => [String(it.question), String(it.answer)])
        .filter(([l, r]) => normalize(l) && normalize(r));

      if (!pairs.length && comp._feedback?.correct) {
        const docTmp = new DOMParser().parseFromString(comp._feedback.correct, "text/html");
        for (const tr of docTmp.querySelectorAll("tr")) {
          const tds = tr.querySelectorAll("td");
          if (tds.length >= 2) {
            const l = tds[0].textContent?.trim();
            const r = tds[1].textContent?.trim();
            if (normalize(l) && normalize(r)) pairs.push([l, r]);
          }
        }
      }
      return pairs.length ? { kind: "objectMatching", pairs, sigItems: pairs.map(([l]) => normalize(l)) } : null;
    }

    if (compType === "fillblanks" || items.some((it) => Array.isArray(it?._options) && ("preText" in it || "postText" in it))) {
      const blanks = items
        .map((it) => {
          const opts = Array.isArray(it?._options) ? it._options : [];
          const right = opts.find((o) => o?._isCorrect || o?._shouldBeSelected);
          return right?.text || null;
        })
        .filter(Boolean);
      return blanks.length ? { kind: "fillBlanks", blanks, sigItems: blanks.map((b) => normalize(b)) } : null;
    }

    if (compType === "matching" || items.some((it) => Array.isArray(it?._options))) {
      const pairs = items
        .map((it) => {
          const left = it?.text || it?.category || "";
          const opts = Array.isArray(it?._options) ? it._options : [];
          const right = opts.find((o) => o?._isCorrect || o?._shouldBeSelected)?.text || "";
          return left && right ? [left, right] : null;
        })
        .filter(Boolean);
      return pairs.length ? { kind: "matching", pairs, sigItems: pairs.map(([l]) => normalize(l)) } : null;
    }

    const correctChoices = items
      .filter((it) => it?._shouldBeSelected || it?._isCorrect)
      .map((it) => it?.text || it?.alt || "")
      .filter(Boolean);
    if (correctChoices.length) {
      const allChoices = items.map((it) => normalize(it?.text || it?.alt || "")).filter(Boolean);
      return { kind: "mcq", choices: correctChoices, sigItems: allChoices };
    }

    return null;
  };

  const collectComponentUrls = (targetDoc) => {
    const win = targetDoc.defaultView || window;
    const perfEntries = [
      ...performance.getEntriesByType("resource"),
      ...(win !== window && win?.performance ? win.performance.getEntriesByType("resource") : [])
    ];

    const urls = new Set(
      perfEntries
        .map((e) => e.name)
        .filter((u) => /components\.json(\?|$)/i.test(u))
    );

    if (!urls.size) {
      for (const e of perfEntries) {
        const m = String(e.name || "").match(/^(https?:\/\/[^?#]+\/courses\/[^/]+\/[^/]+\/[^/]+\/)/i);
        if (m) urls.add(`${m[1]}components.json`);
      }
    }
    return [...urls];
  };

  const loadAllComponentsIndex = async (targetDoc) => {
    const win = targetDoc.defaultView || window;
    const urls = collectComponentUrls(targetDoc);

    if (!RELOAD_COMPONENTS && win.__adaptFastBank?.urlsKey === urls.join("|") && urls.length) {
      return win.__adaptFastBank.index;
    }

    const fetched = await Promise.all(
      urls.map(async (url) => {
        try {
          const res = await fetch(url, { cache: "force-cache" });
          if (!res.ok) return [];
          const data = await res.json();
          return Array.isArray(data) ? data : [];
        } catch {
          return [];
        }
      })
    );

    const allComps = fetched.flat();
    const byCompId = new Map();
    const byBlockId = new Map();
    const bySignature = new Map();
    const byBodyExact = new Map();
    const entries = [];
    const inverted = new Map();

    let order = 0;
    for (const comp of allComps) {
      if (!comp || comp._type !== "component") continue;
      const parsed = extractCourseAnswer(comp);
      if (!parsed) continue;

      const compId = comp._id || comp.id || "";
      const blockId = comp._parentId || "";
      const body = normalize(comp.body || comp.instruction || comp.title || "");
      const wordSet = tokenize(body);
      const sig = parsed.sigItems.length
        ? `${body}||${[...parsed.sigItems].sort().join("|")}`
        : "";

      const record = { compId, blockId, body, wordSet, parsed, order: order++ };
      if (compId) byCompId.set(compId, record);
      if (blockId) {
        if (!byBlockId.has(blockId)) byBlockId.set(blockId, []);
        byBlockId.get(blockId).push(record);
      }
      if (sig) bySignature.set(sig, record);
      if (body) byBodyExact.set(body, record);

      entries.push(record);
      for (const tk of wordSet) {
        if (!inverted.has(tk)) inverted.set(tk, []);
        inverted.get(tk).push(record);
      }
    }

    const index = {
      urlsCount: urls.length,
      totalComps: allComps.length,
      byCompId,
      byBlockId,
      bySignature,
      byBodyExact,
      entries,
      inverted
    };
    if (urls.length) {
      win.__adaptFastBank = { urlsKey: urls.join("|"), index };
    }
    return index;
  };

  const bankIndex = await loadAllComponentsIndex(doc);
  console.log(
    `[AutoFill] Đã nạp ${bankIndex.urlsCount} file components.json (${bankIndex.totalComps} components, ${bankIndex.entries.length} câu có đáp án) trong ${(performance.now() - t0All).toFixed(0)}ms.`
  );

  // ---------- 3. Bấm Start / Bắt đầu nếu đang ở màn hình chào ----------
  if (!deepFind(doc, "button.block-button").length && !deepFind(doc, ".component__inner.is-question").length) {
    const startBtn = deepFind(doc, "button, [role='button'], .start-button").find((el) => {
      const t = normalize(elementText(el));
      return visible(el) && (t === "start" || t === "bắt đầu");
    });
    if (startBtn) {
      ensureInViewAndClick(startBtn);
      for (let i = 0; i < 80; i++) {
        await sleep(POLL_MS);
        invalidateDomCache();
        if (deepFind(doc, "button.block-button, .component__inner.is-question").length) break;
      }
    }
  }

  // ---------- 4. Xét hàng loạt & Khớp đáp án ----------
  const extractQuestionMeta = (root) => {
    const compView = closestAcrossShadow(root, "component-view[modelid], [data-socialgoodpulse-id]");
    let compId = compView?.getAttribute("modelid") || compView?.getAttribute("data-socialgoodpulse-id") || "";
    if (!compId) {
      const inp = deepFind(root, "input[id$='-input']")[0];
      const m = inp?.id?.match(/^([0-9a-f]{16,32})-/i);
      if (m) compId = m[1];
    }
    const blockView = closestAcrossShadow(root, "block-view[modelid]");
    const blockId = blockView?.getAttribute("modelid") || "";

    const bodyEl = deepFind(root, ".component__body")[0];
    const body = normalize(bodyEl ? elementText(bodyEl) : "");

    const mcqTexts = deepFind(root, ".mcq__item").map((it) =>
      normalize(elementText(it).replace(/\s+\d+\s+of\s+\d+\s*$/i, ""))
    );
    const matchLefts = deepFind(root, ".matching__item-title").map((it) => normalize(elementText(it)));
    const objLefts = deepFind(root, "button.objectMatching-category-item").map((it) =>
      normalize(elementText(it).replace(/\s+[A-Z]$/, ""))
    );
    const sigParts = mcqTexts.length ? mcqTexts : matchLefts.length ? matchLefts : objLefts;
    const sig = sigParts.length && body ? `${body}||${[...sigParts].sort().join("|")}` : "";

    return { compId, blockId, body, sig };
  };

  const resolveRecord = (index, meta) => {
    if (meta.compId && index.byCompId.has(meta.compId)) {
      return index.byCompId.get(meta.compId);
    }
    if (meta.sig && index.bySignature.has(meta.sig)) {
      return index.bySignature.get(meta.sig);
    }
    if (meta.blockId && index.byBlockId.has(meta.blockId)) {
      const list = index.byBlockId.get(meta.blockId);
      if (list.length === 1) return list[0];
      const hit = list.find((r) => r.body === meta.body);
      if (hit) return hit;
    }
    if (meta.body && index.byBodyExact.has(meta.body)) {
      return index.byBodyExact.get(meta.body);
    }
    if (!meta.body) return null;

    const bodyTokens = tokenize(meta.body);
    if (!bodyTokens.size) return null;
    const cands = new Set();
    for (const tk of bodyTokens) {
      const arr = index.inverted.get(tk);
      if (arr) for (const r of arr) cands.add(r);
    }
    let best = null;
    let bestScore = 0;
    for (const r of cands) {
      let common = 0;
      for (const tk of r.wordSet) if (bodyTokens.has(tk)) common++;
      const score = common / Math.max(r.wordSet.size, bodyTokens.size);
      if (score > bestScore) { bestScore = score; best = r; }
    }
    return bestScore >= 0.85 ? best : null;
  };

  const plannedMap = new WeakMap();
  const doneRoots = new WeakSet();

  const preplanDomQuestions = () => {
    invalidateDomCache();
    const allQs = deepFind(doc, ".component__inner.is-question");
    let matched = 0;
    for (const qRoot of allQs) {
      if (plannedMap.has(qRoot)) {
        if (plannedMap.get(qRoot)) matched++;
        continue;
      }
      const meta = extractQuestionMeta(qRoot);
      const rec = resolveRecord(bankIndex, meta);
      if (rec) {
        plannedMap.set(qRoot, rec);
        matched++;
      }
    }
    return { total: allQs.length, matched };
  };

  const preStats = preplanDomQuestions();
  console.log(`[AutoFill] Đã xét hàng loạt ${preStats.matched}/${preStats.total} câu trên DOM. Gõ stopAutofill() để dừng.`);

  // ---------- 5. Xác định câu hiện tại & ĐỢI DOM ổn định trước khi điền ----------
  const activeNumber = (targetDoc) => {
    const buttons = deepFind(targetDoc, "button.block-button");
    const btn =
      buttons.find((b) => b.classList.contains("active-block")) ||
      buttons.find((b) => /^(selected|đã chọn)/i.test(b.getAttribute("aria-label") || ""));
    if (!btn) return null;
    const m =
      (btn.getAttribute("aria-label") || "").match(/(?:Question|Câu\s*hỏi)\s+(\d+)/i) ||
      elementText(btn).match(/Q(\d+)/i);
    return m ? Number(m[1]) : null;
  };

  const activeQuestion = (targetDoc) => {
    const all = deepFind(targetDoc, ".component__inner.is-question");
    const num = activeNumber(targetDoc);
    if (num) {
      const re = new RegExp(`(?:Question|Câu\\s*hỏi)\\s+${num}(?!\\d)`, "i");
      const hit = all.find((el) => {
        const title = deepFind(el, ".component__title-inner")[0];
        return title ? re.test(elementText(title)) : false;
      });
      if (hit) return { number: num, root: hit };
    }
    const win = targetDoc.defaultView || window;
    const unhandled = all.find((el) => {
      if (doneRoots.has(el) || !visible(el)) return false;
      const r = el.getBoundingClientRect();
      return r.right > 20 && r.left < win.innerWidth - 20;
    });
    if (unhandled) return { number: num, root: unhandled };

    const shown = all.find((el) => visible(el));
    return shown ? { number: num, root: shown } : null;
  };

  // Đợi câu hỏi render đủ thân & các lựa chọn trước khi đọc/bấm
  const waitQuestionReady = async (root) => {
    const end = Date.now() + MAX_WAIT_READY_MS;
    while (Date.now() < end && !stopped) {
      invalidateDomCache();
      const bodyEl = deepFind(root, ".component__body")[0];
      const hasBody = Boolean(bodyEl && normalize(elementText(bodyEl)));
      const hasInteractive = deepFind(
        root,
        ".mcq__item, [role='radio'], [role='checkbox'], .dropdown__btn, button.objectMatching-category-item"
      ).some(visible);

      const r = root.getBoundingClientRect?.();
      const win = root.ownerDocument?.defaultView || window;
      const inView = !r || (r.width > 0 && r.right > 20 && r.left < win.innerWidth - 20);

      if (hasBody && hasInteractive && inView) return true;
      await sleep(POLL_MS);
    }
    return false;
  };

  const optionText = (item) =>
    elementText(item).replace(/\s+\d+\s+of\s+\d+\s*$/i, "");

  const choiceState = (item) => {
    const inp = deepFind(item, "input")[0];
    if (inp) return Boolean(inp.checked);
    const ac = item.getAttribute("aria-checked");
    return ac === "true" ? true : ac === "false" ? false : null;
  };

  const fillChoicesFast = async (root, choices) => {
    let items = deepFind(root, ".mcq__item");
    if (!items.length) items = deepFind(root, "[role='checkbox'], [role='radio']");
    if (!items.length) throw new Error("Không tìm thấy item trắc nghiệm.");

    const targets = new Set();
    for (const ans of choices) {
      const hit = findByText(items, ans, optionText);
      if (!hit) throw new Error(`Không thấy lựa chọn: ${decodeHtmlEntities(ans)}`);
      targets.add(hit);
    }

    for (const item of items) {
      const inp = deepFind(item, "input")[0];
      const want = targets.has(item);
      if (choiceState(item) === want) continue;
      if (inp?.type === "radio" && !want) continue;

      const lbl = deepFind(item, "label")[0];
      ensureInViewAndClick(lbl || inp || item);
      await sleep(FAST_CLICK_MS);
      if (choiceState(item) !== want && inp) {
        ensureInViewAndClick(inp);
        await sleep(FAST_CLICK_MS);
      }
    }
  };

  const dropdownButtonValue = (btn) => {
    const inner = deepFind(btn, ".dropdown__inner, .js-dropdown-inner")[0];
    const raw = elementText(inner || btn).replace(/^selected\s+/i, "");
    return normalize(stripOuterParens(raw));
  };

  const pickDropdownOption = async (targetDoc, row, root, btn, wantedText) => {
    if (dropdownButtonValue(btn) === normalize(stripOuterParens(wantedText))) return;
    ensureInViewAndClick(btn);
    await sleep(FAST_CLICK_MS);

    const wantNorm = normalize(stripOuterParens(wantedText));
    const wantLoose = normalizeLoose(stripOuterParens(wantedText));
    const findOpt = (scope) => {
      const hits = deepElements(scope).filter((el) => {
        if (el === btn || btn.contains(el) || !visible(el)) return false;
        const txt = stripOuterParens(elementText(el));
        return normalize(txt) === wantNorm || (wantLoose && normalizeLoose(txt) === wantLoose);
      });
      return hits.find((el) => !hits.some((other) => other !== el && el.contains(other)));
    };

    let opt = findOpt(row) || findOpt(root) || findOpt(targetDoc);
    if (!opt) {
      await sleep(120);
      invalidateDomCache();
      opt = findOpt(row) || findOpt(root) || findOpt(targetDoc);
    }
    if (!opt) throw new Error(`Không thấy lựa chọn dropdown: ${decodeHtmlEntities(wantedText)}`);
    ensureInViewAndClick(opt);
    await sleep(FAST_CLICK_MS);
  };

  const fillDropdownMatchingFast = async (targetDoc, root, pairs) => {
    const rows = deepFind(root, ".matching__item-container-options-wrapper");
    for (const [left, right] of pairs) {
      const row = findByText(rows, left, (r) =>
        elementText(deepFind(r, ".matching__item-title")[0] || r)
      );
      if (!row) throw new Error(`Không thấy dòng nối: ${decodeHtmlEntities(left)}`);
      const btn = deepFind(row, ".dropdown__btn")[0];
      if (!btn) throw new Error(`Dòng không có dropdown: ${decodeHtmlEntities(left)}`);
      await pickDropdownOption(targetDoc, row, root, btn, right);
    }
  };

  const fillBlanksFast = async (targetDoc, root, blanks) => {
    const wrappers = deepFind(root, ".fillblanks__item-container-options-wrapper, fillblanks-dropdown-view");
    const btns = wrappers.length
      ? wrappers.map((w) => deepFind(w, ".dropdown__btn")[0]).filter(Boolean)
      : deepFind(root, ".dropdown__btn");
    for (let i = 0; i < blanks.length && i < btns.length; i++) {
      await pickDropdownOption(targetDoc, wrappers[i] || root, root, btns[i], blanks[i]);
    }
  };

  const fillButtonMatchingFast = async (root, pairs) => {
    for (const [left, right] of pairs) {
      const cats = deepFind(root, "button.objectMatching-category-item");
      const opts = deepFind(root, "button.objectMatching-option-item");
      const cat = findByText(cats, left, (c) => elementText(c).replace(/\s+[A-Z]$/, ""));
      const opt = findByText(opts, right);
      if (!cat) throw new Error(`Không thấy vế trái: ${decodeHtmlEntities(left)}`);
      if (!opt) throw new Error(`Không thấy vế phải: ${decodeHtmlEntities(right)}`);
      ensureInViewAndClick(cat);
      await sleep(FAST_CLICK_MS);
      ensureInViewAndClick(opt);
      await sleep(FAST_CLICK_MS);
    }
  };

  const setSkipFast = async (targetDoc, on) => {
    const box = deepFind(targetDoc, "input#skip-question, input[aria-label='Skip Question']")[0];
    if (!box || box.checked === on) return;
    const lbl = deepFind(targetDoc, "label[for='skip-question']")[0];
    ensureInViewAndClick(lbl || box);
    await sleep(FAST_CLICK_MS);
    if (box.checked !== on) {
      ensureInViewAndClick(box);
      await sleep(FAST_CLICK_MS);
    }
  };

  const submitQuestionAndWaitAdvance = async (targetDoc, scopeRoot, prevNum) => {
    const findSubmit = (scope) =>
      deepFind(scope, "button, [role='button'], input[type='submit']").find((el) => {
        const label = normalize([elementText(el), el.getAttribute("aria-label"), el.value].filter(Boolean).join(" "));
        return (/\bsubmit\b/.test(label) || /\bnộp\b/.test(label)) && !/adaptive-assessment-submit/.test(el.className || "") && visible(el);
      });

    const deadline = Date.now() + 2500;
    let clicked = false;
    while (Date.now() < deadline && !stopped) {
      invalidateDomCache();
      const btn = findSubmit(scopeRoot) || findSubmit(targetDoc);
      if (btn) {
        const disabled =
          btn.disabled ||
          btn.getAttribute("aria-disabled") === "true" ||
          btn.classList.contains("is-disabled") ||
          btn.classList.contains("disabled");
        if (!disabled) {
          ensureInViewAndClick(btn);
          clicked = true;
          break;
        }
      }
      await sleep(POLL_MS);
    }
    if (!clicked) return false;

    const waitEnd = Date.now() + MAX_WAIT_ADVANCE_MS;
    while (Date.now() < waitEnd && !stopped) {
      await sleep(POLL_MS);
      invalidateDomCache();
      const nextNum = activeNumber(targetDoc);
      const hasSubmitPage = deepFind(targetDoc, "input#confirm-exam, button.adaptive-assessment-submit").some(visible);
      const hasResult = deepFind(targetDoc, "button.assessmentResults__retry-btn, button.js-assessment-retry-btn").some(visible);
      const hasPopup = deepFind(targetDoc, "button.notify__close-btn, button.js-notify-close-btn").some(visible);
      if ((nextNum && nextNum !== prevNum) || hasSubmitPage || hasResult || hasPopup) return true;
      if (!prevNum) {
        const btnAfter = findSubmit(scopeRoot);
        if (!btnAfter || btnAfter.disabled || btnAfter.classList.contains("is-disabled")) return true;
      }
    }
    return true;
  };

  const handleFinalSubmitAndPopup = async (targetDoc) => {
    const closeBtn = deepFind(targetDoc, "button.notify__close-btn, button.js-notify-close-btn").find(visible);
    if (closeBtn) {
      ensureInViewAndClick(closeBtn);
      await sleep(100);
    }

    // const confirmBox = deepFind(targetDoc, "input#confirm-exam")[0];
    // if (confirmBox && visible(confirmBox) && AUTO_SUBMIT_FINAL_EXAM) {
    //   if (!confirmBox.checked) {
    //     ensureInViewAndClick(confirmBox);
    //     await sleep(80);
    //   }
    //   const finalBtn = deepFind(targetDoc, "button.adaptive-assessment-submit").find(visible);
    //   if (finalBtn && !finalBtn.disabled && !finalBtn.classList.contains("is-disabled")) {
    //     ensureInViewAndClick(finalBtn);
    //     console.log("[AutoFill] Đã tích xác nhận và nộp bài (Submit My Assessment).");
    //     return "submitted";
    //   }
    // }

    const retryBtn =
      deepFind(targetDoc, "button.assessmentResults__retry-btn, button.js-assessment-retry-btn").find(visible) ||
      deepFind(targetDoc, "button").find(
        (b) => visible(b) && /^(reset|đặt lại|thiết lập lại)$/i.test(elementText(b)) && !deepFind(targetDoc, ".component__inner.is-question").some(visible)
      );

    if (retryBtn) {
      if (AUTO_RETRY_ON_RESULT) {
        ensureInViewAndClick(retryBtn);
        console.log("[AutoFill] Đã bấm làm lại từ Trang kết quả...");
        return "retrying";
      }
      return "finished";
    }

    return null;
  };

  // ---------- 6. Vòng lặp xử lý ----------
  const handled = new Set();
  const attempts = new Map();
  let idleTicks = 0;
  let sameTicks = 0;

  while (!stopped && idleTicks < 150) {
    invalidateDomCache();
    const stage = await handleFinalSubmitAndPopup(doc);
    if (stage === "submitted" || stage === "retrying") {
      if (stage === "retrying") handled.clear();
      await sleep(300);
      continue;
    }
    if (stage === "finished") {
      console.log(`[AutoFill] Đang ở Trang kết quả (hoàn tất sau ${((performance.now() - t0All) / 1000).toFixed(2)}s). Bấm "Thiết lập lại" nếu muốn làm lại.`);
      break;
    }

    const active = activeQuestion(doc);
    if (!active) {
      idleTicks++;
      await sleep(POLL_MS);
      continue;
    }
    idleTicks = 0;

    // Đợi câu hỏi render đủ thân + các lựa chọn trước khi xử lý
    await waitQuestionReady(active.root);

    let rec = plannedMap.get(active.root);
    const meta = extractQuestionMeta(active.root);
    if (!rec) {
      rec = resolveRecord(bankIndex, meta);
      if (rec) plannedMap.set(active.root, rec);
    }

    const qKey = `${active.number ?? "?"}|${rec?.compId || meta.body}`;
    if (handled.has(qKey)) {
      sameTicks++;
      if (!deepFind(doc, "button.block-button").length && sameTicks > 25) {
        console.log(`[AutoFill] Hoàn tất các câu trên trang trong ${((performance.now() - t0All) / 1000).toFixed(2)}s.`);
        break;
      }
      await sleep(POLL_MS);
      continue;
    }
    sameTicks = 0;

    const tried = attempts.get(qKey) || 0;
    if (tried >= 3) {
      await sleep(POLL_MS);
      continue;
    }
    attempts.set(qKey, tried + 1);

    const label = `Q${active.number ?? "?"}`;
    try {
      if (!rec) {
        console.warn(`[AutoFill] ${label}: chưa khớp được câu hỏi trong components.json (${meta.body.slice(0, 80)}).`);
        if (AUTO_SKIP && meta.body) {
          await setSkipFast(doc, true);
          if (AUTO_SUBMIT && await submitQuestionAndWaitAdvance(doc, active.root, active.number)) {
            handled.add(qKey);
            doneRoots.add(active.root);
          }
        } else {
          handled.add(qKey);
          doneRoots.add(active.root);
        }
      } else {
        await setSkipFast(doc, false);
        const p = rec.parsed;
        if (p.kind === "mcq") await fillChoicesFast(active.root, p.choices);
        else if (p.kind === "matching") await fillDropdownMatchingFast(doc, active.root, p.pairs);
        else if (p.kind === "objectMatching") await fillButtonMatchingFast(active.root, p.pairs);
        else if (p.kind === "fillBlanks") await fillBlanksFast(doc, active.root, p.blanks);

        console.log(`[AutoFill] ${label} (${p.kind}): đã điền xong.`);
        if (AUTO_SUBMIT) {
          if (await submitQuestionAndWaitAdvance(doc, active.root, active.number)) {
            handled.add(qKey);
            doneRoots.add(active.root);
          }
        } else {
          handled.add(qKey);
          doneRoots.add(active.root);
        }
      }
    } catch (err) {
      console.error(`[AutoFill] ${label} lỗi:`, err?.message || err);
      await sleep(250);
    }
  }
})();