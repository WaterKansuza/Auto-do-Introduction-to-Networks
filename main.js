(async () => {
    // ---------- Cấu hình ----------
    const AUTO_SKIP = true; // true: tự Skip câu không tìm thấy đáp án
    const AUTO_SUBMIT = true; // true: tự Submit sau khi điền
    const RELOAD_ANSWER_FILE = false; // false: tái sử dụng ngân hàng trong cùng trang
    const LOOP_INTERVAL = 700; // thời gian kiểm tra câu hỏi tiếp theo (ms)

    window.stopAutofill?.();

    let stopped = false;
    window.stopAutofill = () => {
        stopped = true;
        console.log("Đã dừng autofill.");
    };

    // Chuẩn hóa cả văn bản DOM lẫn Markdown trong file đáp án.
    // Ví dụ: `reload`, **reload** và <b>reload</b> đều thành "reload".
    const normalize = (value) =>
        String(value ?? "")
            .replace(/```[\w-]*\s*([\s\S]*?)```/g, " $1 ")
            .replace(/<br\s*\/?\s*>/gi, " ")
            .replace(/<[^>]*>/g, " ")
            .replace(/&nbsp;|&#160;/gi, " ")
            .replace(/&amp;/gi, "&")
            .replace(/&quot;/gi, '"')
            .replace(/&#39;|&apos;/gi, "'")
            .replace(/&lt;/gi, "<")
            .replace(/&gt;/gi, ">")
            .replace(/\u00a0/g, " ")
            .replace(/`+/g, "")
            .replace(/\*+/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();

    const sleep = (ms) =>
        new Promise((resolve) => setTimeout(resolve, ms));

    // ---------- Đọc & phân tích file Checkpoint1.md ----------
    const readMarkdown = async () => {
        if (window.showOpenFilePicker) {
            const [handle] = await window.showOpenFilePicker({
                types: [{
                    description: "Markdown",
                    accept: { "text/markdown": [".md"] }
                }],
                multiple: false
            });

            return (await handle.getFile()).text();
        }

        const pasted = window.prompt(
            "Trình duyệt không hỗ trợ chọn file. Hãy dán toàn bộ Checkpoint1.md:"
        );

        if (!pasted) {
            throw new Error("Chưa cung cấp nội dung Checkpoint1.md.");
        }

        return pasted;
    };

    const parseAnswerSection = (markdown) => {
        const answerPart = markdown.split("## Answer")[1];

        if (!answerPart) {
            throw new Error("Không tìm thấy ## Answer.");
        }

        const answers = new Map();
        const sections = answerPart.split(/^Câu\s+(\d+):\s*/m);

        for (let i = 1; i < sections.length; i += 2) {
            const number = Number(sections[i]);
            const body = sections[i + 1]
                .split(/\n\nCâu\s+/)[0]
                .trim();

            if (/^\|/.test(body)) {
                // Bảng nối (Left | Right)
                const pairs = [...body.matchAll(
                    /^\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*$/gm
                )]
                    .filter((match) =>
                        match[1] !== "Left" &&
                        !/^[-\s]+$/.test(match[1])
                    )
                    .map((match) => [
                        match[1].trim(),
                        match[2].trim()
                    ]);

                answers.set(number, pairs);

            } else if (body.startsWith("- ")) {
                answers.set(
                    number,
                    body.split("\n")
                        .filter((line) =>
                            line.trim().startsWith("- ")
                        )
                        .map((line) =>
                            line.trim()
                                .slice(2)
                                .replace(/;$/, "")
                                .trim()
                        )
                );

            } else {
                answers.set(
                    number,
                    body.split(";")
                        .map((value) => value.trim())
                        .filter(Boolean)
                );
            }
        }

        return answers;
    };

    const parseQuestions = (markdown, answers) => {
        const questionPart = markdown.split("## Answer")[0];
        const questions = new Map();

        const blocks = questionPart
            .split(/^## Câu\s+/m)
            .slice(1);

        for (const block of blocks) {
            const match = block.match(/^(\d+)\s*\n\n([\s\S]*)$/);

            if (!match) continue;

            const number = Number(match[1]);

            const question = match[2]
                .split(/\n\n(?:- |\*\*Categories:\*\*)/)[0]
                .trim();

            questions.set(normalize(question), answers.get(number));
        }

        return questions;
    };

    // ---------- Tiện ích DOM ----------
    // Cache kết quả quét DOM trong cùng một vòng xử lý.
    // Cache được vô hiệu hóa sau click và đầu mỗi vòng lặp để tránh DOM cũ.
    let domCacheVersion = 0;
    const domElementsCache = new WeakMap();

    const invalidateDomCache = () => {
        domCacheVersion++;
    };

    const clickElement = (element) => {
        if (!element) return;
        element.click();
        invalidateDomCache();
    };

    // Duyệt DOM thường, open Shadow DOM và iframe cùng origin.
    const deepElements = (root) => {
        if (!root || typeof root !== "object") return [];

        const cached = domElementsCache.get(root);
        if (cached?.version === domCacheVersion) {
            return cached.elements;
        }

        const result = [];
        const roots = [root];
        const visitedRoots = new Set();

        // Dùng chỉ số thay cho Array.shift() để tránh dịch chuyển mảng liên tục.
        for (let rootIndex = 0; rootIndex < roots.length; rootIndex++) {
            const current = roots[rootIndex];

            if (!current || visitedRoots.has(current)) continue;
            visitedRoots.add(current);

            // Nếu root truyền vào chính là Element có Shadow DOM.
            if (current.nodeType === 1 && current.shadowRoot) {
                roots.push(current.shadowRoot);
            }

            let elements;

            try {
                elements = current.querySelectorAll("*");
            } catch (_) {
                continue;
            }

            for (const element of elements) {
                result.push(element);

                // Duyệt Shadow DOM đang mở.
                if (element.shadowRoot) {
                    roots.push(element.shadowRoot);
                }

                // Duyệt iframe cùng origin.
                if (element.tagName === "IFRAME") {
                    try {
                        const frameDoc = element.contentDocument;

                        if (frameDoc?.documentElement) {
                            roots.push(frameDoc);
                        }
                    } catch (_) {
                        // iframe khác origin không thể truy cập.
                    }
                }
            }
        }

        domElementsCache.set(root, {
            version: domCacheVersion,
            elements: result
        });

        return result;
    };

    const deepFind = (root, selector) =>
        deepElements(root).filter((element) =>
            element.matches(selector)
        );

    const elementText = (element) =>
        (element.innerText || element.textContent || "").trim();

    const visible = (element) =>
        Boolean(element && (element.offsetWidth || element.offsetHeight));

    const findByText = (items, wanted, getText = elementText) =>
        items.find((el) =>
            normalize(getText(el)) === normalize(wanted)
        ) ||
        items.find((el) =>
            normalize(getText(el)).startsWith(normalize(wanted))
        );

    const hasContent = (doc) =>
        deepElements(doc).some((el) =>
            el.matches(
                ".component__inner.is-question, button.block-button, .start-button"
            )
        );

    // Tìm document chứa nội dung bài.
    const getFrameDocument = async () => {
        for (let i = 0; i < 30; i++) {
            invalidateDomCache();

            if (hasContent(document)) return document;

            for (const frame of deepFind(document, "iframe")) {
                try {
                    if (
                        frame.contentDocument?.body &&
                        hasContent(frame.contentDocument)
                    ) {
                        return frame.contentDocument;
                    }
                } catch (_) {
                    // iframe khác origin
                }
            }

            await sleep(750);
        }

        throw new Error(
            "Không tìm thấy nội dung bài. Nếu bài nằm trong iframe khác origin, " +
            "hãy chọn context của iframe trong dropdown 'top' của Console rồi chạy lại."
        );
    };

    // ---------- Xác định câu hỏi đang mở ----------
    const activeNumber = (doc) => {
        const buttons = deepFind(doc, "button.block-button");

        const btn =
            buttons.find((b) =>
                b.classList.contains("active-block")
            ) ||
            buttons.find((b) =>
                /^selected/i.test(
                    b.getAttribute("aria-label") || ""
                )
            );

        if (!btn) return null;

        const match =
            (btn.getAttribute("aria-label") || "")
                .match(/Question\s+(\d+)/i) ||
            elementText(btn).match(/Q(\d+)/i);

        return match ? Number(match[1]) : null;
    };

    const titleOf = (el) => {
        const title = deepFind(
            el,
            ".component__title-inner"
        )[0];

        return title ? elementText(title) : "";
    };

    const activeQuestion = (doc) => {
        const all = deepFind(
            doc,
            ".component__inner.is-question"
        );

        const number = activeNumber(doc);

        if (number) {
            const re = new RegExp(
                `Question\\s+${number}(?!\\d)`,
                "i"
            );

            const hit = all.find((el) =>
                re.test(titleOf(el))
            );

            if (hit) return { number, root: hit };
        }

        const shown = all.find((el) =>
            visible(el) &&
            (
                el.checkVisibility
                    ? el.checkVisibility({
                        checkOpacity: true,
                        checkVisibilityCSS: true
                    })
                    : true
            )
        );

        return shown ? { number, root: shown } : null;
    };

    const bodyOf = (root) => {
        const body = deepFind(root, ".component__body")[0];

        return normalize(
            body ? elementText(body) : ""
        );
    };

    // ---------- Tìm đáp án trong file ----------
    // Tách token từ chuỗi đã normalize để tránh chuẩn hóa lặp lại.
    const tokenizeNormalized = (text) =>
        new Set(
            text
                .split(/[^\p{L}\p{N}]+/u)
                .filter(Boolean)
        );

    // Tạo chỉ mục một lần sau khi đọc Markdown.
    // Mỗi token trỏ tới những câu hỏi có chứa token đó.
    const buildLookupIndex = (bank) => {
        const entries = [];
        const inverted = new Map();

        let order = 0;

        for (const [question, answer] of bank) {
            if (!Array.isArray(answer) || !answer.length) continue;

            const q = normalize(question);
            if (!q) continue;

            const wordSet = tokenizeNormalized(q);
            if (!wordSet.size) continue;

            const item = {
                q,
                answer,
                wordSet,
                order: order++
            };

            entries.push(item);

            for (const token of wordSet) {
                if (!inverted.has(token)) {
                    inverted.set(token, []);
                }

                inverted.get(token).push(item);
            }
        }

        return { entries, inverted };
    };

    const lookup = (index, rawBody) => {
        const body = normalize(rawBody);
        if (!body) return null;

        // So khớp trực tiếp trước để giữ nguyên hành vi của phiên bản cũ.
        // Việc quét chuỗi này nhẹ hơn nhiều so với tokenize toàn bộ ngân hàng
        // ở mỗi câu hỏi.
        let direct = null;

        for (const item of index.entries) {
            const matches =
                body.includes(item.q) ||
                (body.length > 20 && item.q.includes(body));

            if (
                matches &&
                (!direct || item.q.length > direct.q.length)
            ) {
                direct = item;
            }
        }

        if (direct) return direct.answer;

        // So khớp gần đúng: chỉ xét những câu có ít nhất một token chung.
        const bodyTokens = tokenizeNormalized(body);
        if (!bodyTokens.size) return null;

        const candidateSet = new Set();

        for (const token of bodyTokens) {
            const matches = index.inverted.get(token);
            if (!matches) continue;

            for (const item of matches) {
                candidateSet.add(item);
            }
        }

        // Giữ thứ tự gốc để xử lý điểm bằng nhau ổn định như bản cũ.
        const candidates = [...candidateSet]
            .sort((a, b) => a.order - b.order);

        let best = null;
        let bestScore = 0;

        for (const item of candidates) {
            let common = 0;

            for (const token of item.wordSet) {
                if (bodyTokens.has(token)) common++;
            }

            const score =
                common / Math.max(item.wordSet.size, bodyTokens.size);

            if (score > bestScore) {
                best = item.answer;
                bestScore = score;
            }
        }

        return bestScore >= 0.85 ? best : null;
    };

    // ---------- Điền đáp án ----------
    // Bỏ phần đuôi "n of m" trong nội dung lựa chọn.
    const optionText = (item) =>
        elementText(item)
            .replace(/\s+\d+\s+of\s+\d+\s*$/i, "");

    const inputOf = (item) =>
        deepFind(item, "input")[0];

    const choiceState = (item) => {
        const input = inputOf(item);

        if (input) return Boolean(input.checked);

        const ariaChecked = item.getAttribute("aria-checked");

        if (ariaChecked === "true") return true;
        if (ariaChecked === "false") return false;

        return null;
    };

    // ---------- Trắc nghiệm ----------
    const fillChoices = async (root, wanted) => {
        let items = deepFind(root, ".mcq__item");

        if (!items.length) {
            items = deepFind(
                root,
                "[role='checkbox'], [role='radio']"
            );
        }

        if (!items.length) {
            throw new Error(
                "Không nhận ra dạng câu trắc nghiệm."
            );
        }

        const targets = new Set();

        // Tìm tất cả lựa chọn cần chọn trước khi click.
        for (const text of wanted) {
            const hit = findByText(
                items,
                text,
                optionText
            );

            if (!hit) {
                throw new Error(
                    `Không tìm thấy đáp án trên trang: ${text}`
                );
            }

            targets.add(hit);
        }

        // Click và kiểm tra lại trạng thái.
        for (const item of items) {
            const input = inputOf(item);
            const want = targets.has(item);
            const isOn = choiceState(item);

            if (isOn === want) continue;

            if (input?.type === "radio" && !want) continue;

            const label = deepFind(item, "label")[0];

            clickElement(label || input || item);

            await sleep(150);

            // Chỉ click input lần hai nếu trạng thái chưa đổi.
            if (choiceState(item) !== want && input) {
                clickElement(input);
                await sleep(150);
            }
        }

        // Kiểm tra khả năng xác minh trạng thái.
        const unverifiable = items.filter(
            (item) => choiceState(item) === null
        );

        if (unverifiable.length) {
            throw new Error(
                `Không xác minh được trạng thái của ${unverifiable.length} lựa chọn; ` +
                "không Submit tự động."
            );
        }

        // Kiểm tra lựa chọn có đúng với đáp án mong muốn không.
        const wrong = items.filter((item) => {
            const input = inputOf(item);
            const want = targets.has(item);
            const actual = choiceState(item);

            return (
                actual !== want &&
                !(input?.type === "radio" && !want)
            );
        });

        if (wrong.length) {
            throw new Error(
                `Còn ${wrong.length} lựa chọn chưa đúng trạng thái; ` +
                "không Submit tự động."
            );
        }
    };

    // ---------- Nối bằng dropdown ----------
    const fillDropdownMatching = async (doc, root, pairs) => {
        const rows = deepFind(
            root,
            ".matching__item-container-options-wrapper"
        );

        for (const [left, right] of pairs) {
            const row = findByText(
                rows,
                left,
                (r) =>
                    elementText(
                        deepFind(r, ".matching__item-title")[0] || r
                    )
            );

            if (!row) {
                throw new Error(
                    `Không tìm thấy dòng nối: ${left}`
                );
            }

            const button = deepFind(
                row,
                ".dropdown__btn"
            )[0];

            if (!button) {
                throw new Error(
                    `Dòng nối không có dropdown: ${left}`
                );
            }

            if (
                normalize(elementText(button)) === normalize(right)
            ) {
                continue;
            }

            clickElement(button);
            await sleep(250);

            const pick = (scope) => {
                const hits = deepElements(scope).filter((el) =>
                    el !== button &&
                    !button.contains(el) &&
                    visible(el) &&
                    normalize(elementText(el)) === normalize(right)
                );

                // Lấy phần tử sâu nhất để click.
                return hits.find((el) =>
                    !hits.some(
                        (other) =>
                            other !== el && el.contains(other)
                    )
                );
            };

            const option =
                pick(row) ||
                pick(root) ||
                pick(doc);

            if (!option) {
                throw new Error(
                    `Không tìm thấy lựa chọn nối: ${right}`
                );
            }

            clickElement(option);
            await sleep(250);

            if (
                normalize(elementText(button)) !== normalize(right)
            ) {
                throw new Error(
                    `Dropdown "${left}" chưa nhận giá trị "${right}"; ` +
                    "không Submit tự động."
                );
            }
        }
    };

    // ---------- Nối bằng nút Object Matching ----------
    const fillButtonMatching = async (root, pairs) => {
        for (const [left, right] of pairs) {
            const categories = deepFind(
                root,
                "button.objectMatching-category-item"
            );

            const options = deepFind(
                root,
                "button.objectMatching-option-item"
            );

            // Vế trái có đuôi chữ cái nhãn như "... is added. A"
            const category = findByText(
                categories,
                left,
                (c) =>
                    elementText(c).replace(/\s+[A-Z]$/, "")
            );

            const option = findByText(options, right);

            if (!category) {
                throw new Error(
                    `Không tìm thấy vế trái: ${left}`
                );
            }

            if (!option) {
                throw new Error(
                    `Không tìm thấy vế phải: ${right}`
                );
            }

            clickElement(category);
            await sleep(200);

            clickElement(option);
            await sleep(250);
        }
    };

    // Trả về true nếu có trạng thái có thể xác minh.
    const fillQuestion = async (doc, root, answer) => {
        if (Array.isArray(answer[0])) {
            if (deepFind(root, ".dropdown__btn").length) {
                await fillDropdownMatching(
                    doc,
                    root,
                    answer
                );

                return true;
            }

            if (
                deepFind(
                    root,
                    "button.objectMatching-category-item"
                ).length
            ) {
                await fillButtonMatching(root, answer);

                // Chưa có bằng chứng về trạng thái ghép
                // nên cần người dùng kiểm tra thủ công.
                return false;
            }

            throw new Error(
                "Không nhận ra dạng câu nối."
            );
        }

        await fillChoices(root, answer);

        return true;
    };

    // ---------- Skip Question ----------
    const setSkip = async (doc, on) => {
        const box = deepFind(
            doc,
            'input#skip-question, input[aria-label="Skip Question"]'
        )[0];

        if (!box) {
            throw new Error(
                'Không tìm thấy checkbox "Skip Question".'
            );
        }

        if (box.checked === on) return true;

        const label = deepFind(
            doc,
            'label[for="skip-question"]'
        )[0];

        clickElement(label || box);
        await sleep(200);

        if (box.checked !== on) {
            clickElement(box);
            await sleep(200);
        }

        if (box.checked !== on) {
            throw new Error(
                `Không thể đặt Skip Question thành ${on}.`
            );
        }

        return true;
    };

    // ---------- Submit ----------
    
const submitCurrent = async (doc) => {
    for (let i = 0; i < 20; i++) {

        // Tìm các phần tử có khả năng là nút Submit.
        const controls = deepFind(
            doc,
            "button, [role='button'], input[type='submit']"
        );

        const button = controls.find((el) => {
            const label = normalize([
                elementText(el),
                el.getAttribute("aria-label"),
                el.getAttribute("title"),
                el.value
            ].filter(Boolean).join(" "));

            return (
                /\bsubmit\b/.test(label) &&
                visible(el)
            );
        });

        if (button) {
            const disabled =
                button.disabled ||
                button.getAttribute("aria-disabled") === "true" ||
                button.classList.contains("is-disabled") ||
                button.classList.contains("disabled");

            if (!disabled) {
                console.log("Đang nhấn Submit...");

                clickElement(button);

                await sleep(700);

                console.log("Đã thực hiện click Submit.");

                return true;
            }
        }

        await sleep(250);
    }

    console.warn(
        "Không tìm thấy nút Submit khả dụng sau 5 giây."
    );

    return false;
};

    // ---------- Chạy ----------
    if (RELOAD_ANSWER_FILE || !window.__autofillBank) {
        console.log("1. Đang đọc markdown...");

        const markdown = (await readMarkdown())
            .replace(/\r\n?/g, "\n");

        console.log(
            "2. Đã đọc xong, độ dài:",
            markdown.length
        );

        window.__autofillBank = parseQuestions(
            markdown,
            parseAnswerSection(markdown)
        );
    }

    const bank = window.__autofillBank;

    // Chỉ xây dựng lại index khi ngân hàng Markdown thay đổi.
    if (window.__autofillIndex?.bank !== bank) {
        console.time("Xây dựng Answer Index");
        window.__autofillIndex = {
            bank,
            data: buildLookupIndex(bank)
        };
        console.timeEnd("Xây dựng Answer Index");
    }

    const answerIndex = window.__autofillIndex.data;

    console.log(
        "3. Số câu đã parse:",
        bank.size
    );
    console.log(
        "4. Số câu có đáp án trong index:",
        answerIndex.entries.length
    );

    console.log("5. Đang tìm nội dung bài...");

    const doc = await getFrameDocument();

    console.log(
        "6. Đã tìm thấy nội dung bài " +
        "(DOM, open Shadow DOM, iframe cùng origin). " +
        "Gõ stopAutofill() để dừng."
    );

    // Chỉ bấm Start khi chưa có dải câu hỏi.
    if (!deepFind(doc, "button.block-button").length) {
        const start = deepFind(
            doc,
            "button, [role='button']"
        ).find((el) =>
            visible(el) &&
            normalize(elementText(el)) === "start"
        );

        if (start) {
            clickElement(start);
            await sleep(1000);
        }
    }

    // Chỉ đánh dấu đã xử lý sau khi điền/Skip thành công.
    // Nếu thao tác lỗi, thử lại tối đa 3 lần.
    const handled = new Set();
    const attempts = new Map();

    const MAX_ATTEMPTS = 3;
    const deadline = Date.now() + 60 * 60 * 1000;

    while (!stopped && Date.now() < deadline) {
        // Mỗi vòng lấy snapshot DOM mới; trong cùng vòng, deepFind dùng cache.
        invalidateDomCache();

        try {
            const active = activeQuestion(doc);

            if (active) {
                const body = bodyOf(active.root);
                const key = `${active.number}|${body}`;

                if (body && !handled.has(key)) {
                    const label = `Q${active.number ?? "?"}`;
                    const tried = attempts.get(key) || 0;

                    if (tried >= MAX_ATTEMPTS) {
                        // Đã báo lỗi đủ số lần.
                    } else {
                        attempts.set(key, tried + 1);

                        try {
                            const answer = lookup(answerIndex, body);

                            let ready = false;
                            let verified = true;

                            if (!answer) {
                                console.warn(
                                    `${label}: chưa tìm thấy đáp án tương ứng trong file. ` +
                                    `(${body.slice(0, 120)})`
                                );

                                if (AUTO_SKIP) {
                                    await setSkip(doc, true);

                                    console.log(
                                        `${label}: đã xác minh Skip Question.`
                                    );

                                    ready = true;

                                } else {
                                    // Để người dùng tự xử lý.
                                    handled.add(key);
                                }

                            } else {
                                await setSkip(doc, false);

                                verified = await fillQuestion(
                                    doc,
                                    active.root,
                                    answer
                                );

                                console.log(
                                    verified
                                        ? `${label}: đã điền và xác minh lựa chọn.`
                                        : `${label}: đã thực hiện ghép lựa chọn; cần kiểm tra thủ công.`
                                );

                                ready = true;
                            }

                          
if (ready) {

    if (AUTO_SUBMIT && verified) {

        const ok = await submitCurrent(doc);

        if (ok) {
            // Chỉ đánh dấu sau khi đã click Submit.
            handled.add(key);

            console.log(
                `${label}: đã click Submit.`
            );

        } else {
            // Không đánh dấu để vòng lặp có thể thử lại.
            console.warn(
                `${label}: Submit thất bại. Sẽ thử lại.`
            );
        }

    } else {

        // Không tự Submit hoặc chưa thể xác minh.
        handled.add(key);

        console.log(
            `${label}: hãy kiểm tra kết quả rồi tự bấm Submit.`
        );
    }
}


                        } catch (error) {
                            console.error(
                                `${label}: lần thử ${tried + 1}/${MAX_ATTEMPTS} thất bại:`,
                                error.message
                            );

                            if (tried + 1 >= MAX_ATTEMPTS) {
                                console.warn(
                                    `${label}: đã dừng tự động xử lý câu này sau ${MAX_ATTEMPTS} lần. ` +
                                    "Không tự Submit; cần kiểm tra DOM/đáp án."
                                );
                            }
                        }
                    }
                }
            }

        } catch (error) {
            console.error(
                "Lỗi vòng lặp:",
                error.message
            );
        }

        await sleep(LOOP_INTERVAL);
    }
})();
